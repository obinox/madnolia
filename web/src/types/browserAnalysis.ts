import type { AnalysisSettings, BrowserAudioData, BrowserPronunciation, InputLanguage } from "./index"

export type BrowserInferenceDevice = "webgpu" | "wasm"

export interface BrowserAnalysisChunk {
  text: string
  timestamp: [number | null, number | null]
}

export interface BrowserTimedAnalysisChunk {
  text: string
  timestamp: [number, number]
}

export interface BrowserAnalysisWorkerSettings {
  job_id: string
  filename: string
  nickname: string
  model_name: string
  candidate_models: string[]
  acoustic_units: boolean
  video_width: number | null
  video_height: number | null
  device: BrowserInferenceDevice
  audio: BrowserAudioData
  workspace: FileSystemDirectoryHandle
}

export type BrowserAnalysisWorkerRequest =
  | { kind: "start"; settings: BrowserAnalysisWorkerSettings }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "stop" }

export interface BrowserAnalysisWorkerProgress {
  kind: "progress"
  stage: string
  percent: number
  download_model: string | null
  download_percent: number | null
}

export interface BrowserAnalysisWorkerEvent {
  kind: "progress" | "complete" | "failure"
  progress?: BrowserAnalysisWorkerProgress
  result?: BrowserAnalysisWorkerComplete
  message?: string
}

export interface BrowserAnalysisNicknameRequest {
  nickname?: string
}

export interface BrowserAnalysisWorkerComplete {
  kind: "complete"
  record_id: string
  file_name: string
  nickname: string
  model_name: string
  duration_ms: number
  transcript: string
  words: BrowserAnalysisWord[]
  candidates: BrowserAnalysisModelTranscript[]
  acoustic_units: boolean
  phones: BrowserPronunciation[]
  audio: BrowserAudioData
  media_path: string
  video_width: number | null
  video_height: number | null
}

export interface BrowserAnalysisModelTranscript {
  model_name: string
  transcript: string
  words: BrowserAnalysisWord[]
}

export interface BrowserAnalysisWord {
  text: string
  start_ms: number
  end_ms: number
  confidence: number | null
}

export interface BrowserModelCacheItem {
  model_id: string
  label: string
  size_label: string
  file_count: number
  size_bytes: number
}

export interface BrowserModelCacheEntry {
  url: string
  path: string
  model_id: string
  size_bytes: number
  content_type: string
}

export interface BrowserAsrOutput {
  text?: string
  chunks?: Array<{ text: string; timestamp: [number | null, number | null] }>
}

export interface BrowserAsrProgressEvent {
  status?: string
  file?: string
  progress?: number
  name?: string
}

export type BrowserAsrPipeline = ((audio: Float32Array, options: Record<string, unknown>) => Promise<BrowserAsrOutput>) & { dispose?: () => Promise<void> }

export interface BrowserAnalysisResultMessage {
  kind: "result"
  result: BrowserAnalysisWorkerComplete
}

export interface BrowserAnalysisFailureMessage {
  kind: "failure"
  message: string
}

export interface BrowserAnalysisProgressMessage {
  kind: "progress"
  progress: BrowserAnalysisWorkerProgress
}

export interface BrowserAnalysisErrorResponse {
  detail: string
}

export type BrowserAnalysisAction = "pause" | "resume" | "stop"

export type BrowserAnalysisSettings = AnalysisSettings & { input_language?: InputLanguage }
