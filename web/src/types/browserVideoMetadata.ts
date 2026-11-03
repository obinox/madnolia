import type { MediaSource } from "./index"
import type { BrowserAnalysisRecord } from "./browser"

export interface BrowserVideoOutputSpec {
  width: number
  height: number
  fps: number
  sourceWidth: number | null
  sourceHeight: number | null
  sourceFps: number | null
}

export interface BrowserVideoProbeResult {
  width: number
  height: number
  fps: number
}

export interface BrowserVideoMetadataProbeOptions {
  signal?: AbortSignal
  runProbe?: (file: File, signal?: AbortSignal) => Promise<string>
}

export interface BrowserVideoProbeLogEvent {
  message: string
}

export type BrowserVideoMetadata = Pick<MediaSource, "video_width" | "video_height" | "video_fps">

export type BrowserVideoMetadataAnalysisRecord = Pick<BrowserAnalysisRecord, "source" | "summary">
