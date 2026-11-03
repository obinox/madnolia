import assert from "node:assert/strict"

const moduleUrl = new URL("../public/wasm/world.js", import.meta.url)
const factory = (await import(moduleUrl)).default
assert.equal(typeof factory, "function")
const world = await factory()
const framePeriodMs = 5
const sampleRate = 16_000
const samples = Float64Array.from({ length: sampleRate }, (_, index) => {
  const envelope = Math.min(1, index / 800, (sampleRate - index) / 800)
  return envelope * (0.38 * Math.sin(2 * Math.PI * 220 * index / sampleRate) + 0.17 * Math.sin(2 * Math.PI * 440 * index / sampleRate))
})
const allocate = (size) => {
  const pointer = world._malloc(size)
  assert.ok(pointer > 0)
  return pointer
}
const allocated = []
const allocateTracked = (size) => {
  const pointer = allocate(size)
  allocated.push(pointer)
  return pointer
}
const dimensions = allocateTracked(8)
const input = allocateTracked(samples.length * 8)
try {
  assert.equal(world._world_dimensions(samples.length, sampleRate, framePeriodMs, dimensions, dimensions + 4), 0)
  const frames = world.HEAP32[dimensions >> 2]
  const fftSize = world.HEAP32[(dimensions >> 2) + 1]
  const bins = fftSize / 2 + 1
  const f0 = allocateTracked(frames * 8)
  const times = allocateTracked(frames * 8)
  const f0Only = allocateTracked(frames * 8)
  const timesOnly = allocateTracked(frames * 8)
  const spectrum = allocateTracked(frames * bins * 8)
  const aperiodicity = allocateTracked(frames * bins * 8)
  const output = allocateTracked(sampleRate * 8)
  world.HEAPF64.set(samples, input / 8)
  assert.equal(world._world_analyze(input, samples.length, sampleRate, framePeriodMs, frames, fftSize, f0, times, spectrum, aperiodicity), 0)
  assert.equal(world._world_analyze_f0(input, samples.length, sampleRate, framePeriodMs, frames, f0Only, timesOnly), 0)
  for (let index = 0; index < frames; index += 1) {
    assert.ok(Math.abs(world.HEAPF64[f0 / 8 + index] - world.HEAPF64[f0Only / 8 + index]) < 1e-8)
    assert.ok(Math.abs(world.HEAPF64[times / 8 + index] - world.HEAPF64[timesOnly / 8 + index]) < 1e-9)
  }
  const estimated = world.HEAPF64.subarray(f0 / 8, f0 / 8 + frames).filter((value) => value > 0)
  assert.ok(estimated.length > 100)
  const sorted = [...estimated].sort((left, right) => left - right)
  const medianF0 = sorted[Math.floor(sorted.length / 2)]
  assert.ok(Math.abs(medianF0 - 220) < 8, `expected 220 Hz, got ${medianF0}`)
  assert.ok(world.HEAPF64.subarray(spectrum / 8, spectrum / 8 + frames * bins).every(Number.isFinite))
  assert.ok(world.HEAPF64.subarray(aperiodicity / 8, aperiodicity / 8 + frames * bins).every(Number.isFinite))
  const changingF0 = new Float64Array(world.HEAPF64.subarray(f0 / 8, f0 / 8 + frames))
  const changingSpectrum = new Float64Array(world.HEAPF64.subarray(spectrum / 8, spectrum / 8 + frames * bins))
  for (let frame = 0; frame < frames; frame += 1) {
    if (changingF0[frame] > 0) changingF0[frame] *= 2 ** ((frame < frames / 2 ? -100 : 100) / 1200)
  }
  world.HEAPF64.set(changingF0, f0 / 8)
  world.HEAPF64.set(changingSpectrum, spectrum / 8)
  assert.equal(world._world_synthesize(f0, frames, spectrum, aperiodicity, fftSize, framePeriodMs, sampleRate, sampleRate, output), 0)
  const rendered = world.HEAPF64.subarray(output / 8, output / 8 + sampleRate)
  assert.ok(rendered.every(Number.isFinite))
  const rms = Math.sqrt(rendered.reduce((sum, value) => sum + value * value, 0) / rendered.length)
  assert.ok(rms > 0.01 && rms < 0.9, `unexpected synthesis RMS ${rms}`)
  console.log(`WORLD WASM smoke passed: ${frames} frames, FFT ${fftSize}, median F0 ${medianF0.toFixed(2)} Hz, RMS ${rms.toFixed(4)}`)
} finally {
  for (const pointer of allocated.reverse()) world._free(pointer)
}
