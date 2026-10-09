import {
  MAX_CROSSFADE_MS,
  PITCH_TRANSITION_DEFAULT_MS,
  PITCH_TRANSITION_DEFAULT_STRENGTH,
  PROFESSIONAL_ENVELOPE_DEFAULT,
  PROFESSIONAL_MAX_DURATION_PERCENT,
  PROFESSIONAL_MIN_DURATION_PERCENT,
  PROFESSIONAL_PITCH_MAX_CENTS,
  PROFESSIONAL_PITCH_MIN_CENTS,
  PITCH_TARGET_STRENGTH_DEFAULT_PERCENT,
  PITCH_VIBRATO_DEPTH_DEFAULT_CENTS,
  PITCH_VIBRATO_RATE_DEFAULT_HZ,
  PITCH_VIBRATO_START_DEFAULT_MS,
  REGION_PITCH_MERGE_GAP_POSITION,
} from "../../constants"
import { retimeCompositionSegments } from "./timeline"
import type { CompositionMode, EditRegion, EnvelopeConstraintPoint, PhonePitchPoint, PhoneUnit, ProfessionalHandleMode, ProfessionalHandleResult, TimelineSegment } from "../../types"

export function deriveProfessionalSegments(segments: TimelineSegment[]): TimelineSegment[] {
  const base = retimeCompositionSegments(segments.map((segment) => {
    const phoneUnits = (segment.phone_units.length ? segment.phone_units : derivePhoneUnits(segment)).map(normalizePhoneUnit)
    return {
      ...segment,
      phone_units: phoneUnits,
      crossfade_ms: segment.crossfade_ms ?? Math.max(0, Math.min(MAX_CROSSFADE_MS, -segment.gap_before_ms)),
      edit_regions: segment.edit_regions?.length ? segment.edit_regions : guideRegions(segment, phoneUnits, segment.timeline_end_ms - segment.timeline_start_ms),
      volume_envelope: segment.volume_envelope?.length ? segment.volume_envelope : PROFESSIONAL_ENVELOPE_DEFAULT,
    }
  }), "PROFESSIONAL")
  return base.map((segment) => ({
    ...segment,
    edit_regions: migrateLegacyPitchCurves(segment.edit_regions, segment, base),
  }))
}

function migrateLegacyPitchCurves(regions: EditRegion[], segment: TimelineSegment, segments: TimelineSegment[]): EditRegion[] {
  const outputAt = (item: TimelineSegment, sourceMs: number) => {
    let offset = 0
    for (const region of item.edit_regions) {
      if (sourceMs <= region.source_start_ms) return offset
      if (sourceMs <= region.source_end_ms) return offset + (sourceMs - region.source_start_ms) / Math.max(1, region.source_end_ms - region.source_start_ms) * region.output_duration_ms
      offset += region.output_duration_ms
    }
    return offset
  }
  const phoneInterval = (item: TimelineSegment, phone: PhoneUnit) => phone.source_start_ms === null || phone.source_end_ms === null ? null : {
    start: item.timeline_start_ms + outputAt(item, phone.source_start_ms),
    end: item.timeline_start_ms + outputAt(item, phone.source_end_ms),
  }
  const ownerRef = (item: TimelineSegment, phone: PhoneUnit) => phone.pitch_owner_ref ?? { segment_id: item.segment_id, phone_unit_id: phone.phone_unit_id }
  return regions.map((region) => {
    if (region.pitch_points?.length) return region
    const regionStart = segment.timeline_start_ms + outputAt(segment, region.source_start_ms)
    const regionEnd = segment.timeline_start_ms + outputAt(segment, region.source_end_ms)
    const samples = segment.phone_units.flatMap((phone) => {
      const owner = ownerRef(segment, phone)
      const ownerSegment = segments.find((candidate) => candidate.segment_id === owner.segment_id)
      if (!ownerSegment || ownerSegment.lane !== segment.lane) return []
      const ownerPhone = ownerSegment?.phone_units.find((candidate) => candidate.phone_unit_id === owner.phone_unit_id)
      const curve = ownerPhone?.pitch_points
      if (!curve?.length) return []
      const members = segments.flatMap((candidate) => candidate.lane === ownerSegment.lane ? candidate.phone_units.flatMap((member) => {
        const reference = ownerRef(candidate, member)
        const interval = phoneInterval(candidate, member)
        return reference.segment_id === owner.segment_id && reference.phone_unit_id === owner.phone_unit_id && interval ? [interval] : []
      }) : [])
      if (!members.length) return []
      const groupStart = Math.min(...members.map((interval) => interval.start))
      const groupEnd = Math.max(...members.map((interval) => interval.end))
      const interval = phoneInterval(segment, phone)
      if (!interval || interval.end <= regionStart || interval.start >= regionEnd || groupEnd <= groupStart) return []
      const low = Math.max(regionStart, interval.start)
      const high = Math.min(regionEnd, interval.end)
      const midiAt = (position: number) => {
        const rightIndex = curve.findIndex((point) => point.position >= position)
        if (rightIndex <= 0) return curve[rightIndex < 0 ? curve.length - 1 : 0].midi
        const left = curve[rightIndex - 1]
        const right = curve[rightIndex]
        const amount = (position - left.position) / Math.max(Number.EPSILON, right.position - left.position)
        return left.midi + (right.midi - left.midi) * amount
      }
      const pointAtTime = (time: number) => midiAt((time - groupStart) / (groupEnd - groupStart))
      return [
        { position: (low - regionStart) / Math.max(1, regionEnd - regionStart), midi: pointAtTime(low) },
        ...curve.flatMap((point) => {
          const time = groupStart + point.position * (groupEnd - groupStart)
          return time > low && time < high ? [{ position: (time - regionStart) / Math.max(1, regionEnd - regionStart), midi: point.midi }] : []
        }),
        { position: (high - regionStart) / Math.max(1, regionEnd - regionStart), midi: pointAtTime(high) },
      ]
    }).sort((left, right) => left.position - right.position)
    const unique: PhonePitchPoint[] = []
    let sourcePosition = Number.NaN
    let sourceValues = new Set<number>()
    for (const point of samples) {
      if (point.position !== sourcePosition) {
        sourcePosition = point.position
        sourceValues = new Set()
      }
      if (sourceValues.has(point.midi)) continue
      sourceValues.add(point.midi)
      const previous = unique.at(-1)
      if (!previous || point.position > previous.position) unique.push(point)
      else {
        const position = Math.min(1, previous.position + REGION_PITCH_MERGE_GAP_POSITION)
        if (position > previous.position) unique.push({ ...point, position })
      }
    }
    if (!unique.length) return region
    const startMidi = unique[0].midi
    const endMidi = unique.at(-1)!.midi
    const voicedPhone = segment.phone_units.find((phone) => phone.source_start_ms !== null && phone.source_end_ms !== null && phone.source_start_ms < region.source_end_ms && phone.source_end_ms > region.source_start_ms && phone.source_f0_hz !== null && phone.source_f0_hz > 0)
    return {
      ...region,
      source_f0_hz: region.source_f0_hz ?? voicedPhone?.source_f0_hz ?? null,
      pitch_points: [{ position: 0, midi: startMidi }, ...unique.filter((point) => point.position > 0 && point.position < 1), { position: 1, midi: endMidi }],
    }
  })
}

function normalizePhoneUnit(unit: PhoneUnit): PhoneUnit {
  return {
    ...unit,
    target_pitch_strength_percent: unit.target_pitch_strength_percent ?? PITCH_TARGET_STRENGTH_DEFAULT_PERCENT,
    vibrato_depth_cents: unit.vibrato_depth_cents ?? PITCH_VIBRATO_DEPTH_DEFAULT_CENTS,
    vibrato_rate_hz: unit.vibrato_rate_hz ?? PITCH_VIBRATO_RATE_DEFAULT_HZ,
    vibrato_start_ms: unit.vibrato_start_ms ?? PITCH_VIBRATO_START_DEFAULT_MS,
    pitch_points: unit.pitch_points ?? [],
    pitch_owner_ref: unit.pitch_owner_ref ?? null,
  }
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
      pitch_points: clipRegionPitchPoints(region.pitch_points, (point - region.source_start_ms) / sourceLength, (cuts[index + 1] - region.source_start_ms) / sourceLength),
    }))
  })
}

export function clipRegionPitchPoints(points: PhonePitchPoint[] | undefined, low: number, high: number): PhonePitchPoint[] | undefined {
  if (!points?.length) return points
  const at = (position: number) => {
    const rightIndex = points.findIndex((point) => point.position >= position)
    if (rightIndex < 0) return points.at(-1)!.midi
    if (rightIndex === 0) return points[0].midi
    const left = points[rightIndex - 1]
    const right = points[rightIndex]
    const amount = (position - left.position) / Math.max(Number.EPSILON, right.position - left.position)
    return left.midi + (right.midi - left.midi) * amount
  }
  const start = Math.max(0, Math.min(1, low))
  const end = Math.max(start, Math.min(1, high))
  const retained = points.filter((point) => point.position > start && point.position < end)
  const span = Math.max(Number.EPSILON, end - start)
  return [
    { position: 0, midi: at(start) },
    ...retained.map((point) => ({ ...point, position: (point.position - start) / span })),
    { position: 1, midi: at(end) },
  ]
}

export function mergeRegionPitchPoints(left: EditRegion, right: EditRegion): PhonePitchPoint[] | undefined {
  if (!left.pitch_points?.length && !right.pitch_points?.length) return undefined
  const leftRatio = left.output_duration_ms / Math.max(1, left.output_duration_ms + right.output_duration_ms)
  const gap = Math.min(REGION_PITCH_MERGE_GAP_POSITION, (1 - leftRatio) / 2)
  const leftPoints = clipRegionPitchPoints(left.pitch_points, 0, 1) ?? []
  const rightPoints = clipRegionPitchPoints(right.pitch_points, 0, 1) ?? []
  const leftValue = leftPoints.at(-1)?.midi ?? rightPoints[0]?.midi ?? 60
  const rightValue = (rightPoints[0]?.midi ?? leftValue) + (right.relative_pitch_cents - left.relative_pitch_cents) / 100
  const leftCurve = leftPoints.length ? leftPoints : [{ position: 0, midi: rightValue }, { position: 1, midi: rightValue }]
  const rightCurve = rightPoints.length ? rightPoints : [{ position: 0, midi: leftValue }, { position: 1, midi: leftValue }]
  const mappedLeft = leftCurve.map((point) => ({ position: point.position * leftRatio, midi: point.midi }))
  const mappedRight = rightCurve.map((point) => ({ position: leftRatio + gap + point.position * (1 - leftRatio - gap), midi: point.midi + (right.relative_pitch_cents - left.relative_pitch_cents) / 100 }))
  return [...mappedLeft, ...mappedRight]
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
    const leftRatioOfCurve = (bounded - left.source_start_ms) / (left.source_end_ms - left.source_start_ms)
    const rightRatioOfCurve = (bounded - right.source_start_ms) / (right.source_end_ms - right.source_start_ms)
    next[boundaryIndex - 1] = { ...left, source_end_ms: bounded, output_duration_ms: clampDuration(Math.round(leftSource * leftRatio), leftSource), pitch_points: clipRegionPitchPoints(left.pitch_points, 0, leftRatioOfCurve) }
    next[boundaryIndex] = { ...right, source_start_ms: bounded, output_duration_ms: clampDuration(Math.round(rightSource * rightRatio), rightSource), pitch_points: clipRegionPitchPoints(right.pitch_points, rightRatioOfCurve, 1) }
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

export function moveProfessionalTimelineSuffix(segments: TimelineSegment[], original: TimelineSegment[], grabbedId: string, deltaMs: number): TimelineSegment[] {
  const grabbed = original.find((segment) => segment.segment_id === grabbedId)
  if (!grabbed || !Number.isFinite(deltaMs)) return segments
  const affected = new Set(original.filter((segment) => segment.segment_id === grabbedId || segment.timeline_start_ms > grabbed.timeline_start_ms).map((segment) => segment.segment_id))
  const minimumStart = Math.min(...original.filter((segment) => affected.has(segment.segment_id)).map((segment) => segment.timeline_start_ms))
  const delta = Math.trunc(Math.max(-minimumStart, deltaMs))
  if (!delta) return original
  const moved = segments.map((segment) => {
    const snapshot = original.find((item) => item.segment_id === segment.segment_id)
    return snapshot && affected.has(segment.segment_id) ? { ...snapshot, timeline_start_ms: snapshot.timeline_start_ms + delta } : segment
  })
  const recalculated = retimeCompositionSegments([...moved].sort((left, right) => left.timeline_start_ms - right.timeline_start_ms || left.segment_id.localeCompare(right.segment_id)), "PROFESSIONAL")
  const byId = new Map(recalculated.map((segment) => [segment.segment_id, segment]))
  return moved.map((segment) => byId.get(segment.segment_id) ?? segment)
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

export function warpEnvelopeForRegionDurations<T extends EnvelopeConstraintPoint>(points: T[], previous: EditRegion[], next: EditRegion[]): T[] {
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
      target_pitch_strength_percent: PITCH_TARGET_STRENGTH_DEFAULT_PERCENT,
      formant_shift_semitones: 0,
      vibrato_depth_cents: PITCH_VIBRATO_DEPTH_DEFAULT_CENTS,
      vibrato_rate_hz: PITCH_VIBRATO_RATE_DEFAULT_HZ,
      vibrato_start_ms: PITCH_VIBRATO_START_DEFAULT_MS,
      transition_to_next_ms: PITCH_TRANSITION_DEFAULT_MS,
      transition_strength_percent: PITCH_TRANSITION_DEFAULT_STRENGTH,
      transition_center_ms: 0,
      pitch_points: [],
      pitch_owner_ref: null,
    }
  })
}
