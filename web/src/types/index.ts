import type { PROFESSIONAL_BEAT_DIVISIONS } from "../constants"

export type ProfessionalBeatDivision = typeof PROFESSIONAL_BEAT_DIVISIONS[number]

export interface EnvelopeConstraintPoint {
  position: number
}

export interface JobIdResponse {
  job_id: string
}

export interface ProjectIdResponse {
  project_id: string
}

export type AudioRegionType = "SPEECH" | "NON_SPEECH"
export type AlignmentMethod = "ESTIMATED_WORD" | "CTC_FORCED"
export type AlignmentStatus = "ESTIMATED" | "ALIGNED" | "LOW_CONFIDENCE" | "MISSING"
export type SelectionKind = "WORD" | "PHONE"
export type MatchStatus = "EXACT" | "APPROXIMATE" | "MISSING"
export type CompositionMode = "SIMPLE" | "PROFESSIONAL"
export type InputLanguage = "AUTO" | "KO" | "EN" | "JA"
export type CandidateSearchTab = "EXACT" | "APPROXIMATE"
export type SynthesisWorkspace = "SEARCH" | "ASSEMBLY"
export type PhoneAlignmentOperation = "MATCH" | "SUBSTITUTE" | "INSERT" | "DELETE"
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

export interface CompositionDraft {
  schema_version: number
  project_id: string
  composition_id: string
  saved_at: string
  target_text: string
  target_pronunciation: string
  input_language: InputLanguage
  name: string
  crossfade_ms: number
  segments: TimelineSegment[]
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
  fallback: boolean
  alignments: CandidatePhoneAlignment[]
}

export interface CandidatePhoneAlignment {
  operation: PhoneAlignmentOperation
  target_index: number | null
  target_phone_id: string | null
  target_ipa: string | null
  source_occurrence_id: string | null
  source_phone_id: string | null
  source_ipa: string | null
  source_start_ms: number | null
  source_end_ms: number | null
  similarity: number
  source_f0_hz: number | null
  voiced_probability: number
}

export interface PhoneUnit {
  phone_unit_id: string
  operation: PhoneAlignmentOperation
  target_index: number | null
  target_phone_id: string | null
  target_ipa: string | null
  source_occurrence_id: string | null
  source_phone_id: string | null
  source_ipa: string | null
  source_start_ms: number | null
  source_end_ms: number | null
  output_duration_ms: number
  source_f0_hz: number | null
  voiced_probability: number
  target_pitch_midi: number | null
  formant_shift_semitones: number
  transition_to_next_ms: number
  transition_strength_percent: number
  transition_center_ms: number
}

export interface EditRegion {
  region_id: string
  source_start_ms: number
  source_end_ms: number
  output_duration_ms: number
  relative_pitch_cents: number
}

export interface VolumeEnvelopePoint {
  position: number
  gain: number
}

export interface PitchEnvelopePoint {
  position: number
  cents: number
}

export type ProfessionalLane = "pitch" | "volume"

export interface ProfessionalSelectedPoint {
  lane: ProfessionalLane
  segmentId: string
  index: number
  position?: number
}

export interface ProfessionalSourceRange {
  segmentId: string
  startMs: number
  endMs: number
}

export interface ProfessionalZoomAnchor {
  timeAtCursor: number
  cursorLocalX: number
}

export interface ProfessionalWaveformRequest {
  promise: Promise<number[]>
  controller: AbortController
}

export interface CandidateSearchResult {
  target_text: string
  target_pronunciation: string
  input_language: InputLanguage
  target_phones: QueryPhone[]
  candidates: UnitCandidate[]
  source_labels: Record<string, string>
}

export type SearchJobStatus = "running" | "complete" | "cancelled" | "failed"

export interface SearchJob {
  job_id: string
  project_id: string
  status: SearchJobStatus
  percent: number
  stage: string
  result: CandidateSearchResult | null
  error: string | null
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
  crossfade_ms?: number
  stretch_percent: number
  lane: number
  phone_units: PhoneUnit[]
  edit_regions: EditRegion[]
  volume_envelope: VolumeEnvelopePoint[]
  pitch_envelope?: PitchEnvelopePoint[]
  user_guide_source_ms?: number[]
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
  tempo_bpm?: number
  beats_per_bar?: number
  beat_division?: ProfessionalBeatDivision
  grid_offset_units?: number
  segments: TimelineSegment[]
  mode: CompositionMode
  schema_version: number
  parent_composition_id: string | null
  parent_composition_updated_at: string | null
}

export interface SaveCompositionRequest {
  name: string
  target_text: string
  target_pronunciation: string
  crossfade_ms: number
  tempo_bpm: number
  beats_per_bar: number
  beat_division: ProfessionalBeatDivision
  grid_offset_units?: number
  segments: TimelineSegment[]
  mode: CompositionMode
  schema_version: number
  parent_composition_id: string | null
  parent_composition_updated_at: string | null
}

export interface CollagePanelProps {
  projectId: string
  initialCompositionId?: string
  onPreview: (candidate: UnitCandidate) => void
  onPreparePreview: (candidate: UnitCandidate) => void
}

export interface ProfessionalEditorProps {
  projectId: string
  segments: TimelineSegment[]
  selectedSegmentId: string
  playheadMs: number
  tempoBpm: number
  beatsPerBar: number
  beatDivision: ProfessionalBeatDivision
  gridOffsetUnits: number
  onTempoChange: (tempo: number) => void
  onBeatsPerBarChange: (beats: number) => void
  onBeatDivisionChange: (division: ProfessionalBeatDivision) => void
  onGridOffsetChange: (offset: number) => void
  onSelectSegment: (segmentId: string) => void
  onPlayheadChange: (timeMs: number) => void
  onUpdatePhone: (segmentId: string, phoneUnitId: string, updates: Partial<PhoneUnit>) => void
  onUpdateRegion: (segmentId: string, regionId: string, updates: Partial<EditRegion>) => void
  onApplyRange: (segmentId: string, startMs: number, endMs: number, updates: Partial<EditRegion>) => void
  onApplyHandleDrag: (segment: TimelineSegment, nextStartMs: number, durations: number[]) => void
  onMoveTimelineSuffix: (segments: TimelineSegment[], segmentId: string, deltaMs: number) => void
  onBeginGesture: () => void
  onEndGesture: () => void
  onAddGuide: (segmentId: string, sourceMs: number) => void
  onRemoveGuide: (segmentId: string, regionId: string) => void
  onUpdateEnvelope: (segmentId: string, points: VolumeEnvelopePoint[]) => void
  onUpdatePitchEnvelope: (segmentId: string, points: PitchEnvelopePoint[]) => void
  onUpdateSegment: (segmentId: string, updates: Partial<TimelineSegment>) => void
  onReorderSegment: (segmentId: string, destinationId: string) => void
  onDeleteSegment: (segmentId: string) => void
  onChangeOrder: (segmentId: string, offset: number) => void
}

export interface ProfessionalPreviewIntent {
  timeMs: number
  autoplay: boolean
}

export type ProfessionalHandleMode = "normal" | "ctrl" | "shift"

export interface ProfessionalEditableState {
  name: string
  segments: TimelineSegment[]
  crossfadeMs: number
  tempoBpm: number
  beatsPerBar: number
  beatDivision: ProfessionalBeatDivision
  gridOffsetUnits: number
}

export interface ProfessionalHistoryState {
  present: ProfessionalEditableState
  past: ProfessionalEditableState[]
  future: ProfessionalEditableState[]
  gestureBaseline: ProfessionalEditableState | null
}

export type ProfessionalHistoryAction =
  | { type: "edit"; next: ProfessionalEditableState }
  | { type: "begin-gesture" }
  | { type: "end-gesture" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset"; next: ProfessionalEditableState }

export interface ProfessionalHandleResult {
  startMs: number
  durations: number[]
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
  backend: "openvino" | "faster-whisper" | "qwen3-asr"
  device: "GPU" | "CPU" | "CUDA" | "XPU"
  alignment_mode: "ctc" | "estimated"
  candidate_models: string[]
  acoustic_units: boolean
}

export interface DetectedAnalysisHardware {
  backend: AnalysisSettings["backend"]
  device: AnalysisSettings["device"]
  gpu_vendor: string | null
}

export interface VideoUploadResult {
  filename: string
}

export interface ApiErrorResponse {
  detail?: unknown
}

export type AnalysisAction = "pause" | "resume" | "stop"

export type WorkflowPage = "analysis" | "projects" | "collage" | "professional"

export interface ProfessionalSynthesisPageProps {
  projectId: string
  initialCompositionId?: string
}

export interface AnalysisPageProps {
  onGoToProjects: () => void
}

export interface ProjectsPageProps {
  projects: ProjectSummary[]
  onOpenProject: (projectId: string) => void
  onOpenCollage: (collageId: string) => void
  onProjectCreated: () => Promise<void>
}
