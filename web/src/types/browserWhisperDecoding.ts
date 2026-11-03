import type { Tensor } from "@huggingface/transformers"
import type { BrowserAsrRawWord } from "./browserAsrDecoding"
import type { BrowserSpeechWindow } from "./browserSpeech"

export type BrowserWhisperTokenId = number | bigint

export interface BrowserWhisperSequenceTensor {
  dims: number[]
  tolist(): unknown
}

export interface BrowserWhisperTokenizer {
  model: { tokens_to_ids: Map<string, number> }
  bos_token_id?: number | null
  eos_token_id?: number | null
  encode(text: string, options: { add_special_tokens: boolean }): number[]
  _decode_asr(
    chunks: Array<{ tokens: BrowserWhisperTokenId[]; token_timestamps: number[]; stride: [number, number, number] }>,
    options: { time_precision: number; return_timestamps: "word"; force_full_sequences: false },
  ): [string, { chunks?: Array<{ text: string; timestamp: [number | null, number | null] }> }]
}

export interface BrowserWhisperProcessor {
  (audio: Float32Array): Promise<{ input_features: Tensor }>
  feature_extractor: { config: Record<string, unknown> }
}

export interface BrowserWhisperModel {
  config: Record<string, unknown>
  generation_config: Record<string, unknown>
  _retrieve_init_tokens?: (generationConfig: Record<string, unknown>) => number[]
  generate(options: Record<string, unknown>): Promise<{
    sequences: Tensor
    cross_attentions?: Tensor[][]
  }>
}

export interface BrowserWhisperDecodingDiagnostic {
  window: BrowserSpeechWindow
  audioDurationSeconds: number
  encoderFrameCount: number
  decoderPrefixTokenIds: number[]
  strippedContextTokenCount: number
  sequenceTokenIds: number[]
  tokenTimestampsSeconds: number[]
}

export interface BrowserWhisperWindowDecoderOptions {
  model: BrowserWhisperModel
  tokenizer: BrowserWhisperTokenizer
  processor: BrowserWhisperProcessor
  language: string
  onDiagnostic?: (diagnostic: BrowserWhisperDecodingDiagnostic) => void
}

export type BrowserWhisperDecodedWords = BrowserAsrRawWord[]
