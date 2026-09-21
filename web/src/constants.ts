export const MIN_VIEW_DURATION_MS = 1_000
export const WORD_DETAIL_MAX_MS = 15 * 60 * 1_000
export const PHONE_DETAIL_MAX_MS = 2 * 60 * 1_000
export const WAVEFORM_BINS = 1_400
export const TIMELINE_HEIGHT = 190
export const TIMELINE_PADDING = 12

export const COLORS = {
  background: "#0d1117",
  grid: "#26303a",
  speech: "#27c499",
  nonSpeech: "#303943",
  waveform: "#65a9ff",
  word: "#a78bfa",
  phone: "#f59e63",
  phoneAlt: "#f8c267",
  playhead: "#ff5470",
  text: "#dfe8f1",
  mutedText: "#8091a3",
  selected: "#ffffff",
} as const
