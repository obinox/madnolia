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

const { encodeWav, estimatePitch, pitchShift, renderPitchCurve, stretchAudio } = await import("../src/browser/audioDsp.ts")
const sampleRate = 16_000

function tone(hz, durationMs, amplitude = 0.5) {
  const length = Math.round(sampleRate * durationMs / 1000)
  return Float32Array.from({ length }, (_, index) => amplitude * Math.sin(2 * Math.PI * hz * index / sampleRate))
}

function medianPitch(samples) {
  const frames = estimatePitch(samples, sampleRate).filter((frame) => frame.hz !== null)
  assert.ok(frames.length > 0, "the estimator should find voiced frames")
  const pitches = frames.map((frame) => frame.hz).sort((left, right) => left - right)
  return pitches[Math.floor(pitches.length / 2)]
}

function oracleSignal(length = 3200) {
  return Float32Array.from({ length }, (_, index) =>
    0.31 * Math.sin(2 * Math.PI * 220 * index / sampleRate)
      + 0.12 * Math.sin(2 * Math.PI * 440 * index / sampleRate)
      + 0.04 * Math.sin(2 * Math.PI * 880 * index / sampleRate),
  )
}

function assertOracleSamples(actual, indices, expected, tolerance = 2e-5) {
  for (const [index, value] of indices.map((index, offset) => [index, expected[offset]])) {
    assert.ok(Math.abs(actual[index] - value) <= tolerance, `sample ${index}: ${actual[index]} != ${value}`)
  }
}

test("WSOLA stretches duration while keeping a steady tone near its source pitch", () => {
  const source = tone(220, 500)
  const stretched = stretchAudio(source, Math.round(source.length * 1.35))
  assert.equal(stretched.length, Math.round(source.length * 1.35))
  assert.ok(Math.abs(medianPitch(stretched) - 220) < 4)
  assert.ok(stretched.every(Number.isFinite))
  const oracle = stretchAudio(oracleSignal(), 4160)
  assertOracleSamples(oracle, [0, 1, 17, 79, 159, 319, 640, 1024, 1599, 2048, 3000, 4159], [
    0, 0.06092978, 0.31683412, 0.29902872, 0.33165699, 0.07321158,
    -0.32617509, 0.26663992, -0.1396791, 0.3418878, 0.32243326, -0.06092978,
  ])
})

test("autocorrelation pitch estimation selects the fundamental of a 440 Hz sine", () => {
  assert.ok(Math.abs(medianPitch(tone(440, 500)) - 440) < 5)
})

test("pitch shifting changes pitch while preserving the requested sample duration", () => {
  const source = tone(220, 500)
  const shifted = pitchShift(source, 200, source.length)
  assert.equal(shifted.length, source.length)
  assert.ok(Math.abs(medianPitch(shifted) - 220 * 2 ** (2 / 12)) < 6)
  const oracle = pitchShift(oracleSignal(), 200)
  assertOracleSamples(oracle, [0, 1, 17, 79, 159, 319, 640, 1024, 1599, 2048, 3000], [
    -0.00000001, 0.06809514, 0.30258915, 0.32150003, -0.01311232, -0.27931008,
    -0.33747777, -0.32765213, -0.21113344, -0.04246097, -0.2121516,
  ])
})

test("a varying pitch curve matches the Python curve renderer", async () => {
  const source = tone(220, 650)
  const cents = Float32Array.from({ length: source.length }, (_, index) => index < source.length / 2 ? 0 : 200)
  const rendered = await renderPitchCurve(source, cents)
  const early = medianPitch(rendered.slice(1_000, 4_000))
  const late = medianPitch(rendered.slice(6_500, 9_500))
  assert.equal(rendered.length, source.length)
  assert.ok(Math.abs(early - 220) < 8)
  assert.ok(Math.abs(late - 220 * 2 ** (2 / 12)) < 10)
  const oracleSource = oracleSignal()
  const oracleCents = Float32Array.from({ length: oracleSource.length }, (_, index) => 200 * index / (oracleSource.length - 1))
  const oracle = await renderPitchCurve(oracleSource, oracleCents)
  assertOracleSamples(oracle, [0, 1, 17, 79, 159, 319, 640, 1024, 1599, 2048, 3000], [
    0, 0.060939, 0.31679049, 0.3016943, 0.32950211, 0.02172935,
    -0.30964187, 0.15910591, -0.16261464, 0.30473983, 0.18959913,
  ])
})

test("formant correction matches the cepstral Python reference", async () => {
  const source = oracleSignal()
  const cents = new Float32Array(source.length)
  const corrected = await renderPitchCurve(source, cents, undefined, 4)
  assertOracleSamples(corrected, [0, 1, 17, 79, 159, 319, 640, 1024, 1599, 2048, 3000], [
    0.04916558, 0.17564915, 0.22497162, 0.3570579, 0.20875975, 0.02412573,
    -0.20436394, 0.35706034, -0.08995823, 0.23963112, 0.27455401,
  ], 5e-5)
})

test("pitch estimation includes the final off-grid analysis frame", () => {
  const samples = tone(440, 60.0625)
  const frames = estimatePitch(samples, sampleRate)
  assert.equal(frames.length, 4)
  assert.equal(frames.at(-1).timeMs, 40.0625)
  assert.ok(Math.abs(frames.at(-1).hz - 440.006574) < 0.1)
  assert.ok(Math.abs(frames.at(-1).periodicity - 0.9999) < 0.01)
})

test("WAV encoding writes mono PCM16 headers and clips non-finite samples safely", async () => {
  const blob = encodeWav({ samples: Float32Array.of(-1, 0, 1, Number.NaN, Number.POSITIVE_INFINITY), sampleRate })
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const view = new DataView(bytes.buffer)
  assert.equal(blob.type, "audio/wav")
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "RIFF")
  assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), "WAVE")
  assert.equal(view.getUint16(22, true), 1)
  assert.equal(view.getUint32(24, true), sampleRate)
  assert.equal(view.getUint16(34, true), 16)
  assert.equal(view.getUint32(40, true), 10)
  assert.equal(view.getInt16(44, true), -32768)
  assert.equal(view.getInt16(48, true), 32767)
  assert.equal(view.getInt16(50, true), 0)
  assert.equal(view.getInt16(52, true), 0)
})
