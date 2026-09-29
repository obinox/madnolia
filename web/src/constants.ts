export const MIN_VIEW_DURATION_MS = 1_000
export const ANALYSIS_JOB_STORAGE_KEY = "madnolia.analysisJobId"
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
export const ANALYSIS_PROGRESS_ANIMATION_MIN_MS = 350
export const ANALYSIS_PROGRESS_ANIMATION_MAX_MS = 1800
export const ANALYSIS_PROGRESS_ANIMATION_PER_PERCENT_MS = 90
export const WORD_DETAIL_MAX_MS = 15 * 60 * 1_000
export const PHONE_DETAIL_MAX_MS = 2 * 60 * 1_000
export const WAVEFORM_BINS = 1_400
export const TIMELINE_HEIGHT = 190
export const TIMELINE_PADDING = 12
export const PLAYBACK_LOOP_EPSILON_MS = 10
export const EDITOR_SPLIT_X_DEFAULT_PERCENT = 50
export const EDITOR_SPLIT_Y_DEFAULT_PERCENT = 40
export const EDITOR_SPLIT_X_MIN_PERCENT = 25
export const EDITOR_SPLIT_X_MAX_PERCENT = 75
export const EDITOR_SPLIT_Y_MIN_PERCENT = 25
export const EDITOR_SPLIT_Y_MAX_PERCENT = 70
export const MIN_STRETCH_PERCENT = 100
export const MAX_STRETCH_PERCENT = 150
export const PROFESSIONAL_MIN_DURATION_PERCENT = 25
export const PROFESSIONAL_MAX_DURATION_PERCENT = 800
export const PROFESSIONAL_TIMELINE_PIXELS_PER_MS = 0.22
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
