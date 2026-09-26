export type AudioRegionType = "SPEECH" | "NON_SPEECH"
export type AlignmentMethod = "ESTIMATED_WORD" | "CTC_FORCED"
export type AlignmentStatus = "ESTIMATED" | "ALIGNED" | "LOW_CONFIDENCE" | "MISSING"
export type SelectionKind = "WORD" | "PHONE"
export type MatchStatus = "EXACT" | "APPROXIMATE" | "MISSING"
export type UnitType = "WORD" | "SYLLABLE" | "PHONEME" | "PHONE_SEQUENCE"
export type ExportTarget = "JSON" | "WAV" | "MP4" | "EDL" | "FCPXML"

export interface ProjectSummary {
  project_id: string
  name: string
  created_at: string
  model_name: string
  inference_backend: string
  inference_device: string
  alignment_mode?: "estimated" | "ctc"
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
  name: string
  analysis_ids: string[]
  source_analyses: Record<string, string>
  created_at: string
  model_name: string
  inference_backend: string
  inference_device: string
  sources: MediaSource[]
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

export interface TranscriptCandidate {
  candidate_id: string
  model_name: string
  transcript: string
  language_probability: number | null
  words: TranscriptWord[]
  sentences: TranscriptSentence[]
}

export interface TranscriptSentence {
  sentence_index: number
  text: string
  start_ms: number
  end_ms: number
  word_start_index: number
  word_end_index: number
}

export interface PhoneOccurrence {
  occurrence_id: string
  source_id: string
  sentence_index: number
  word_index: number
  grapheme: string
  pronunciation: string
  phone_id: string
  ipa: string
  start_ms: number
  end_ms: number
  confidence: number | null
  alignment_method: AlignmentMethod
  alignment_status: AlignmentStatus
}

export interface PhoneAcousticFeatures {
  occurrence_id: string
  rms_db: number
  peak_db: number
  f0_hz: number | null
  voiced_probability: number
  acoustic_unit_id: number | null
}

export interface AnalysisOverview {
  source_id: string
  transcript: string
  audio_regions: AudioRegion[]
  sentences: TranscriptSentence[]
  words: TranscriptWord[]
  transcript_candidates: TranscriptCandidate[]
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
  acoustic_features: PhoneAcousticFeatures[]
}

export interface WaveformData {
  start_ms: number
  end_ms: number
  peaks: number[]
}

export interface PhoneCache {
  sourceId: string
  startMs: number
  endMs: number
  phones: PhoneOccurrence[]
  acousticFeatures: PhoneAcousticFeatures[]
}

export interface TimelineSelection {
  occurrence_id: string | null
  kind: SelectionKind
  label: string
  start_ms: number
  end_ms: number
  pronunciation: string | null
  phone_id: string | null
  alignment_method: AlignmentMethod | null
  alignment_status: AlignmentStatus | null
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

export interface QueryPhone {
  target_index: number
  grapheme: string
  phone_id: string
  ipa: string
  exact_available: boolean
}

export interface UnitCandidate {
  candidate_id: string
  target_start_index: number
  target_end_index: number
  target_ipa: string[]
  matched_ipa: string[]
  occurrence_ids: string[]
  source_id: string
  source_start_ms: number
  source_end_ms: number
  unit_type: UnitType
  match_status: MatchStatus
  similarity: number
  score: number
}

export interface CandidateSearchResult {
  target_text: string
  target_pronunciation: string
  target_phones: QueryPhone[]
  candidates: UnitCandidate[]
  source_labels: Record<string, string>
}

export interface TimelineSegment {
  segment_id: string
  candidate_id: string
  target_start_index: number
  target_end_index: number
  source_id: string
  source_start_ms: number
  source_end_ms: number
  timeline_start_ms: number
  timeline_end_ms: number
  match_status: MatchStatus
  target_ipa: string[]
  matched_ipa: string[]
  gap_before_ms: number
  stretch_percent: number
}

export interface CompositionProject {
  composition_id: string
  corpus_project_id: string
  name: string
  target_text: string
  target_pronunciation: string
  created_at: string
  updated_at: string
  crossfade_ms: number
  segments: TimelineSegment[]
}

export interface SaveCompositionRequest {
  name: string
  target_text: string
  target_pronunciation: string
  crossfade_ms: number
  segments: TimelineSegment[]
}

export interface CollagePanelProps {
  projectId: string
  initialCompositionId?: string
  onPreview: (candidate: UnitCandidate) => void
}

export interface AnalysisSummary {
  analysis_id: string
  created_at: string
  model_name: string
  nickname: string | null
  source: MediaSource
}

export interface AnalysisJob {
  job_id: string
  status: "running" | "pausing" | "paused" | "stopping" | "stopped" | "complete" | "failed"
  filename: string
  percent: number
  stage: string
  analysis_id: string | null
  error: string | null
  download_model: string | null
  download_percent: number | null
}

export interface AnalysisSettings {
  filename: string
  nickname: string
  model_name: string
  backend: "openvino" | "faster-whisper" | "vulkan"
  device: "GPU" | "CPU" | "CUDA" | "VULKAN"
  alignment_mode: "ctc" | "estimated"
  candidate_models: string[]
  acoustic_units: boolean
}

export interface DetectedAnalysisHardware {
  backend: AnalysisSettings["backend"]
  device: AnalysisSettings["device"]
  gpu_vendor: string | null
}

export type AnalysisAction = "pause" | "resume" | "stop"

export type WorkflowPage = "analysis" | "projects" | "collage"

export interface AnalysisPageProps {
  onGoToProjects: () => void
}

export interface ProjectsPageProps {
  projects: ProjectSummary[]
  onOpenProject: (projectId: string) => void
  onOpenCollage: (collageId: string) => void
  onProjectCreated: () => Promise<void>
}
