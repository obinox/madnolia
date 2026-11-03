import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { BROWSER_ASR_DEFAULT_LANGUAGE, BROWSER_ASR_DEFAULT_MODEL, BROWSER_ASR_MODELS, BROWSER_ASR_TASK } from "../src/browserAnalysisConstants.ts"

test("ASR uses Korean transcription by default and passes explicit language and task options", async () => {
  const worker = await readFile(new URL("../src/browser/analysis.worker.ts", import.meta.url), "utf8")
  assert.equal(BROWSER_ASR_DEFAULT_LANGUAGE, "ko")
  assert.equal(BROWSER_ASR_TASK, "transcribe")
  assert.match(worker, /language: settings\.asr_language \?\? BROWSER_ASR_DEFAULT_LANGUAGE/u)
  assert.match(worker, /task: BROWSER_ASR_TASK/u)
  assert.match(worker, /asr_language: settings\.asr_language \?\? BROWSER_ASR_DEFAULT_LANGUAGE/u)
})

test("ASR baseline keeps the large-v3 selection and full precision", () => {
  assert.equal(BROWSER_ASR_DEFAULT_MODEL, "onnx-community/whisper-large-v3-ONNX")
  for (const model of BROWSER_ASR_MODELS) {
    assert.ok(model.artifacts.baseline.model_id)
    assert.equal(model.artifacts.baseline.dtype.webgpu, "fp32")
    assert.equal(model.artifacts.baseline.dtype.wasm, "fp32")
  }
})

test("large-v3 keeps same-checkpoint FP32 baseline and Q4 compact artifacts pinned", () => {
  const model = BROWSER_ASR_MODELS.find(({ id }) => id === BROWSER_ASR_DEFAULT_MODEL)
  assert.ok(model)
  assert.equal(model.artifacts.baseline.model_id, "Xenova/whisper-large-v3")
  assert.equal(model.artifacts.baseline.revision, "67bf02d92b7754a1ff82a7f8545f8b8c378b2ef0")
  assert.equal(model.artifacts.compact.model_id, "musetric/whisper-large-v3-onnx")
  assert.equal(model.artifacts.compact.revision, "228b20358cc86d1f8cc30299dc940438a3a7e4a0")
  assert.equal(model.artifacts.compact.subfolder, "")
  assert.equal(model.artifacts.compact.dtype.webgpu, "q4")
  assert.equal(model.artifacts.compact.dtype.wasm, "q4")
  assert.equal(model.artifacts.baseline.external_data_format.encoder_model, true)
  assert.equal(model.artifacts.baseline.external_data_format.decoder_model_merged, true)
})

test("smaller Whisper checkpoints are pinned to immutable revisions", () => {
  const revisions = new Map(BROWSER_ASR_MODELS.map(({ id, artifacts }) => [id, artifacts.baseline.revision]))
  assert.equal(revisions.get("Xenova/whisper-small"), "2d67713f236afa48a18992566e7647f6ca848e13")
  assert.equal(revisions.get("Xenova/whisper-base"), "64da57285918e20ea79ea5c88eed7197933abaa8")
  assert.equal(revisions.get("Xenova/whisper-tiny"), "5332fcc35e32a33b86612b9a57a89be7906102b1")
})

test("turbo compact preserves the timestamped turbo artifact and reports its actual q8 dtype", () => {
  const model = BROWSER_ASR_MODELS.find(({ id }) => id === "onnx-community/whisper-large-v3-turbo_timestamped")
  assert.ok(model)
  assert.equal(model.artifacts.compact.model_id, model.id)
  assert.equal(model.artifacts.compact.revision, "b3f77bf9a8c4d5ea3415827033d1ffea7955fd9a")
  assert.equal(model.artifacts.compact.dtype.webgpu, "q8")
  assert.equal(model.artifacts.compact.dtype.wasm, "q8")
})
