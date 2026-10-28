import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import test from "node:test"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("worker.js?worker&url")) return { url: "data:text/javascript,export%20default%20%27worker.js%27", shortCircuit: true }
    if (specifier === "@ffmpeg/ffmpeg") return { url: "data:text/javascript,export%20class%20FFmpeg%20%7B%20async%20load()%20%7B%7D%20terminate()%20%7B%7D%20%7D", shortCircuit: true }
    if (specifier.endsWith("?url")) return { url: "data:text/javascript,export%20default%20''", shortCircuit: true }
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try { return nextResolve(`${specifier}.ts`, context) } catch {}
    }
    return nextResolve(specifier, context)
  },
})

const { restoreWorkspaceHandle } = await import("../src/browser/workspace.ts")
const { handleBrowserRequest } = await import("../src/browser/router.ts")

class MemoryFileHandle {
  constructor(name, value = new Blob()) {
    this.name = name
    this.value = value
    this.kind = "file"
  }

  async getFile() { return new File([this.value], this.name, { type: this.value.type }) }
  async createWritable() {
    return {
      write: async (value) => { this.value = value instanceof Blob ? value : new Blob([value]) },
      close: async () => undefined,
      abort: async () => undefined,
    }
  }
}

class MemoryDirectoryHandle {
  constructor(name = "workspace") {
    this.name = name
    this.kind = "directory"
    this.entries = new Map()
  }

  async queryPermission() { return "granted" }
  async getDirectoryHandle(name, options = {}) {
    if (!this.entries.has(name)) {
      if (!options.create) throw new DOMException("Missing directory", "NotFoundError")
      this.entries.set(name, new MemoryDirectoryHandle(name))
    }
    const entry = this.entries.get(name)
    if (entry.kind !== "directory") throw new DOMException("Not a directory", "TypeMismatchError")
    return entry
  }
  async getFileHandle(name, options = {}) {
    if (!this.entries.has(name)) {
      if (!options.create) throw new DOMException("Missing file", "NotFoundError")
      this.entries.set(name, new MemoryFileHandle(name))
    }
    const entry = this.entries.get(name)
    if (entry.kind !== "file") throw new DOMException("Not a file", "TypeMismatchError")
    return entry
  }
  async *values() { yield* this.entries.values() }
}

async function putJson(directory, path, value) {
  const parts = path.split("/")
  let current = directory
  for (const part of parts.slice(0, -1)) current = await current.getDirectoryHandle(part, { create: true })
  const file = await current.getFileHandle(parts.at(-1), { create: true })
  const writable = await file.createWritable()
  await writable.write(new Blob([JSON.stringify(value)], { type: "application/json" }))
  await writable.close()
}

const root = new MemoryDirectoryHandle()
await putJson(root, "madnolia-browser.json", { application: "madnolia-browser", schema_version: 1, created_at: "2026-01-01T00:00:00.000Z" })
await putJson(root, "projects/project-1/project.json", { detail: { manifest: { project_id: "project-1" } }, analysis_ids: [] })
await restoreWorkspaceHandle(root)
const testWindow = { location: { origin: "http://localhost" }, setTimeout }

test("missing workspace objects return 404", async () => {
  globalThis.window = testWindow
  const response = await handleBrowserRequest("/api/projects/missing-project")
  const body = await response.json()
  assert.equal(response.status, 404, body.detail)
  assert.match(body.detail, /Missing directory/)
})

test("new collage creation rejects a stale professional parent revision", async () => {
  globalThis.window = testWindow
  await putJson(root, "collages/parent-1/collage.json", {
    composition_id: "parent-1", corpus_project_id: "project-1", updated_at: "2026-10-01T00:00:00.000Z",
  })
  const response = await handleBrowserRequest("/api/collages", {
    method: "POST",
    body: JSON.stringify({
      project_id: "project-1",
      composition: {
        name: "stale copy", target_text: "", target_pronunciation: "", crossfade_ms: 0,
        tempo_bpm: 120, beats_per_bar: 4, beat_division: 4, segments: [], mode: "simple",
        schema_version: 1, parent_composition_id: "parent-1", parent_composition_updated_at: "2026-09-30T00:00:00.000Z",
      },
    }),
  })
  assert.equal(response.status, 400)
  assert.match((await response.json()).detail, /부모 합성이 변경/)
  const collages = await root.getDirectoryHandle("collages")
  assert.deepEqual([...collages.entries.keys()].sort(), ["parent-1"])
})

test("invalid export targets fail before a job is created", async () => {
  globalThis.window = testWindow
  const response = await handleBrowserRequest("/api/collages/any/export-jobs/unknown", { method: "POST" })
  assert.equal(response.status, 400)
  assert.match((await response.json()).detail, /Unsupported export target/)
})

test("search jobs return promptly, accept cancellation, and persist terminal status", async () => {
  globalThis.window = testWindow
  const started = await handleBrowserRequest("/api/projects/project-1/search-jobs", {
    method: "POST",
    body: JSON.stringify({ text: "hello", input_language: "EN", include_exact: true, include_approximate: true }),
  })
  const startBody = await started.clone().json()
  assert.equal(started.status, 200, startBody.detail)
  const { job_id } = await started.json()
  const cancelled = await handleBrowserRequest(`/api/search-jobs/${job_id}`, { method: "DELETE" })
  assert.equal(cancelled.status, 200)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const current = await handleBrowserRequest(`/api/search-jobs/${job_id}`)
  assert.equal((await current.json()).status, "cancelled")
})

test("video uploads route to local workspace and default ASR model is accepted", async () => {
  globalThis.window = testWindow
  const { uploadVideo } = await import("../src/api/analysis.ts")
  const progress = []
  let uploadCompleted = false
  const uploaded = await uploadVideo(new File(["video"], "camera.webm", { type: "video/webm" }), (percent) => progress.push(percent), () => { uploadCompleted = true })
  assert.deepEqual(uploaded, { filename: "camera.webm" })
  assert.deepEqual(progress, [0, 100])
  assert.equal(uploadCompleted, true)
  const videos = await handleBrowserRequest("/api/videos")
  assert.deepEqual(await videos.json(), ["camera.webm"])
  const { BROWSER_ASR_DEFAULT_MODEL, BROWSER_ASR_MODELS } = await import("../src/browserAnalysisConstants.ts")
  assert.ok(BROWSER_ASR_MODELS.some((model) => model.id === BROWSER_ASR_DEFAULT_MODEL))
  const settings = { filename: "camera.webm", nickname: "", model_name: BROWSER_ASR_DEFAULT_MODEL, backend: "transformers-js", device: "wasm", alignment_mode: "estimated", candidate_models: [], acoustic_units: true }
  const started = await handleBrowserRequest("/api/analyses", { method: "POST", body: JSON.stringify(settings) })
  assert.equal(started.status, 200, (await started.clone().json()).detail)
  await handleBrowserRequest(`/api/analysis-jobs/${(await started.json()).job_id}/stop`, { method: "POST" })
})

test("unknown Japanese kanji remains marked as missing pronunciation", async () => {
  const { pronounceBrowserText } = await import("../src/browser/phonetics.ts")
  const phones = pronounceBrowserText("\u9b31\u9b31", "JA")
  assert.equal(phones.length, 2)
  assert.ok(phones.every((phone) => phone.phone_id === "und.approximate.unknown"))
  assert.deepEqual(phones.map((phone) => phone.word_index), [0, 0])
})

test("model cache safely reuses concurrent writes and reads from the workspace", async () => {
  globalThis.window = testWindow
  const { createWorkspaceModelCache } = await import("../src/browser/modelCache.ts")
  const cache = createWorkspaceModelCache(root)
  const url = "https://huggingface.co/Xenova/whisper-tiny/resolve/main/config.json"
  await Promise.all([
    cache.put(url, new Response("{\"config\":1}", { headers: { "Content-Type": "application/json" } })),
    cache.put(url, new Response("{\"config\":1}", { headers: { "Content-Type": "application/json" } })),
  ])
  const reused = await cache.match(url)
  assert.equal(await reused.text(), "{\"config\":1}")
  const { listCachedModels } = await import("../src/browser/modelCache.ts")
  const models = await listCachedModels()
  assert.equal(models.find((item) => item.model_id === "Xenova/whisper-tiny").file_count, 1)
})
