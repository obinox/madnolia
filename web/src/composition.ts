import {
  MAX_CROSSFADE_MS,
  PITCH_TRANSITION_DEFAULT_MS,
  PITCH_TRANSITION_DEFAULT_STRENGTH,
  PROFESSIONAL_ENVELOPE_DEFAULT,
  PROFESSIONAL_MAX_DURATION_PERCENT,
  PROFESSIONAL_MIN_DURATION_PERCENT,
  PROFESSIONAL_PITCH_MAX_CENTS,
  PROFESSIONAL_PITCH_MIN_CENTS,
} from "./constants"
import type { CompositionMode, EditRegion, PhoneUnit, ProfessionalHandleMode, ProfessionalHandleResult, TimelineSegment } from "./types"

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

export function mapWaveformToOutput(segment: TimelineSegment, peaks: number[]): string {
  if (!peaks.length) return ""
  const sourceLength = segment.source_end_ms - segment.source_start_ms
  const duration = segment.edit_regions.reduce((sum, region) => sum + region.output_duration_ms, 0)
  let output = 0
  const points: string[] = []
  segment.edit_regions.forEach((region) => {
    const count = Math.max(2, Math.ceil(region.output_duration_ms / duration * 400))
    for (let index = 0; index <= count; index += 1) {
      const source = region.source_start_ms + (region.source_end_ms - region.source_start_ms) * index / count
      const peak = Math.max(0, Math.min(peaks.length - 1, Math.floor((source - segment.source_start_ms) / sourceLength * peaks.length)))
      const x = (output + region.output_duration_ms * index / count) / duration * 1000
      points.push(`${x},${50 - peaks[peak] * 44}`)
    }
    output += region.output_duration_ms
  })
  return points.join(" ")
}

export function deriveProfessionalSegments(segments: TimelineSegment[]): TimelineSegment[] {
  return retimeCompositionSegments(segments.map((segment) => {
    const phoneUnits = segment.phone_units.length ? segment.phone_units : derivePhoneUnits(segment)
    return {
      ...segment,
      crossfade_ms: segment.crossfade_ms ?? Math.max(0, Math.min(MAX_CROSSFADE_MS, -segment.gap_before_ms)),
      edit_regions: segment.edit_regions?.length ? segment.edit_regions : guideRegions(segment, phoneUnits, segment.timeline_end_ms - segment.timeline_start_ms),
      volume_envelope: segment.volume_envelope?.length ? segment.volume_envelope : PROFESSIONAL_ENVELOPE_DEFAULT,
    }
  }), "PROFESSIONAL")
}

function segmentDuration(segment: TimelineSegment, mode: CompositionMode): number {
  return mode === "PROFESSIONAL"
    ? segment.edit_regions?.length
      ? segment.edit_regions.reduce((total, region) => total + region.output_duration_ms, 0)
      : segment.phone_units.reduce((total, unit) => total + unit.output_duration_ms, 0)
    : Math.round((segment.source_end_ms - segment.source_start_ms) * segment.stretch_percent / 100)
}

function guideRegions(segment: TimelineSegment, units: PhoneUnit[], outputTotal: number): EditRegion[] {
  const start = segment.source_start_ms
  const end = segment.source_end_ms
  const guideStarts = [...new Set(units
    .map((unit) => unit.source_start_ms)
    .filter((value): value is number => value !== null && value > start && value < end))].sort((a, b) => a - b)
  const boundaries = [start, ...guideStarts, end]
  const sourceDurations = boundaries.slice(0, -1).map((sourceStart, index) => boundaries[index + 1] - sourceStart)
  let allocated = 0
  return boundaries.slice(0, -1).map((sourceStart, index) => {
    const sourceEnd = boundaries[index + 1]
    const outputDuration = index === boundaries.length - 2
      ? outputTotal - allocated
      : Math.max(1, Math.round(outputTotal * sourceDurations[index] / (segment.source_end_ms - segment.source_start_ms)))
    allocated += outputDuration
    return {
      region_id: `region_${crypto.randomUUID()}`,
      source_start_ms: sourceStart,
      source_end_ms: sourceEnd,
      output_duration_ms: outputDuration,
      relative_pitch_cents: 0,
    }
  })
}

export function splitEditRegions(regions: EditRegion[], startMs: number, endMs: number): EditRegion[] {
  const low = Math.min(startMs, endMs)
  const high = Math.max(startMs, endMs)
  return regions.flatMap((region) => {
    const cuts = [...new Set([region.source_start_ms, ...[low, high].filter((point) => point > region.source_start_ms && point < region.source_end_ms), region.source_end_ms])]
    if (cuts.length === 2) return [region]
    const sourceLength = region.source_end_ms - region.source_start_ms
    const lengths = cuts.slice(0, -1).map((point, index) => cuts[index + 1] - point)
    const minimums = lengths.map((length) => Math.ceil(length * PROFESSIONAL_MIN_DURATION_PERCENT / 100))
    const maximums = lengths.map((length) => Math.floor(length * PROFESSIONAL_MAX_DURATION_PERCENT / 100))
    if (region.output_duration_ms < minimums.reduce((sum, value) => sum + value, 0)
      || region.output_duration_ms > maximums.reduce((sum, value) => sum + value, 0)) return [region]
    const durations = lengths.map((length) => Math.max(1, Math.round(region.output_duration_ms * length / sourceLength)))
    for (let index = 0; index < durations.length; index += 1) durations[index] = Math.max(minimums[index], Math.min(maximums[index], durations[index]))
    let difference = region.output_duration_ms - durations.reduce((sum, value) => sum + value, 0)
    for (let index = 0; difference && index < durations.length; index += 1) {
      const capacity = difference > 0 ? maximums[index] - durations[index] : durations[index] - minimums[index]
      const adjustment = Math.min(Math.abs(difference), capacity) * Math.sign(difference)
      durations[index] += adjustment
      difference -= adjustment
    }
    if (difference) return [region]
    return cuts.slice(0, -1).map((point, index) => ({
      ...region,
      region_id: index === 0 ? region.region_id : `region_${crypto.randomUUID()}`,
      source_start_ms: point,
      source_end_ms: cuts[index + 1],
      output_duration_ms: durations[index],
    }))
  })
}

export function changeRegionBoundary(segments: TimelineSegment[], segmentId: string, regionId: string, field: "source_start_ms" | "source_end_ms", value: number): TimelineSegment[] {
  if (!Number.isFinite(value)) return segments
  const changed = segments.map((segment) => {
    if (segment.segment_id !== segmentId) return segment
    const original = segment.edit_regions
    const index = original.findIndex((region) => region.region_id === regionId)
    if (index < 0) return segment
    const next = [...original]
    const region = original[index]
    const point = Math.trunc(value)
    const boundaryIndex = field === "source_start_ms" ? index : index + 1
    const lower = boundaryIndex ? original[boundaryIndex - 1].source_start_ms + 1 : segment.source_start_ms
    const upper = boundaryIndex < original.length ? original[boundaryIndex].source_end_ms - 1 : segment.source_end_ms
    const bounded = Math.max(lower, Math.min(upper, point))
    if (field === "source_start_ms" && index === 0 || field === "source_end_ms" && index === original.length - 1) return segment
    const left = original[boundaryIndex - 1]
    const right = original[boundaryIndex]
    const leftSource = bounded - left.source_start_ms
    const rightSource = right.source_end_ms - bounded
    const leftRatio = left.output_duration_ms / (left.source_end_ms - left.source_start_ms)
    const rightRatio = right.output_duration_ms / (right.source_end_ms - right.source_start_ms)
    next[boundaryIndex - 1] = { ...left, source_end_ms: bounded, output_duration_ms: clampDuration(Math.round(leftSource * leftRatio), leftSource) }
    next[boundaryIndex] = { ...right, source_start_ms: bounded, output_duration_ms: clampDuration(Math.round(rightSource * rightRatio), rightSource) }
    return { ...segment, edit_regions: next }
  })
  return retimeCompositionSegments(changed, "PROFESSIONAL")
}

export function updateEditRegion(segments: TimelineSegment[], segmentId: string, regionId: string, updates: Partial<EditRegion>): TimelineSegment[] {
  if (updates.output_duration_ms !== undefined && !Number.isFinite(updates.output_duration_ms)) return segments
  if (updates.relative_pitch_cents !== undefined && !Number.isFinite(updates.relative_pitch_cents)) return segments
  const changed = segments.map((segment) => {
    if (segment.segment_id !== segmentId) return segment
    const regions = segment.edit_regions.map((region) => {
      if (region.region_id !== regionId) return region
      const duration = updates.output_duration_ms === undefined
        ? region.output_duration_ms
        : clampDuration(Math.trunc(updates.output_duration_ms), region.source_end_ms - region.source_start_ms)
    const cents = updates.relative_pitch_cents === undefined
      ? region.relative_pitch_cents
      : Math.max(PROFESSIONAL_PITCH_MIN_CENTS, Math.min(PROFESSIONAL_PITCH_MAX_CENTS, Math.trunc(updates.relative_pitch_cents)))
      return { ...region, ...updates, output_duration_ms: duration, relative_pitch_cents: cents }
    })
    return { ...segment, edit_regions: regions }
  })
  return retimeCompositionSegments(changed, "PROFESSIONAL")
}

export function resizeProfessionalHandle(segment: TimelineSegment, selectedIndex: number, boundaryIndex: number, mode: ProfessionalHandleMode, requestedDelta: number): ProfessionalHandleResult {
  const durations = segment.edit_regions.map((region) => region.output_duration_ms)
  if (!Number.isFinite(requestedDelta) || selectedIndex < 0 || selectedIndex >= durations.length || boundaryIndex < 0 || boundaryIndex > durations.length) {
    return { startMs: segment.timeline_start_ms, durations }
  }
  const startMs = segment.timeline_start_ms
  if (mode === "shift") return { startMs: Math.max(0, Math.round(startMs + requestedDelta)), durations }
  const minimums = segment.edit_regions.map((region) => Math.ceil((region.source_end_ms - region.source_start_ms) * PROFESSIONAL_MIN_DURATION_PERCENT / 100))
  const maximums = segment.edit_regions.map((region) => Math.floor((region.source_end_ms - region.source_start_ms) * PROFESSIONAL_MAX_DURATION_PERCENT / 100))
  let delta = Math.round(requestedDelta)
  const adjust = (index: number, sign: number) => {
    delta = Math.max(sign > 0 ? minimums[index] - durations[index] : durations[index] - maximums[index], Math.min(sign > 0 ? maximums[index] - durations[index] : durations[index] - minimums[index], delta))
  }
  if (mode === "normal" && boundaryIndex === selectedIndex && selectedIndex > 0) {
    delta = Math.max(minimums[selectedIndex - 1] - durations[selectedIndex - 1], Math.min(maximums[selectedIndex - 1] - durations[selectedIndex - 1], delta))
    delta = Math.max(durations[selectedIndex] - maximums[selectedIndex], Math.min(durations[selectedIndex] - minimums[selectedIndex], delta))
    durations[selectedIndex - 1] += delta
    durations[selectedIndex] -= delta
  } else if (mode === "normal" && boundaryIndex === selectedIndex + 1 && selectedIndex < durations.length - 1) {
    delta = Math.max(minimums[selectedIndex] - durations[selectedIndex], Math.min(maximums[selectedIndex] - durations[selectedIndex], delta))
    delta = Math.max(durations[selectedIndex + 1] - maximums[selectedIndex + 1], Math.min(durations[selectedIndex + 1] - minimums[selectedIndex + 1], delta))
    durations[selectedIndex] += delta
    durations[selectedIndex + 1] -= delta
  } else if (boundaryIndex === 0) {
    delta = Math.max(-startMs, delta)
    delta = Math.max(durations[0] - maximums[0], Math.min(durations[0] - minimums[0], delta))
    durations[0] -= delta
    return { startMs: Math.max(0, startMs + delta), durations }
  } else if (boundaryIndex === durations.length) {
    adjust(selectedIndex, 1)
    durations[selectedIndex] += delta
  } else if (mode === "ctrl" && boundaryIndex === selectedIndex) {
    delta = Math.max(-startMs, delta)
    delta = Math.max(durations[selectedIndex] - maximums[selectedIndex], Math.min(durations[selectedIndex] - minimums[selectedIndex], delta))
    durations[selectedIndex] -= delta
    return { startMs: Math.max(0, startMs + delta), durations }
  } else if (mode === "ctrl" && boundaryIndex === selectedIndex + 1) {
    adjust(selectedIndex, 1)
    durations[selectedIndex] += delta
  }
  return { startMs, durations }
}

export function applyProfessionalHandleDrag(segments: TimelineSegment[], original: TimelineSegment, nextStartMs: number, durations: number[]): TimelineSegment[] {
  if (durations.length !== original.edit_regions.length || durations.some((duration) => !Number.isFinite(duration))) return segments
  const edit_regions = original.edit_regions.map((region, index) => ({ ...region, output_duration_ms: Math.trunc(durations[index]) }))
  const changed = segments.map((segment) => segment.segment_id === original.segment_id ? {
    ...original,
    timeline_start_ms: Math.max(0, Math.trunc(nextStartMs)),
    edit_regions,
    volume_envelope: warpEnvelopeForRegionDurations(original.volume_envelope, original.edit_regions, edit_regions),
    pitch_envelope: original.pitch_envelope ? warpEnvelopeForRegionDurations(original.pitch_envelope, original.edit_regions, edit_regions) : undefined,
  } : segment)
  return retimeCompositionSegments(changed, "PROFESSIONAL")
}

export function updateSelectedRange(segments: TimelineSegment[], segmentId: string, startMs: number, endMs: number, updates: Partial<EditRegion>): TimelineSegment[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return segments
  if (updates.output_duration_ms !== undefined && !Number.isFinite(updates.output_duration_ms)) return segments
  if (updates.relative_pitch_cents !== undefined && !Number.isFinite(updates.relative_pitch_cents)) return segments
  const selected = segments.find((segment) => segment.segment_id === segmentId)
  if (!selected) return segments
  const low = Math.max(selected.source_start_ms, Math.trunc(Math.min(startMs, endMs)))
  const high = Math.min(selected.source_end_ms, Math.trunc(Math.max(startMs, endMs)))
  if (high <= low) return segments
  const split = segments.map((segment) => segment.segment_id === segmentId
    ? { ...segment, edit_regions: splitEditRegions(segment.edit_regions, low, high) }
    : segment)
  const targetIds = new Set(split.find((segment) => segment.segment_id === segmentId)?.edit_regions
    .filter((region) => region.source_start_ms >= low && region.source_end_ms <= high)
    .map((region) => region.region_id))
  const selectedRegions = split.find((segment) => segment.segment_id === segmentId)?.edit_regions.filter((region) => targetIds.has(region.region_id)) ?? []
  const selectedSourceLength = selectedRegions.reduce((sum, region) => sum + region.source_end_ms - region.source_start_ms, 0)
  const selectedTargetDuration = updates.output_duration_ms === undefined
    ? null
    : clampDuration(Math.trunc(updates.output_duration_ms), selectedSourceLength)
  return retimeCompositionSegments(split.map((segment) => {
    if (segment.segment_id !== segmentId) return segment
    const edit_regions = segment.edit_regions.map((region) => {
      if (!targetIds.has(region.region_id)) return region
      const duration = selectedTargetDuration === null
        ? region.output_duration_ms
        : clampDuration(Math.round(selectedTargetDuration * (region.source_end_ms - region.source_start_ms) / selectedSourceLength), region.source_end_ms - region.source_start_ms)
      const cents = updates.relative_pitch_cents === undefined
        ? region.relative_pitch_cents
        : Math.max(PROFESSIONAL_PITCH_MIN_CENTS, Math.min(PROFESSIONAL_PITCH_MAX_CENTS, Math.trunc(updates.relative_pitch_cents)))
      return { ...region, output_duration_ms: duration, relative_pitch_cents: cents }
    })
    return {
      ...segment,
      edit_regions,
      volume_envelope: warpEnvelopeForRegionDurations(segment.volume_envelope, selected.edit_regions, edit_regions),
      pitch_envelope: segment.pitch_envelope
        ? warpEnvelopeForRegionDurations(segment.pitch_envelope, selected.edit_regions, edit_regions)
        : undefined,
    }
  }), "PROFESSIONAL")
}

export function warpEnvelopeForRegionDurations<T extends { position: number }>(points: T[], previous: EditRegion[], next: EditRegion[]): T[] {
  const previousTotal = previous.reduce((sum, region) => sum + region.output_duration_ms, 0)
  const nextTotal = next.reduce((sum, region) => sum + region.output_duration_ms, 0)
  if (!previousTotal || !nextTotal || previous.length === 0 || next.length === 0) return points
  const mapPosition = (position: number) => {
    const output = Math.max(0, Math.min(previousTotal, position * previousTotal))
    let previousOffset = 0
    let source = previous.at(-1)!.source_end_ms
    for (const region of previous) {
      if (output <= previousOffset + region.output_duration_ms) {
        source = region.source_start_ms + (output - previousOffset) / region.output_duration_ms * (region.source_end_ms - region.source_start_ms)
        break
      }
      previousOffset += region.output_duration_ms
    }
    let nextOffset = 0
    for (const region of next) {
      if (source <= region.source_end_ms) return (nextOffset + Math.max(0, source - region.source_start_ms) / (region.source_end_ms - region.source_start_ms) * region.output_duration_ms) / nextTotal
      nextOffset += region.output_duration_ms
    }
    return 1
  }
  return points.map((point) => ({ ...point, position: mapPosition(point.position) }))
}

function clampDuration(duration: number, sourceDuration: number): number {
  return Math.max(Math.ceil(sourceDuration * PROFESSIONAL_MIN_DURATION_PERCENT / 100), Math.min(Math.floor(sourceDuration * PROFESSIONAL_MAX_DURATION_PERCENT / 100), duration))
}

function derivePhoneUnits(segment: TimelineSegment): PhoneUnit[] {
  const targetDuration = segment.timeline_end_ms - segment.timeline_start_ms
  if (segment.phone_units.length) {
    const sourceDurations = segment.phone_units.map((unit) => (
      unit.source_start_ms === null || unit.source_end_ms === null
        ? unit.output_duration_ms
        : Math.max(1, unit.source_end_ms - unit.source_start_ms)
    ))
    const sourceTotal = sourceDurations.reduce((total, duration) => total + duration, 0)
    let allocated = 0
    return segment.phone_units.map((unit, index) => {
      const duration = index === segment.phone_units.length - 1
        ? Math.max(1, targetDuration - allocated)
        : Math.max(1, Math.round(targetDuration * sourceDurations[index] / sourceTotal))
      allocated += duration
      return { ...unit, phone_unit_id: `phone_${crypto.randomUUID()}`, output_duration_ms: duration }
    })
  }

  const count = Math.max(1, segment.target_ipa.length)
  const sourceDuration = segment.source_end_ms - segment.source_start_ms
  let outputCursor = 0
  return Array.from({ length: count }, (_, index) => {
    const sourceStart = segment.source_start_ms + Math.round(sourceDuration * index / count)
    const sourceEnd = segment.source_start_ms + Math.round(sourceDuration * (index + 1) / count)
    const outputDuration = index === count - 1
      ? Math.max(1, targetDuration - outputCursor)
      : Math.max(1, Math.round(targetDuration / count))
    outputCursor += outputDuration
    return {
      phone_unit_id: `phone_${crypto.randomUUID()}`,
      operation: segment.match_status === "EXACT" ? "MATCH" : "SUBSTITUTE",
      target_index: segment.target_start_index + index,
      target_phone_id: null,
      target_ipa: segment.target_ipa[index] ?? null,
      source_occurrence_id: null,
      source_phone_id: null,
      source_ipa: segment.matched_ipa[index] ?? null,
      source_start_ms: sourceStart,
      source_end_ms: Math.max(sourceStart + 1, sourceEnd),
      output_duration_ms: outputDuration,
      source_f0_hz: null,
      voiced_probability: 0,
      target_pitch_midi: null,
      formant_shift_semitones: 0,
      transition_to_next_ms: PITCH_TRANSITION_DEFAULT_MS,
      transition_strength_percent: PITCH_TRANSITION_DEFAULT_STRENGTH,
      transition_center_ms: 0,
    }
  })
}
