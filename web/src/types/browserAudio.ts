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
