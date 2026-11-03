import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import test from "node:test"

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    try { return nextResolve(`${specifier}.ts`, context) } catch {}
  }
  return nextResolve(specifier, context)
} })

class MemoryFileHandle {
  constructor(name, path, root) { this.name = name; this.path = path; this.root = root; this.kind = "file"; this.bytes = new Uint8Array() }
  async getFile() { return new File([this.bytes], this.name) }
  async createWritable() {
    const target = this
    return {
      async write(value) {
        if (target.root.pausePath === target.path) {
          target.root.pausePath = ""
          target.root.pauseStarted?.()
          await target.root.pauseGate
        }
        if (target.root.failPath === target.path) { target.root.failPath = ""; throw new Error("injected publish interruption") }
        target.bytes = value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : value instanceof Uint8Array ? new Uint8Array(value) : new TextEncoder().encode(String(value))
      },
      async close() {},
      async abort() {},
    }
  }
}
class MemoryDirectoryHandle {
  constructor(name, path = "", root = this) { this.name = name; this.path = path; this.root = root; this.kind = "directory"; this.entries = new Map() }
  async queryPermission() { return "granted" }
  async requestPermission() { return "granted" }
  async getDirectoryHandle(name, options = {}) {
    if (!this.entries.has(name)) {
      if (!options.create) throw new DOMException("missing", "NotFoundError")
      this.entries.set(name, new MemoryDirectoryHandle(name, this.path ? `${this.path}/${name}` : name, this.root))
    }
    const entry = this.entries.get(name)
    if (entry.kind !== "directory") throw new DOMException("wrong kind", "TypeMismatchError")
    return entry
  }
  async getFileHandle(name, options = {}) {
    if (!this.entries.has(name)) {
      if (!options.create) throw new DOMException("missing", "NotFoundError")
      const path = this.path ? `${this.path}/${name}` : name
      this.entries.set(name, new MemoryFileHandle(name, path, this.root))
    }
    const entry = this.entries.get(name)
    if (entry.kind !== "file") throw new DOMException("wrong kind", "TypeMismatchError")
    return entry
  }
  async *values() { yield* this.entries.values() }
  async removeEntry(name) {
    const path = this.path ? `${this.path}/${name}` : name
    if (this.root.failRemovePath === path) { this.root.failRemovePath = ""; throw new Error("injected cleanup interruption") }
    if (!this.entries.has(name)) throw new DOMException("missing", "NotFoundError")
    this.entries.delete(name)
  }
}

const databases = new Map()
globalThis.indexedDB = { open(name) {
  const request = {}
  queueMicrotask(() => {
    if (!databases.has(name)) databases.set(name, new Map())
    const store = databases.get(name)
    request.result = { objectStoreNames: { contains: () => true }, createObjectStore() {}, transaction() {
      const transaction = {}
      transaction.objectStore = () => ({ get(key) { const item = {}; queueMicrotask(() => { item.result = store.get(key); item.onsuccess?.(); transaction.oncomplete?.() }); return item }, put(value, key) { const item = {}; queueMicrotask(() => { store.set(key, value); item.onsuccess?.(); transaction.oncomplete?.() }); return item } })
      return transaction
    }, close() {} }
    request.onsuccess?.()
  })
  return request
} }

const root = new MemoryDirectoryHandle("reprocess-test")
globalThis.window = { showDirectoryPicker: async () => root }
const workspace = await import("../src/browser/workspace.ts")
await workspace.connectWorkspace()
const transactions = await import("../src/browser/reprocessTransactions.ts")
const modelStorage = await import("../src/browser/modelStorage.ts")
const reprocessing = await import("../src/browser/analysisReprocessing.ts")

test("reprocessing requires only selected CTC and optional HuBERT models", () => {
  assert.deepEqual(modelStorage.analysisReprocessModelSelections("compact", "wasm", false).map((item) => item.kind), ["ctc"])
  assert.deepEqual(modelStorage.analysisReprocessModelSelections("baseline", "webgpu", true).map((item) => item.kind), ["ctc", "hubert"])
})

test("stable phone identities retain collage occurrence ids and preserve unknown ASR provenance", () => {
  const originalPhone = { occurrence_id: "saved-phone", source_id: "source", sentence_index: 0, word_index: 0, grapheme: "a", pronunciation: "a", phone_id: "en.vowel.a", ipa: "a", start_ms: 2, end_ms: 6, confidence: null, alignment_method: "ESTIMATED_WORD", alignment_status: "ESTIMATED" }
  const pronunciation = { word_index: 0, grapheme: "a", ipa: "a", phone_id: "en.vowel.a" }
  const indexed = reprocessing.indexStablePhoneOccurrences([originalPhone])
  assert.equal(reprocessing.takeStableOccurrenceId(indexed, pronunciation), "saved-phone")
  assert.equal(reprocessing.takeStableOccurrenceId(indexed, pronunciation), null)
  const record = { summary: {}, source: {}, overview: { transcript: "a" }, phones: [originalPhone], acoustic_features: [], audio_path: "audio.wav", media_path: "" }
  const inference = { precision: "compact", alignment: { model_name: "ctc", model_revision: "r1", dtype: "q4", device: "wasm", enabled: true }, acoustic_units: { model_name: "hubert", model_revision: "r2", dtype: "q8", device: "wasm", enabled: false } }
  const updated = reprocessing.withBrowserReprocessingMetadata(record, { inference }, "2026-01-01T00:00:00.000Z")
  assert.equal(Object.hasOwn(updated, "inference_metadata"), false)
  assert.equal(updated.overview, record.overview)
  assert.deepEqual(updated.reprocessing_metadata, { ...inference, processed_at: "2026-01-01T00:00:00.000Z" })
  const asrProvenance = { precision: "baseline", asr_language: "en", asr_task: "transcribe", asr_models: [{ model_name: "saved-asr", model_revision: "original", dtype: "fp32", device: "wasm", enabled: true }], alignment: { model_name: "old-ctc", model_revision: "old", dtype: "fp32", device: "wasm", enabled: false }, acoustic_units: { model_name: "old-hubert", model_revision: "old", dtype: "fp32", device: "wasm", enabled: false } }
  const knownRecord = { ...record, inference_metadata: asrProvenance }
  assert.deepEqual(reprocessing.withBrowserReprocessingMetadata(knownRecord, { inference }, "now").inference_metadata, asrProvenance)
  assert.equal(reprocessing.mayCommitReprocessing({ job_id: "j", analysis_id: "a", status: "stopped", stage: "cancelled", percent: 30, error: null }), false)
})

test("live foreign job leases block takeover while expired leases allow explicit resume", () => {
  const live = { job_id: "active-job", owner_id: "other-tab", expires_at: 5000 }
  assert.equal(reprocessing.browserAnalysisLeaseAllowsJob(live, "active-job", "this-tab", 4000), false)
  assert.equal(reprocessing.browserAnalysisLeaseIsLiveForJob(live, "active-job", 4000), true)
  assert.equal(reprocessing.browserAnalysisLeaseAllowsJob(live, "active-job", "this-tab", 5000), true)
  assert.equal(reprocessing.browserAnalysisLeaseIsLiveForJob(live, "active-job", 5000), false)
})

test("referencing projects refresh source and overview snapshots without changing transcript data", () => {
  const overview = { source_id: "source", transcript: "saved transcript", words: [{ text: "word", start_ms: 1, end_ms: 2 }] }
  const source = { source_id: "source", video_fps: 30 }
  const project = { analysis_ids: ["analysis"], detail: { manifest: { sources: [source] }, analyses: [overview] } }
  const nextSource = { ...source, video_fps: 30 }
  const nextOverview = { ...overview, phone_count: 4 }
  const updated = reprocessing.updateProjectAnalysisSnapshot(project, { source: nextSource, overview: nextOverview })
  assert.deepEqual(updated.detail.manifest.sources[0], nextSource)
  assert.deepEqual(updated.detail.analyses[0], nextOverview)
  assert.equal(updated.detail.analyses[0].transcript, "saved transcript")
})

test("publish failure rolls back original analysis and centroids", async () => {
  const put = async (path, value) => {
    const parts = path.split("/")
    let dir = root
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true })
    ;(await dir.getFileHandle(parts.at(-1), { create: true })).bytes = new TextEncoder().encode(value)
  }
  const read = async (path) => (await workspace.readWorkspaceFile(path)).text()
  await put("analyses/a/analysis.json", "original-record")
  await put("analyses/a/centroids.json", "original-centroids")
  root.failPath = "analyses/a/centroids.json"
  await assert.rejects(transactions.transactionalPublish("failed", [
    { path: "analyses/a/analysis.json", data: new Blob(["changed-record"]) },
    { path: "analyses/a/centroids.json", data: new Blob(["changed-centroids"]) },
  ]), /injected publish interruption/)
  assert.equal(await read("analyses/a/analysis.json"), "original-record")
  assert.equal(await read("analyses/a/centroids.json"), "original-centroids")
})

test("next workspace access recovers an interrupted staged publish", async () => {
  const put = async (path, value) => {
    const parts = path.split("/")
    let dir = root
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true })
    ;(await dir.getFileHandle(parts.at(-1), { create: true })).bytes = new TextEncoder().encode(value)
  }
  await put("analyses/a/analysis.json", "partially-published")
  await put("transactions/reprocess-staging/crash/backup-0.bin", "original-after-crash")
  await workspace.writeWorkspaceJson("transactions/reprocess-journal.json", { transaction_id: "crash", state: "applying", entries: [{ path: "analyses/a/analysis.json", backup_path: "transactions/reprocess-staging/crash/backup-0.bin" }] })
  await transactions.recoverReprocessTransaction()
  assert.equal(await workspace.readWorkspaceFile("analyses/a/analysis.json").then((file) => file.text()), "original-after-crash")
  await assert.rejects(workspace.readWorkspaceJson("transactions/reprocess-journal.json"), { name: "NotFoundError" })
})

test("concurrent recovery waits for an active publish and committed archives remain", async () => {
  const put = async (path, value) => {
    const parts = path.split("/")
    let dir = root
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true })
    ;(await dir.getFileHandle(parts.at(-1), { create: true })).bytes = new TextEncoder().encode(value)
  }
  await put("analyses/queue/analysis.json", "before")
  await put("analyses/queue/reprocess-backups/tx/analysis.json", "archive-before")
  let resumeWrite
  root.pauseGate = new Promise((resolve) => { resumeWrite = resolve })
  let markPaused
  const paused = new Promise((resolve) => { markPaused = resolve })
  root.pauseStarted = markPaused
  root.pausePath = "analyses/queue/analysis.json"
  const publishing = transactions.transactionalPublish("tx", [{ path: "analyses/queue/analysis.json", backup_archive_path: "analyses/queue/reprocess-backups/tx/analysis.json", data: new Blob(["after"]) }])
  await paused
  let recoveryFinished = false
  const recovery = transactions.recoverReprocessTransaction().then(() => { recoveryFinished = true })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(recoveryFinished, false)
  resumeWrite()
  await Promise.all([publishing, recovery])
  assert.equal(await workspace.readWorkspaceFile("analyses/queue/analysis.json").then((file) => file.text()), "after")
  assert.equal(await workspace.readWorkspaceFile("analyses/queue/reprocess-backups/tx/analysis.json").then((file) => file.text()), "before")
})

test("a cleanup interruption after rollback can be recovered again", async () => {
  const put = async (path, value) => {
    const parts = path.split("/")
    let dir = root
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true })
    ;(await dir.getFileHandle(parts.at(-1), { create: true })).bytes = new TextEncoder().encode(value)
  }
  await put("analyses/retry/analysis.json", "partially-written")
  await put("transactions/reprocess-staging/retry/backup-0.bin", "restored-value")
  await workspace.writeWorkspaceJson("transactions/reprocess-journal.json", { transaction_id: "retry", state: "applying", entries: [{ path: "analyses/retry/analysis.json", backup_path: "transactions/reprocess-staging/retry/backup-0.bin" }] })
  root.failRemovePath = "transactions/reprocess-staging/retry"
  await assert.rejects(transactions.recoverReprocessTransaction(), /injected cleanup interruption/)
  assert.equal(await workspace.readWorkspaceFile("analyses/retry/analysis.json").then((file) => file.text()), "restored-value")
  await transactions.recoverReprocessTransaction()
  assert.equal(await workspace.readWorkspaceFile("analyses/retry/analysis.json").then((file) => file.text()), "restored-value")
})

test("a corrupt transaction journal remains available with a descriptive error", async () => {
  await workspace.writeWorkspaceFile("transactions/reprocess-journal.json", new Blob(["{broken"]))
  await assert.rejects(transactions.recoverReprocessTransaction(), /journal is corrupt JSON/)
  assert.equal(await workspace.readWorkspaceFile("transactions/reprocess-journal.json").then((file) => file.text()), "{broken")
})
