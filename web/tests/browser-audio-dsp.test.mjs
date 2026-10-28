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

test("WSOLA stretches duration while keeping a steady tone near its source pitch", () => {
  const source = tone(220, 500)
  const stretched = stretchAudio(source, Math.round(source.length * 1.35))
  assert.equal(stretched.length, Math.round(source.length * 1.35))
  assert.ok(Math.abs(medianPitch(stretched) - 220) < 4)
  assert.ok(stretched.every(Number.isFinite))
})

test("autocorrelation pitch estimation selects the fundamental of a 440 Hz sine", () => {
  assert.ok(Math.abs(medianPitch(tone(440, 500)) - 440) < 5)
})

test("pitch shifting changes pitch while preserving the requested sample duration", () => {
  const source = tone(220, 500)
  const shifted = pitchShift(source, 200, source.length)
  assert.equal(shifted.length, source.length)
  assert.ok(Math.abs(medianPitch(shifted) - 220 * 2 ** (2 / 12)) < 6)
})

test("a pitch curve renders changing pitch without changing duration", async () => {
  const source = tone(220, 650)
  const cents = Float32Array.from({ length: source.length }, (_, index) => index < source.length / 2 ? 0 : 200)
  const rendered = await renderPitchCurve(source, cents)
  const early = medianPitch(rendered.slice(1_000, 4_000))
  const late = medianPitch(rendered.slice(6_500, 9_500))
  assert.equal(rendered.length, source.length)
  assert.ok(Math.abs(early - 220) < 8)
  assert.ok(Math.abs(late - 220 * 2 ** (2 / 12)) < 10)
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
