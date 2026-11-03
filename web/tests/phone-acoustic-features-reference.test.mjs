import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { registerHooks } from "node:module"
import test from "node:test"

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    try { return nextResolve(`${specifier}.ts`, context) } catch {}
  }
  return nextResolve(specifier, context)
} })

const { analyzePhoneAcousticFeatures } = await import("../src/browser/phoneAcousticFeatures.ts")
const fixture = JSON.parse(await readFile(new URL("./fixtures/phone-acoustic-features.json", import.meta.url), "utf8"))

test("phone acoustic features use Python context voicing, eligibility, and amplitude rules", () => {
  const { sample_rate: sampleRate, cases } = fixture
  const samples = new Float32Array(sampleRate)
  for (let index = 0; index < sampleRate * 0.25; index += 1) samples[index] = Math.round(0.2 * Math.sin(2 * Math.PI * 200 * index / sampleRate) * 32768) / 32768
  const phones = cases.map((item, index) => ({
    occurrence_id: `fixture-${index}`,
    phone_id: item.phone_id,
    start_ms: item.start_ms,
    end_ms: item.end_ms,
  }))
  const features = analyzePhoneAcousticFeatures(samples, sampleRate, phones)
  assert.equal(fixture.source, "legacy/python:src/madnolia/acoustic_features.py")
  assert.equal(fixture.source_commit, "f9ff39cd4d60d3c4dcd2e79c3f1b7bb919a416cd")
  for (const [index, feature] of features.entries()) {
    const expected = cases[index]
    assert.equal(feature.f0_hz, expected.f0_hz)
    assert.ok(Math.abs(feature.voiced_probability - expected.voiced_probability) < 1e-10)
    assert.ok(Math.abs(feature.rms_db - expected.rms_db) < 1e-10)
    assert.ok(Math.abs(feature.peak_db - expected.peak_db) < 1e-10)
  }
})
