import type { BrowserVideoMetadata, BrowserVideoMetadataAnalysisRecord, BrowserVideoMetadataProbeOptions, BrowserVideoOutputSpec, BrowserVideoProbeLogEvent, BrowserVideoProbeResult } from "../types/browserVideoMetadata"
import {
  BROWSER_VIDEO_FALLBACK_FPS,
  BROWSER_VIDEO_FALLBACK_HEIGHT,
  BROWSER_VIDEO_FALLBACK_WIDTH,
  BROWSER_VIDEO_METADATA_PROBE_TIMEOUT_MS,
  BROWSER_VIDEO_PROBE_LOG_LIMIT,
} from "../browserVideoMetadataConstants"

export const parseFfmpegVideoMetadata = (log: string): BrowserVideoProbeResult | null => {
  const stream = log.match(/Stream #\d+(?::\d+)?(?:\[[^\]]+\])?(?:\([^)]*\))?: Video:[^\r\n]*/i)?.[0]
  if (!stream) return null
  const dimensions = stream.match(/(?:^|\s)(\d{2,6})x(\d{2,6})(?:\s|,|$)/)
  if (!dimensions) return null
  const chosen = stream.match(/(?:,\s*)(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)\s*fps\b/i)
  if (!chosen) return null
  const raw = chosen[1]
  const [numerator, denominator] = raw.split("/").map(Number)
  const fps = denominator === undefined ? numerator : numerator / denominator
  const width = Number(dimensions[1])
  const height = Number(dimensions[2])
  return Number.isFinite(fps) && fps > 0 && width > 0 && height > 0 ? { width, height, fps } : null
}

export const validSourceVideoMetadata = (source: BrowserVideoMetadata): boolean =>
  Number.isFinite(source.video_width) && (source.video_width ?? 0) > 0 &&
  Number.isFinite(source.video_height) && (source.video_height ?? 0) > 0 &&
  Number.isFinite(source.video_fps) && (source.video_fps ?? 0) > 0

export const isClearlyAudioMedia = (file: Pick<File, "name" | "type">): boolean =>
  file.type.startsWith("audio/") || /\.(?:aac|aiff?|alac|amr|flac|m4a|mp3|ogg|opus|wav|wma)$/i.test(file.name)

export const probeOptionalSourceVideoMetadata = (
  file: File | null,
  options: BrowserVideoMetadataProbeOptions = {},
  textOutput = false,
): Promise<BrowserVideoProbeResult | null> => {
  if (options.signal?.aborted) throw new DOMException("Operation cancelled", "AbortError")
  if (!file || (textOutput && isClearlyAudioMedia(file))) return Promise.resolve(null)
  return getOrProbeSourceVideoMetadata(file, options)
}

export const mergeProbedVideoMetadata = (source: BrowserVideoMetadata, probed: BrowserVideoProbeResult): BrowserVideoMetadata => ({
  video_width: Number.isFinite(source.video_width) && (source.video_width ?? 0) > 0 ? source.video_width : probed.width,
  video_height: Number.isFinite(source.video_height) && (source.video_height ?? 0) > 0 ? source.video_height : probed.height,
  video_fps: Number.isFinite(source.video_fps) && (source.video_fps ?? 0) > 0 ? source.video_fps : probed.fps,
})

export const backfillAnalysisRecordVideoMetadata = (
  record: BrowserVideoMetadataAnalysisRecord,
  probed: BrowserVideoProbeResult,
): BrowserVideoMetadata => {
  const updated = mergeProbedVideoMetadata(record.source, probed)
  record.source = { ...record.source, ...updated }
  record.summary.source = record.source
  return updated
}

export const resolveBrowserVideoOutputSpec = (
  source: BrowserVideoMetadata | null | undefined,
): BrowserVideoOutputSpec => {
  const sourceWidth = Number.isFinite(source?.video_width) && (source?.video_width ?? 0) > 0 ? source!.video_width : null
  const sourceHeight = Number.isFinite(source?.video_height) && (source?.video_height ?? 0) > 0 ? source!.video_height : null
  const sourceFps = Number.isFinite(source?.video_fps) && (source?.video_fps ?? 0) > 0 ? source!.video_fps : null
  const width = sourceWidth ?? BROWSER_VIDEO_FALLBACK_WIDTH
  const height = sourceHeight ?? BROWSER_VIDEO_FALLBACK_HEIGHT
  const roundedFps = sourceFps === null ? BROWSER_VIDEO_FALLBACK_FPS : (() => {
    const floor = Math.floor(sourceFps)
    const fraction = sourceFps - floor
    return fraction < 0.5 ? floor : fraction > 0.5 ? floor + 1 : floor % 2 === 0 ? floor : floor + 1
  })()
  return {
    width: width + (width % 2),
    height: height + (height % 2),
    fps: Math.max(1, roundedFps),
    sourceWidth,
    sourceHeight,
    sourceFps,
  }
}

export function getOrProbeSourceVideoMetadata(file: File, signal?: AbortSignal): Promise<BrowserVideoProbeResult | null>
export function getOrProbeSourceVideoMetadata(file: File, options?: BrowserVideoMetadataProbeOptions): Promise<BrowserVideoProbeResult | null>
export async function getOrProbeSourceVideoMetadata(
  file: File,
  signalOrOptions: AbortSignal | BrowserVideoMetadataProbeOptions = {},
): Promise<BrowserVideoProbeResult | null> {
  const options = "aborted" in signalOrOptions ? { signal: signalOrOptions } : signalOrOptions
  if (options.signal?.aborted) throw new DOMException("Operation cancelled", "AbortError")
  const runProbe = options.runProbe ?? (async (input, signal) => {
    const { cleanupFfmpegFiles, withBrowserFfmpeg } = await import("./ffmpeg")
    return withBrowserFfmpeg(signal, async (ffmpeg) => {
    const inputPath = "madnolia-video-metadata-input.bin"
    const logs: string[] = []
    const onLog = ({ message }: BrowserVideoProbeLogEvent): void => {
      logs.push(message.slice(0, 400))
      while (logs.join("\n").length > BROWSER_VIDEO_PROBE_LOG_LIMIT * 1024) logs.shift()
    }
    ffmpeg.on("log", onLog)
    try {
      await ffmpeg.writeFile(inputPath, new Uint8Array(await input.arrayBuffer()), { signal })
      await ffmpeg.exec(["-i", inputPath, "-map", "0:v:0", "-c", "copy", "-t", "0", "-f", "null", "-"], BROWSER_VIDEO_METADATA_PROBE_TIMEOUT_MS, { signal })
      return logs.join("\n")
    } finally {
      ffmpeg.off("log", onLog)
      await cleanupFfmpegFiles(ffmpeg, [inputPath])
    }
    })
  })
  return parseFfmpegVideoMetadata(await runProbe(file, options.signal))
}
