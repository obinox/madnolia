import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

const factory = (await import(new URL("../public/wasm/world.js", import.meta.url))).default
const world = await factory()
const sampleRate = 16_000
const framePeriodMs = 5
const contextStartMs = 0
const sourceStartMs = 200
const sourceEndMs = 800
const outputLength = 14_400
const samples = Float64Array.from({ length: 14_720 }, (_, index) => {
  const envelope = Math.min(1, index / 800, (14_720 - index) / 800)
  return envelope * (0.38 * Math.sin(2 * Math.PI * 220 * index / sampleRate) + 0.17 * Math.sin(2 * Math.PI * 440 * index / sampleRate))
})
const allocated = []
const allocate = (size) => {
  const pointer = world._malloc(size)
  assert.ok(pointer > 0)
  allocated.push(pointer)
  return pointer
}
const dimensions = allocate(8)
const input = allocate(samples.length * 8)
try {
  assert.equal(world._world_dimensions(samples.length, sampleRate, framePeriodMs, dimensions, dimensions + 4), 0)
  const analysisFrames = world.HEAP32[dimensions >> 2]
  const fftSize = world.HEAP32[(dimensions >> 2) + 1]
  const bins = fftSize / 2 + 1
  const inputF0 = allocate(analysisFrames * 8)
  const times = allocate(analysisFrames * 8)
  const spectrum = allocate(analysisFrames * bins * 8)
  const aperiodicity = allocate(analysisFrames * bins * 8)
  const outputFrames = Math.max(2, Math.ceil(outputLength * 1000 / sampleRate / framePeriodMs) + 1)
  const synthesisLength = Math.round(outputFrames * framePeriodMs * sampleRate / 1000)
  const outputF0 = allocate(outputFrames * 8)
  const outputSpectrum = allocate(outputFrames * bins * 8)
  const outputAperiodicity = allocate(outputFrames * bins * 8)
  const output = allocate(synthesisLength * 8)
  world.HEAPF64.set(samples, input / 8)
  assert.equal(world._world_analyze(input, samples.length, sampleRate, framePeriodMs, analysisFrames, fftSize, inputF0, times, spectrum, aperiodicity), 0)
  const timesData = new Float64Array(world.HEAPF64.subarray(times / 8, times / 8 + analysisFrames))
  const f0Data = new Float64Array(world.HEAPF64.subarray(inputF0 / 8, inputF0 / 8 + analysisFrames))
  const spectrumData = new Float64Array(world.HEAPF64.subarray(spectrum / 8, spectrum / 8 + analysisFrames * bins))
  const apData = new Float64Array(world.HEAPF64.subarray(aperiodicity / 8, aperiodicity / 8 + analysisFrames * bins))
  let next = 0
  for (let frame = 0; frame < outputFrames; frame += 1) {
    const outputMs = frame * framePeriodMs
    const position = Math.min(1, outputMs / (outputLength * 1000 / sampleRate))
    const sourceSeconds = (sourceStartMs + position * (sourceEndMs - sourceStartMs) - contextStartMs) / 1000
    while (next < analysisFrames - 1 && timesData[next] < sourceSeconds) next += 1
    const right = next
    const left = Math.max(0, right - 1)
    const mix = Math.max(0, Math.min(1, (sourceSeconds - timesData[left]) / Math.max(1e-12, timesData[right] - timesData[left])))
    const nearest = Math.abs(sourceSeconds - timesData[left]) < Math.abs(sourceSeconds - timesData[right]) ? left : right
    const sampleIndex = Math.max(0, Math.min(outputLength - 1, Math.round(outputMs * sampleRate / 1000)))
    const cents = sampleIndex < outputLength / 2 ? -25 : 35
    const absoluteMidi = sampleIndex < outputLength / 2 ? 57 : 62
    world.HEAPF64[outputF0 / 8 + frame] = f0Data[nearest] > 0
      ? 440 * 2 ** ((absoluteMidi - 69) / 12 + cents / 1200)
      : 0
    for (let bin = 0; bin < bins; bin += 1) {
      const offset = frame * bins + bin
      world.HEAPF64[outputSpectrum / 8 + offset] = spectrumData[left * bins + bin] * (1 - mix) + spectrumData[right * bins + bin] * mix
      world.HEAPF64[outputAperiodicity / 8 + offset] = apData[left * bins + bin] * (1 - mix) + apData[right * bins + bin] * mix
    }
  }
  assert.equal(world._world_synthesize(outputF0, outputFrames, outputSpectrum, outputAperiodicity, fftSize, framePeriodMs, sampleRate, synthesisLength, output), 0)
  const wasmF0 = new Float64Array(f0Data)
  const wasmTimes = new Float64Array(timesData)
  const wasmSpectrum = new Float64Array(spectrumData)
  const wasmAperiodicity = new Float64Array(apData)
  const wasmSynthesis = new Float64Array(world.HEAPF64.subarray(output / 8, output / 8 + outputLength))
  const python = process.env.PYTHON_EXE ?? resolve("../.venv/Scripts/python.exe")
  const script = `import sys, struct, numpy as np, pyworld as pw
x=np.frombuffer(sys.stdin.buffer.read(), dtype='<f8').copy(); fs=16000; fp=5.0
f0,t=pw.dio(x,fs,frame_period=fp); f0=pw.stonemask(x,f0,t,fs); sp=pw.cheaptrick(x,f0,t,fs); ap=pw.d4c(x,f0,t,fs)
duration=14400*1000/fs; out_frames=max(2,int(np.ceil(duration/fp))+1); out_ms=np.arange(out_frames)*fp; src_ms=200+np.clip(out_ms/duration,0,1)*600; src_s=(src_ms/1000)
indices=np.searchsorted(t,src_s).clip(0,len(t)-1); prev=np.maximum(0,indices-1); use_prev=np.abs(t[prev]-src_s)<np.abs(t[indices]-src_s); indices[use_prev]=prev[use_prev]
target_f0=f0[indices].copy(); sample_idx=np.clip(np.rint(out_ms*fs/1000).astype(int),0,14399); cents=np.where(sample_idx<7200,-25,35); midi=np.where(sample_idx<7200,57,62); voiced=target_f0>0; target_f0[voiced]=440*2**((midi[voiced]-69)/12+cents[voiced]/1200)
left=np.searchsorted(t,src_s).clip(0,len(t)-1); previous=np.maximum(0,left-1); lt=t[previous]; rt=t[left]; mix=np.divide(src_s-lt,rt-lt,out=np.zeros_like(src_s),where=rt>lt).clip(0,1)[:,None]
spec=sp[previous]*(1-mix)+sp[left]*mix; aper=ap[previous]*(1-mix)+ap[left]*mix; y=pw.synthesize(target_f0,spec,aper,fs,fp)[:14400]
sys.stdout.buffer.write(struct.pack('<III',len(f0),sp.shape[1],len(y)))
for a in (f0,t,sp,ap,y): sys.stdout.buffer.write(np.asarray(a,dtype='<f8').tobytes())`
  const reference = spawnSync(python, ["-c", script], { input: Buffer.from(samples.buffer), maxBuffer: 64 * 1024 * 1024 })
  assert.equal(reference.status, 0, reference.error?.message ?? reference.stderr?.toString() ?? "PyWORLD reference process failed")
  const referenceBuffer = reference.stdout
  const referenceFrames = referenceBuffer.readUInt32LE(0)
  const referenceBins = referenceBuffer.readUInt32LE(4)
  const referenceSamples = referenceBuffer.readUInt32LE(8)
  assert.equal(referenceFrames, analysisFrames)
  assert.equal(referenceBins, bins)
  assert.equal(referenceSamples, outputLength)
  let offset = 12
  const read = (length) => {
    const result = new Float64Array(length)
    for (let index = 0; index < length; index += 1) result[index] = referenceBuffer.readDoubleLE(offset + index * 8)
    offset += length * 8
    return result
  }
  const referenceF0 = read(analysisFrames)
  const referenceTimes = read(analysisFrames)
  const referenceSpectrum = read(analysisFrames * bins)
  const referenceAperiodicity = read(analysisFrames * bins)
  const referenceSynthesis = read(outputLength)
  const maxError = (left, right) => {
    let maximum = 0
    for (let index = 0; index < left.length; index += 1) maximum = Math.max(maximum, Math.abs(left[index] - right[index]))
    return maximum
  }
  const f0Error = maxError(wasmF0, referenceF0)
  const timeError = maxError(wasmTimes, referenceTimes)
  const spectrumError = maxError(wasmSpectrum, referenceSpectrum)
  const aperiodicityError = maxError(wasmAperiodicity, referenceAperiodicity)
  const synthesisError = maxError(wasmSynthesis, referenceSynthesis)
  assert.ok(f0Error < 1e-6, `F0 error ${f0Error}`)
  assert.ok(timeError < 1e-9, `time-axis error ${timeError}`)
  assert.ok(spectrumError < 1e-7, `spectrum error ${spectrumError}`)
  assert.ok(aperiodicityError < 1e-7, `aperiodicity error ${aperiodicityError}`)
  assert.ok(synthesisError < 1e-6, `time-mapped synthesis error ${synthesisError}`)
  console.log(`PyWORLD ${process.env.PYWORLD_VERSION ?? "0.3.5"} reference passed: F0 ${f0Error}, spectrum ${spectrumError}, aperiodicity ${aperiodicityError}, stretched synthesis ${synthesisError}`)
} finally {
  for (const pointer of allocated.reverse()) world._free(pointer)
}
