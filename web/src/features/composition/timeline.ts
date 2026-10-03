import type { CompositionMode, TimelineSegment } from "../../types"

export function retimeCompositionSegments(
  segments: TimelineSegment[],
  mode: CompositionMode,
): TimelineSegment[] {
  if (mode === "PROFESSIONAL") {
    const durations = segments.map((segment) => segmentDuration(segment, mode))
    const laneEnds: number[] = []
    const ordered = segments.map((segment, index) => ({ segment, index }))
      .sort((left, right) => left.segment.timeline_start_ms - right.segment.timeline_start_ms
        || (left.segment.segment_id < right.segment.segment_id ? -1 : left.segment.segment_id > right.segment.segment_id ? 1 : 0))
    const lanes = new Map<string, number>()
    for (const { segment, index } of ordered) {
      const start = segment.timeline_start_ms
      let lane = laneEnds.findIndex((end) => end <= start)
      if (lane < 0) lane = laneEnds.length
      laneEnds[lane] = start + durations[index]
      lanes.set(segment.segment_id, lane)
    }
    return segments.map((segment, index) => {
      const previous = segments[index - 1]
      const end = segment.timeline_start_ms + durations[index]
      return {
        ...segment,
        lane: lanes.get(segment.segment_id) ?? 0,
        gap_before_ms: previous ? segment.timeline_start_ms - previous.timeline_start_ms - durations[index - 1] : segment.timeline_start_ms,
        timeline_end_ms: end,
      }
    })
  }
  let cursor = 0
  return segments.map((segment, index) => {
    const timelineDuration = segmentDuration(segment, mode)
    const duration = timelineDuration
    const previousDuration = index ? segmentDuration(segments[index - 1], mode) : duration
    const gap = index ? Math.max(-Math.min(duration, previousDuration), segment.gap_before_ms) : Math.max(0, segment.gap_before_ms)
    const previousEnd = cursor
    const start = cursor + gap
    cursor = start + duration
    return {
      ...segment,
      lane: 0,
      gap_before_ms: index ? start - previousEnd : start,
      timeline_start_ms: start,
      timeline_end_ms: cursor,
    }
  })
}

function segmentDuration(segment: TimelineSegment, mode: CompositionMode): number {
  return mode === "PROFESSIONAL"
    ? segment.edit_regions?.length
      ? segment.edit_regions.reduce((total, region) => total + region.output_duration_ms, 0)
      : segment.phone_units.reduce((total, unit) => total + unit.output_duration_ms, 0)
    : Math.round((segment.source_end_ms - segment.source_start_ms) * segment.stretch_percent / 100)
}

export function reorderSegments(segments: TimelineSegment[], sourceId: string, destinationId: string): TimelineSegment[] {
  const from = segments.findIndex((segment) => segment.segment_id === sourceId)
  const to = segments.findIndex((segment) => segment.segment_id === destinationId)
  if (from < 0 || to < 0 || from === to) return segments
  const result = [...segments]
  const [item] = result.splice(from, 1)
  result.splice(to, 0, item)
  return result
}
