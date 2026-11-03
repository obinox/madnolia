import assert from "node:assert/strict"
import { register } from "node:module"
import test from "node:test"
import { Tensor } from "@huggingface/transformers"

register("./resolve-typescript-loader.mjs", import.meta.url)
const { createWhisperWindowDecoder } = await import("../src/browser/whisperDecoding.ts")

const audio = new Float32Array(8_000)

function createFixture({ maxSourcePositions = 1_500, decodedText = "spoken", timestamp = [0.1005, 0.2005] } = {}) {
  const generationCalls = []
  const decodeCalls = []
  const diagnostics = []
  const model = {
    config: { max_source_positions: maxSourcePositions, median_filter_width: 1, conv_stride: [1, 2] },
    generation_config: {
      alignment_heads: [[0, 0]],
      decoder_start_token_id: 1,
      is_multilingual: true,
      lang_to_id: { "<|en|>": 2 },
      task_to_id: { transcribe: 3 },
      no_timestamps_token_id: 4,
    },
    _retrieve_init_tokens(config) {
      assert.equal(config.language, "en")
      assert.equal(config.task, "transcribe")
      assert.equal(config.return_timestamps, false)
      return [1, config.lang_to_id["<|en|>"], config.task_to_id.transcribe, config.no_timestamps_token_id]
    },
    async generate(options) {
      generationCalls.push(options)
      const tokenIds = options.decoder_input_ids
        ? [90n, 21n, 22n, 1n, 2n, 3n, 4n, 30n, 31n]
        : [1n, 2n, 3n, 4n, 30n, 31n]
      const queryRows = tokenIds.length - 1
      const frameWidth = 1_000
      const weights = new Float32Array(queryRows * frameWidth)
      for (let query = 0; query < queryRows; query += 1) weights[query * frameWidth + query * 17 + 2] = 1
      return {
        sequences: new Tensor("int64", BigInt64Array.from(tokenIds), [1, tokenIds.length]),
        cross_attentions: [[new Tensor("float32", weights, [1, 1, queryRows, frameWidth])]],
      }
    },
  }
  const tokenizer = {
    model: { tokens_to_ids: new Map([["<|startofprev|>", 90]]) },
    bos_token_id: 1,
    eos_token_id: 99,
    encode(text, options) {
      assert.deepEqual(options, { add_special_tokens: false })
      if (text === "<|startofprev|>") return [90]
      assert.equal(text, " prior context")
      return [21, 22]
    },
    _decode_asr(chunks, options) {
      decodeCalls.push({ chunks, options })
      return [decodedText, { chunks: [{ text: decodedText, timestamp }] }]
    },
  }
  const processor = Object.assign(async () => ({ input_features: new Tensor("float32", new Float32Array(1), [1, 1]) }), {
    feature_extractor: { config: { chunk_length: 30, sampling_rate: 16_000, hop_length: 160 } },
  })
  const decode = createWhisperWindowDecoder({ model, tokenizer, processor, language: "en", onDiagnostic: (item) => diagnostics.push(item) })
  return { decode, generationCalls, decodeCalls, diagnostics }
}

test("prepends context before the full standard prefix, then strips context IDs and timestamps", async () => {
  const fixture = createFixture()
  const words = await fixture.decode(audio, { contextPrompt: "prior context", maxNewTokens: 32, window: { start_ms: 0, end_ms: 500, keep_start_ms: 0, keep_end_ms: 500 } })
  const call = fixture.generationCalls[0]
  assert.deepEqual(call.decoder_input_ids, [90, 21, 22, 1, 2, 3, 4])
  assert.equal(call.max_new_tokens, 32)
  assert.equal(call.language, "en")
  assert.equal(call.task, "transcribe")
  assert.equal(call.return_token_timestamps, false)
  assert.equal(call.output_attentions, true)
  assert.equal(call.return_dict_in_generate, true)
  assert.deepEqual(fixture.decodeCalls[0].chunks[0].tokens, [1n, 2n, 3n, 4n, 30n, 31n])
  assert.deepEqual(fixture.decodeCalls[0].chunks[0].token_timestamps, fixture.diagnostics[0].tokenTimestampsSeconds.slice(3))
  assert.deepEqual(fixture.decodeCalls[0].chunks[0].stride, [0.5, 0, 0])
  assert.deepEqual(fixture.decodeCalls[0].options, { time_precision: 0.02, return_timestamps: "word", force_full_sequences: false })
  assert.equal(fixture.diagnostics[0].strippedContextTokenCount, 3)
  assert.equal(fixture.diagnostics[0].tokenTimestampsSeconds.length, 9)
  assert.doesNotThrow(() => JSON.stringify(fixture.diagnostics[0]))
  assert.deepEqual(words, [{ text: "spoken", start_ms: 100, end_ms: 200 }])
})

test("uses model default decoder prefix when context is empty", async () => {
  const fixture = createFixture()
  await fixture.decode(audio, { contextPrompt: "", maxNewTokens: 17, window: { start_ms: 0, end_ms: 500, keep_start_ms: 0, keep_end_ms: 500 } })
  const call = fixture.generationCalls[0]
  assert.equal(Object.hasOwn(call, "decoder_input_ids"), false)
  assert.equal(call.max_new_tokens, 17)
  assert.equal(call.language, "en")
  assert.equal(call.task, "transcribe")
  assert.deepEqual(fixture.decodeCalls[0].chunks[0].tokens, [1n, 2n, 3n, 4n, 30n, 31n])
  assert.deepEqual(fixture.decodeCalls[0].chunks[0].token_timestamps, fixture.diagnostics[0].tokenTimestampsSeconds)
})

test("uses encoder frame crop from audio duration and 20 ms model precision", async () => {
  const fixture = createFixture()
  await fixture.decode(audio, { contextPrompt: "prior context", maxNewTokens: 32, window: { start_ms: 0, end_ms: 500, keep_start_ms: 0, keep_end_ms: 500 } })
  const diagnostic = fixture.diagnostics[0]
  assert.ok(Math.max(...diagnostic.tokenTimestampsSeconds) <= 0.5)
})

test("crops encoder frames by whole sample hops at the 20 ms boundary", async () => {
  const fixture = createFixture()
  await fixture.decode(new Float32Array(37_119), { contextPrompt: "", maxNewTokens: 32, window: { start_ms: 0, end_ms: 2_320, keep_start_ms: 0, keep_end_ms: 2_320 } })
  assert.equal(fixture.diagnostics[0].encoderFrameCount, 115)
  await fixture.decode(new Float32Array(37_120), { contextPrompt: "", maxNewTokens: 32, window: { start_ms: 0, end_ms: 2_320, keep_start_ms: 0, keep_end_ms: 2_320 } })
  assert.equal(fixture.diagnostics[1].encoderFrameCount, 116)
})

test("reports missing frame configuration before attempting inference", () => {
  assert.throws(() => createFixture({ maxSourcePositions: null }), /max_source_positions/)
})

test("fails clearly when nonempty text has no positive finite word bounds", async () => {
  const fixture = createFixture({ timestamp: [0.2, 0.2] })
  await assert.rejects(
    fixture.decode(audio, { contextPrompt: "", maxNewTokens: 32, window: { start_ms: 0, end_ms: 500, keep_start_ms: 0, keep_end_ms: 500 } }),
    /nonempty text without any usable positive finite word timestamp bounds/u,
  )
})
