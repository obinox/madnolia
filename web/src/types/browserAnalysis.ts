import type { AnalysisPrecision, AnalysisSettings, BrowserAsrLanguage, BrowserAudioData, BrowserPronunciation, InputLanguage, PhoneAcousticFeatures, PhoneOccurrence } from "./index"
import type { Tensor } from "@huggingface/transformers"
import type { AudioRegion } from "./index"

export type BrowserInferenceDevice = "webgpu" | "wasm"
export type BrowserInferenceDType = "fp32" | "fp16" | "q8" | "q4" | "q4f16"

export interface BrowserAsrArtifactConfig {
  model_id: string
  revision: string | null
  dtype: Record<BrowserInferenceDevice, BrowserInferenceDType>
  subfolder?: string
  external_data_format?: Record<string, boolean | number>
}

export interface BrowserAsrModelConfig {
  id: string
  label: string
  size_label: string
  timestamps: "word"
  dtype: Record<BrowserInferenceDevice, BrowserInferenceDType>
  artifacts: Record<AnalysisPrecision, BrowserAsrArtifactConfig>
}

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
  record_id: string
  filename: string
  nickname: string
  model_name: string
  asr_diagnostics?: boolean
  asr_language?: BrowserAsrLanguage
  candidate_models: string[]
  acoustic_units: boolean
  alignment_mode: "estimated" | "ctc"
  precision: AnalysisPrecision
  video_width: number | null
  video_height: number | null
  device: BrowserInferenceDevice
  audio: BrowserAudioData
  audio_regions: AudioRegion[]
  workspace: FileSystemDirectoryHandle
  model_directory?: FileSystemDirectoryHandle | null
}

export interface BrowserAnalysisReprocessSettings {
  job_id: string
  record_id: string
  transcript: string
  words: BrowserAnalysisWord[]
  precision: AnalysisPrecision
  device: BrowserInferenceDevice
  acoustic_units: boolean
  audio: BrowserAudioData
  workspace: FileSystemDirectoryHandle
  model_directory?: FileSystemDirectoryHandle | null
}

export interface BrowserAnalysisReprocessResult {
  record_id: string
  phones: BrowserPronunciation[]
  phone_alignments: BrowserPhoneAlignment[]
  hubert_embeddings: number[][]
  inference: {
    precision: AnalysisPrecision
    alignment: BrowserInferenceModelMetadata
    acoustic_units: BrowserInferenceModelMetadata
  }
}

export interface BrowserInferenceModelMetadata {
  model_name: string
  model_revision: string | null
  dtype: BrowserInferenceDType
  device: BrowserInferenceDevice
  enabled: boolean
}

export interface BrowserInferenceMetadata {
  precision: AnalysisPrecision
  asr_language: BrowserAsrLanguage
  asr_task: "transcribe"
  asr_models: BrowserInferenceModelMetadata[]
  alignment: BrowserInferenceModelMetadata
  acoustic_units: BrowserInferenceModelMetadata
}

export type BrowserAnalysisWorkerRequest =
  | { kind: "start"; settings: BrowserAnalysisWorkerSettings }
  | { kind: "reprocess"; settings: BrowserAnalysisReprocessSettings }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "stop" }

export interface BrowserAnalysisWorkerProgress {
  kind: "progress"
  stage: string
  percent: number
  download_model: string | null
  download_percent: number | null
  completed_windows?: number
  total_windows?: number
  reused_windows?: number
}

export interface BrowserAnalysisWorkerEvent {
  kind: "progress" | "complete" | "reprocessed" | "failure"
  progress?: BrowserAnalysisWorkerProgress
  result?: BrowserAnalysisWorkerComplete
  reprocess_result?: BrowserAnalysisReprocessResult
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
  phone_alignments: BrowserPhoneAlignment[]
  hubert_embeddings: number[][]
  audio: BrowserAudioData
  media_path: string
  video_width: number | null
  video_height: number | null
  inference_metadata: BrowserInferenceMetadata
}

export interface BrowserPhoneAlignment {
  phone_index: number
  start_ms: number | null
  end_ms: number | null
  confidence: number
  status: "ALIGNED" | "LOW_CONFIDENCE" | "MISSING"
}

export interface BrowserCtcTensor {
  data: ArrayLike<number>
  dims: number[]
}

export interface BrowserCtcModel {
  (inputs: { input_values: Tensor; attention_mask: Tensor }): Promise<{ logits: BrowserCtcTensor }>
  dispose?: () => Promise<void>
}

export interface BrowserCtcWordBatch {
  phone_indices: number[]
  start_ms: number
  end_ms: number
}

export interface BrowserCtcTokenSpan {
  start: number
  end: number
  confidence: number
}

export interface BrowserHubertTensor {
  data: ArrayLike<number>
  dims: number[]
}

export interface BrowserHubertModel {
  (inputs: { input_values: Tensor }): Promise<{ last_hidden_state: BrowserHubertTensor }>
  dispose?: () => Promise<void>
}

export interface BrowserPhoneInterval {
  phone_index: number
  start_ms: number
  end_ms: number
}

export interface BrowserAcousticUnitCentroids {
  model_name: string
  model_revision: string
  dimensions: number
  cluster_count: number
  centroids: number[][]
}

export interface BrowserIndexedPronunciation {
  phone: BrowserPronunciation
  phone_index: number
}

export interface BrowserAnalysisModelTranscript {
  model_name: string
  model_revision: string | null
  model_dtype: BrowserInferenceDType
  inference_device: BrowserInferenceDevice
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

export interface BrowserAnalysisReprocessRequest {
  analysis_id: string
  precision: AnalysisPrecision
  device: BrowserInferenceDevice
  acoustic_units: boolean
}

export interface BrowserAnalysisReprocessJob {
  job_id: string
  analysis_id: string
  status: "running" | "complete" | "failed" | "stopped"
  stage: string
  percent: number
  error: string | null
}

export interface BrowserReprocessedPhones {
  phones: PhoneOccurrence[]
  acousticFeatures: PhoneAcousticFeatures[]
  centroids: number[][]
}

export interface BrowserReprocessTransactionJournal {
  transaction_id: string
  state: "applying" | "rollback-complete" | "committed"
  entries: Array<{ path: string; backup_path: string | null; delete_after?: boolean }>
}

export interface BrowserReprocessPublishUpdate {
  path: string
  data?: Blob
  delete_after?: boolean
  backup_archive_path?: string
}

export interface BrowserAnalysisActiveLease {
  job_id: string
  owner_id: string
  expires_at: number
}

export type BrowserAnalysisAction = "pause" | "resume" | "stop"

export type BrowserAnalysisSettings = AnalysisSettings & { input_language?: InputLanguage }
