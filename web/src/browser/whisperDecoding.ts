import type { BrowserAsrWindowDecoder } from "../types/browserAsrWindowTranscription"
import type { BrowserWhisperModel, BrowserWhisperSequenceTensor, BrowserWhisperTokenId, BrowserWhisperWindowDecoderOptions } from "../types/browserWhisperDecoding"
import {
  BROWSER_WHISPER_DECODING_ENCODER_DOWNSAMPLE_FACTOR,
  BROWSER_WHISPER_DECODING_MAX_WINDOW_SECONDS,
  BROWSER_WHISPER_DECODING_START_OF_PREVIOUS_TOKEN,
  BROWSER_WHISPER_DECODING_TASK,
} from "../browserWhisperDecodingConstants"
import { extractWhisperTokenTimestamps } from "./whisperTimestamps"
import { pythonRound } from "./asrDecoding"

function requiredPositiveNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Whisper decoding requires a finite positive ${name} in the loaded model configuration.`)
  }
  return value
}

function makeInitTokens(model: BrowserWhisperModel, language: string): number[] {
  const config = model.generation_config
  const retrieve = model._retrieve_init_tokens
  if (typeof retrieve !== "function") throw new Error("Whisper model does not expose _retrieve_init_tokens; explicit language/task prefix cannot be verified.")
  const prepared = {
    ...config,
    language,
    task: BROWSER_WHISPER_DECODING_TASK,
    return_timestamps: false,
  }
  let tokens: number[]
  try {
    tokens = retrieve.call(model, prepared)
  } catch (error) {
    throw new Error(`Whisper could not build its ${language}/${BROWSER_WHISPER_DECODING_TASK} decoder prefix: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(tokens) || tokens.length < 2 || tokens.some((token) => !Number.isInteger(token) || token < 0)) {
    throw new Error("Whisper generation configuration produced an invalid standard decoder prefix.")
  }
  const expectedTask = (config.task_to_id as Record<string, number> | undefined)?.[BROWSER_WHISPER_DECODING_TASK]
  if (typeof expectedTask === "number" && tokens[2] !== expectedTask) throw new Error("Whisper generation configuration did not produce the transcribe task token.")
  const noTimestamp = config.no_timestamps_token_id
  if (typeof noTimestamp === "number" && tokens.at(-1) !== noTimestamp) throw new Error("Whisper decoder prefix is missing the notimestamps token required for word alignment.")
  return tokens
}

function contextPromptTokens(
  contextPrompt: string,
  tokenizer: BrowserWhisperWindowDecoderOptions["tokenizer"],
): number[] {
  if (!contextPrompt.trim()) return []
  const previousToken = tokenizer.encode(BROWSER_WHISPER_DECODING_START_OF_PREVIOUS_TOKEN, { add_special_tokens: false })
  if (!Array.isArray(previousToken) || previousToken.length !== 1 || !Number.isInteger(previousToken[0]) || previousToken[0] < 0) {
    throw new Error("Whisper tokenizer must encode <|startofprev|> as exactly one valid token ID.")
  }
  const encoded = tokenizer.encode(` ${contextPrompt.trim()}`, { add_special_tokens: false })
  if (!Array.isArray(encoded) || encoded.some((id) => !Number.isInteger(id) || id < 0)) throw new Error("Whisper tokenizer returned invalid context token IDs.")
  if (encoded.includes(tokenizer.bos_token_id ?? -1) || encoded.includes(tokenizer.eos_token_id ?? -1)) {
    throw new Error("Whisper context encoding unexpectedly included a beginning or end token.")
  }
  return [previousToken[0], ...encoded]
}

function sequenceTokenIds(sequences: BrowserWhisperSequenceTensor): BrowserWhisperTokenId[] {
  const rows = sequences.tolist()
  if (sequences.dims.length !== 2 || sequences.dims[0] !== 1 || !Array.isArray(rows) || !Array.isArray(rows[0])) {
    throw new Error("Whisper generation returned sequences with an unsupported shape; expected [1, tokens].")
  }
  const ids = rows[0] as BrowserWhisperTokenId[]
  if (ids.length < 2 || ids.some((id) => typeof id !== "number" && typeof id !== "bigint")) throw new Error("Whisper generation returned an invalid token sequence.")
  return ids
}

export function createWhisperWindowDecoder({
  model,
  tokenizer,
  processor,
  language,
  onDiagnostic,
}: BrowserWhisperWindowDecoderOptions): BrowserAsrWindowDecoder {
  if (!language.trim()) throw new Error("Whisper decoding requires an explicit language.")
  const generationConfig = model.generation_config
  const modelConfig = model.config
  const featureConfig = processor.feature_extractor.config
  const chunkLengthSeconds = requiredPositiveNumber(featureConfig.chunk_length, "feature extractor chunk_length")
  const sampleRate = requiredPositiveNumber(featureConfig.sampling_rate, "feature extractor sampling_rate")
  const hopLength = requiredPositiveNumber(featureConfig.hop_length, "feature extractor hop_length")
  if (!Number.isInteger(hopLength)) throw new Error("Whisper processor hop_length must be an integer number of samples.")
  const sourcePositions = requiredPositiveNumber(modelConfig.max_source_positions, "model max_source_positions")
  const precision = chunkLengthSeconds / sourcePositions
  if (!Number.isFinite(precision) || precision <= 0) throw new Error("Whisper time precision derived from chunk_length/max_source_positions is invalid.")
  const expectedFramePrecision = hopLength * BROWSER_WHISPER_DECODING_ENCODER_DOWNSAMPLE_FACTOR / sampleRate
  if (Math.abs(expectedFramePrecision - precision) > precision * 0.05) {
    throw new Error(`Whisper time precision (${precision}s) does not match the processor hop and encoder downsampling (${expectedFramePrecision}s).`)
  }
  const alignmentHeads = generationConfig.alignment_heads
  if (!Array.isArray(alignmentHeads) || alignmentHeads.length === 0) throw new Error("Whisper generation configuration has no alignment_heads for word timestamps.")
  const initTokens = makeInitTokens(model, language)

  return async (windowSamples, options) => {
    if (!(windowSamples instanceof Float32Array) || windowSamples.length === 0) throw new Error("Whisper window decoding requires nonempty Float32 PCM audio.")
    const durationSeconds = windowSamples.length / sampleRate
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > BROWSER_WHISPER_DECODING_MAX_WINDOW_SECONDS) {
      throw new RangeError(`Whisper decoder window duration must be positive and at most ${BROWSER_WHISPER_DECODING_MAX_WINDOW_SECONDS} seconds.`)
    }
    if (!Number.isInteger(options.maxNewTokens) || options.maxNewTokens <= 0) throw new RangeError("Whisper maxNewTokens must be a positive integer.")
    const contextTokens = contextPromptTokens(options.contextPrompt, tokenizer)
    const decoderPrefix = contextTokens.length ? [...contextTokens, ...initTokens] : initTokens
    const features = await processor(windowSamples)
    if (!features?.input_features) throw new Error("Whisper processor did not return input_features for the audio window.")
    const generationOptions: Record<string, unknown> = {
      inputs: features.input_features,
      language,
      task: BROWSER_WHISPER_DECODING_TASK,
      max_new_tokens: options.maxNewTokens,
      return_token_timestamps: false,
      return_timestamps: false,
      output_attentions: true,
      return_dict_in_generate: true,
    }
    if (contextTokens.length) generationOptions.decoder_input_ids = decoderPrefix
    const result = await model.generate(generationOptions)
    if (!result?.sequences) throw new Error("Whisper generation returned no sequences.")
    if (!Array.isArray(result.cross_attentions) || result.cross_attentions.length === 0) {
      throw new Error("Whisper generation returned no cross_attentions; word timestamps require output_attentions=true and a model exported with cross-attention outputs.")
    }
    const sequenceIds = sequenceTokenIds(result.sequences)
    const frameWidth = result.cross_attentions[0]?.[0]?.dims?.[3]
    if (!Number.isInteger(frameWidth) || (frameWidth as number) <= 0) throw new Error("Whisper cross-attention output has no valid encoder frame dimension.")
    const samplesPerEncoderFrame = hopLength * BROWSER_WHISPER_DECODING_ENCODER_DOWNSAMPLE_FACTOR
    const encoderFrameCount = Math.min(frameWidth as number, Math.max(1, Math.floor(windowSamples.length / samplesPerEncoderFrame)))
    const timestamps = extractWhisperTokenTimestamps({
      crossAttentions: result.cross_attentions,
      sequences: result.sequences,
      alignmentHeads: alignmentHeads as Array<readonly [number, number]>,
      encoderFrameCount,
      timePrecisionSeconds: precision,
      medianFilterWidth: typeof modelConfig.median_filter_width === "number" ? modelConfig.median_filter_width : undefined,
      previousContextTokenCount: contextTokens.length,
    })
    const tokenTimestamps = Array.from(timestamps.data as Float32Array)
    const contextCount = contextTokens.length
    const decodedIds = sequenceIds.slice(contextCount)
    const decodedTimestamps = tokenTimestamps.slice(contextCount)
    const [text, decoded] = tokenizer._decode_asr([{
      tokens: decodedIds,
      token_timestamps: decodedTimestamps,
      stride: [durationSeconds, 0, 0],
    }], {
      time_precision: precision,
      return_timestamps: "word",
      force_full_sequences: false,
    })
    onDiagnostic?.({
      window: options.window,
      audioDurationSeconds: durationSeconds,
      encoderFrameCount,
      decoderPrefixTokenIds: decoderPrefix,
      strippedContextTokenCount: contextCount,
      sequenceTokenIds: sequenceIds.map(Number),
      tokenTimestampsSeconds: tokenTimestamps,
    })
    const words = decoded.chunks ?? []
    const timedWords = words.flatMap((word) => {
      const [start, end] = word.timestamp
      if (!word.text.trim() || start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return []
      return [{ text: word.text, start_ms: pythonRound(start * 1000), end_ms: pythonRound(end * 1000) }]
    })
    if (text.trim() && !timedWords.length) throw new Error("Whisper generated nonempty text without any usable positive finite word timestamp bounds.")
    return timedWords
  }
}
