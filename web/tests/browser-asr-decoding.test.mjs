import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { registerHooks } from "node:module"
import test from "node:test"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try { return nextResolve(`${specifier}.ts`, context) } catch {}
    }
    return nextResolve(specifier, context)
  },
})

const oracle = JSON.parse(await readFile(new URL("./fixtures/asr-decoding-python-oracle.json", import.meta.url), "utf8"))
const {
  asrContextPrompt,
  asrMaxNewTokens,
  asrSpeechWindows,
  hasRepeatedAsrTranscription,
  mergeAsrWindowWords,
} = await import("../src/browser/asrDecoding.ts")

test("matches the pinned Python context and token policy oracle", () => {
  const words = oracle.context.words.map((text, index) => ({ text, start_ms: index * 10, end_ms: index * 10 + 1, confidence: null }))
  assert.equal(asrContextPrompt(words, words.at(-1).end_ms + oracle.context.at_gap_ms), oracle.context.expected_at_gap)
  assert.equal(asrContextPrompt(words, words.at(-1).end_ms + oracle.context.beyond_gap_ms), oracle.context.expected_beyond_gap)
  for (const item of oracle.tokens) assert.equal(asrMaxNewTokens(item.duration_seconds), item.expected)
})

test("matches exact-case repeated transcription thresholds from the pinned Python oracle", () => {
  for (const item of oracle.repetition) {
    assert.equal(hasRepeatedAsrTranscription(item.texts.map((text) => ({ text }))), item.expected)
  }
})

test("merges offsets using midpoint ownership, speech bounds, and finite timestamps", () => {
  const makeWords = (items) => items.map((word) => ({
    ...word,
    start_ms: typeof word.start_ms === "string" ? Number(word.start_ms) : word.start_ms,
    end_ms: typeof word.end_ms === "string" ? Number(word.end_ms) : word.end_ms,
  }))
  assert.deepEqual(
    mergeAsrWindowWords(makeWords(oracle.merge.words), oracle.merge.window, oracle.merge.speech_regions),
    oracle.merge.expected,
  )
  assert.deepEqual(
    mergeAsrWindowWords(makeWords(oracle.end_clip.words), oracle.end_clip.window, oracle.end_clip.speech_regions),
    oracle.end_clip.expected,
  )
})

test("uses shared VAD windows with the original 30 second and 5 second policy", () => {
  const windows = asrSpeechWindows([{ type: "speech", start_ms: 0, end_ms: 65_000 }])
  assert.deepEqual(windows, [
    { start_ms: 0, end_ms: 30_000, keep_start_ms: 0, keep_end_ms: 27_500 },
    { start_ms: 25_000, end_ms: 55_000, keep_start_ms: 27_500, keep_end_ms: 52_500 },
    { start_ms: 50_000, end_ms: 65_000, keep_start_ms: 52_500, keep_end_ms: 65_000 },
  ])
})
