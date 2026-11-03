import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import test from "node:test"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try { return nextResolve(specifier + ".ts", context) } catch {}
    }
    return nextResolve(specifier, context)
  },
})

class MemoryFile {
  constructor(name) { this.name = name; this.kind = "file"; this.data = new Uint8Array() }
  async getFile() { return new File([this.data], this.name) }
  async createWritable() {
    const owner = this
    return {
      async write(value) {
        if (value instanceof Blob) owner.data = new Uint8Array(await value.arrayBuffer())
        else if (value instanceof Uint8Array) owner.data = new Uint8Array(value)
        else owner.data = new TextEncoder().encode(String(value))
      },
      async close() {},
      async abort() { owner.data = new Uint8Array() },
    }
  }
}
class MemoryDirectory {
  constructor(name) { this.name = name; this.kind = "directory"; this.children = new Map() }
  async queryPermission() { return "granted" }
  async requestPermission() { return "granted" }
  async *entries() { yield* this.children.entries() }
  async getDirectoryHandle(name, options = {}) {
    if (!this.children.has(name)) {
      if (!options.create) throw new DOMException("missing", "NotFoundError")
      this.children.set(name, new MemoryDirectory(name))
    }
    const found = this.children.get(name)
    if (found.kind !== "directory") throw new DOMException("wrong kind", "TypeMismatchError")
    return found
  }
  async getFileHandle(name, options = {}) {
    if (!this.children.has(name)) {
      if (!options.create) throw new DOMException("missing", "NotFoundError")
      this.children.set(name, new MemoryFile(name))
    }
    const found = this.children.get(name)
    if (found.kind !== "file") throw new DOMException("wrong kind", "TypeMismatchError")
    return found
  }
  async removeEntry(name) {
    if (!this.children.has(name)) throw new DOMException("missing", "NotFoundError")
    this.children.delete(name)
  }
}

const databases = new Map()
globalThis.indexedDB = {
  open(name) {
    const request = {}
    queueMicrotask(() => {
      if (!databases.has(name)) databases.set(name, new Map())
      request.result = {
        objectStoreNames: { contains: () => true },
        createObjectStore() {},
        transaction(storeName) {
          const db = databases.get(name)
          const tx = {}
          tx.objectStore = () => ({
            get(key) { const req = {}; queueMicrotask(() => { req.result = db.get(key); req.onsuccess?.(); tx.oncomplete?.() }); return req },
            put(value, key) { const req = {}; queueMicrotask(() => { db.set(key, value); req.onsuccess?.(); tx.oncomplete?.() }); return req },
            delete(key) { const req = {}; queueMicrotask(() => { db.delete(key); req.onsuccess?.(); tx.oncomplete?.() }); return req },
          })
          return tx
        },
        close() {},
      }
      request.onsuccess?.()
    })
    return request
  },
}

const storage = await import("../src/browser/modelStorage.ts")
const cacheModule = await import("../src/browser/modelCache.ts")
const selection = { kind: "asr", model_id: "onnx-community/whisper-large-v3-ONNX", revision: "abc123", dtype: "fp32" }
const selectionBase = selection
const files = ["config.json", "preprocessor_config.json", "generation_config.json", "tokenizer_config.json", "tokenizer.json", "onnx/encoder_model.onnx", "onnx/decoder_model_merged.onnx"]
const write = async (root, path, bytes) => {
  const parts = path.split("/")
  let current = root
  for (const part of parts.slice(0, -1)) current = await current.getDirectoryHandle(part, { create: true })
  const handle = await current.getFileHandle(parts.at(-1), { create: true })
  const writer = await handle.createWritable()
  await writer.write(bytes)
  await writer.close()
  return handle
}
const read = async (root, path) => {
  let current = root
  const parts = path.split("/")
  for (const part of parts.slice(0, -1)) current = await current.getDirectoryHandle(part)
  return current.getFileHandle(parts.at(-1)).then((handle) => handle.getFile())
}

test("complete local model hit performs no network access", async () => {
  const root = new MemoryDirectory("models")
  for (const path of files) await write(root, path, path === "config.json" ? JSON.stringify({ _name_or_path: selection.model_id, model_type: "whisper" }) : "local")
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls += 1; throw new Error("network should not run") }
  try {
    const ready = await storage.getModelReadiness(selection, root)
    assert.equal(ready.ready, true)
    assert.equal(ready.present_files, files.length, ready.message)
    assert.equal(calls, 0)
    const cache = storage.createModelFolderCache(root)
    const path = "https://huggingface.co/" + selection.model_id + "/resolve/" + selection.revision + "/onnx/encoder_model.onnx"
    assert.equal(await (await cache.match(path)).text(), "local")
    assert.equal(await cache.match(path.replace(selection.revision, "other")), undefined)
  } finally { globalThis.fetch = originalFetch }
})

test("offline ASR readiness requires tokenizer configuration and processor files", async () => {
  for (const missing of ["tokenizer_config.json", "preprocessor_config.json"]) {
    const root = new MemoryDirectory("models")
    for (const path of files.filter((item) => item !== missing)) await write(root, path, path === "config.json" ? JSON.stringify({ _name_or_path: selection.model_id, model_type: "whisper" }) : "local")
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new Error("offline") }
    try {
      const ready = await storage.getModelReadiness(selection, root)
      assert.equal(ready.ready, false, missing)
      assert.match(ready.message, new RegExp(missing.replaceAll(".", "\\."), "u"))
    } finally { globalThis.fetch = originalFetch }
  }
})

test("offline CTC and HuBERT readiness requires processor configuration", async () => {
  for (const kind of ["ctc", "hubert"]) {
    const selected = storage.modelSelection(kind, "", "baseline", "wasm")
    const root = new MemoryDirectory("models")
    const type = kind === "ctc" ? "wav2vec2" : "hubert"
    await write(root, "config.json", JSON.stringify({ _name_or_path: selected.model_id, model_type: type }))
    await write(root, "onnx/model.onnx", "local")
    if (kind === "ctc") await write(root, "vocab.json", "{}")
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new Error("offline") }
    try {
      const ready = await storage.getModelReadiness(selected, root)
      assert.equal(ready.ready, false, kind)
      assert.match(ready.message, /preprocessor_config\.json/u)
    } finally { globalThis.fetch = originalFetch }
  }
})

test("analysis preparation selections include only enabled models at chosen precision and device", () => {
  const selected = storage.analysisModelSelections({
    model_name: "onnx-community/whisper-large-v3-ONNX",
    candidate_models: ["Xenova/whisper-small"],
    alignment_mode: "estimated",
    acoustic_units: false,
    precision: "compact",
    device: "wasm",
  })
  assert.deepEqual(selected.map((item) => [item.kind, item.model_id, item.dtype]), [
    ["asr", "musetric/whisper-large-v3-onnx", "q4"],
    ["asr", "Xenova/whisper-small", "q8"],
  ])
  const all = storage.analysisModelSelections({
    model_name: "onnx-community/whisper-large-v3-ONNX",
    candidate_models: [],
    alignment_mode: "ctc",
    acoustic_units: true,
    precision: "compact",
    device: "webgpu",
  })
  assert.deepEqual(all.map((item) => item.kind), ["asr", "ctc", "hubert"])
  assert.ok(all.every((item) => item.dtype === "q4" || item.dtype === "fp16"))
})

test("snapshot sidecars count toward offline readiness and Git LFS sidecars do not", async () => {
  const root = new MemoryDirectory("models")
  const external = { ...selection, external_data_format: { encoder_model: true } }
  const snapshot = `models--${selection.model_id.replaceAll("/", "--")}/snapshots/${selection.revision}/`
  for (const path of files) await write(root, snapshot + path, path === "config.json" ? JSON.stringify({ _name_or_path: selection.model_id, model_type: "whisper" }) : "local")
  const sidecarPath = snapshot + "onnx/encoder_model.onnx_data"
  await write(root, sidecarPath, "external")
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error("offline") }
  try {
    const snapshotReady = await storage.getModelReadiness(external, root)
    assert.equal(snapshotReady.ready, true, snapshotReady.message)
    await write(root, sidecarPath, "version https://git-lfs.github.com/spec/v1\noid sha256:placeholder")
    const readiness = await storage.getModelReadiness(external, root)
    assert.equal(readiness.ready, false)
    assert.match(readiness.message, /external data sidecars/u)
  } finally { globalThis.fetch = originalFetch }
})

test("pinned repository preparation includes ONNX external-data sidecars", async () => {
  const root = new MemoryDirectory("models")
  const external = { ...selection, external_data_format: { encoder_model: true, decoder_model_merged: true } }
  const repositoryFiles = [
    ...files,
    "onnx/encoder_model.onnx_data",
    "onnx/decoder_model_merged.onnx_data",
  ].map((path) => ({ path, type: "file", size: 1024 }))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => repositoryFiles })
  try {
    const readiness = await storage.getModelReadiness(external, root)
    assert.equal(readiness.ready, false)
    assert.equal(readiness.present_files, 0)
    assert.equal(readiness.total_files, repositoryFiles.length)
    assert.match(readiness.message, /required files will be downloaded/u)
  } finally { globalThis.fetch = originalFetch }
})

test("cache lookup isolates model ID and pinned revision", async () => {
  const root = new MemoryDirectory("models")
  await write(root, "models--onnx-community--whisper-large-v3-ONNX/snapshots/abc123/config.json", "right")
  const cache = storage.createModelFolderCache(root)
  const base = "https://huggingface.co/onnx-community/whisper-large-v3-ONNX/resolve/"
  assert.equal(await (await cache.match(base + "abc123/config.json")).text(), "right")
  assert.equal(await cache.match(base + "other/config.json"), undefined)
  assert.equal(await cache.match("https://huggingface.co/other/model/resolve/abc123/config.json"), undefined)
})

test("model cache hits expose exact content length and preserve binary bodies", async () => {
  const modelId = selectionBase.model_id
  const revision = selectionBase.revision
  const fileName = "onnx/encoder_model.onnx"
  const url = `https://huggingface.co/${modelId}/resolve/${revision}/${fileName}`
  const bytes = Uint8Array.from({ length: 256 * 1024 }, (_, index) => (index * 31) & 255)
  const checkResponse = async (response) => {
    assert.equal(response.headers.get("content-length"), String(bytes.byteLength))
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes)
  }

  const managedRoot = new MemoryDirectory("managed")
  const managedCache = storage.createModelFolderCache(managedRoot)
  await managedCache.put(url, new Response(bytes))
  await checkResponse(await managedCache.match(url))

  const snapshotRoot = new MemoryDirectory("snapshot")
  await write(snapshotRoot, `models--${modelId.replaceAll("/", "--")}/snapshots/${revision}/${fileName}`, bytes)
  await checkResponse(await storage.createModelFolderCache(snapshotRoot).match(url))

  const flatRoot = new MemoryDirectory("flat")
  await write(flatRoot, "config.json", JSON.stringify({ _name_or_path: modelId, model_type: "whisper" }))
  await write(flatRoot, fileName, bytes)
  await write(flatRoot, ".madnolia-models/index.json", JSON.stringify({ schema_version: 1, files: [], bindings: [{ model_id: modelId, revision, dtype: selectionBase.dtype, files: [fileName] }] }))
  await checkResponse(await storage.createModelFolderCache(flatRoot).match(url))

  const workspaceRoot = new MemoryDirectory("workspace")
  const workspaceCache = cacheModule.createWorkspaceModelCache(workspaceRoot)
  await workspaceCache.put(url, new Response(bytes))
  await checkResponse(await workspaceCache.match(url))
})

test("flat folders with another model identity are not served", async () => {
  const root = new MemoryDirectory("models")
  await write(root, "config.json", JSON.stringify({ _name_or_path: "somebody/else" }))
  await write(root, "onnx/encoder_model.onnx", "wrong")
  const cache = storage.createModelFolderCache(root)
  assert.equal(await cache.match("https://huggingface.co/onnx-community/whisper-large-v3-ONNX/resolve/abc123/onnx/encoder_model.onnx"), undefined)
})

test("download streams only selected ONNX artifacts and commits the index", async () => {
  const root = new MemoryDirectory("models")
  await write(root, "user-notes.txt", "keep")
  const originalFetch = globalThis.fetch
  const downloaded = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/api/models/")) return Response.json([
      ...files.map((path) => ({ path, size: 4 })),
      { path: "onnx/encoder_model_q8.onnx", size: 99 },
      { path: "pytorch_model.bin", size: 99 },
    ])
    const path = decodeURIComponent(new URL(url).pathname.split("/").at(-1))
    downloaded.push(path)
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data")); controller.close() } }), { headers: { "content-length": "4" } })
  }
  try {
    const result = await storage.prepareModel(selection, new AbortController().signal, () => {}, root)
    assert.equal(result.ready, true)
    assert.deepEqual(downloaded, files.map((path) => path.split("/").at(-1)))
    assert.equal(await (await read(root, "user-notes.txt")).text(), "keep")
    const index = JSON.parse(await (await read(root, ".madnolia-models/index.json")).text())
    assert.equal(index.files.length, files.length)
    assert.ok(index.files.every((item) => item.model_id === selection.model_id && item.revision === selection.revision && item.dtype === selection.dtype))
  } finally { globalThis.fetch = originalFetch }
})

test("Q8 graph files use quantized suffixes and subfolders apply only to ONNX graphs", async () => {
  const root = new MemoryDirectory("models")
  const selection = { ...selectionBase, dtype: "q8", subfolder: "graphs" }
  const expected = ["config.json", "preprocessor_config.json", "generation_config.json", "tokenizer_config.json", "tokenizer.json", "graphs/encoder_model_quantized.onnx", "graphs/decoder_model_merged_quantized.onnx"]
  const originalFetch = globalThis.fetch
  const requested = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/api/models/")) return Response.json(expected.map((path) => ({ path, size: 4 })))
    const path = decodeURIComponent(new URL(url).pathname.split("/resolve/")[1].split("/").slice(1).join("/"))
    requested.push(path)
    return new Response("data", { headers: { "content-length": "4" } })
  }
  try {
    const result = await storage.prepareModel({ ...selectionBase, dtype: "q8", subfolder: "graphs" }, new AbortController().signal, () => {}, root)
    assert.equal(result.ready, true)
    assert.deepEqual(requested, expected)
    assert.equal(await read(root, ".madnolia-models/files/onnx-community%2Fwhisper-large-v3-ONNX/abc123/q8/config.json").then((file) => file.text()), "data")
  } finally { globalThis.fetch = originalFetch }
})

test("cache put writes streamed model files to the selected folder index", async () => {
  const root = new MemoryDirectory("models")
  const cache = storage.createModelFolderCache(root)
  const url = "https://huggingface.co/onnx-community/whisper-large-v3-ONNX/resolve/abc123/onnx/encoder_model_quantized.onnx"
  await cache.put(url, new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("onnx-data")); controller.close() } })))
  assert.equal(await (await cache.match(url)).text(), "onnx-data")
  const index = JSON.parse(await (await read(root, ".madnolia-models/index.json")).text())
  assert.equal(index.files.length, 1)
  assert.equal(index.files[0].dtype, "q8")
  assert.equal(index.files[0].file, "onnx/encoder_model_quantized.onnx")
})

test("concurrent cache puts preserve every index entry and infer q4f16", async () => {
  const root = new MemoryDirectory("models")
  const cache = storage.createModelFolderCache(root)
  const base = "https://huggingface.co/example/whisper/resolve/rev/onnx/"
  await Promise.all([
    cache.put(base + "encoder_model_q4f16.onnx", new Response("q4f16")),
    cache.put(base + "decoder_model_quantized.onnx", new Response("q8")),
    cache.put(base + "decoder_model_merged.onnx", new Response("fp32")),
  ])
  const index = JSON.parse(await (await read(root, ".madnolia-models/index.json")).text())
  assert.equal(index.files.length, 3)
  assert.deepEqual(index.files.map((item) => item.dtype).sort(), ["fp32", "q4f16", "q8"])
  assert.deepEqual(index.files.map((item) => item.file).sort(), [
    "onnx/decoder_model_merged.onnx",
    "onnx/decoder_model_quantized.onnx",
    "onnx/encoder_model_q4f16.onnx",
  ])
})

test("flat turbo export config accepts its exact known base identity", async () => {
  const root = new MemoryDirectory("models")
  const turbo = { kind: "asr", model_id: "onnx-community/whisper-large-v3-turbo_timestamped", revision: "rev", dtype: "q8" }
  const turboFiles = ["config.json", "preprocessor_config.json", "generation_config.json", "tokenizer_config.json", "tokenizer.json", "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"]
  for (const path of turboFiles) await write(root, path, path === "config.json" ? JSON.stringify({ _name_or_path: "openai/whisper-large-v3-turbo", model_type: "whisper" }) : "local")
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error("network should not run") }
  try {
    const ready = await storage.getModelReadiness(turbo, root)
    assert.equal(ready.ready, true, ready.message)
    const cache = storage.createModelFolderCache(root)
    const url = "https://huggingface.co/" + turbo.model_id + "/resolve/" + turbo.revision + "/onnx/encoder_model_quantized.onnx"
    assert.equal(await (await cache.match(url)).text(), "local")
  } finally { globalThis.fetch = originalFetch }
})

test("flat config identity aliases do not accept unknown turbo model identities", async () => {
  const root = new MemoryDirectory("models")
  const turbo = { kind: "asr", model_id: "onnx-community/whisper-large-v3-turbo_timestamped", revision: "rev", dtype: "q8" }
  const turboFiles = ["config.json", "preprocessor_config.json", "generation_config.json", "tokenizer_config.json", "tokenizer.json", "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"]
  for (const path of turboFiles) await write(root, path, path === "config.json" ? JSON.stringify({ _name_or_path: "example/whisper-large-v3-turbo", model_type: "whisper" }) : "local")
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error("offline") }
  try {
    const ready = await storage.getModelReadiness(turbo, root)
    assert.equal(ready.ready, false)
    assert.match(ready.message, /offline/u)
  } finally { globalThis.fetch = originalFetch }
})

test("Git LFS pointers are not treated as reusable ONNX files", async () => {
  const root = new MemoryDirectory("models")
  for (const path of files) await write(root, path, path === "config.json" ? JSON.stringify({ _name_or_path: selectionBase.model_id, model_type: "whisper" }) : path === "onnx/encoder_model.onnx" ? "version https://git-lfs.github.com/spec/v1\noid sha256:placeholder" : "local")
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => String(input).includes("/api/models/")
    ? Response.json(files.map((path) => ({ path, size: 4 })))
    : new Response("data", { headers: { "content-length": "4" } })
  try {
    const status = await storage.getModelReadiness(selectionBase, root)
    assert.equal(status.ready, false)
    assert.equal(status.present_files, files.length - 1)
    assert.match(status.message, /downloaded/u)
    assert.match(await (await read(root, "onnx/encoder_model.onnx")).text(), /git-lfs/u)
  } finally { globalThis.fetch = originalFetch }
})

test("cancelled stream removes partial file and leaves no index entry", async () => {
  const root = new MemoryDirectory("models")
  const originalFetch = globalThis.fetch
  const controller = new AbortController()
  globalThis.fetch = async (input) => String(input).includes("/api/models/")
    ? Response.json(files.map((path) => ({ path, size: 8 })))
    : new Response(new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array([1, 2, 3])) } }), { headers: { "content-length": "8" } })
  try {
    const pending = storage.prepareModel(selection, controller.signal, () => controller.abort(), root)
    await assert.rejects(pending, { name: "AbortError" })
    assert.equal(await read(root, ".madnolia-models/index.json").then(() => true, () => false), false)
    const containsPartial = async (directory) => {
      for (const [name, entry] of directory.children) {
        if (name.endsWith(".partial")) return true
        if (entry.kind === "directory" && await containsPartial(entry)) return true
      }
      return false
    }
    assert.equal(await containsPartial(root), false)
  } finally { globalThis.fetch = originalFetch }
})

test("saved directory handle can be reloaded and old workspace cache remains readable", async () => {
  const root = new MemoryDirectory("models")
  root.isSameEntry = async (other) => root === other
  const originalWindow = globalThis.window
  globalThis.window = { showDirectoryPicker: async () => root }
  await storage.connectModelFolder()
  const saved = await storage.getSavedModelFolder()
  await storage.resetModelFolder()
  assert.equal(await storage.restoreModelFolder(saved), root)
  globalThis.window = originalWindow
  const handle = await write(root, "old.bin", "old-cache")
  const workspace = new MemoryDirectory("workspace")
  const workspaceCache = cacheModule.createWorkspaceModelCache(workspace)
  const url = "https://huggingface.co/example/model/resolve/rev/onnx/model.onnx"
  await workspaceCache.put(url, new Response("old-cache"))
  assert.equal(await (await workspaceCache.match(url)).text(), "old-cache")
  assert.equal(await handle.getFile().then((file) => file.text()), "old-cache")
})
