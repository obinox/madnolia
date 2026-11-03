import type { BrowserAsrAcceptedWord, BrowserAsrRawWord } from "./browserAsrDecoding"
import type { BrowserSpeechInterval, BrowserSpeechWindow } from "./browserSpeech"

export interface BrowserAsrWindowDecodeOptions {
  contextPrompt: string
  maxNewTokens: number
  window: BrowserSpeechWindow
}

export type BrowserAsrWindowDecoder = (
  windowSamples: Float32Array,
  options: BrowserAsrWindowDecodeOptions,
) => Promise<BrowserAsrRawWord[]>

export interface BrowserAsrWindowBoundary {
  window: BrowserSpeechWindow
  index: number
  total: number
}

export interface BrowserAsrWindowProgress extends BrowserAsrWindowBoundary {
  completed: number
  reused: number
}

export interface BrowserAsrWindowCheckpoint {
  version: number
  identity: string
  context_hash: string
  window: BrowserSpeechWindow
  words: BrowserAsrRawWord[]
}

export interface BrowserAsrWindowCallbacks {
  signal?: AbortSignal
  onBoundary?: (boundary: BrowserAsrWindowBoundary) => Promise<void> | void
  onProgress?: (progress: BrowserAsrWindowProgress) => Promise<void> | void
  loadCheckpoint?: (index: number, window: BrowserSpeechWindow, contextHash: string) => Promise<BrowserAsrRawWord[] | null>
  saveCheckpoint?: (index: number, window: BrowserSpeechWindow, words: BrowserAsrRawWord[], contextHash: string) => Promise<void>
}

export type BrowserAsrWindowTranscription = (samples: Float32Array, regions: BrowserSpeechInterval[], decode: BrowserAsrWindowDecoder, callbacks?: BrowserAsrWindowCallbacks) => Promise<BrowserAsrAcceptedWord[]>
