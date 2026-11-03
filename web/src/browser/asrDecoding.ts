import type { BrowserSpeechInterval, BrowserSpeechWindow } from "../types/browserSpeech"
import type { BrowserAsrAcceptedWord, BrowserAsrRawWord } from "../types/browserAsrDecoding"
import { BROWSER_SPEECH_CONTEXT_MAX_GAP_MS, BROWSER_SPEECH_CONTEXT_WORDS } from "../browserSpeechConstants"
import {
  BROWSER_ASR_MAX_NEW_TOKENS,
  BROWSER_ASR_MIN_NEW_TOKENS,
  BROWSER_ASR_NEW_TOKENS_PER_SECOND,
  BROWSER_ASR_REPEATED_WORD_MIN_COUNT,
  BROWSER_ASR_REPEATED_WORD_RATIO,
} from "../browserAsrDecodingConstants"
import { speechWindows } from "./sileroVad"

export function asrSpeechWindows(intervals: BrowserSpeechInterval[]): BrowserSpeechWindow[] {
  return speechWindows(intervals)
}

export function asrContextPrompt(words: BrowserAsrAcceptedWord[], chunkStartMs: number): string {
  const lastWord = words.at(-1)
  if (!lastWord || chunkStartMs - lastWord.end_ms > BROWSER_SPEECH_CONTEXT_MAX_GAP_MS) return ""
  return words.slice(-BROWSER_SPEECH_CONTEXT_WORDS).map((word) => word.text).join(" ")
}

export function pythonRound(value: number): number {
  const floor = Math.floor(value)
  const fraction = value - floor
  if (fraction === 0.5) return floor % 2 === 0 ? floor : floor + 1
  return Math.round(value)
}

export function asrMaxNewTokens(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) throw new RangeError("ASR duration must be a finite nonnegative number.")
  return Math.min(
    BROWSER_ASR_MAX_NEW_TOKENS,
    Math.max(BROWSER_ASR_MIN_NEW_TOKENS, pythonRound(durationSeconds * BROWSER_ASR_NEW_TOKENS_PER_SECOND)),
  )
}

export function hasRepeatedAsrTranscription(words: BrowserAsrRawWord[]): boolean {
  const texts = words.map((word) => word.text.trim()).filter(Boolean)
  if (texts.length < BROWSER_ASR_REPEATED_WORD_MIN_COUNT) return false
  const counts = new Map<string, number>()
  for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1)
  return Math.max(...counts.values()) / texts.length >= BROWSER_ASR_REPEATED_WORD_RATIO
}

function pointInSpeech(timeMs: number, regions: BrowserSpeechInterval[]): boolean {
  return regions.some((region) => region.type === "speech" && region.start_ms <= timeMs && timeMs < region.end_ms)
}

export function mergeAsrWindowWords(
  words: BrowserAsrRawWord[],
  window: BrowserSpeechWindow,
  speechRegions: BrowserSpeechInterval[],
): BrowserAsrAcceptedWord[] {
  const accepted: BrowserAsrAcceptedWord[] = []
  for (const word of words) {
    const text = word.text.trim()
    if (!text || !Number.isFinite(word.start_ms) || !Number.isFinite(word.end_ms)) continue
    const startMs = window.start_ms + word.start_ms
    const endMs = Math.min(window.end_ms, window.start_ms + word.end_ms)
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue
    const midpoint = Math.floor((startMs + endMs) / 2)
    if (
      window.keep_start_ms <= midpoint && midpoint < window.keep_end_ms &&
      pointInSpeech(midpoint, speechRegions)
    ) {
      accepted.push({ text, start_ms: startMs, end_ms: endMs, confidence: null })
    }
  }
  return accepted
}
