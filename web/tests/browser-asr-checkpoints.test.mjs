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

const { readAsrWindowCheckpoint, validateAsrCheckpoint } = await import("../src/browser/asrCheckpoints.ts")

class MemoryFile {
  constructor(text) { this.value = text }
  async getFile() { return { text: async () => this.value } }
}

class MemoryDirectory {
  constructor(entries = new Map()) { this.entries = entries }
  async getDirectoryHandle(name, options = {}) {
    if (!this.entries.has(name) && options.create) this.entries.set(name, new MemoryDirectory())
    if (!this.entries.has(name)) throw new DOMException("Not found", "NotFoundError")
    return this.entries.get(name)
  }
  async *values() { yield* this.entries.values() }
}

const file = (name, text) => Object.assign(new MemoryFile(text), { name, kind: "file" })

test("ASR checkpoint validation requires matching identity, exact finite window, and bounded timed words", () => {
  const window = { start_ms: 1000, end_ms: 5000, keep_start_ms: 1000, keep_end_ms: 5000 }
  const checkpoint = { version: 1, identity: "digest", context_hash: "previous", window, words: [{ text: "hello", start_ms: 100, end_ms: 400 }] }
  assert.deepEqual(validateAsrCheckpoint(checkpoint, "digest", window, "previous"), checkpoint.words)
  assert.equal(validateAsrCheckpoint(checkpoint, "digest", window), null)
  assert.equal(validateAsrCheckpoint(checkpoint, "other", window, "previous"), null)
  assert.equal(validateAsrCheckpoint(checkpoint, "digest", { ...window, keep_start_ms: 0 }, "previous"), null)
  assert.equal(validateAsrCheckpoint({ ...checkpoint, window: { ...window, start_ms: NaN } }, "digest", window, "previous"), null)
  assert.equal(validateAsrCheckpoint({ ...checkpoint, window: { ...window, keep_end_ms: 5001 } }, "digest", window, "previous"), null)
  assert.equal(validateAsrCheckpoint({ ...checkpoint, words: [{ text: "", start_ms: 0, end_ms: 1 }] }, "digest", window, "previous"), null)
  assert.equal(validateAsrCheckpoint({ ...checkpoint, words: [{ text: "bad", start_ms: 0, end_ms: 4001 }] }, "digest", window, "previous"), null)
  assert.deepEqual(validateAsrCheckpoint({ ...checkpoint, words: [] }, "digest", window, "previous"), [])
})

test("checkpoint lookup leaves missing directories alone and chooses latest valid matching context", async () => {
  const root = new MemoryDirectory()
  const window = { start_ms: 0, end_ms: 1000, keep_start_ms: 0, keep_end_ms: 1000 }
  assert.equal(await readAsrWindowCheckpoint(root, "checkpoints/job", 0, "digest", window, "ctx"), null)
  assert.equal(root.entries.size, 0)
  const good = { version: 1, identity: "digest", context_hash: "ctx", window, words: [] }
  const old = { version: 1, identity: "digest", context_hash: "ctx", window: good.window, words: [{ text: "old", start_ms: 1, end_ms: 2 }] }
  const wrongContext = { ...good, context_hash: "stale" }
  const checkpointDirectory = new MemoryDirectory(new Map([
    ["000001-0000000000000001-old.json", file("000001-0000000000000001-old.json", JSON.stringify(old))],
    ["000001-0000000000000002-bad.json", file("000001-0000000000000002-bad.json", "{")],
    ["000001-0000000000000003-stale.json", file("000001-0000000000000003-stale.json", JSON.stringify(wrongContext))],
    ["000001-0000000000000004-latest.json", file("000001-0000000000000004-latest.json", JSON.stringify(good))],
  ]))
  root.entries.set("checkpoints", new MemoryDirectory(new Map([["job", checkpointDirectory]])))
  assert.deepEqual(await readAsrWindowCheckpoint(root, "checkpoints/job", 0, "digest", good.window, "ctx"), [])
  assert.equal(checkpointDirectory.entries.size, 4)
  const corruptOnly = new MemoryDirectory(new Map([["000001-0000000000000005-corrupt.json", file("000001-0000000000000005-corrupt.json", "{")]]))
  root.entries.set("corrupt", corruptOnly)
  assert.equal(await readAsrWindowCheckpoint(root, "corrupt", 0, "digest", good.window, "ctx"), null)
  assert.equal(corruptOnly.entries.size, 1)
})

test("checkpoint lookup does not turn permission failures into cache misses", async () => {
  const denied = { async getDirectoryHandle() { throw new DOMException("Denied", "SecurityError") } }
  await assert.rejects(readAsrWindowCheckpoint(denied, "checkpoints/job", 0, "digest", { start_ms: 0, end_ms: 1000, keep_start_ms: 0, keep_end_ms: 1000 }), { name: "SecurityError" })
})
