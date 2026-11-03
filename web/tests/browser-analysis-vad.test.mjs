import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import test from "node:test"

const decodedAudio = { samples: new Float32Array(16_000), sampleRate: 16_000 }
const replacements = new Map([
  ["./audio", "export const decodeMedia = async () => globalThis.__decodedAudio"],
  ["./modelStorage", "export const analysisModelSelections = () => []; export const analysisReprocessModelSelections = () => []; export const getModelFolderHandle = () => ({}); export const getModelReadiness = async () => ({ ready: true, message: '' })"],
])

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (replacements.has(specifier) && context.parentURL?.endsWith("/browser/analysis.ts")) {
      return { url: `data:text/javascript,${encodeURIComponent(replacements.get(specifier))}`, shortCircuit: true }
    }
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try { return nextResolve(`${specifier}.ts`, context) } catch {}
    }
    return nextResolve(specifier, context)
  },
})

globalThis.__decodedAudio = decodedAudio
const createdWorkers = []
let holdVad = false
let emitSpeech = true
let capturedSettings

class DeterministicWorker {
  constructor(url) {
    this.url = String(url)
    this.kind = this.url.includes("sileroVad.worker") ? "vad" : "asr"
    createdWorkers.push(this)
  }

  postMessage(message) {
    if (this.kind === "vad" && message.kind === "detect" && !holdVad) {
      queueMicrotask(() => this.onmessage?.({ data: {
        kind: "complete",
        probabilities: Float32Array.from({ length: 32 }, (_, index) => emitSpeech && index < 14 ? 0.9 : 0.01),
        chunkFrameCounts: [32],
      } }))
    } else if (this.kind === "vad" && message.kind === "cancel") {
      queueMicrotask(() => this.onmessage?.({ data: { kind: "cancelled" } }))
    } else if (this.kind === "asr" && message.kind === "start") {
      capturedSettings = message.settings
      queueMicrotask(() => this.onmessage?.({ data: { kind: "complete", result: {
        kind: "complete", record_id: message.settings.record_id, file_name: "clip.wav", nickname: "", model_name: "model",
        duration_ms: 1000, transcript: "", words: [], candidates: [], acoustic_units: false, phones: [],
        phone_alignments: [], hubert_embeddings: [], audio: decodedAudio, media_path: "media/clip.wav",
        video_width: null, video_height: null,
        inference_metadata: { precision: "baseline", asr_language: "en", asr_task: "transcribe", asr_models: [], alignment: {}, acoustic_units: {} },
      } } }))
    }
  }

  terminate() { this.terminated = true }
}

globalThis.Worker = DeterministicWorker
globalThis.window = { location: { origin: "http://localhost" }, setTimeout, clearTimeout }
globalThis.location = { search: "" }
globalThis.document = { createElement: () => ({ removeAttribute() {}, load() {} }) }

class MemoryFileHandle {
  constructor(name, value = new Blob()) { this.name = name; this.value = value; this.kind = "file" }
  async getFile() { return new File([this.value], this.name, { type: this.value.type }) }
  async createWritable() {
    return { write: async (value) => { this.value = value instanceof Blob ? value : new Blob([value]) }, close: async () => {}, abort: async () => {} }
  }
}

class MemoryDirectoryHandle {
  constructor(name = "workspace") { this.name = name; this.kind = "directory"; this.children = new Map() }
  async queryPermission() { return "granted" }
  async requestPermission() { return "granted" }
  async getDirectoryHandle(name, options = {}) {
    if (!this.children.has(name)) {
      if (!options.create) throw new DOMException("Missing directory", "NotFoundError")
      this.children.set(name, new MemoryDirectoryHandle(name))
    }
    return this.children.get(name)
  }
  async getFileHandle(name, options = {}) {
    if (!this.children.has(name)) {
      if (!options.create) throw new DOMException("Missing file", "NotFoundError")
      this.children.set(name, new MemoryFileHandle(name))
    }
    return this.children.get(name)
  }
  async *entries() { yield* this.children.entries() }
}

const root = new MemoryDirectoryHandle()
const marker = await root.getFileHandle("madnolia-browser.json", { create: true })
const markerWriter = await marker.createWritable()
await markerWriter.write(new Blob([JSON.stringify({ application: "madnolia-browser", schema_version: 1, created_at: "2026-01-01T00:00:00.000Z" })]))
await markerWriter.close()
const { restoreWorkspaceHandle, writeWorkspaceJson, writeWorkspaceFile, readWorkspaceJson } = await import("../src/browser/workspace.ts")
const { handleBrowserAnalysisRequest } = await import("../src/browser/analysis.ts")
const { BROWSER_ANALYSIS_RECORD_FILENAME } = await import("../src/browserConstants.ts")
await restoreWorkspaceHandle(root)
await writeWorkspaceJson("media/index.json", { "clip.wav": { path: "media/clip.wav", type: "audio/wav", size: 1 } })
await writeWorkspaceFile("media/clip.wav", new Blob(["audio"], { type: "audio/wav" }))

async function startJob() {
  const { BROWSER_ASR_DEFAULT_MODEL } = await import("../src/browserAnalysisConstants.ts")
  const response = await handleBrowserAnalysisRequest("/api/analyses", { method: "POST", body: JSON.stringify({
    filename: "clip.wav", nickname: "", model_name: BROWSER_ASR_DEFAULT_MODEL, backend: "transformers-js", device: "wasm",
    alignment_mode: "estimated", precision: "baseline", candidate_models: [], acoustic_units: false,
  }) })
  assert.equal(response.status, 200)
  return (await response.json()).job_id
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail("Timed out waiting for the analysis worker")
}

test("preparation completes Silero before ASR and saves its supplied regions", async () => {
  holdVad = false
  createdWorkers.length = 0
  capturedSettings = undefined
  const jobId = await startJob()
  await waitFor(() => createdWorkers.some((worker) => worker.kind === "asr"))
  assert.deepEqual(createdWorkers.map((worker) => worker.kind), ["vad", "asr"])
  assert.equal(capturedSettings.audio_regions[0].region_type, "SPEECH")
  assert.ok(capturedSettings.audio_regions.some((region) => region.region_type === "NON_SPEECH"))
  let completedJob
  await waitFor(async () => {
    const response = await handleBrowserAnalysisRequest(`/api/analysis-jobs/${jobId}`)
    completedJob = await response.json()
    return completedJob.status === "complete"
  })
  const record = await readWorkspaceJson(`analyses/${completedJob.analysis_id}/${BROWSER_ANALYSIS_RECORD_FILENAME}`)
  assert.deepEqual(record.overview.audio_regions, capturedSettings.audio_regions)
  assert.equal(record.overview.audio_regions[0].start_ms, 0)
})

test("stopping during Silero cancellation prevents ASR worker creation", async () => {
  holdVad = true
  createdWorkers.length = 0
  const jobId = await startJob()
  await waitFor(() => createdWorkers.some((worker) => worker.kind === "vad"))
  const response = await handleBrowserAnalysisRequest(`/api/analysis-jobs/${jobId}/stop`, { method: "POST" })
  assert.equal(response.status, 200)
  await waitFor(() => createdWorkers.find((worker) => worker.kind === "vad")?.terminated)
  assert.deepEqual(createdWorkers.map((worker) => worker.kind), ["vad"])
  const job = await handleBrowserAnalysisRequest(`/api/analysis-jobs/${jobId}`)
  assert.equal((await job.json()).status, "stopped")
})

test("a valid all non-speech Silero result stays non-speech", async () => {
  holdVad = false
  emitSpeech = false
  createdWorkers.length = 0
  capturedSettings = undefined
  const jobId = await startJob()
  await waitFor(() => capturedSettings !== undefined)
  assert.deepEqual(capturedSettings.audio_regions, [{ region_type: "NON_SPEECH", start_ms: 0, end_ms: 1000 }])
  let completedJob
  await waitFor(async () => {
    const response = await handleBrowserAnalysisRequest(`/api/analysis-jobs/${jobId}`)
    completedJob = await response.json()
    return completedJob.status === "complete"
  })
  const record = await readWorkspaceJson(`analyses/${completedJob.analysis_id}/${BROWSER_ANALYSIS_RECORD_FILENAME}`)
  assert.deepEqual(record.overview.audio_regions, capturedSettings.audio_regions)
})
