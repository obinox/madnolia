import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { registerHooks } from "node:module"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { rm } from "node:fs/promises"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/iu.test(specifier)) {
      try { return nextResolve(`${specifier}.ts`, context) } catch {}
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".ts")) {
      return nextLoad(url, context)
    }
    return nextLoad(url, context)
  },
})

const worldFixture = JSON.parse(await readFile(new URL("./fixtures/world-worker-reference.json", import.meta.url), "utf8"))

function bytesOf(view) {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength)
}

function findPythonOracle() {
  const virtualenvPython = process.platform === "win32" ? resolve("../.venv/Scripts/python.exe") : resolve("../.venv/bin/python")
  const candidates = [...new Set([process.env.PYTHON_EXE, virtualenvPython, "python", "python3"].filter(Boolean))]
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["-c", "import numpy, pyworld; assert pyworld.__version__ == '0.3.5'"])
    if (probe.status === 0) return candidate
  }
  return null
}

async function pythonReference(pcm, config) {
  const python = findPythonOracle()
  if (!python) return null
  const source = spawnSync("git", ["show", "legacy/python:src/madnolia/world_pitch.py"], { cwd: resolve(".."), maxBuffer: 4 * 1024 * 1024 })
  assert.equal(source.status, 0, source.error?.message ?? source.stderr?.toString() ?? "Unable to read retained Python WORLD implementation")
  const fixture = await mkdtemp(join(tmpdir(), "madnolia-world-reference-"))
  const packageDirectory = join(fixture, "madnolia")
  const typesDirectory = join(packageDirectory, "types")
  await mkdir(typesDirectory, { recursive: true })
  await writeFile(join(packageDirectory, "__init__.py"), "")
  await writeFile(join(typesDirectory, "__init__.py"), "")
  await writeFile(join(packageDirectory, "world_pitch.py"), source.stdout)
  await writeFile(join(packageDirectory, "constants.py"), "WORLD_PITCH_CONTEXT_MS=120\nWORLD_PITCH_FRAME_PERIOD_MS=5\nWORLD_PITCH_PEAK_LIMIT=0.98\n")
  await writeFile(join(packageDirectory, "pitch_shift.py"), "import math\ndef midi_to_hz(midi): return 440.0 * 2 ** ((midi - 69.0) / 12.0)\n")
  await writeFile(join(typesDirectory, "common.py"), "class EditRegion: pass\nclass TimelineSegment: pass\nclass WorldPitchAnalysis:\n def __init__(self, **kwargs): self.__dict__.update(kwargs)\n")
  const script = `import json, os, sys, wave
import numpy as np, pyworld as pw
assert getattr(pw,'__version__',None)=='0.3.5', f"Expected PyWORLD 0.3.5, found {getattr(pw,'__version__',None)}"
sys.path.insert(0,sys.argv[1])
from types import SimpleNamespace as NS
from madnolia.world_pitch import render_world_regions
config=json.loads(sys.argv[2]); raw=sys.stdin.buffer.read()
path=os.path.join(sys.argv[1],'source.wav')
with wave.open(path,'wb') as audio:
 audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(16000); audio.writeframes(raw)
regions=[NS(source_start_ms=r['start'], source_end_ms=r['end'], output_duration_ms=r['duration'], relative_pitch_cents=r['cents'], pitch_points=[NS(**p) for p in r['points']]) for r in config['regions']]
units=[NS(source_start_ms=u['start'], source_end_ms=u['end'], vibrato_depth_cents=u['depth'], vibrato_rate_hz=u['rate'], vibrato_start_ms=u['vibrato_start']) for u in config['units']]
notes=[NS(start_ms=n['start'], end_ms=n['end'], pitch_points=[NS(**p) for p in n['points']]) for n in config['notes']]
segment=NS(edit_regions=regions, pitch_envelope=[], phone_units=units, timeline_start_ms=0, timeline_end_ms=config['duration'])
result=render_world_regions(__import__('pathlib').Path(path),segment,pitch_notes=notes)
sys.stdout.buffer.write(np.asarray(result,dtype='<f4').tobytes())`
  try {
    const result = spawnSync(python, ["-c", script, fixture, JSON.stringify(config)], { input: bytesOf(pcm), maxBuffer: 128 * 1024 * 1024 })
    assert.equal(result.status, 0, result.error?.message ?? result.stderr?.toString() ?? "Original Python render_world_regions failed")
    return new Float32Array(result.stdout.buffer.slice(result.stdout.byteOffset, result.stdout.byteOffset + result.stdout.byteLength))
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
}

test("production WORLD worker maps reordered regions and frame controls like PyWORLD", async () => {
  const { buildWorldVibratoCents } = await import("../src/browser/regionWorldMerge.ts")
  const scope = { onmessage: null, postMessage: (message) => scope.resolve(message) }
  globalThis.self = scope
  await import("../src/browser/worldPitch.worker.ts")
  const worldFactory = (await import(new URL("../public/wasm/world.js", import.meta.url))).default
  const sampleRate = 16_000
  const rawSamples = Float32Array.from({ length: sampleRate * 6 }, (_, index) => {
    const t = index / sampleRate
    const frequency = t < 2 ? 175 : t < 4 ? 247 : 329
    return 0.42 * Math.sin(2 * Math.PI * frequency * t) + 0.09 * Math.sin(2 * Math.PI * 2 * frequency * t)
  })
  const regions = [
    { start: 3_600, end: 5_500, duration: 1_550, cents: -37.125, points: [{ position: 0, midi: 64.375 }, { position: 1, midi: 64.375 }] },
    { start: 300, end: 1_900, duration: 2_000, cents: 18.625, points: [] },
    { start: 2_650, end: 4_700, duration: 2_100, cents: -11.375, points: [{ position: 0, midi: 67.125 }, { position: 1, midi: 67.125 }] },
  ]
  const pcm = Int16Array.from(rawSamples, (sample) => Math.max(-32768, Math.min(32767, Math.round(sample * 32768))))
  const fullSamples = Float32Array.from(pcm, (sample) => sample / 32768)
  const contextStartMs = 180
  const contextEndMs = 5_620
  const samples = fullSamples.slice(contextStartMs * 16, contextEndMs * 16)
  const outputLength = regions.reduce((sum, region) => sum + region.duration * 16, 0)
  assert.ok(outputLength > sampleRate * 5)
  const sourceTimes = new Float64Array(outputLength + 1)
  let outputStart = 0
  for (const region of regions) {
    const length = region.duration * 16
    for (let offset = 0; offset <= length; offset += 1) {
      if (offset === length && region !== regions.at(-1)) continue
      sourceTimes[outputStart + offset] = region.start + offset / (length || 1) * (region.end - region.start)
    }
    outputStart += length
  }
  assert.equal(sourceTimes[regions[0].duration * 16], regions[1].start)
  assert.equal(sourceTimes[regions[0].duration * 16 + regions[1].duration * 16], regions[2].start)
  assert.equal(sourceTimes.at(-1), regions.at(-1).end)
  const controlRegions = []
  let controlStartMs = 0
  for (const region of regions) {
    controlRegions.push({ startMs: controlStartMs, endMs: controlStartMs + region.duration, region: { source_start_ms: region.start, source_end_ms: region.end, output_duration_ms: region.duration, relative_pitch_cents: region.cents, pitch_points: region.points.map((point) => ({ position: point.position, midi: point.midi })) } })
    controlStartMs += region.duration
  }
  const vibratoCents = buildWorldVibratoCents(controlRegions, [{ unit: { source_start_ms: 2650, source_end_ms: 4700, vibrato_depth_cents: 24, vibrato_rate_hz: 5.25, vibrato_start_ms: 0 } }], sourceTimes)
  const cents = new Float64Array(outputLength + 1)
  const midis = new Float64Array(outputLength + 1)
  for (let index = 0; index <= outputLength; index += 1) {
    const outputMs = index * 1000 / sampleRate
    const region = outputMs < 1550 ? regions[0] : outputMs < 3550 ? regions[1] : regions[2]
    const regionStart = outputMs < 1550 ? 0 : outputMs < 3550 ? 1550 : 3550
    const regionPosition = Math.max(0, Math.min(1, (outputMs - regionStart) / region.duration))
    const sourceMs = region.start + regionPosition * (region.end - region.start)
    sourceTimes[index] = sourceMs
    let amount = region.cents
    cents[index] = amount + vibratoCents[index]
    if (region.points.length) midis[index] = region.points[0].midi
  }
  const notes = [
    { start: 1_950, end: 2_430, points: [{ position: 0, midi: 72.125 }, { position: 1, midi: 72.125 }] },
    { start: 4_120, end: 5_650, points: [{ position: 0, midi: 59.625 }, { position: 1, midi: 59.625 }] },
  ]
  for (let index = 0; index <= outputLength; index += 1) {
    const outputMs = index * 1000 / sampleRate
    const note = notes.find((item) => outputMs >= item.start && outputMs < item.end)
    if (!note) continue
    cents[index] = 0
    midis[index] = note.points[0].midi
  }
  const moduleUrl = new URL("../public/wasm/world.js", import.meta.url).href
  scope.resolve = undefined
  const resultPromise = new Promise((resolveResult) => { scope.resolve = resolveResult })
  scope.onmessage({ data: { kind: "render", request_id: 7, module_url: moduleUrl, samples, cents, absolute_pitch_midi: midis, source_start_ms: 300, source_end_ms: 5_500, context_start_ms: contextStartMs, output_length: outputLength, formant_semitones: 0, source_times_ms: sourceTimes } })
  const response = await resultPromise
  assert.ifError(response.error)
  const expected = await pythonReference(pcm, { regions, units: [{ start: 2650, end: 4700, depth: 24, rate: 5.25, vibrato_start: 0 }], notes, duration: 5650 })
  assert.equal(response.samples.length, outputLength)
  assert.equal(worldFixture.source_commit, "cb398e6e80f6533bc6821288843e7be878e89beb")
  assert.equal(worldFixture.pyworld_version, "0.3.5")
  assert.equal(worldFixture.output_length, outputLength)
  const fixtureErrors = worldFixture.sample_indices.map((index, fixtureIndex) => Math.abs(response.samples[index] - worldFixture.samples[fixtureIndex]))
  assert.ok(Math.max(...fixtureErrors) < 3e-5, `WORLD reference fixture sample error ${Math.max(...fixtureErrors)}`)
  if (expected) {
    assert.equal(response.samples.length, expected.length)
    let maximum = 0
    let rms = 0
    let maximumIndex = 0
    for (let index = 0; index < expected.length; index += 1) {
      const error = Math.abs(response.samples[index] - expected[index])
      if (error > maximum) { maximum = error; maximumIndex = index }
      rms += error * error
    }
    rms = Math.sqrt(rms / expected.length)
    assert.ok(maximum < 3e-5, `maximum waveform error ${maximum} at ${maximumIndex}: ${response.samples[maximumIndex]} vs ${expected[maximumIndex]}`)
    assert.ok(rms < 2e-6, `RMS waveform error ${rms}`)
  } else {
    assert.equal(worldFixture.source, "legacy/python:src/madnolia/world_pitch.py")
  }
  const invalidPromise = new Promise((resolveResult) => { scope.resolve = resolveResult })
  scope.onmessage({ data: {
    kind: "render",
    request_id: 8,
    module_url: new URL("../public/wasm/world.js", import.meta.url).href,
    samples,
    cents: new Float64Array(outputLength - 1),
    absolute_pitch_midi: new Float64Array(outputLength - 1),
    source_start_ms: 300,
    source_end_ms: 5500,
    context_start_ms: contextStartMs,
    output_length: outputLength,
    formant_semitones: 0,
  } })
  const invalidResponse = await invalidPromise
  assert.match(invalidResponse.error, /pitch controls must contain one value per output sample/)
})
