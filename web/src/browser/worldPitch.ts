import type { BrowserWorldF0Frame, BrowserWorldPitchAnalysisWorkerRequest, BrowserWorldPitchPendingRequest, BrowserWorldPitchWorkerRequest, BrowserWorldPitchWorkerResponse } from "../types/browserAudio"
import { BROWSER_AUDIO_SAMPLE_RATE } from "../browserAudioConstants"

const pending = new Map<number, BrowserWorldPitchPendingRequest>()
let worker: Worker | null = null
let nextRequestId = 0

function rejectWorker(error: Error): void {
  worker?.terminate()
  worker = null
  for (const request of pending.values()) {
    if (request.abort) request.signal?.removeEventListener("abort", request.abort)
    request.reject(error)
  }
  pending.clear()
}

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL("./worldPitch.worker.ts", import.meta.url), { type: "module" })
  worker.onmessage = (event: MessageEvent<BrowserWorldPitchWorkerResponse>) => {
    const request = pending.get(event.data.request_id)
    if (!request) return
    pending.delete(event.data.request_id)
    if (request.abort) request.signal?.removeEventListener("abort", request.abort)
    if (event.data.error) request.reject(new Error(event.data.error))
    else request.resolve(event.data)
  }
  worker.onerror = (event) => rejectWorker(new Error(event.message || "WORLD worker failed."))
  worker.onmessageerror = () => rejectWorker(new Error("WORLD worker sent an invalid response."))
  return worker
}

function postWorldRequest(request: BrowserWorldPitchWorkerRequest | BrowserWorldPitchAnalysisWorkerRequest, transfer: Transferable[], signal?: AbortSignal): Promise<BrowserWorldPitchWorkerResponse> {
  if (signal?.aborted) return Promise.reject(new DOMException("Operation cancelled", "AbortError"))
  return new Promise<BrowserWorldPitchWorkerResponse>((resolve, reject) => {
    const abort = (): void => {
      if (!pending.has(request.request_id)) return
      rejectWorker(new DOMException("Operation cancelled", "AbortError"))
    }
    pending.set(request.request_id, { resolve, reject, signal, abort })
    signal?.addEventListener("abort", abort, { once: true })
    try {
      getWorker().postMessage(request, transfer)
    } catch (error) {
      pending.delete(request.request_id)
      signal?.removeEventListener("abort", abort)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

const moduleUrl = (): string => {
  const baseUrl = import.meta.env?.BASE_URL ?? "./"
  const documentBase = typeof document === "undefined" ? new URL("../../public/", import.meta.url).href : document.baseURI
  return new URL(`${baseUrl}wasm/world.js`, documentBase).href
}

function renderWorld(samples: Float32Array, cents: Float64Array, sourceStartMs: number, sourceEndMs: number, contextStartMs: number, outputLength: number, signal?: AbortSignal, formantSemitones = 0, absolutePitchMidi?: Float64Array, sourceTimesMs?: Float64Array): Promise<Float32Array> {
  if (signal?.aborted) return Promise.reject(new DOMException("Operation cancelled", "AbortError"))
  if (samples.length < 2) return Promise.reject(new Error("WORLD requires at least two input samples."))
  if (!Number.isInteger(outputLength) || outputLength < 2) return Promise.reject(new Error("WORLD output length must be an integer of at least two samples."))
  if (![outputLength, outputLength + 1].includes(cents.length)) {
    return Promise.reject(new Error("WORLD requires at least two input and output samples with pitch controls per output sample."))
  }
  if (!cents.some((value) => Math.abs(value) > 0.5) && !absolutePitchMidi?.some((value) => value > 0) && Math.abs(formantSemitones) < 0.01 && outputLength === samples.length && sourceStartMs === contextStartMs) return Promise.resolve(new Float32Array(samples))
  const requestId = ++nextRequestId
  const sampleCopy = new Float32Array(samples)
  const centsCopy = new Float64Array(cents)
  const absolutePitchCopy = absolutePitchMidi ? new Float64Array(absolutePitchMidi) : new Float64Array(cents.length)
  if (absolutePitchCopy.length !== cents.length) return Promise.reject(new Error("WORLD absolute pitch controls must match the pitch control length."))
  const sourceTimesCopy = sourceTimesMs ? new Float64Array(sourceTimesMs) : undefined
  if (sourceTimesCopy && sourceTimesCopy.length !== cents.length) return Promise.reject(new Error("WORLD source timeline must match the pitch control length, including any endpoint control."))
  const request: BrowserWorldPitchWorkerRequest = { kind: "render", request_id: requestId, module_url: moduleUrl(), samples: sampleCopy, cents: centsCopy, absolute_pitch_midi: absolutePitchCopy, source_start_ms: sourceStartMs, source_end_ms: sourceEndMs, context_start_ms: contextStartMs, output_length: outputLength, formant_semitones: formantSemitones, source_times_ms: sourceTimesCopy }
  return postWorldRequest(request, [sampleCopy.buffer, centsCopy.buffer, absolutePitchCopy.buffer, ...(sourceTimesCopy ? [sourceTimesCopy.buffer] : [])], signal).then((response) => {
    if (!response.samples) throw new Error("WORLD worker returned no audio.")
    return response.samples
  })
}

export function renderWorldMappedTimeline(samples: Float32Array, cents: Float64Array, sourceTimesMs: Float64Array, sourceStartMs: number, sourceEndMs: number, contextStartMs: number, outputLength: number, signal?: AbortSignal, absolutePitchMidi?: Float64Array): Promise<Float32Array> {
  return renderWorld(samples, cents, sourceStartMs, sourceEndMs, contextStartMs, outputLength, signal, 0, absolutePitchMidi, sourceTimesMs)
}

export function analyzeWorldF0(samples: Float32Array, contextStartMs = 0, signal?: AbortSignal): Promise<BrowserWorldF0Frame[]> {
  const request: BrowserWorldPitchAnalysisWorkerRequest = { kind: "analyze", request_id: ++nextRequestId, module_url: moduleUrl(), samples: new Float32Array(samples) }
  return postWorldRequest(request, [request.samples.buffer], signal).then((response) => {
    if (!response.frames) throw new Error("WORLD worker returned no pitch frames.")
    return response.frames.map((frame) => ({ ...frame, timeMs: frame.timeMs + contextStartMs }))
  })
}

export function renderWorldPitchCurve(samples: Float32Array, cents: Float32Array, signal?: AbortSignal, formantSemitones = 0, absolutePitchMidi?: Float32Array): Promise<Float32Array> {
  const durationMs = samples.length * 1000 / BROWSER_AUDIO_SAMPLE_RATE
  return renderWorld(samples, new Float64Array(cents), 0, durationMs, 0, samples.length, signal, formantSemitones, absolutePitchMidi ? new Float64Array(absolutePitchMidi) : undefined)
}

export function renderWorldMappedRegion(samples: Float32Array, cents: Float32Array, sourceStartMs: number, sourceEndMs: number, contextStartMs: number, outputLength: number, signal?: AbortSignal, formantSemitones = 0, absolutePitchMidi?: Float32Array): Promise<Float32Array> {
  if (signal?.aborted) return Promise.reject(new DOMException("Operation cancelled", "AbortError"))
  const unchanged = !cents.some((value) => Math.abs(value) > 0.5) && !absolutePitchMidi?.some((value) => value > 0) && Math.abs(formantSemitones) < 0.01
  const sourceLength = Math.round((sourceEndMs - sourceStartMs) * BROWSER_AUDIO_SAMPLE_RATE / 1000)
  if (unchanged && outputLength === sourceLength) {
    const start = Math.round((sourceStartMs - contextStartMs) * BROWSER_AUDIO_SAMPLE_RATE / 1000)
    return Promise.resolve(samples.slice(start, start + sourceLength))
  }
  return renderWorld(samples, new Float64Array(cents), sourceStartMs, sourceEndMs, contextStartMs, outputLength, signal, formantSemitones, absolutePitchMidi ? new Float64Array(absolutePitchMidi) : undefined)
}
