export type AudioRegionType = "SPEECH" | "NON_SPEECH"
export type AlignmentMethod = "ESTIMATED_WORD" | "CTC_FORCED"
export type SelectionKind = "WORD" | "PHONE"

export interface ProjectSummary {
  project_id: string
  created_at: string
  model_name: string
  inference_backend: string
  inference_device: string
  source_count: number
  total_duration_ms: number
}

export interface MediaSource {
  source_id: string
  path: string
  duration_ms: number
  audio_sample_rate: number
  audio_channels: number
  video_width: number | null
  video_height: number | null
  video_fps: number | null
}

export interface ProjectManifest {
  project_id: string
  schema_version: string
  created_at: string
  model_name: string
  inference_backend: string
  inference_device: string
  language: string
  sources: MediaSource[]
  analysis_files: string[]
  database_file: string
}

export interface AudioRegion {
  region_type: AudioRegionType
  start_ms: number
  end_ms: number
}

export interface TranscriptWord {
  text: string
  start_ms: number
  end_ms: number
  confidence: number | null
}

export interface PhoneOccurrence {
  occurrence_id: string
  source_id: string
  word_index: number
  grapheme: string
  pronunciation: string
  phone_id: string
  ipa: string
  start_ms: number
  end_ms: number
  confidence: number | null
  alignment_method: AlignmentMethod
}

export interface AnalysisOverview {
  source_id: string
  transcript: string
  audio_regions: AudioRegion[]
  word_count: number
  phone_count: number
}

export interface ProjectDetail {
  manifest: ProjectManifest
  analyses: AnalysisOverview[]
}

export interface TimelineSlice {
  start_ms: number
  end_ms: number
  audio_regions: AudioRegion[]
  words: TranscriptWord[]
  phones: PhoneOccurrence[]
}

export interface WaveformData {
  start_ms: number
  end_ms: number
  peaks: number[]
}

export interface TimelineSelection {
  kind: SelectionKind
  label: string
  start_ms: number
  end_ms: number
  pronunciation: string | null
  phone_id: string | null
  alignment_method: AlignmentMethod | null
}

export interface TimelineProps {
  durationMs: number
  viewStartMs: number
  viewEndMs: number
  currentMs: number
  waveform: WaveformData | null
  timeline: TimelineSlice | null
  selection: TimelineSelection | null
  onSeek: (timeMs: number) => void
  onViewChange: (startMs: number, endMs: number) => void
  onSelect: (selection: TimelineSelection | null) => void
}
