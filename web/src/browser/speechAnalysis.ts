import type { AudioRegion, TranscriptSentence, TranscriptWord } from "../types"
import {
  BROWSER_ANALYSIS_SENTENCE_GAP_MS,
  BROWSER_ANALYSIS_VAD_FRAME_MS,
  BROWSER_ANALYSIS_VAD_MIN_RMS,
  BROWSER_ANALYSIS_VAD_MIN_SPEECH_MS,
  BROWSER_ANALYSIS_VAD_PADDING_MS,
} from "../browserAnalysisConstants"

export function buildBrowserSentences(words: TranscriptWord[], transcript: string): TranscriptSentence[] {
  const groups: TranscriptWord[][] = []
  for (const word of words) {
    const group = groups.at(-1)
    const gap = group ? word.start_ms - group.at(-1)!.end_ms : 0
    if (!group || gap > BROWSER_ANALYSIS_SENTENCE_GAP_MS || /[.!?。！？]$/u.test(group.at(-1)!.text)) groups.push([word])
    else group.push(word)
  }
  if (!groups.length && transcript.trim()) return [{ sentence_index: 0, text: transcript.trim(), start_ms: 0, end_ms: 0, word_start_index: 0, word_end_index: 0 }]
  let offset = 0
  return groups.map((group, sentence_index) => {
    const word_start_index = offset
    offset += group.length
    return { sentence_index, text: group.map((word) => word.text).join(" "), start_ms: group[0].start_ms, end_ms: group.at(-1)!.end_ms, word_start_index, word_end_index: offset }
  })
}

export function classifyBrowserAudio(samples: Float32Array, sampleRate: number, durationMs: number): AudioRegion[] {
  const frameSamples = Math.max(1, Math.round(sampleRate * BROWSER_ANALYSIS_VAD_FRAME_MS / 1000))
  const frameCount = Math.ceil(samples.length / frameSamples)
  const energies = Array.from({ length: frameCount }, (_, frame) => {
    const start = frame * frameSamples
    const end = Math.min(samples.length, start + frameSamples)
    let sum = 0
    for (let index = start; index < end; index += 1) sum += samples[index] ** 2
    return Math.sqrt(sum / Math.max(1, end - start))
  })
  const rawActive = energies.map((energy) => energy >= BROWSER_ANALYSIS_VAD_MIN_RMS)
  const padding = Math.ceil(BROWSER_ANALYSIS_VAD_PADDING_MS / BROWSER_ANALYSIS_VAD_FRAME_MS)
  const active = rawActive.map((_, index) => rawActive.slice(Math.max(0, index - padding), index + padding + 1).some(Boolean))
  const regions: AudioRegion[] = []
  for (let start = 0; start < active.length;) {
    let end = start + 1
    while (end < active.length && active[end] === active[start]) end += 1
    const start_ms = start * BROWSER_ANALYSIS_VAD_FRAME_MS
    const end_ms = Math.min(durationMs, end * BROWSER_ANALYSIS_VAD_FRAME_MS)
    const speech = active[start] && end_ms - start_ms >= BROWSER_ANALYSIS_VAD_MIN_SPEECH_MS
    const region_type = speech ? "SPEECH" : "NON_SPEECH"
    const previous = regions.at(-1)
    if (previous?.region_type === region_type) previous.end_ms = end_ms
    else regions.push({ region_type, start_ms: previous?.end_ms ?? start_ms, end_ms })
    start = end
  }
  return regions
}
