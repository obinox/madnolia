import type { ReactNode } from "react"

import type {
  AnalysisOverview,
  AnalysisSummary,
  InputLanguage,
  MediaSource,
  PhoneAcousticFeatures,
  PhoneOccurrence,
  ProjectDetail,
  CandidatePhoneAlignment,
  ProjectIdResponse,
  SaveCompositionRequest,
} from "./index"

export interface BrowserAudioData {
  samples: Float32Array
  sampleRate: number
}

export interface BrowserAnalysisRecord {
  summary: AnalysisSummary
  source: MediaSource
  overview: AnalysisOverview
  phones: PhoneOccurrence[]
  acoustic_features: PhoneAcousticFeatures[]
  audio_path: string
  media_path: string
}

export interface BrowserProjectRecord {
  detail: ProjectDetail
  analysis_ids: string[]
}

export interface BrowserExportArtifact {
  blob: Blob
  filename: string
}

export interface BrowserPronunciation {
  grapheme: string
  phone_id: string
  ipa: string
  word_index: number
}

export interface BrowserSearchRequest {
  text: string
  max_candidates_per_start?: number
  input_language: InputLanguage
  include_exact: boolean
  include_approximate: boolean
}

export interface BrowserSearchProgress {
  stage: "exact" | "approximate" | "sorting"
  percent: number
}

export type BrowserSearchProgressCallback = (progress: BrowserSearchProgress) => void | Promise<void>

export interface BrowserSearchMatchPath {
  distance: number
  alignments: CandidatePhoneAlignment[]
  phones: PhoneOccurrence[]
}

export interface BrowserRankedSearchPath {
  path: BrowserSearchMatchPath
  similarity: number
}

export interface BrowserProjectCreateRequest {
  name: string
  analysis_ids: string[]
}

export type BrowserProjectCreateResponse = ProjectIdResponse

export interface BrowserVideoIndexEntry {
  path: string
  type: string
  size: number
}

export interface BrowserCompositionCreateBody {
  project_id: string
  composition: SaveCompositionRequest
}

export interface BrowserWorkspaceProps {
  children: ReactNode
}

export interface BrowserWorkspaceManifest {
  application: "madnolia-browser"
  schema_version: number
  created_at: string
}

export interface BrowserPermissionDirectoryHandle extends FileSystemDirectoryHandle {
  queryPermission(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>
  requestPermission(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>
}

export interface BrowserDirectoryPickerWindow extends Window {
  showDirectoryPicker(options?: { id?: string; mode?: "read" | "readwrite" }): Promise<BrowserPermissionDirectoryHandle>
}

export type BrowserGpuNavigator = Navigator

export interface BrowserWorkspaceModelSummary {
  name: string
  file_count: number
  size_bytes: number
}
