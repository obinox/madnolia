import type { BrowserWorldF0Frame, BrowserWorldPitchAnalysisWorkerRequest, BrowserWorldPitchModuleFactory, BrowserWorldPitchModuleLoad, BrowserWorldPitchWorkerRequest, BrowserWorldPitchWorkerResponse, BrowserWorldPitchWorkerScope } from "../types/browserAudio"
import { BROWSER_AUDIO_SAMPLE_RATE, BROWSER_WORLD_FRAME_PERIOD_MS, BROWSER_WORLD_PEAK_LIMIT } from "../browserAudioConstants"

let modulePromise: Promise<Awaited<ReturnType<BrowserWorldPitchModuleFactory>>> | null = null
let loadedUrl = ""

function loadModule(moduleUrl: string): Promise<Awaited<ReturnType<BrowserWorldPitchModuleFactory>>> {
  if (modulePromise && loadedUrl !== moduleUrl) throw new Error("WORLD module URL changed during this worker session.")
  if (!modulePromise) {
    loadedUrl = moduleUrl
    modulePromise = import(/* @vite-ignore */ moduleUrl).then(async (loaded: BrowserWorldPitchModuleLoad) => {
      if (!loaded.default) throw new Error("WORLD WASM module factory is missing.")
      return loaded.default()
    }).catch((error: unknown) => {
      modulePromise = null
      loadedUrl = ""
      throw error
    })
  }
  return modulePromise
}

async function analyzeF0(request: BrowserWorldPitchAnalysisWorkerRequest): Promise<BrowserWorldF0Frame[]> {
  if (request.samples.length < 2) return []
  const module = await loadModule(request.module_url)
  const dimensionsPointer = module._malloc(Int32Array.BYTES_PER_ELEMENT * 2)
  if (!dimensionsPointer) throw new Error("WORLD could not allocate analysis dimensions.")
  const allocated: number[] = [dimensionsPointer]
  try {
    const dimensionsResult = module._world_dimensions(request.samples.length, BROWSER_AUDIO_SAMPLE_RATE, BROWSER_WORLD_FRAME_PERIOD_MS, dimensionsPointer, dimensionsPointer + Int32Array.BYTES_PER_ELEMENT)
    if (dimensionsResult !== 0) throw new Error(`WORLD dimensions failed (${dimensionsResult}).`)
    const frameCount = module.HEAP32[dimensionsPointer >> 2]
    const samplesPointer = module._malloc(request.samples.length * Float64Array.BYTES_PER_ELEMENT)
    const f0Pointer = module._malloc(frameCount * Float64Array.BYTES_PER_ELEMENT)
    const timesPointer = module._malloc(frameCount * Float64Array.BYTES_PER_ELEMENT)
    allocated.push(samplesPointer, f0Pointer, timesPointer)
    if (allocated.some((pointer) => pointer === 0)) throw new Error("WORLD ran out of browser memory.")
    module.HEAPF64.set(new Float64Array(request.samples), samplesPointer / 8)
    const result = module._world_analyze_f0(samplesPointer, request.samples.length, BROWSER_AUDIO_SAMPLE_RATE, BROWSER_WORLD_FRAME_PERIOD_MS, frameCount, f0Pointer, timesPointer)
    if (result !== 0) throw new Error(`WORLD F0 analysis failed (${result}).`)
    const f0 = module.HEAPF64.subarray(f0Pointer / 8, f0Pointer / 8 + frameCount)
    const times = module.HEAPF64.subarray(timesPointer / 8, timesPointer / 8 + frameCount)
    return Array.from(f0, (hz, index) => ({ hz: hz > 0 ? hz : null, timeMs: times[index] * 1000 }))
  } finally {
    for (const pointer of allocated.reverse()) if (pointer) module._free(pointer)
  }
}

async function renderSingle(request: BrowserWorldPitchWorkerRequest): Promise<Float32Array> {
  if (request.samples.length < 2) throw new Error("WORLD pitch input must contain at least two samples.")
  if (!Number.isInteger(request.output_length) || request.output_length < 2) throw new Error("WORLD output length must be an integer of at least two samples.")
  if (![request.output_length, request.output_length + 1].includes(request.cents.length)) throw new Error("WORLD pitch controls must contain one value per output sample, with an optional endpoint control.")
  if (request.absolute_pitch_midi.length !== request.cents.length) throw new Error("WORLD absolute pitch controls must match the pitch control length.")
  const module = await loadModule(request.module_url)
  const dimensionsPointer = module._malloc(Int32Array.BYTES_PER_ELEMENT * 2)
  if (!dimensionsPointer) throw new Error("WORLD could not allocate analysis dimensions.")
  const allocated: number[] = [dimensionsPointer]
  try {
    const dimensionsResult = module._world_dimensions(request.samples.length, BROWSER_AUDIO_SAMPLE_RATE, BROWSER_WORLD_FRAME_PERIOD_MS, dimensionsPointer, dimensionsPointer + Int32Array.BYTES_PER_ELEMENT)
    if (dimensionsResult !== 0) throw new Error(`WORLD dimensions failed (${dimensionsResult}).`)
    const analysisFrames = module.HEAP32[dimensionsPointer >> 2]
    const fftSize = module.HEAP32[(dimensionsPointer >> 2) + 1]
    const bins = fftSize / 2 + 1
    const outputDurationMs = request.output_length * 1000 / BROWSER_AUDIO_SAMPLE_RATE
    const outputFrames = Math.max(2, Math.ceil(outputDurationMs / BROWSER_WORLD_FRAME_PERIOD_MS) + 1)
    const synthesisLength = Math.round(outputFrames * BROWSER_WORLD_FRAME_PERIOD_MS * BROWSER_AUDIO_SAMPLE_RATE / 1000)
    const inputPointer = module._malloc(request.samples.length * Float64Array.BYTES_PER_ELEMENT)
    const analysisF0Pointer = module._malloc(analysisFrames * Float64Array.BYTES_PER_ELEMENT)
    const timesPointer = module._malloc(analysisFrames * Float64Array.BYTES_PER_ELEMENT)
    const analysisSpectrumPointer = module._malloc(analysisFrames * bins * Float64Array.BYTES_PER_ELEMENT)
    const analysisAperiodicityPointer = module._malloc(analysisFrames * bins * Float64Array.BYTES_PER_ELEMENT)
    const outputF0Pointer = module._malloc(outputFrames * Float64Array.BYTES_PER_ELEMENT)
    const outputSpectrumPointer = module._malloc(outputFrames * bins * Float64Array.BYTES_PER_ELEMENT)
    const outputAperiodicityPointer = module._malloc(outputFrames * bins * Float64Array.BYTES_PER_ELEMENT)
    const waveformPointer = module._malloc(synthesisLength * Float64Array.BYTES_PER_ELEMENT)
    allocated.push(inputPointer, analysisF0Pointer, timesPointer, analysisSpectrumPointer, analysisAperiodicityPointer, outputF0Pointer, outputSpectrumPointer, outputAperiodicityPointer, waveformPointer)
    if (allocated.some((pointer) => pointer === 0)) throw new Error("WORLD ran out of browser memory.")
    module.HEAPF64.set(new Float64Array(request.samples), inputPointer / 8)
    const analysisResult = module._world_analyze(inputPointer, request.samples.length, BROWSER_AUDIO_SAMPLE_RATE, BROWSER_WORLD_FRAME_PERIOD_MS, analysisFrames, fftSize, analysisF0Pointer, timesPointer, analysisSpectrumPointer, analysisAperiodicityPointer)
    if (analysisResult !== 0) throw new Error(`WORLD analysis failed (${analysisResult}).`)
    const analysisTimes = new Float64Array(module.HEAPF64.subarray(timesPointer / 8, timesPointer / 8 + analysisFrames))
    const analysisF0 = new Float64Array(module.HEAPF64.subarray(analysisF0Pointer / 8, analysisF0Pointer / 8 + analysisFrames))
    const analysisSpectrum = new Float64Array(module.HEAPF64.subarray(analysisSpectrumPointer / 8, analysisSpectrumPointer / 8 + analysisFrames * bins))
    const analysisAperiodicity = new Float64Array(module.HEAPF64.subarray(analysisAperiodicityPointer / 8, analysisAperiodicityPointer / 8 + analysisFrames * bins))
    const formantRatio = 2 ** (Math.max(-12, Math.min(12, request.formant_semitones)) / 12)
    for (let frame = 0; frame < outputFrames; frame += 1) {
      const outputMs = frame * BROWSER_WORLD_FRAME_PERIOD_MS
      const progress = Math.max(0, Math.min(1, outputMs / outputDurationMs))
      const outputSample = Math.min(request.output_length, Math.max(0, Math.round(outputMs * BROWSER_AUDIO_SAMPLE_RATE / 1000)))
      const sourceMs = request.source_times_ms?.[outputSample] ?? request.source_start_ms + progress * (request.source_end_ms - request.source_start_ms)
      const relativeSourceSeconds = (sourceMs - request.context_start_ms) / 1000
      let low = 0
      let high = analysisFrames
      while (low < high) {
        const middle = (low + high) >>> 1
        if (analysisTimes[middle] < relativeSourceSeconds) low = middle + 1
        else high = middle
      }
      const right = Math.min(analysisFrames - 1, low)
      const left = Math.max(0, right - 1)
      const leftTime = analysisTimes[left]
      const rightTime = analysisTimes[right]
      const mix = Math.max(0, Math.min(1, (relativeSourceSeconds - leftTime) / Math.max(1e-12, rightTime - leftTime)))
      const nearest = Math.abs(relativeSourceSeconds - leftTime) < Math.abs(relativeSourceSeconds - rightTime) ? left : right
      const sourceF0 = analysisF0[nearest]
      const sampleIndex = Math.max(0, Math.min(request.output_length, Math.round(outputMs * BROWSER_AUDIO_SAMPLE_RATE / 1000)))
      const controlIndex = Math.min(request.cents.length - 1, sampleIndex)
      const absoluteMidi = request.absolute_pitch_midi[controlIndex] ?? 0
      const targetF0 = sourceF0 <= 0 ? 0
        : absoluteMidi > 0
          ? 440 * 2 ** ((absoluteMidi - 69) / 12 + (request.cents[controlIndex] ?? 0) / 1200)
          : sourceF0 * 2 ** ((request.cents[controlIndex] ?? 0) / 1200)
      module.HEAPF64[outputF0Pointer / 8 + frame] = targetF0
      const sourceLeft = left * bins
      const sourceRight = right * bins
      const targetOffset = frame * bins
      for (let bin = 0; bin < bins; bin += 1) {
        const sourceBin = Math.max(0, Math.min(bins - 1, Math.round(bin / formantRatio)))
        const leftIndex = sourceLeft + sourceBin
        const rightIndex = sourceRight + sourceBin
        module.HEAPF64[outputSpectrumPointer / 8 + targetOffset + bin] = analysisSpectrum[leftIndex] * (1 - mix) + analysisSpectrum[rightIndex] * mix
        module.HEAPF64[outputAperiodicityPointer / 8 + targetOffset + bin] = analysisAperiodicity[leftIndex] * (1 - mix) + analysisAperiodicity[rightIndex] * mix
      }
    }
    const synthesisResult = module._world_synthesize(outputF0Pointer, outputFrames, outputSpectrumPointer, outputAperiodicityPointer, fftSize, BROWSER_WORLD_FRAME_PERIOD_MS, BROWSER_AUDIO_SAMPLE_RATE, synthesisLength, waveformPointer)
    if (synthesisResult !== 0) throw new Error(`WORLD synthesis failed (${synthesisResult}).`)
    const result64 = module.HEAPF64.subarray(waveformPointer / 8, waveformPointer / 8 + request.output_length)
    let peak = 0
    for (const sample of result64) peak = Math.max(peak, Math.abs(sample))
    const scale = peak > BROWSER_WORLD_PEAK_LIMIT ? BROWSER_WORLD_PEAK_LIMIT / peak : 1
    const output = new Float32Array(request.output_length)
    for (let index = 0; index < output.length; index += 1) {
      const sample = result64[index] * scale
      output[index] = Number.isFinite(sample) ? sample : 0
    }
    return output
  } finally {
    for (const pointer of allocated.reverse()) if (pointer) module._free(pointer)
  }
}

async function render(request: BrowserWorldPitchWorkerRequest): Promise<Float32Array> {
  if (request.source_times_ms && request.source_times_ms.length !== request.cents.length) throw new Error("WORLD source timeline must match the pitch control length, including any endpoint control.")
  return renderSingle(request)
}

const workerScope = self as unknown as BrowserWorldPitchWorkerScope

workerScope.onmessage = (event) => {
  void (async () => {
    if (event.data.kind === "analyze") {
      const frames = await analyzeF0(event.data)
      workerScope.postMessage({ request_id: event.data.request_id, frames })
      return
    }
    const samples = await render(event.data)
    workerScope.postMessage({ request_id: event.data.request_id, samples }, [samples.buffer])
  })().catch((error: unknown) => {
    workerScope.postMessage({ request_id: event.data.request_id, error: error instanceof Error ? error.message : String(error) })
  })
}
