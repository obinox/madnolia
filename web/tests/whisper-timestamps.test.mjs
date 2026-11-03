import assert from "node:assert/strict"
import { register } from "node:module"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { Tensor } from "@huggingface/transformers"

register("./resolve-typescript-loader.mjs", import.meta.url)
const { extractWhisperTokenTimestamps } = await import("../src/browser/whisperTimestamps.ts")

const fixture = JSON.parse(await readFile(new URL("./fixtures/whisper-timestamps-reference.json", import.meta.url), "utf8"))

function attentionTensor(heads, frameWidth = heads[0][0].length) {
  const tokens = heads[0].length
  const headCount = heads.length
  const data = new Float32Array(headCount * tokens * frameWidth)
  for (let head = 0; head < headCount; head += 1) {
    for (let token = 0; token < tokens; token += 1) {
      data.set(heads[head][token].slice(0, frameWidth), (head * tokens + token) * frameWidth)
    }
  }
  return new Tensor("float32", data, [1, headCount, tokens, frameWidth])
}

const sequences = (count) => new Tensor("int64", new BigInt64Array(count).fill(1n), [1, count])
const options = (heads, count, extras = {}) => ({
  crossAttentions: [[attentionTensor(heads)]],
  sequences: sequences(count),
  alignmentHeads: [[0, 0], [0, 1]],
  encoderFrameCount: fixture.encoder_frame_count,
  timePrecisionSeconds: fixture.time_precision_seconds,
  medianFilterWidth: fixture.median_filter_width,
  ...extras,
})

const scaledTimestamps = (values) => Array.from(values, (value) => Math.round(value * 1_000_000))

test("Whisper timestamps match an independent Python normalization, median, and DTW fixture", () => {
  const result = extractWhisperTokenTimestamps(options(fixture.attention_heads, fixture.sequence_token_count))
  assert.deepEqual(scaledTimestamps(result.data), scaledTimestamps(fixture.expected_output_timestamps_seconds))
  assert.equal(result.dims.join(","), `1,${fixture.sequence_token_count}`)
  assert.ok(Array.from(result.data).every(Number.isFinite))
  assert.ok(Array.from(result.data).every((value, index, values) => index === 0 || value >= values[index - 1]))
  assert.ok(Math.max(...result.data) <= fixture.encoder_frame_count * fixture.time_precision_seconds)
})

test("constant zero-variance attention columns normalize to finite neutral values", () => {
  const paddedZeroHeads = fixture.attention_heads.map((head) => head.map((row) => [...row]))
  const result = extractWhisperTokenTimestamps(options(paddedZeroHeads, 7, { encoderFrameCount: 8 }))
  assert.ok(Array.from(result.data).every(Number.isFinite))
  assert.ok(result.data[6] > result.data[0])
})

test("10 ms mel-frame input can crop to an explicit 20 ms encoder-frame width", () => {
  const width = 1100
  const encoderFrames = 550
  const heads = [0, 1].map((headIndex) => Array.from({ length: 4 }, (_, token) => {
    const row = new Array(width).fill(0)
    row[10 + token * 100 + headIndex] = 10
    row[encoderFrames + 10 + token * 100] = 1000
    return row
  }))
  const result = extractWhisperTokenTimestamps({
    crossAttentions: [[attentionTensor(heads, width)]],
    sequences: sequences(5),
    alignmentHeads: [[0, 0], [0, 1]],
    encoderFrameCount: encoderFrames,
    timePrecisionSeconds: 0.02,
    medianFilterWidth: 1,
  })
  assert.equal(result.dims[1], 5)
  assert.ok(Math.max(...result.data) <= encoderFrames * 0.02)
  assert.deepEqual(scaledTimestamps(result.data), scaledTimestamps(fixture.mel_crop_expected_output_timestamps_seconds))
  assert.ok(new Set(Array.from(result.data).filter((value) => value > 0).map((value) => Math.round(value * 1_000_000))).size >= 3)
  const tailZeroHeads = heads.map((head) => head.map((row) => row.map((value, frame) => frame < encoderFrames ? value : 0)))
  const tailZeroTensor = attentionTensor(tailZeroHeads, width)
  const baseline = extractWhisperTokenTimestamps({
    crossAttentions: [[tailZeroTensor]],
    sequences: sequences(5),
    alignmentHeads: [[0, 0], [0, 1]],
    encoderFrameCount: encoderFrames,
    timePrecisionSeconds: 0.02,
    medianFilterWidth: 1,
  })
  assert.deepEqual(scaledTimestamps(result.data), scaledTimestamps(baseline.data))
})

test("non-finite attention fails with its step and layer location", () => {
  const heads = fixture.attention_heads.map((head) => head.map((row) => [...row]))
  heads[1][2][3] = Number.NaN
  assert.throws(() => extractWhisperTokenTimestamps(options(heads, 6)), /non-finite value at step 0, layer 0/u)
})

test("context prefix query rows are excluded and their timestamp slots are restored as zero", () => {
  const withoutContext = extractWhisperTokenTimestamps(options(fixture.attention_heads, fixture.sequence_token_count))
  const heads = fixture.attention_heads.map((head) => head.map((row) => [...row]))
  for (const head of heads) head.unshift([100, 0, 0, 0, 0, 0, 0, 0])
  const result = extractWhisperTokenTimestamps({
    ...options(heads, 8),
    previousContextTokenCount: 1,
  })
  assert.equal(result.data[0], 0)
  assert.equal(result.data[1], 0)
  assert.deepEqual(scaledTimestamps(result.data.slice(2)), scaledTimestamps(withoutContext.data.slice(1)))
})

test("context stripping preserves the SOT and task prompt queries after the context rows", () => {
  const heads = fixture.attention_heads.map((head) => head.map((row) => [...row]))
  for (const head of heads) head.unshift([100, 0, 0, 0, 0, 0, 0, 0], [0, 9, 0, 0, 0, 0, 0, 0])
  const result = extractWhisperTokenTimestamps({
    ...options(heads, 9),
    previousContextTokenCount: 1,
  })
  assert.equal(result.dims[1], 9)
  assert.equal(result.data[0], 0)
  assert.equal(result.data[1], 0)
  assert.equal(result.data[2], 0)
  assert.ok(result.data[3] >= result.data[2])
})

test("autoregressive attention maps four initial queries and two cached queries to seven sequence tokens", () => {
  const heads = fixture.attention_heads.map((head) => head.map((row) => [...row]))
  const crossAttentions = [
    [attentionTensor(heads.map((head) => head.slice(0, 4)))],
    [attentionTensor(heads.map((head) => head.slice(4, 5)))],
    [attentionTensor(heads.map((head) => head.slice(5, 6)))],
  ]
  const result = extractWhisperTokenTimestamps({
    ...options(fixture.attention_heads, fixture.sequence_token_count),
    crossAttentions,
    sequences: new Tensor("int64", new BigInt64Array([50258n, 1n, 2n, 3n, 4n, 5n, 50257n]), [1, 7]),
  })
  assert.deepEqual(scaledTimestamps(result.data), scaledTimestamps(fixture.expected_output_timestamps_seconds))
  assert.equal(scaledTimestamps([result.data[6]])[0], scaledTimestamps([fixture.expected_output_timestamps_seconds[6]])[0])
})

test("query rows must correspond to every sequence token after the initial token", () => {
  assert.throws(() => extractWhisperTokenTimestamps(options(fixture.attention_heads, 6)), /expected one query per token/u)
})
