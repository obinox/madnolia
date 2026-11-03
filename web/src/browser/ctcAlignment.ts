import { AutoModelForCTC, Tensor } from "@huggingface/transformers"
import type { BrowserAnalysisWord, BrowserCtcModel, BrowserCtcTensor, BrowserCtcTokenSpan, BrowserCtcWordBatch, BrowserPhoneAlignment } from "../types/browserAnalysis"
import type { AnalysisPrecision, BrowserPronunciation, TranscriptSentence } from "../types"
import {
  BROWSER_ASR_SAMPLE_RATE,
  BROWSER_CTC_CHUNK_MS,
  BROWSER_CTC_IPA_ALIASES,
  BROWSER_CTC_LOW_CONFIDENCE_THRESHOLD,
  BROWSER_CTC_MIN_INPUT_SAMPLES,
  BROWSER_CTC_MODEL,
  BROWSER_CTC_PADDING_MS,
  BROWSER_CTC_REVISION,
  BROWSER_CTC_VOCAB_URL,
} from "../browserAnalysisConstants"
import { createWorkspaceModelCache } from "./modelCache"

const tokenizeIpa = (ipa: string, vocab: Record<string, number>): string[] => {
  const alias = BROWSER_CTC_IPA_ALIASES[ipa]
  if (alias && alias.every((token) => token in vocab)) return [...alias]
  if (ipa in vocab) return [ipa]
  const normalized = [...ipa].filter((character) => !/\p{M}/u.test(character)).join("")
  const aspirated = normalized.replaceAll("ʰ", "h")
  for (const value of [aspirated, normalized]) {
    if (value in vocab) return [value]
    const tokens = longestTokens(value, vocab)
    if (tokens.length) return tokens
  }
  return []
}

const longestTokens = (value: string, vocab: Record<string, number>): string[] => {
  const candidates = Object.keys(vocab).filter((token) => !token.startsWith("<") && token !== "|").sort((left, right) => right.length - left.length)
  const tokens: string[] = []
  let cursor = 0
  while (cursor < value.length) {
    const token = candidates.find((candidate) => value.startsWith(candidate, cursor))
    if (!token) return []
    tokens.push(token)
    cursor += token.length
  }
  return tokens
}

const batchesForPhones = (words: BrowserAnalysisWord[], phones: BrowserPronunciation[], sentences: TranscriptSentence[]): BrowserCtcWordBatch[] => {
  const byWord = new Map<number, number[]>()
  phones.forEach((phone, phoneIndex) => byWord.set(phone.word_index, [...(byWord.get(phone.word_index) ?? []), phoneIndex]))
  const batches: BrowserCtcWordBatch[] = []
  for (const sentence of sentences) {
    let start = sentence.word_start_index
    while (start < sentence.word_end_index) {
      let end = start + 1
      while (end < sentence.word_end_index && words[end].end_ms - words[start].start_ms <= BROWSER_CTC_CHUNK_MS) end += 1
      const phoneIndices = Array.from({ length: end - start }, (_, offset) => byWord.get(start + offset) ?? []).flat()
      if (phoneIndices.length) {
        batches.push({
          phone_indices: phoneIndices,
          start_ms: Math.max(0, words[start].start_ms - BROWSER_CTC_PADDING_MS),
          end_ms: words[end - 1].end_ms + BROWSER_CTC_PADDING_MS,
        })
      }
      start = end
    }
  }
  return batches
}

const logProbabilities = (logits: BrowserCtcTensor): Float32Array => {
  const [frameCount, vocabularySize] = logits.dims.slice(-2)
  if (!frameCount || !vocabularySize) throw new Error("CTC model returned empty logits.")
  const output = new Float32Array(frameCount * vocabularySize)
  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = frame * vocabularySize
    let maximum = -Infinity
    for (let token = 0; token < vocabularySize; token += 1) maximum = Math.max(maximum, logits.data[offset + token])
    let sum = 0
    for (let token = 0; token < vocabularySize; token += 1) sum += Math.exp(logits.data[offset + token] - maximum)
    const normalizer = maximum + Math.log(sum)
    for (let token = 0; token < vocabularySize; token += 1) output[offset + token] = logits.data[offset + token] - normalizer
  }
  return output
}

const tokenSpans = (probabilities: Float32Array, frameCount: number, vocabularySize: number, tokenIds: number[], blankId: number): BrowserCtcTokenSpan[] | null => {
  const stateCount = tokenIds.length * 2 + 1
  if (!frameCount || stateCount > frameCount * 2 + 1) return null
  const scores = new Float32Array(frameCount * stateCount).fill(-Infinity)
  const back = new Int32Array(frameCount * stateCount).fill(-1)
  scores[0] = probabilities[blankId]
  if (tokenIds.length) scores[1] = probabilities[tokenIds[0]]
  for (let frame = 1; frame < frameCount; frame += 1) {
    const rowOffset = frame * stateCount
    const previousOffset = (frame - 1) * stateCount
    const probabilityOffset = frame * vocabularySize
    for (let state = 0; state < stateCount; state += 1) {
      const tokenId = state % 2 === 0 ? blankId : tokenIds[(state - 1) >> 1]
      let previousState = state
      let best = scores[previousOffset + state]
      if (state > 0 && scores[previousOffset + state - 1] > best) {
        previousState = state - 1
        best = scores[previousOffset + state - 1]
      }
      if (state > 1 && state % 2 === 1) {
        const tokenIndex = (state - 1) >> 1
        if (tokenIds[tokenIndex] !== tokenIds[tokenIndex - 1] && scores[previousOffset + state - 2] > best) {
          previousState = state - 2
          best = scores[previousOffset + state - 2]
        }
      }
      scores[rowOffset + state] = best + probabilities[probabilityOffset + tokenId]
      back[rowOffset + state] = previousState
    }
  }
  let state = stateCount - 1
  if (scores[(frameCount - 1) * stateCount + state - 1] > scores[(frameCount - 1) * stateCount + state]) state -= 1
  if (!Number.isFinite(scores[(frameCount - 1) * stateCount + state])) return null
  const states = new Int32Array(frameCount)
  states[frameCount - 1] = state
  for (let frame = frameCount - 1; frame > 0; frame -= 1) {
    state = back[frame * stateCount + state]
    if (state < 0) return null
    states[frame - 1] = state
  }
  const spans: BrowserCtcTokenSpan[] = []
  for (let tokenIndex = 0; tokenIndex < tokenIds.length; tokenIndex += 1) {
    const tokenState = tokenIndex * 2 + 1
    let start = -1
    let end = -1
    let score = 0
    let count = 0
    for (let frame = 0; frame < frameCount; frame += 1) {
      if (states[frame] !== tokenState) continue
      if (start < 0) start = frame
      end = frame + 1
      score += probabilities[frame * vocabularySize + tokenIds[tokenIndex]]
      count += 1
    }
    if (start < 0) return null
    spans.push({ start, end, confidence: Math.exp(score / count) })
  }
  return spans
}

export async function alignBrowserPhones(
  samples: Float32Array,
  words: BrowserAnalysisWord[],
  phones: BrowserPronunciation[],
  sentences: TranscriptSentence[],
  device: "webgpu" | "wasm",
  precision: AnalysisPrecision,
  workspace: FileSystemDirectoryHandle,
  modelDirectory: FileSystemDirectoryHandle | null | undefined,
  checkpoint: () => Promise<void>,
  progress: (percent: number) => void,
): Promise<BrowserPhoneAlignment[]> {
  const missing = phones.map((_, phone_index): BrowserPhoneAlignment => ({ phone_index, start_ms: null, end_ms: null, confidence: 0, status: "MISSING" }))
  if (!phones.length || !words.length) return missing
  const cache = createWorkspaceModelCache(workspace, modelDirectory)
  const request = new Request(BROWSER_CTC_VOCAB_URL)
  let vocabularyResponse = await cache.match(request)
  if (!vocabularyResponse) {
    vocabularyResponse = await fetch(request)
    if (!vocabularyResponse.ok) throw new Error(`Unable to download the CTC vocabulary (${vocabularyResponse.status}).`)
    await cache.put(request, vocabularyResponse.clone())
  }
  const vocab = await vocabularyResponse.json() as Record<string, number>
  const blankId = vocab["<pad>"]
  if (!Number.isInteger(blankId)) throw new Error("The CTC vocabulary does not contain its blank token.")
  const model = await AutoModelForCTC.from_pretrained(BROWSER_CTC_MODEL, {
    revision: BROWSER_CTC_REVISION,
    device,
    dtype: precision === "baseline" ? "fp32" : device === "webgpu" ? "fp16" : "q4",
    progress_callback: (event: { status?: string; progress?: number }) => {
      if (event.status === "progress") progress(event.progress ?? 0)
    },
  }) as unknown as BrowserCtcModel
  try {
    const batches = batchesForPhones(words, phones, sentences)
    for (const [batchIndex, batch] of batches.entries()) {
      await checkpoint()
      const phoneTokens = batch.phone_indices.map((index) => tokenizeIpa(phones[index].ipa, vocab))
      if (phoneTokens.some((tokens) => !tokens.length)) continue
      const tokenIds = phoneTokens.flatMap((tokens) => tokens.map((token) => vocab[token]))
      const localStart = Math.floor(batch.start_ms * BROWSER_ASR_SAMPLE_RATE / 1000)
      const localEnd = Math.min(samples.length, Math.ceil(batch.end_ms * BROWSER_ASR_SAMPLE_RATE / 1000))
      if (localEnd <= localStart) continue
      let waveform = samples.slice(localStart, localEnd)
      let mean = 0
      for (const value of waveform) mean += value
      mean /= Math.max(1, waveform.length)
      let variance = 0
      for (const value of waveform) variance += (value - mean) ** 2
      const deviation = Math.sqrt(variance / Math.max(1, waveform.length) + 1e-7)
      waveform = Float32Array.from(waveform, (value) => (value - mean) / deviation)
      if (waveform.length < BROWSER_CTC_MIN_INPUT_SAMPLES) {
        const padded = new Float32Array(BROWSER_CTC_MIN_INPUT_SAMPLES)
        padded.set(waveform)
        waveform = padded
      }
      const inputValues = new Tensor("float32", waveform, [1, waveform.length])
      const attentionMask = new Tensor("int64", new BigInt64Array(waveform.length).fill(1n), [1, waveform.length])
      const result = await model({ input_values: inputValues, attention_mask: attentionMask })
      await checkpoint()
      const [frameCount, vocabularySize] = result.logits.dims.slice(-2)
      const probabilities = logProbabilities(result.logits)
      const spans = tokenSpans(probabilities, frameCount, vocabularySize, tokenIds, blankId)
      if (!spans) continue
      const frameMs = waveform.length * 1000 / BROWSER_ASR_SAMPLE_RATE / frameCount
      let tokenCursor = 0
      for (const [batchPhoneIndex, phoneIndex] of batch.phone_indices.entries()) {
        const tokenCount = phoneTokens[batchPhoneIndex].length
        const phoneSpans = spans.slice(tokenCursor, tokenCursor + tokenCount)
        tokenCursor += tokenCount
        if (!phoneSpans.length || phoneSpans.length !== tokenCount) continue
        const startMs = batch.start_ms + phoneSpans[0].start * frameMs
        const endMs = batch.start_ms + phoneSpans.at(-1)!.end * frameMs
        const confidence = phoneSpans.reduce((sum, span) => sum + span.confidence, 0) / phoneSpans.length
        const durationMs = samples.length * 1000 / BROWSER_ASR_SAMPLE_RATE
        if (startMs >= durationMs || endMs <= startMs) continue
        const boundedStart = Math.max(0, Math.min(durationMs - 1, Math.round(startMs)))
        missing[phoneIndex] = {
          phone_index: phoneIndex,
          start_ms: boundedStart,
          end_ms: Math.min(Math.round(durationMs), Math.max(boundedStart + 1, Math.round(endMs))),
          confidence,
          status: confidence >= BROWSER_CTC_LOW_CONFIDENCE_THRESHOLD ? "ALIGNED" : "LOW_CONFIDENCE",
        }
      }
      progress((batchIndex + 1) * 100 / batches.length)
    }
  } finally {
    await model.dispose?.()
  }
  return missing
}
