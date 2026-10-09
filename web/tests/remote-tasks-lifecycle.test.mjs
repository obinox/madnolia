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

const { pollSearchJob, readRemoteTask, saveRemoteTask } = await import("../src/api/remoteTasks.ts")
const { REMOTE_TASK_SCHEMA_VERSION, REMOTE_TASK_STORAGE_KEY } = await import("../src/constants.ts")

const storage = new Map()
const timers = new Map()
let timerId = 0
globalThis.window = {
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  },
  setTimeout(callback) {
    const id = ++timerId
    timers.set(id, setTimeout(() => { timers.delete(id); callback() }, 2))
    return id
  },
  clearTimeout(id) {
    clearTimeout(timers.get(id))
    timers.delete(id)
  },
}

const job = (status, percent = 37) => ({ job_id: "search-1", status, stage: status, percent, result: null, error: null })
const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, statusText: "fixture", json: async () => body })

test("search polling retains progress through HTTP 500 and reaches completion", async () => {
  const sequence = [jsonResponse(job("running")), jsonResponse({ detail: "temporary" }, 500), jsonResponse(job("running")), jsonResponse({ ...job("complete", 100), result: { candidates: [], target_phones: [] } })]
  globalThis.fetch = async () => sequence.shift()
  const progress = []
  const result = await pollSearchJob("search-1", (status) => progress.push(status?.percent ?? null))
  assert.equal(result.status, "complete")
  assert.deepEqual(progress, [37, null, 37, 100])
})

test("invalid JSON and unknown statuses retry until a valid completion arrives", async () => {
  const sequence = [
    { ok: true, status: 200, json: async () => { throw new SyntaxError("bad JSON") } },
    jsonResponse(job("mystery")),
    jsonResponse({ ...job("complete", 100), result: { candidates: [], target_phones: [] } }),
  ]
  globalThis.fetch = async () => sequence.shift()
  const statuses = []
  const result = await pollSearchJob("search-1", (status) => statuses.push(status?.status ?? "retry"))
  assert.equal(result.status, "complete")
  assert.deepEqual(statuses, ["retry", "retry", "complete"])
})

test("only a confirmed 404 rejects polling as a disappeared job", async () => {
  globalThis.fetch = async () => jsonResponse({ detail: "missing" }, 404)
  await assert.rejects(pollSearchJob("search-1", () => {}), (error) => error.status === 404)
})

test("abort clears an outstanding retry timer", async () => {
  globalThis.fetch = async () => jsonResponse(job("running"))
  const controller = new AbortController()
  let received = false
  const polling = pollSearchJob("search-1", () => { received = true; setTimeout(() => controller.abort(), 1) }, controller.signal)
  await assert.rejects(polling, (error) => error.name === "AbortError")
  assert.equal(received, true)
  assert.equal(timers.size, 0)
})

test("remote descriptor guard accepts a valid search and removes malformed versions and export targets", () => {
  const valid = {
    version: REMOTE_TASK_SCHEMA_VERSION, job_id: "search-1", kind: "search", project_id: "project-1",
    label: "Exact search", search: { text: "hello", tab: "EXACT", input_language: "EN", pronunciation: "həˈloʊ" },
  }
  saveRemoteTask(valid)
  assert.equal(readRemoteTask().job_id, "search-1")
  storage.set(REMOTE_TASK_STORAGE_KEY, JSON.stringify({ ...valid, version: -1 }))
  assert.equal(readRemoteTask(), null)
  storage.set(REMOTE_TASK_STORAGE_KEY, JSON.stringify({ ...valid, kind: "export", composition_id: "comp-1", target: "EXE" }))
  assert.equal(readRemoteTask(), null)
  assert.equal(storage.has(REMOTE_TASK_STORAGE_KEY), false)
})
