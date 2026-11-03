import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { registerHooks } from "node:module"
import test from "node:test"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/iu.test(specifier)) {
      try { return nextResolve(`${specifier}.ts`, context) } catch {}
    }
    return nextResolve(specifier, context)
  },
})

const { detectSileroSpeech, intervalsFromChunkProbabilities, intervalsFromSileroProbabilities, speechTimestampsFromProbabilities, completeSpeechIntervals, speechWindows } = await import("../src/browser/sileroVad.ts")
const fixture = JSON.parse(await readFile(new URL("./fixtures/silero-vad-reference.json", import.meta.url), "utf8"))

test("Silero timestamp logic matches faster-whisper reference probabilities for silence, tone, and real JFK speech", () => {
  assert.equal(fixture.model, "Silero VAD v6 / faster-whisper 1.2.1")
  assert.equal(fixture.sample_rate, 16000)
  for (const sample of fixture.cases) {
    assert.deepEqual(speechTimestampsFromProbabilities(sample.probabilities, sample.audio_length_samples), sample.speech_samples, sample.name)
  }
  const speech = fixture.cases.find((sample) => sample.name === "jfk_english_speech")
  assert.ok(speech.speech_samples.length > 0)
  assert.deepEqual(intervalsFromSileroProbabilities(speech.probabilities, speech.audio_length_samples), [
    { type: "non_speech", start_ms: 0, end_ms: 120 },
    { type: "speech", start_ms: 120, end_ms: 2440 },
    { type: "non_speech", start_ms: 2440, end_ms: 3128 },
    { type: "speech", start_ms: 3128, end_ms: 4552 },
    { type: "non_speech", start_ms: 4552, end_ms: 5240 },
    { type: "speech", start_ms: 5240, end_ms: 11000 },
  ])
})

test("30s blocks match independent faster-whisper references with per-block recurrent resets", () => {
  const reference = fixture.chunk_reset_case
  assert.equal(reference.name, "jfk_restarted_at_30s_boundary")
  const probabilities = new Float32Array(reference.chunks.flatMap((chunk) => chunk.probabilities))
  const frameCounts = reference.chunks.map((chunk) => chunk.probabilities.length)
  assert.deepEqual(reference.chunks.map((chunk) => chunk.probabilities.length), reference.chunks.map((chunk) => Math.floor(chunk.audio_length_samples / 512) + 1))
  assert.deepEqual(intervalsFromChunkProbabilities(probabilities, frameCounts, reference.audio_length_samples), referenceExpectedIntervals(reference))
  assert.ok(reference.chunks[0].speech_samples.length > 0)
  assert.ok(reference.chunks[1].speech_samples.length > 0)
})

function referenceExpectedIntervals(reference) {
  const speech = []
  let offsetSamples = 0
  for (const chunk of reference.chunks) {
    for (const interval of chunk.speech_samples) {
      speech.push({
        start_ms: Math.round((offsetSamples + interval.start) * 1000 / fixture.sample_rate),
        end_ms: Math.round((offsetSamples + interval.end) * 1000 / fixture.sample_rate),
      })
    }
    offsetSamples += chunk.audio_length_samples
  }
  return completeSpeechIntervals(Math.round(reference.audio_length_samples * 1000 / fixture.sample_rate), speech)
}

test("abort waits for worker session release before termination and preserves caller samples", async () => {
  const originalWorker = globalThis.Worker
  const events = []
  let workerInstance
  globalThis.Worker = class {
    constructor() { workerInstance = this }
    postMessage(message) {
      if (message.kind === "detect") queueMicrotask(() => this.onmessage({ data: { kind: "progress", completedSamples: 1, totalSamples: message.samples.length } }))
      if (message.kind === "cancel") queueMicrotask(() => {
        events.push("session-released")
        this.onmessage({ data: { kind: "cancelled" } })
      })
    }
    terminate() { events.push("worker-terminated") }
  }
  const samples = new Float32Array([0.25, -0.5, 0.75])
  const originalSamples = samples.slice()
  const controller = new AbortController()
  let progress
  try {
    const pending = detectSileroSpeech(samples, {}, { signal: controller.signal, onProgress: (value) => { progress = value } })
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort()
    await assert.rejects(pending, { name: "AbortError" })
    assert.deepEqual(progress, { completedSamples: 1, totalSamples: samples.length })
    assert.deepEqual(samples, originalSamples)
    assert.deepEqual(events, ["session-released", "worker-terminated"])
    assert.ok(workerInstance)
  } finally {
    globalThis.Worker = originalWorker
  }
})

test("short speech is filtered, 500ms silence closes speech, and padding follows reference sample boundaries", () => {
  const probabilities = new Float32Array(30).fill(0.01)
  probabilities.fill(0.9, 0, 8)
  assert.deepEqual(speechTimestampsFromProbabilities(probabilities, 30 * 512), [{ start: 0, end: 7296 }])
  assert.deepEqual(speechTimestampsFromProbabilities(probabilities, 30 * 512, { minSpeechMs: 256 }), [])
  const tooShort = new Float32Array(40).fill(0.01)
  tooShort.fill(0.9, 0, 8)
  tooShort.fill(0.01, 8, 40)
  assert.deepEqual(speechTimestampsFromProbabilities(tooShort, 40 * 512, { minSpeechMs: 300 }), [])
})

test("speech gaps merge through 400ms and completed output covers the full recording", () => {
  assert.deepEqual(completeSpeechIntervals(2200, [
    { start_ms: 100, end_ms: 500 },
    { start_ms: 900, end_ms: 1200 },
    { start_ms: 1701, end_ms: 2000 },
  ]), [
    { type: "non_speech", start_ms: 0, end_ms: 100 },
    { type: "speech", start_ms: 100, end_ms: 1200 },
    { type: "non_speech", start_ms: 1200, end_ms: 1701 },
    { type: "speech", start_ms: 1701, end_ms: 2000 },
    { type: "non_speech", start_ms: 2000, end_ms: 2200 },
  ])
})

test("long continuous speech remains one original large-model region", () => {
  const probabilities = new Float32Array(90 * 16000 / 512).fill(0.95)
  assert.deepEqual(speechTimestampsFromProbabilities(probabilities, 90 * 16000), [{ start: 0, end: 90 * 16000 }])
})

test("maximum speech duration splits at an aggressive boundary and pads the shared seam", () => {
  const probabilities = new Float32Array(61).fill(0.9)
  assert.deepEqual(speechTimestampsFromProbabilities(probabilities, 60 * 512, { maxSpeechSeconds: 1.5 }), [
    { start: 0, end: 17664 },
    { start: 17664, end: 30720 },
  ])
})

test("speech chunks use original 30s windows, 5s overlap, and midpoint keep ranges", () => {
  assert.deepEqual(speechWindows([
    { type: "non_speech", start_ms: 0, end_ms: 1000 },
    { type: "speech", start_ms: 1000, end_ms: 66000 },
  ]), [
    { start_ms: 1000, end_ms: 31000, keep_start_ms: 1000, keep_end_ms: 28500 },
    { start_ms: 26000, end_ms: 56000, keep_start_ms: 28500, keep_end_ms: 53500 },
    { start_ms: 51000, end_ms: 66000, keep_start_ms: 53500, keep_end_ms: 66000 },
  ])
})
