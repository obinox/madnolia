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

const workspace = await import("../src/browser/workspace.ts")
const databases = new Map()
globalThis.indexedDB = {
  open(name) {
    const request = {}
    queueMicrotask(() => {
      let database = databases.get(name)
      if (!database) {
        database = {
          values: new Map(),
          objectStoreNames: { contains: () => true },
          createObjectStore() {},
          transaction() {
            const transaction = {}
            transaction.objectStore = () => ({
              get: (key) => {
                const request = {}
                queueMicrotask(() => { request.result = database.values.get(key); request.onsuccess?.(); transaction.oncomplete?.() })
                return request
              },
              put: (value, key) => {
                const request = {}
                queueMicrotask(() => { database.values.set(key, value); request.result = key; request.onsuccess?.(); transaction.oncomplete?.() })
                return request
              },
            })
            return transaction
          },
          close() {},
        }
        databases.set(name, database)
        request.result = database
        request.onupgradeneeded?.()
      } else request.result = database
      request.onsuccess?.()
    })
    return request
  },
}

class MemoryFileHandle {
  constructor(name, bytes = "") { this.name = name; this.kind = "file"; this.bytes = bytes }
  async getFile() { return new File([this.bytes], this.name) }
  async createWritable() {
    return { write: async (data) => { this.bytes = data instanceof Blob ? await data.text() : String(data) }, close: async () => {}, abort: async () => {} }
  }
}

class MemoryDirectoryHandle {
  constructor(name) { this.name = name; this.kind = "directory"; this.entries = new Map(); this.permission = "granted" }
  async queryPermission() { return this.permission }
  async requestPermission() { return this.permission }
  async isSameEntry(other) { return this === other }
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

function pickerFor(handle) {
  globalThis.window = { showDirectoryPicker: async () => handle }
}

async function savedHandle() {
  const database = databases.get("madnolia-browser-workspace")
  return database?.values.get("active-workspace") ?? null
}

async function putFile(root, path, content) {
  const parts = path.split("/")
  let parent = root
  for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part, { create: true })
  const file = await parent.getFileHandle(parts.at(-1), { create: true })
  file.bytes = content
}

const validMarker = JSON.stringify({ application: "madnolia-browser", schema_version: 1, created_at: "2026-01-01T00:00:00.000Z", future_field: { retained: true } })

test("new registration and existing-folder reopen preserve marker and populated data", async () => {
  const root = new MemoryDirectoryHandle("reuse")
  pickerFor(root)
  await workspace.connectWorkspace()
  const marker = await root.getFileHandle("madnolia-browser.json")
  marker.bytes = validMarker
  await putFile(root, "projects/sentinel.json", "project data")
  await putFile(root, "media/sentinel.wav", "media data")
  await putFile(root, "models/sentinel.onnx", "model data")
  const previousMarker = marker.bytes
  pickerFor(root)
  await workspace.connectWorkspace(true)
  assert.equal(marker.bytes, previousMarker)
  assert.equal(await (await (await root.getDirectoryHandle("projects")).getFileHandle("sentinel.json")).getFile().then((file) => file.text()), "project data")
  assert.equal(await (await (await root.getDirectoryHandle("media")).getFileHandle("sentinel.wav")).getFile().then((file) => file.text()), "media data")
  assert.equal(await (await (await root.getDirectoryHandle("models")).getFileHandle("sentinel.onnx")).getFile().then((file) => file.text()), "model data")
})

test("explicit existing picker rejects unmarked folders without changing active or saved handle", async () => {
  const previous = await savedHandle()
  const empty = new MemoryDirectoryHandle("empty")
  pickerFor(empty)
  await assert.rejects(workspace.connectWorkspace(true), /기존 Madnolia 작업공간 표시/)
  assert.equal(empty.entries.size, 0)
  assert.equal(await savedHandle(), previous)
  assert.equal(workspace.getWorkspaceHandle(), previous)
})

test("new-folder flow refuses to register occupied unmarked managed directories", async () => {
  const root = new MemoryDirectoryHandle("occupied")
  await putFile(root, "projects/legacy.json", "keep")
  pickerFor(root)
  await assert.rejects(workspace.connectWorkspace(), /기존 데이터가 있는 폴더/)
  assert.equal(root.entries.has("madnolia-browser.json"), false)
  assert.equal(await (await (await root.getDirectoryHandle("projects")).getFileHandle("legacy.json")).getFile().then((file) => file.text()), "keep")
})

test("foreign, wrong-version, malformed, and invalid-shape markers are rejected without overwrite", async (context) => {
  for (const [name, bytes] of [
    ["foreign", JSON.stringify({ application: "other", schema_version: 1, created_at: "2026-01-01T00:00:00Z" })],
    ["version", JSON.stringify({ application: "madnolia-browser", schema_version: 2, created_at: "2026-01-01T00:00:00Z" })],
    ["malformed", "{"],
    ["shape", "null"],
    ["timestamp", JSON.stringify({ application: "madnolia-browser", schema_version: 1, created_at: "invalid" })],
  ]) {
    await context.test(name, async () => {
      const root = new MemoryDirectoryHandle(name)
      await putFile(root, "madnolia-browser.json", bytes)
      pickerFor(root)
      await assert.rejects(workspace.connectWorkspace(true))
      assert.equal((await root.getFileHandle("madnolia-browser.json")).bytes, bytes)
    })
  }
})

test("restore rejects a disappeared marker and permission denial without writes", async () => {
  const root = new MemoryDirectoryHandle("restore")
  pickerFor(root)
  await workspace.connectWorkspace()
  const previousActive = workspace.getWorkspaceHandle()
  const markerBytes = (await root.getFileHandle("madnolia-browser.json")).bytes
  root.entries.delete("madnolia-browser.json")
  await assert.rejects(workspace.restoreWorkspaceHandle(root), /표시/)
  await assert.rejects(workspace.reconnectWorkspace(), /표시/)
  assert.equal(workspace.getWorkspaceHandle(), previousActive)
  assert.equal(await savedHandle(), root)
  assert.equal(root.entries.has("madnolia-browser.json"), false)
  await putFile(root, "madnolia-browser.json", markerBytes)
  root.permission = "denied"
  pickerFor(root)
  await assert.rejects(workspace.connectWorkspace(true), /권한/)
  assert.equal((await root.getFileHandle("madnolia-browser.json")).bytes, markerBytes)
})

test("saved version-one workspace reconnects without rewriting its marker", async () => {
  const root = await savedHandle()
  root.permission = "granted"
  const marker = await root.getFileHandle("madnolia-browser.json")
  marker.bytes = validMarker
  assert.equal(await workspace.reconnectWorkspace(), root)
  assert.equal(marker.bytes, validMarker)
})
