export const MIN_VIEW_DURATION_MS = 1_000
export const ANALYSIS_JOB_STORAGE_KEY = "madnolia.analysisJobId"
export const ANALYSIS_MODEL_OPTIONS = ["large-v3", "large-v3-turbo", "small"] as const
export const ANALYSIS_NICKNAME_MAX_LENGTH = 80
export const DEFAULT_ANALYSIS_MODEL = "large-v3"
export const DEFAULT_ANALYSIS_BACKEND = "openvino"
export const DEFAULT_ANALYSIS_DEVICE = "GPU"
export const ANALYSIS_DEVICE_OPTIONS = {
  openvino: ["GPU", "CPU"],
  "faster-whisper": ["CUDA", "CPU"],
  vulkan: ["VULKAN"],
} as const
export const DEFAULT_ANALYSIS_ALIGNMENT = "ctc"
export const DEFAULT_ANALYSIS_ACOUSTIC_UNITS = true
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
export const MIN_STRETCH_PERCENT = 100
export const MAX_STRETCH_PERCENT = 150

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
