import assert from "node:assert/strict"
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

const { transcribeAsrWindows } = await import("../src/browser/asrWindowTranscription.ts")

const speech = (start_ms, end_ms) => ({ type: "speech", start_ms, end_ms })
const word = (text, start_ms, end_ms) => ({ text, start_ms, end_ms })

test("decodes overlapping speech windows with context and midpoint ownership", async () => {
  const samples = new Float32Array(65_000 * 16)
  const calls = []
  const boundaries = []
  const progress = []
  const result = await transcribeAsrWindows(samples, [speech(0, 65_000)], async (audio, options) => {
    calls.push({ audioLength: audio.length, ...options })
    if (calls.length === 1) return [word("prior", 27_100, 27_300), word("edge", 27_400, 27_600)]
    if (calls.length === 2) return [word("edge", 2_400, 2_600), word("next", 24_600, 24_800)]
    return [word("last", 2_600, 2_800)]
  }, { onBoundary: (item) => boundaries.push(item), onProgress: (item) => progress.push(item) })

  assert.deepEqual(calls.map(({ audioLength }) => audioLength), [480_000, 480_000, 240_000])
  assert.deepEqual(calls.map(({ contextPrompt }) => contextPrompt), ["", "prior", "prior edge next"])
  assert.deepEqual(calls.map(({ maxNewTokens }) => maxNewTokens), [300, 300, 150])
  assert.deepEqual(result.map(({ text }) => text), ["prior", "edge", "next", "last"])
  assert.deepEqual(boundaries.map(({ index, total }) => [index, total]), [[1, 3], [2, 3], [3, 3]])
  assert.deepEqual(progress.map(({ completed, total }) => [completed, total]), [[1, 3], [2, 3], [3, 3]])
})

test("clears context after a long silence between speech regions", async () => {
  const prompts = []
  await transcribeAsrWindows(new Float32Array(40_000 * 16), [speech(0, 1000), speech(30_000, 40_000)], async (_audio, options) => {
    prompts.push(options.contextPrompt)
    return [word("word", 100, 300)]
  })
  assert.deepEqual(prompts, ["", ""])
})

test("rejects repeated decoded words with the policy error", async () => {
  const repeated = Array.from({ length: 8 }, () => word("same", 100, 200))
  await assert.rejects(
    transcribeAsrWindows(new Float32Array(1000 * 16), [speech(0, 1000)], async () => repeated),
    /repeated transcription detected/u,
  )
})

test("does not call decoder or callbacks when no speech windows exist", async () => {
  let calls = 0
  await transcribeAsrWindows(new Float32Array(1000 * 16), [{ type: "non_speech", start_ms: 0, end_ms: 1000 }], async () => {
    calls += 1
    return []
  }, { onBoundary: () => { calls += 1 }, onProgress: () => { calls += 1 } })
  assert.equal(calls, 0)
})

test("cancellation during asynchronous decode rejects without returning partial words", async () => {
  const controller = new AbortController()
  let resolveDecode
  let signalDecodeStarted
  const decodeStarted = new Promise((resolve) => { signalDecodeStarted = resolve })
  const decoding = transcribeAsrWindows(new Float32Array(40_000 * 16), [speech(0, 40_000)], () => new Promise((resolve) => {
    resolveDecode = resolve
    signalDecodeStarted()
  }), { signal: controller.signal })
  await decodeStarted
  controller.abort()
  resolveDecode([word("partial", 100, 200)])
  await assert.rejects(decoding, { name: "AbortError" })
})

test("awaits asynchronous window boundaries before decoding", async () => {
  const events = []
  await transcribeAsrWindows(new Float32Array(1000 * 16), [speech(0, 1000)], async () => {
    events.push("decode")
    return [word("word", 100, 300)]
  }, {
    onBoundary: async () => {
      await Promise.resolve()
      events.push("boundary")
    },
  })
  assert.deepEqual(events, ["boundary", "decode"])
})

test("cancellation after decode prevents merging and progress callbacks", async () => {
  const controller = new AbortController()
  let progressCalls = 0
  await assert.rejects(transcribeAsrWindows(new Float32Array(1000 * 16), [speech(0, 1000)], async () => {
    controller.abort()
    return [word("word", 100, 300)]
  }, { signal: controller.signal, onProgress: () => { progressCalls += 1 } }), { name: "AbortError" })
  assert.equal(progressCalls, 0)
})

test("recomputing an earlier window rejects cached windows whose context chain is stale", async () => {
  const samples = new Float32Array(65_000 * 16)
  const cached = new Map()
  await transcribeAsrWindows(samples, [speech(0, 65_000)], async (_audio, options) => [word(options.window.start_ms ? "later" : "original", 100, 300)], {
    saveCheckpoint: async (index, _window, words, contextHash) => cached.set(index, { words, contextHash }),
  })
  const calls = []
  await transcribeAsrWindows(samples, [speech(0, 65_000)], async (_audio, options) => {
    calls.push(options.window.start_ms)
    return [word(options.window.start_ms ? `new-${options.window.start_ms}` : "changed", 100, 300)]
  }, {
    loadCheckpoint: async (index, _window, contextHash) => index > 0 && cached.get(index)?.contextHash === contextHash ? cached.get(index).words : null,
    saveCheckpoint: async (index, _window, words, contextHash) => cached.set(index, { words, contextHash }),
  })
  assert.deepEqual(calls, [0, 25_000, 50_000])
})

test("awaits durable checkpoint commit before decoding the following window", async () => {
  const events = []
  let releaseSave
  const saveStarted = new Promise((resolve) => { releaseSave = resolve })
  const saving = new Promise((resolve) => { globalThis.finishSave = resolve })
  const run = transcribeAsrWindows(new Float32Array(40_000 * 16), [speech(0, 40_000)], async (_audio, options) => {
    events.push(`decode-${options.window.start_ms}`)
    return [word("word", 100, 200)]
  }, {
    saveCheckpoint: async (_index, window) => {
      events.push(`save-${window.start_ms}`)
      releaseSave()
      await saving
      events.push(`commit-${window.start_ms}`)
    },
  })
  await saveStarted
  assert.deepEqual(events, ["decode-0", "save-0"])
  globalThis.finishSave()
  await run
  delete globalThis.finishSave
  assert.ok(events.indexOf("commit-0") < events.indexOf("decode-25000"))
})

test("cancellation prevents writing newly decoded words", async () => {
  const controller = new AbortController()
  let saves = 0
  await assert.rejects(transcribeAsrWindows(new Float32Array(40_000 * 16), [speech(0, 40_000)], async () => {
    controller.abort()
    return [word("partial", 100, 200)]
  }, { signal: controller.signal, saveCheckpoint: async () => { saves += 1 } }), { name: "AbortError" })
  assert.equal(saves, 0)
})
