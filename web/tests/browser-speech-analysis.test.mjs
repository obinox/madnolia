import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import test from "node:test"

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    try { return nextResolve(`${specifier}.ts`, context) } catch {}
  }
  return nextResolve(specifier, context)
} })

const { buildBrowserSentences, classifyBrowserAudio } = await import("../src/browser/speechAnalysis.ts")

test("speech sentences split at punctuation and long word gaps", () => {
  const words = [
    { text: "Hello.", start_ms: 0, end_ms: 250, confidence: null },
    { text: "There", start_ms: 300, end_ms: 500, confidence: null },
    { text: "again", start_ms: 1800, end_ms: 2100, confidence: null },
  ]
  assert.deepEqual(buildBrowserSentences(words, "" ).map((item) => [item.text, item.word_start_index, item.word_end_index]), [
    ["Hello.", 0, 1], ["There", 1, 2], ["again", 2, 3],
  ])
})

test("audio energy separates silence from a sustained tone", () => {
  const sampleRate = 16000
  const samples = new Float32Array(sampleRate)
  for (let i = 3200; i < 11200; i += 1) samples[i] = Math.sin(2 * Math.PI * 220 * i / sampleRate) * 0.2
  const regions = classifyBrowserAudio(samples, sampleRate, 1000)
  assert.deepEqual(regions.map((item) => item.region_type), ["NON_SPEECH", "SPEECH", "NON_SPEECH"])
})
