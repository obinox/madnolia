export const MIN_VIEW_DURATION_MS = 1_000
export const ANALYSIS_JOB_STORAGE_KEY = "madnolia.analysisJobId"
export const GLOBAL_TASK_DEFAULT_STAGE = "처리 중"
export const GLOBAL_TASK_CANCEL_PENDING_STAGE = "중단 요청 처리 중"
export const GLOBAL_TASK_PERCENT_MIN = 0
export const GLOBAL_TASK_PERCENT_MAX = 100
export const ANALYSIS_MODEL_DOWNLOAD_STAGE = "모델 다운로드"
export const SEARCH_STAGE_LABELS: Record<string, string> = {
  corpus: "코퍼스 확인 중",
  phonetic: "발음 정보 준비 중",
  exact: "정확 검색 중",
  approximate: "유사 검색 중",
  sorting: "결과 정렬 중",
}
export const ANALYSIS_MODEL_OPTIONS = ["large-v3", "large-v3-turbo", "small"] as const
export const QWEN_ASR_MODEL_OPTIONS = ["qwen3-asr-0.6b", "qwen3-asr-1.7b"] as const
export const ANALYSIS_NICKNAME_MAX_LENGTH = 80
export const DEFAULT_ANALYSIS_MODEL = "large-v3"
export const DEFAULT_ANALYSIS_BACKEND = "openvino"
export const DEFAULT_ANALYSIS_DEVICE = "GPU"
export const FALLBACK_ANALYSIS_BACKEND = "faster-whisper"
export const FALLBACK_ANALYSIS_DEVICE = "CPU"
export const ANALYSIS_DEVICE_OPTIONS = {
  openvino: ["GPU", "CPU"],
  "faster-whisper": ["CUDA", "CPU"],
  "qwen3-asr": ["CPU", "XPU", "CUDA"],
} as const
export const DEFAULT_ANALYSIS_ALIGNMENT = "ctc"
export const DEFAULT_ANALYSIS_ACOUSTIC_UNITS = true
export const VIDEO_UPLOAD_ACCEPT = ".mp4,.mov,.mkv,.avi,.webm,.m4v,.mts,.m2ts"
export const ANALYSIS_PROGRESS_POLL_MS = 900
export const EXPORT_PROGRESS_POLL_MS = 500
export const REMOTE_TASK_STORAGE_KEY = "madnolia.remoteTask"
export const REMOTE_SEARCH_RESULT_STORAGE_PREFIX = "madnolia.remoteSearchResult."
export const REMOTE_TASK_SCHEMA_VERSION = 1
export const REMOTE_TASK_RETRY_MS = 1_500
export const ANALYSIS_PROGRESS_ANIMATION_MIN_MS = 350
export const ANALYSIS_PROGRESS_ANIMATION_MAX_MS = 1800
export const ANALYSIS_PROGRESS_ANIMATION_PER_PERCENT_MS = 90
export const WORD_DETAIL_MAX_MS = 15 * 60 * 1_000
export const PHONE_DETAIL_MAX_MS = 2 * 60 * 1_000
export const WAVEFORM_BINS = 1_400
export const EXACT_SEARCH_CANDIDATES_PER_PHONE = 40
export const APPROXIMATE_SEARCH_CANDIDATES_PER_PHONE = 8
export const SOURCE_TIMELINE_FETCH_DEBOUNCE_MS = 900
export const TIMELINE_HEIGHT = 140
export const TIMELINE_PADDING = 12
export const PLAYBACK_LOOP_EPSILON_MS = 10
export const COMPOSITION_DRAFT_STORAGE_PREFIX = "madnolia.compositionDraft."
export const COMPOSITION_DRAFT_SCHEMA_VERSION = 1
export const PROFESSIONAL_DRAFT_STORAGE_PREFIX = "madnolia.professionalDraft."
export const PROFESSIONAL_DRAFT_SCHEMA_VERSION = 1
export const PROFESSIONAL_DRAFT_ACTIVE_PREFIX = "madnolia.professionalDraftActive."
export const MIN_STRETCH_PERCENT = 100
export const MAX_STRETCH_PERCENT = 150
export const PROFESSIONAL_MIN_DURATION_PERCENT = 1
export const PROFESSIONAL_MAX_DURATION_PERCENT = 3200
export const PROFESSIONAL_PITCH_MIN_CENTS = -2400
export const PROFESSIONAL_PITCH_MAX_CENTS = 2400
export const PROFESSIONAL_PITCH_DISPLAY_RANGES_CENTS = [50, 100, 200, 500, 1000, 2400] as const
export const PROFESSIONAL_PITCH_DISPLAY_RANGE_DEFAULT_CENTS = 100
export const PROFESSIONAL_GAIN_MAX = 2
export const PROFESSIONAL_GAIN_MIN = 0
export const PROFESSIONAL_GAIN_DEFAULT = 1
export const PROFESSIONAL_ENVELOPE_POSITION_MIN = 0
export const PROFESSIONAL_ENVELOPE_POSITION_MAX = 1
export const PROFESSIONAL_ENVELOPE_POSITION_EPSILON = 2.220446049250313e-16
export const PROFESSIONAL_COMPOSITION_SCHEMA_VERSION = 3
export const PROFESSIONAL_STEP_TIMING = "timing"
export const PROFESSIONAL_STEP_CORRECTION = "correction"
export const PROFESSIONAL_AUTOTUNE_STRENGTH_DEFAULT_PERCENT = 100
export const PROFESSIONAL_AUTOTUNE_SPEED_DEFAULT_MS = 50
export const DEFAULT_CROSSFADE_MS = 8
export const MAX_CROSSFADE_MS = 100
export const PROFESSIONAL_ENVELOPE_DEFAULT = [
  { position: PROFESSIONAL_ENVELOPE_POSITION_MIN, gain: PROFESSIONAL_GAIN_DEFAULT },
  { position: PROFESSIONAL_ENVELOPE_POSITION_MAX, gain: PROFESSIONAL_GAIN_DEFAULT },
]
export const PROFESSIONAL_DEFAULT_VOICED_DURATION_MS = 120
export const PROFESSIONAL_DEFAULT_UNVOICED_DURATION_MS = 75
export const PROFESSIONAL_DEFAULT_MISSING_DURATION_MS = 90
export const PROFESSIONAL_TIMELINE_PIXELS_PER_MS = 0.22
export const PROFESSIONAL_TIMELINE_LABEL_WIDTH = 96
export const PROFESSIONAL_LANE_ROW_HEIGHT = 96
export const PROFESSIONAL_AUDIO_LANE_TOP_PADDING = 28
export const PROFESSIONAL_WAVEFORM_COLUMN_COUNT = 400
export const PROFESSIONAL_WAVEFORM_VIEW_WIDTH = 1000
export const PROFESSIONAL_WAVEFORM_VIEW_HEIGHT = 100
export const PROFESSIONAL_WAVEFORM_CENTER_Y = 50
export const PROFESSIONAL_WAVEFORM_AMPLITUDE = 44
export const PROFESSIONAL_EDITOR_INITIAL_SCALE = 0.12
export const PROFESSIONAL_EDITOR_MIN_SCALE = 0.025
export const PROFESSIONAL_EDITOR_MAX_SCALE = 1.5
export const PROFESSIONAL_CURVE_VERTICAL_INSET = 8
export const PROFESSIONAL_CURVE_POINT_MIN_GAP_PX = 14
export const PROFESSIONAL_RANGE_DRAG_THRESHOLD_PX = 2
export const PROFESSIONAL_EDGE_HANDLE_WIDTH_PX = 8
export const PROFESSIONAL_MINIMUM_VISUAL_TIMELINE_WIDTH = 1000
export const PROFESSIONAL_TIMELINE_TAIL_WIDTH = 80
export const PROFESSIONAL_TEMPO_DEFAULT_BPM = 120
export const PROFESSIONAL_TEMPO_MIN_BPM = 20
export const PROFESSIONAL_TEMPO_MAX_BPM = 400
export const PROFESSIONAL_BEATS_PER_BAR_DEFAULT = 4
export const PROFESSIONAL_BEATS_PER_BAR_MIN = 1
export const PROFESSIONAL_BEATS_PER_BAR_MAX = 16
export const PROFESSIONAL_BEAT_DIVISION_DEFAULT = 4
export const PROFESSIONAL_BEAT_DIVISIONS = [4, 8, 16, 24, 32, 48, 64, 96] as const
export const PROFESSIONAL_GRID_OFFSET_UNITS_DEFAULT = 0
export const PROFESSIONAL_GRID_BACKGROUND_IMAGE = "linear-gradient(to right, #ffda63 3px, transparent 3px), linear-gradient(to right, #c4d2e0 2px, transparent 2px), linear-gradient(to right, #9aadc1 1.5px, transparent 1.5px), linear-gradient(to right, #8296aa 1px, transparent 1px)"
export const PIANO_ROLL_GRID_BACKGROUND_IMAGE = "linear-gradient(to right, #ffda63 3px, transparent 3px), linear-gradient(to right, #68a9ff 2px, transparent 2px), linear-gradient(to right, #b58cff 1.5px, transparent 1.5px), linear-gradient(to right, #8296aa 1px, transparent 1px)"
export const PIANO_ROLL_SEGMENT_COLORS = ["hsl(0 62% 38%)", "hsl(180 63% 34%)", "hsl(40 68% 36%)", "hsl(220 62% 40%)", "hsl(80 55% 34%)", "hsl(260 58% 40%)", "hsl(140 55% 32%)", "hsl(300 62% 38%)"] as const
export const PROFESSIONAL_HISTORY_LIMIT = 100
export const PROFESSIONAL_PIANO_ROLL_HEIGHT = 360
export const PITCH_MIN_MIDI = 24
export const PITCH_MAX_MIDI = 108
export const FORMANT_SHIFT_MIN_SEMITONES = -12
export const FORMANT_SHIFT_MAX_SEMITONES = 12
export const PITCH_TRANSITION_DEFAULT_MS = 80
export const PITCH_TRANSITION_MAX_MS = 500
export const PITCH_TRANSITION_DEFAULT_STRENGTH = 100
export const PITCH_TRANSITION_CENTER_MIN_MS = -250
export const PITCH_TRANSITION_CENTER_MAX_MS = 250
export const PITCH_TARGET_STRENGTH_DEFAULT_PERCENT = 100
export const PITCH_VIBRATO_DEPTH_DEFAULT_CENTS = 0
export const PITCH_VIBRATO_DEPTH_MAX_CENTS = 200
export const PITCH_VIBRATO_RATE_DEFAULT_HZ = 5
export const PITCH_VIBRATO_START_DEFAULT_MS = 0
export const PIANO_ROLL_TIME_ZOOM_DEFAULT = 1
export const PIANO_ROLL_TIME_ZOOM_MIN = 1
export const PIANO_ROLL_TIME_ZOOM_MAX = 8
export const PIANO_ROLL_SEMITONE_HEIGHT_DEFAULT = 16
export const PIANO_ROLL_SEMITONE_HEIGHT_MIN = 7
export const PIANO_ROLL_SEMITONE_HEIGHT_MAX = 28
export const PIANO_ROLL_KEYBOARD_WIDTH = 60
export const PIANO_ROLL_PHONE_CONTIGUITY_TOLERANCE_MS = 2
export const PIANO_ROLL_BLACK_KEY_PITCH_CLASSES = [1, 3, 6, 8, 10] as const
export const PIANO_ROLL_VOLUME_HEIGHT = 174
export const PIANO_ROLL_ANALYSIS_DEBOUNCE_MS = 350
export const PIANO_ROLL_UNPITCHED_LANE_HEIGHT = 30
export const PIANO_ROLL_SELECTED_PHONE_SEPARATOR = ":"
export const PIANO_ROLL_NOTE_MIN_DURATION_MS = 20
export const PIANO_ROLL_PITCH_POINT_MIN_GAP = 0.01
export const PIANO_ROLL_SELECTION_DRAG_THRESHOLD_PX = 4
export const REGION_PITCH_MERGE_GAP_POSITION = 0.000001
export const PIANO_ROLL_VOLUME_MIN_LANE_HEIGHT = 24
export const PIANO_ROLL_SEMITONE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"] as const
export const COLLAGE_EXPORT_TARGETS = ["WAV", "MP4", "JSON", "EDL", "FCPXML"] as const

export const COLORS = {
  background: "#0d1117",
  grid: "#26303a",
  speech: "#27c499",
  nonSpeech: "#303943",
  waveform: "#65a9ff",
  word: "#a78bfa",
  phone: "#f59e63",
  phoneAlt: "#f8c267",
  phoneLowConfidence: "#ff7b72",
  phoneMissing: "#8b2635",
  playhead: "#ff5470",
  text: "#dfe8f1",
  mutedText: "#8091a3",
  selected: "#ffffff",
} as const
