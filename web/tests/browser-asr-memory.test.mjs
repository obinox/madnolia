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

const { BROWSER_ASR_WASM_MEMORY_EVIDENCE, BROWSER_ASR_WASM_MEMORY_ERROR } = await import("../src/browserAsrMemoryConstants.ts")
const { assertAsrMemoryPreflight } = await import("../src/browser/asrMemory.ts")

const knownArtifact = {
  model_id: BROWSER_ASR_WASM_MEMORY_EVIDENCE.artifact.modelId,
  revision: BROWSER_ASR_WASM_MEMORY_EVIDENCE.artifact.revision,
}

test("rejects the known pinned FP32 WASM profile with exact size evidence", () => {
  assert.equal(BROWSER_ASR_WASM_MEMORY_EVIDENCE.artifact.externalWeightBytes, 6173962240)
  assert.equal(BROWSER_ASR_WASM_MEMORY_EVIDENCE.wasmHeap.maximumBytes, 4294967296)
  assert.match(BROWSER_ASR_WASM_MEMORY_ERROR, /6,173,962,240 external weight bytes \(~5\.75 GiB\)/u)
  assert.match(BROWSER_ASR_WASM_MEMORY_ERROR, /4,294,967,296 bytes \(4 GiB\)/u)
  assert.throws(() => assertAsrMemoryPreflight(knownArtifact, "fp32", "wasm"), /6,173,962,240/u)
})

test("allows the same pinned FP32 artifact on WebGPU unchanged", () => {
  assert.equal(assertAsrMemoryPreflight(knownArtifact, "fp32", "webgpu"), undefined)
})

test("allows the compact Q4 profile on WASM unchanged", () => {
  assert.equal(assertAsrMemoryPreflight({ model_id: "musetric/whisper-large-v3-onnx", revision: "228b20358cc86d1f8cc30299dc940438a3a7e4a0" }, "q4", "wasm"), undefined)
})

test("does not guess for unknown models or revisions", () => {
  assert.equal(assertAsrMemoryPreflight({ model_id: "other/model", revision: knownArtifact.revision }, "fp32", "wasm"), undefined)
  assert.equal(assertAsrMemoryPreflight({ model_id: knownArtifact.model_id, revision: "another-revision" }, "fp32", "wasm"), undefined)
})

test("does not mutate artifact input", () => {
  const artifact = { ...knownArtifact }
  const before = structuredClone(artifact)
  assert.throws(() => assertAsrMemoryPreflight(artifact, "fp32", "wasm"))
  assert.deepEqual(artifact, before)
})
