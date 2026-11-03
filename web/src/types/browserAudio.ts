import type { BrowserAudioData } from "./browser"
import type {
  EditRegion,
  PhonePitchPoint,
  PhoneUnit,
  MediaSource,
  TimelineSegment,
  VolumeEnvelopePoint,
} from "./index"

export type BrowserProgressCallback = (percent: number, stage: string) => void

export interface BrowserPitchFrame {
  hz: number | null
  timeMs: number
  periodicity: number
}

export interface BrowserFftSpectrum {
  real: Float64Array
  imag: Float64Array
}

export interface BrowserWorldPitchModule {
  HEAP32: Int32Array
  HEAPF64: Float64Array
  _malloc(size: number): number
  _free(pointer: number): void
  _world_dimensions(sampleCount: number, sampleRate: number, framePeriodMs: number, frameCountPointer: number, fftSizePointer: number): number
  _world_analyze_f0(samplesPointer: number, sampleCount: number, sampleRate: number, framePeriodMs: number, frameCount: number, f0Pointer: number, timesPointer: number): number
  _world_analyze(samplesPointer: number, sampleCount: number, sampleRate: number, framePeriodMs: number, frameCount: number, fftSize: number, f0Pointer: number, timesPointer: number, spectrumPointer: number, aperiodicityPointer: number): number
  _world_synthesize(f0Pointer: number, frameCount: number, spectrumPointer: number, aperiodicityPointer: number, fftSize: number, framePeriodMs: number, sampleRate: number, outputCount: number, outputPointer: number): number
}

export type BrowserWorldPitchModuleFactory = () => Promise<BrowserWorldPitchModule>

export type BrowserWorldPitchControlSeries = Float64Array

export interface BrowserWorldPitchModuleLoad {
  default?: BrowserWorldPitchModuleFactory
}

export interface BrowserWorldPitchPendingRequest {
  resolve: (response: BrowserWorldPitchWorkerResponse) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  abort?: () => void
}

export interface BrowserWorldPitchWorkerRequest {
  kind: "render"
  request_id: number
  module_url: string
  samples: Float32Array
  cents: BrowserWorldPitchControlSeries
  absolute_pitch_midi: BrowserWorldPitchControlSeries
  source_start_ms: number
  source_end_ms: number
  context_start_ms: number
  output_length: number
  formant_semitones: number
  source_times_ms?: BrowserWorldPitchControlSeries
}

export interface BrowserWorldPitchAnalysisWorkerRequest {
  kind: "analyze"
  request_id: number
  module_url: string
  samples: Float32Array
}

export type BrowserWorldWorkerRequest = BrowserWorldPitchWorkerRequest | BrowserWorldPitchAnalysisWorkerRequest

export interface BrowserWorldPitchWorkerScope {
  onmessage: ((event: MessageEvent<BrowserWorldWorkerRequest>) => void) | null
  postMessage: (message: BrowserWorldPitchWorkerResponse, transfer?: Transferable[]) => void
}

export interface BrowserWorldF0Frame {
  hz: number | null
  timeMs: number
}

export interface BrowserWorldSourceContext {
  samples: Float32Array
  contextStartMs: number
}

export interface BrowserWorldPitchWorkerResponse {
  request_id: number
  samples?: Float32Array
  frames?: BrowserWorldF0Frame[]
  error?: string
}

export interface BrowserRenderUnit {
  unit: PhoneUnit
  startMs: number
  endMs: number
}

export interface BrowserRenderRegion {
  region: EditRegion
  startMs: number
  endMs: number
}

export interface BrowserCompositionSource {
  sourceId: string
  audio: BrowserAudioData
  media: File | null
  source: MediaSource
  mediaPath: string
}

export interface BrowserCompositionRender {
  samples: Float32Array
  sampleRate: number
  durationMs: number
}

export interface BrowserRenderSettings {
  sampleRate: number
  maxDurationMs: number
  maxInputBytes: number
  maxOutputSamples: number
}

export interface BrowserEnvelope {
  points: VolumeEnvelopePoint[]
  fallback: number
}

export interface BrowserPitchCurve {
  points: PhonePitchPoint[]
  startMs: number
  endMs: number
}

export interface BrowserAudioCompositionSegment {
  segment: TimelineSegment
  startSample: number
  endSample: number
  samples: Float32Array
}

export interface BrowserVideoClip {
  sourceId: string
  sourceStartMs: number
  sourceEndMs: number
  timelineStartMs: number
  durationMs: number
  crossfadeMs: number
  segmentId: string
}
