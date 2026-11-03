import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import test from "node:test"


registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/iu.test(specifier)) {
      try { return nextResolve(`${specifier}.ts`, context) } catch {}
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".ts")) return nextLoad(url, context)
    return nextLoad(url, context)
  },
})

const { canCopyRegionAudio, copyRegionAudio, overlayWorldSlices } = await import("../src/browser/regionWorldMerge.ts")

test("unchanged regions keep exact-copy eligibility", () => {
  const segment = { timeline_start_ms: 0, timeline_end_ms: 200, pitch_envelope: [], phone_units: [] }
  const regions = [{ region: { output_duration_ms: 100, source_end_ms: 100, source_start_ms: 0, relative_pitch_cents: 0, pitch_points: [] } }, { region: { output_duration_ms: 100, source_end_ms: 300, source_start_ms: 200, relative_pitch_cents: 0, pitch_points: [] } }]
  assert.equal(canCopyRegionAudio(regions, segment, []), true)
  assert.equal(canCopyRegionAudio(regions, segment, [{ start_ms: 50, end_ms: 75 }]), false)
  const source = Float32Array.from({ length: 8 }, (_, index) => index / 10)
  const output = new Float32Array(4)
  copyRegionAudio(output, source, 1_000, [{ region: { source_start_ms: 1, source_end_ms: 3 } }, { region: { source_start_ms: 6, source_end_ms: 8 } }])
  assert.deepEqual([...output], [...source.slice(1, 3), ...source.slice(6, 8)])
})

test("WORLD slices leave all base samples outside selected ranges unchanged", () => {
  const base = Float32Array.from({ length: 12 }, (_, index) => index / 20)
  const expected = new Float32Array(base)
  const world = new Float32Array(12).fill(0.9)
  overlayWorldSlices(base, world, [[2, 5], [8, 10]])
  for (let index = 0; index < base.length; index += 1) {
    assert.equal(base[index], index >= 2 && index < 5 || index >= 8 && index < 10 ? world[index] : expected[index])
  }
})
