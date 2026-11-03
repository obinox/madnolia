export interface BrowserSpeechInterval {
  start_ms: number
  end_ms: number
  type: "speech" | "non_speech"
}

export interface BrowserSpeechSampleInterval {
  start: number
  end: number
}

export interface BrowserSpeechTimedInterval {
  start_ms: number
  end_ms: number
}

export interface BrowserSpeechWindow {
  start_ms: number
  end_ms: number
  keep_start_ms: number
  keep_end_ms: number
}

export interface BrowserSileroVadRequest {
  kind: "detect"
  samples: Float32Array
  modelUrl: string
}

export interface BrowserSileroVadCancel {
  kind: "cancel"
}

export interface BrowserSileroVadProgress {
  completedSamples: number
  totalSamples: number
}

export interface BrowserSileroVadCallbacks {
  signal?: AbortSignal
  onProgress?: (progress: BrowserSileroVadProgress) => void
}

export interface BrowserSileroVadOptions {
  threshold?: number
  negThreshold?: number
  minSpeechMs?: number
  minSilenceMs?: number
  maxSpeechSeconds?: number
  speechPadMs?: number
  mergeGapMs?: number
}

export interface BrowserSileroVadResponse {
  kind: "complete" | "failure" | "cancelled" | "progress"
  probabilities?: Float32Array
  chunkFrameCounts?: number[]
  completedSamples?: number
  totalSamples?: number
  message?: string
}
