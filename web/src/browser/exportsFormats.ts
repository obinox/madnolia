import type { CompositionProject, TimelineSegment } from "../types"
import type { BrowserCompositionSource, BrowserVideoClip } from "../types/browserAudio"

const timelineKey = (left: TimelineSegment, right: TimelineSegment): number =>
  left.timeline_start_ms - right.timeline_start_ms || left.segment_id.localeCompare(right.segment_id)

export const videoClips = (composition: CompositionProject): BrowserVideoClip[] => {
  const clips: BrowserVideoClip[] = []
  for (const segment of [...composition.segments].sort(timelineKey)) {
    const spans = segment.edit_regions.length
      ? segment.edit_regions.map((region) => ({ sourceStartMs: region.source_start_ms, sourceEndMs: region.source_end_ms, durationMs: region.output_duration_ms }))
      : segment.phone_units.length
        ? segment.phone_units.flatMap((unit) => unit.source_start_ms === null || unit.source_end_ms === null
          ? []
          : [{ sourceStartMs: unit.source_start_ms, sourceEndMs: unit.source_end_ms, durationMs: unit.output_duration_ms }])
        : [{ sourceStartMs: segment.source_start_ms, sourceEndMs: segment.source_end_ms, durationMs: segment.timeline_end_ms - segment.timeline_start_ms }]
    let offsetMs = 0
    for (const span of spans) {
      if (span.sourceEndMs <= span.sourceStartMs || span.durationMs <= 0) continue
      clips.push({
        sourceId: segment.source_id,
        sourceStartMs: span.sourceStartMs,
        sourceEndMs: span.sourceEndMs,
        timelineStartMs: segment.timeline_start_ms + offsetMs,
        durationMs: span.durationMs,
        crossfadeMs: segment.crossfade_ms ?? composition.crossfade_ms,
        segmentId: segment.segment_id,
      })
      offsetMs += span.durationMs
    }
  }
  return clips
}

const timecode = (milliseconds: number, fps: number): string => {
  const frames = Math.round(milliseconds * fps / 1000)
  const frame = frames % fps
  const seconds = Math.floor(frames / fps)
  return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}:${String(frame).padStart(2, "0")}`
}

const xml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&apos;")
const seconds = (milliseconds: number, fps: number): string => `${Math.round(milliseconds * fps / 1000)}/${fps}s`

export const edlText = (
  composition: CompositionProject,
  sources: Map<string, BrowserCompositionSource>,
  defaultFps: number,
): string => {
  const clips = videoClips(composition)
  const fps = Math.max(1, Math.round(clips.map((clip) => sources.get(clip.sourceId)?.source.video_fps).find((value) => value && value > 0) ?? defaultFps))
  const lines = [`TITLE: ${composition.name}`, "FCM: NON-DROP FRAME", ""]
  for (const [index, clip] of clips.entries()) {
    const source = sources.get(clip.sourceId)
    if (!source) continue
    const filename = source.media?.name ?? source.source.path.split(/[\\/]/).pop() ?? source.source.source_id
    const sourceName = filename.replace(/\.[^.]+$/, "").slice(0, 8).toUpperCase()
    const sourceDuration = clip.sourceEndMs - clip.sourceStartMs
    const speed = clip.durationMs / sourceDuration
    lines.push(`${String(index + 1).padStart(3, "0")}  ${sourceName.padEnd(8)} V     C        ${timecode(clip.sourceStartMs, fps)} ${timecode(clip.sourceEndMs, fps)} ${timecode(clip.timelineStartMs, fps)} ${timecode(clip.timelineStartMs + clip.durationMs, fps)}`)
    lines.push(`* FROM CLIP NAME: ${filename}`)
    lines.push(`* SOURCE SPEED: ${speed.toFixed(6)}x`)
    lines.push("")
  }
  return lines.join("\n")
}

export const fcpxmlText = (
  composition: CompositionProject,
  sources: Map<string, BrowserCompositionSource>,
  defaultFps: number,
  defaultWidth: number,
  defaultHeight: number,
): string => {
  const clips = videoClips(composition)
  const usedSourceIds = [...new Set(clips.map((clip) => clip.sourceId))]
  const first = usedSourceIds.map((id) => sources.get(id)).find(Boolean)
  const fps = Math.max(1, Math.round(first?.source.video_fps ?? defaultFps))
  const width = first?.source.video_width ?? defaultWidth
  const height = first?.source.video_height ?? defaultHeight
  const assetRefs = new Map(usedSourceIds.map((sourceId, index) => [sourceId, `r${index + 2}`]))
  const resources = usedSourceIds.map((sourceId) => {
    const source = sources.get(sourceId)
    if (!source) return ""
    const filename = source.media?.name ?? source.source.path.split(/[\\/]/).pop() ?? source.source.source_id
    const src = `madnolia-relink://${encodeURIComponent(sourceId)}/${encodeURIComponent(filename)}`
    return `<asset id="${assetRefs.get(sourceId)}" name="${xml(filename)}" start="0s" duration="${Math.max(0, source.source.duration_ms)}/1000s" hasVideo="${source.source.video_width ? 1 : 0}" hasAudio="1"><media-rep kind="original-media" src="${xml(src)}"/></asset>`
  }).join("")
  const assetClips = clips.map((clip) => {
    const start = seconds(clip.sourceStartMs, fps)
    const end = seconds(clip.sourceEndMs, fps)
    const offset = seconds(clip.timelineStartMs, fps)
    const duration = seconds(clip.durationMs, fps)
    const sourceDuration = clip.sourceEndMs - clip.sourceStartMs
    const timeMap = Math.abs(clip.durationMs - sourceDuration) < 0.5
      ? ""
      : `<timeMap><timept time="0s" value="${start}" interp="linear"/><timept time="${duration}" value="${end}" interp="linear"/></timeMap>`
    return `<asset-clip ref="${assetRefs.get(clip.sourceId)}" offset="${offset}" start="${start}" duration="${duration}" name="${xml(clip.segmentId)}">${timeMap}</asset-clip>`
  }).join("")
  const sequenceDuration = seconds(Math.max(0, ...composition.segments.map((segment) => segment.timeline_end_ms)), fps)
  return `<?xml version="1.0" encoding="UTF-8"?><fcpxml version="1.10"><resources><format id="f1" name="MadnoliaFormat" frameDuration="1/${fps}s" width="${width}" height="${height}"/>${resources}</resources><library><event name="Madnolia"><project name="${xml(composition.name)}"><sequence format="f1" duration="${sequenceDuration}"><spine>${assetClips}</spine></sequence></project></event></library></fcpxml>`
}
