import {
  PIANO_ROLL_PHONE_CONTIGUITY_TOLERANCE_MS,
  PITCH_MAX_MIDI,
  PITCH_MIN_MIDI,
  PITCH_VIBRATO_START_DEFAULT_MS,
  PROFESSIONAL_MAX_DURATION_PERCENT,
  PROFESSIONAL_MIN_DURATION_PERCENT,
} from "../../constants"
import type { PhonePitchOwnerRef, PhonePitchPoint, PhoneUnit, PianoRollInterval, PianoRollPhoneRef, PianoRollRegionView, PianoRollSyllableGroup, PianoRollSyllablePhone, TimelineSegment } from "../../types"
import { clipRegionPitchPoints, splitEditRegions, warpEnvelopeForRegionDurations } from "./regions"
import { retimeCompositionSegments } from "./timeline"

export function sourceTimeToSegmentOutput(segment: TimelineSegment, sourceTimeMs: number): number {
  let outputOffset = 0
  for (const region of segment.edit_regions) {
    if (sourceTimeMs <= region.source_start_ms) return outputOffset
    if (sourceTimeMs <= region.source_end_ms) {
      const sourceDuration = region.source_end_ms - region.source_start_ms
      if (sourceDuration <= 0) return outputOffset
      return outputOffset + (sourceTimeMs - region.source_start_ms) / sourceDuration * region.output_duration_ms
    }
    outputOffset += region.output_duration_ms
  }
  return outputOffset
}

export function phoneOutputInterval(segment: TimelineSegment, phone: PhoneUnit) {
  if (phone.source_start_ms === null || phone.source_end_ms === null) return null
  const startMs = sourceTimeToSegmentOutput(segment, phone.source_start_ms)
  const endMs = sourceTimeToSegmentOutput(segment, phone.source_end_ms)
  return endMs > startMs ? { startMs, endMs } : null
}

export function phonePitchOwnerRef(segment: TimelineSegment, phone: PhoneUnit): PhonePitchOwnerRef {
  return phone.pitch_owner_ref ?? { segment_id: segment.segment_id, phone_unit_id: phone.phone_unit_id }
}

export function pianoRollDraggedMidi(displayMidi: number, semitoneDelta: number, fine: boolean): number {
  const requestedMidi = displayMidi + semitoneDelta
  return fine ? requestedMidi : Math.round(requestedMidi)
}

export function pianoRollSyllableGroups(segments: TimelineSegment[]): PianoRollSyllableGroup[] {
  const groups: PianoRollSyllableGroup[] = []
  const memberMap = new Map<string, PianoRollSyllablePhone[]>()
  for (const segment of segments) {
    const phones = segment.phone_units.flatMap((phone) => phone.source_start_ms === null || phone.source_end_ms === null || phone.source_end_ms <= phone.source_start_ms ? [] : [{
      segmentId: segment.segment_id,
      phoneUnitId: phone.phone_unit_id,
      sourceStartMs: phone.source_start_ms,
      sourceEndMs: phone.source_end_ms,
      phoneId: (phone.source_phone_id ?? phone.target_phone_id ?? "").toLowerCase(),
      lane: segment.lane,
      ipa: phone.target_ipa ?? phone.source_ipa ?? "",
    }]).sort((left, right) => left.sourceStartMs - right.sourceStartMs || left.sourceEndMs - right.sourceEndMs)
    let pending: PianoRollSyllablePhone[] = []
    let active: PianoRollSyllableGroup | null = null
    let previousEnd: number | null = null
    for (const phone of phones) {
      const gap = previousEnd === null ? 0 : phone.sourceStartMs - previousEnd
      if (previousEnd !== null && (gap < -PIANO_ROLL_PHONE_CONTIGUITY_TOLERANCE_MS || gap > PIANO_ROLL_PHONE_CONTIGUITY_TOLERANCE_MS)) {
        pending = []
        active = null
      }
      if (phone.phoneId.startsWith("ko.vowel.")) {
        const nucleus = { segmentId: phone.segmentId, phoneUnitId: phone.phoneUnitId }
        const members = [...pending.filter((item) => item.phoneId.startsWith("ko.consonant.")), phone]
        const group = { key: `${phone.segmentId}:${phone.phoneUnitId}`, label: phone.ipa || "음절", nucleus, phones: members.map((item) => ({ segmentId: item.segmentId, phoneUnitId: item.phoneUnitId })), ranges: [] }
        groups.push(group)
        memberMap.set(group.key, members)
        pending = []
        active = group
      } else if (phone.phoneId.startsWith("ko.coda.")) {
        if (active) {
          active.phones.push({ segmentId: phone.segmentId, phoneUnitId: phone.phoneUnitId })
          memberMap.get(active.key)?.push(phone)
        } else pending = []
      } else if (phone.phoneId.startsWith("ko.consonant.")) pending.push(phone)
      else {
        pending = []
        active = null
      }
      previousEnd = phone.sourceEndMs
    }
  }
  return groups.map((group) => {
    const members = memberMap.get(group.key) ?? []
    const ranges = segments.flatMap((segment) => {
      const local = members.filter((member) => member.segmentId === segment.segment_id && member.lane === segment.lane)
      if (!local.length) return []
      return [{
        segmentId: segment.segment_id,
        startMs: Math.max(segment.source_start_ms, Math.min(...local.map((member) => member.sourceStartMs))),
        endMs: Math.min(segment.source_end_ms, Math.max(...local.map((member) => member.sourceEndMs))),
      }].filter((range) => range.endMs > range.startMs)
    })
    return { ...group, ranges }
  }).filter((group) => group.ranges.length > 0)
}

export function pianoRollUncoveredRegionViews(segments: TimelineSegment[], groups: PianoRollSyllableGroup[]): PianoRollRegionView[] {
  return segments.flatMap((segment) => segment.edit_regions.flatMap((region) => {
    const coverages = groups.flatMap((group) => group.ranges
      .filter((range) => range.segmentId === segment.segment_id && range.startMs < region.source_end_ms && range.endMs > region.source_start_ms)
      .map((range) => ({ start: Math.max(region.source_start_ms, range.startMs), end: Math.min(region.source_end_ms, range.endMs) })))
      .sort((left, right) => left.start - right.start || left.end - right.end)
    const merged: PianoRollInterval[] = []
    for (const coverage of coverages) {
      const previous = merged.at(-1)
      if (previous && coverage.start <= previous.end) previous.end = Math.max(previous.end, coverage.end)
      else merged.push({ ...coverage })
    }
    const ranges: PianoRollInterval[] = []
    let cursor = region.source_start_ms
    for (const coverage of merged) {
      if (coverage.start > cursor) ranges.push({ start: cursor, end: coverage.start })
      cursor = Math.max(cursor, coverage.end)
    }
    if (cursor < region.source_end_ms) ranges.push({ start: cursor, end: region.source_end_ms })
    const sourceSpan = Math.max(1, region.source_end_ms - region.source_start_ms)
    return ranges.filter((range) => range.end > range.start).map((range) => ({
      segmentId: segment.segment_id,
      regionId: region.region_id,
      sourceStartMs: range.start,
      sourceEndMs: range.end,
      pitchPoints: clipRegionPitchPoints(region.pitch_points, (range.start - region.source_start_ms) / sourceSpan, (range.end - region.source_start_ms) / sourceSpan),
    }))
  }))
}

export function setRegionRangePitchPoints(segments: TimelineSegment[], view: PianoRollRegionView, points: PhonePitchPoint[]): TimelineSegment[] | null {
  const segment = segments.find((item) => item.segment_id === view.segmentId)
  if (!segment || view.sourceEndMs <= view.sourceStartMs || (points.length > 0 && points.length < 2)) return null
  const regions = splitEditRegions(segment.edit_regions, view.sourceStartMs, view.sourceEndMs)
  if (!regions.some((region) => region.source_start_ms === view.sourceStartMs) || !regions.some((region) => region.source_end_ms === view.sourceEndMs)) return null
  const selected = regions.filter((region) => region.source_start_ms >= view.sourceStartMs && region.source_end_ms <= view.sourceEndMs)
  if (!selected.length) return null
  const viewSpan = view.sourceEndMs - view.sourceStartMs
  const editRegions = regions.map((region) => selected.includes(region) ? {
    ...region,
    pitch_points: points.length ? clipRegionPitchPoints(points,
      (region.source_start_ms - view.sourceStartMs) / viewSpan,
      (region.source_end_ms - view.sourceStartMs) / viewSpan) : undefined,
  } : region)
  return segments.map((item) => item.segment_id === segment.segment_id ? { ...item, edit_regions: editRegions } : item)
}

export function setSyllablePitch(segments: TimelineSegment[], group: PianoRollSyllableGroup, midi: number | null): TimelineSegment[] | null {
  if (midi !== null && (!Number.isFinite(midi) || midi < PITCH_MIN_MIDI || midi > PITCH_MAX_MIDI)) return null
  const groupPhoneKeys = new Set(group.phones.map((phone) => `${phone.segmentId}:${phone.phoneUnitId}`))
  const groupOwnerKeys = new Set(group.phones.flatMap((reference) => {
    const segment = segments.find((item) => item.segment_id === reference.segmentId)
    const phone = segment?.phone_units.find((item) => item.phone_unit_id === reference.phoneUnitId)
    const owner = segment && phone ? phonePitchOwnerRef(segment, phone) : { segment_id: reference.segmentId, phone_unit_id: reference.phoneUnitId }
    return [`${reference.segmentId}:${reference.phoneUnitId}`, `${owner.segment_id}:${owner.phone_unit_id}`]
  }))
  if (segments.some((segment) => segment.phone_units.some((phone) => {
    const key = `${segment.segment_id}:${phone.phone_unit_id}`
    if (groupPhoneKeys.has(key)) return false
    const owner = phone.pitch_owner_ref
    return owner !== null && owner !== undefined && groupOwnerKeys.has(`${owner.segment_id}:${owner.phone_unit_id}`)
  }))) return null
  const changed = new Map<string, TimelineSegment>()
  for (const range of group.ranges) {
    const segment = changed.get(range.segmentId) ?? segments.find((item) => item.segment_id === range.segmentId)
    if (!segment) return null
    const regions = splitEditRegions(segment.edit_regions, range.startMs, range.endMs)
    if (!regions.some((region) => region.source_start_ms === range.startMs) || !regions.some((region) => region.source_end_ms === range.endMs)) return null
    const selected = regions.filter((region) => region.source_start_ms >= range.startMs && region.source_end_ms <= range.endMs)
    if (!selected.length || selected.some((region) => region.source_start_ms < range.startMs || region.source_end_ms > range.endMs)) return null
    const totalOutputDuration = regions.reduce((sum, region) => sum + region.output_duration_ms, 0)
    let invalidStoredPoints = false
    const nextRegions = regions.map((region) => {
      if (!selected.includes(region)) return region
      if (midi === null) return { ...region, relative_pitch_cents: 0, pitch_points: undefined }
      const outputStart = sourceTimeToSegmentOutput({ ...segment, edit_regions: regions }, region.source_start_ms)
      const outputEnd = outputStart + region.output_duration_ms
      const samplePositions = [...new Set([outputStart, outputEnd, ...(segment.pitch_envelope ?? [])
        .map((point) => point.position * totalOutputDuration)
        .filter((position) => position > outputStart && position < outputEnd)])].sort((left, right) => left - right)
      const envelopeCents = (outputMs: number) => {
        const points = segment.pitch_envelope ?? []
        if (!points.length) return 0
        const position = outputMs / Math.max(1, totalOutputDuration)
        const rightIndex = points.findIndex((point) => point.position >= position)
        if (rightIndex < 0) return points.at(-1)!.cents
        if (rightIndex === 0) return points[0].cents
        const left = points[rightIndex - 1]
        const right = points[rightIndex]
        const amount = (position - left.position) / Math.max(Number.EPSILON, right.position - left.position)
        return left.cents + (right.cents - left.cents) * amount
      }
      const points = samplePositions.map((outputMs) => ({
        position: (outputMs - outputStart) / Math.max(1, region.output_duration_ms),
        midi: midi - region.relative_pitch_cents / 100 - envelopeCents(outputMs) / 100,
      }))
      if (points.some((point) => !Number.isFinite(point.midi) || point.midi < PITCH_MIN_MIDI || point.midi > PITCH_MAX_MIDI)) {
        invalidStoredPoints = true
        return region
      }
      return {
        ...region,
        pitch_points: points,
      }
    })
    if (invalidStoredPoints) return null
    changed.set(segment.segment_id, { ...segment, edit_regions: nextRegions })
  }
  const clearedPhones = new Set(group.phones.map((phone) => `${phone.segmentId}:${phone.phoneUnitId}`))
  return segments.map((segment) => {
    const updated = changed.get(segment.segment_id) ?? segment
    if (![...clearedPhones].some((key) => key.startsWith(`${segment.segment_id}:`))) return updated
    return {
      ...updated,
      phone_units: updated.phone_units.map((phone) => clearedPhones.has(`${segment.segment_id}:${phone.phone_unit_id}`) ? {
        ...phone,
        target_pitch_midi: null,
        pitch_points: [],
        pitch_owner_ref: null,
        vibrato_depth_cents: 0,
      } : phone),
    }
  })
}

export function phonePitchGroupRefs(segments: TimelineSegment[], reference: PianoRollPhoneRef): PianoRollPhoneRef[] {
  const segment = segments.find((item) => item.segment_id === reference.segmentId)
  const phone = segment?.phone_units.find((item) => item.phone_unit_id === reference.phoneUnitId)
  if (!segment || !phone) return [reference]
  const owner = phonePitchOwnerRef(segment, phone)
  return segments.flatMap((item) => item.phone_units
    .filter((unit) => {
      const ref = phonePitchOwnerRef(item, unit)
      return ref.segment_id === owner.segment_id && ref.phone_unit_id === owner.phone_unit_id
    })
    .map((unit) => ({ segmentId: item.segment_id, phoneUnitId: unit.phone_unit_id })))
}

export function updatePhonePitchPoints(
  segments: TimelineSegment[],
  segmentId: string,
  phoneUnitId: string,
  points: PhonePitchPoint[],
): TimelineSegment[] {
  const segment = segments.find((item) => item.segment_id === segmentId)
  const phone = segment?.phone_units.find((item) => item.phone_unit_id === phoneUnitId)
  if (!segment || !phone) return segments
  const owner = phonePitchOwnerRef(segment, phone)
  const isOwner = owner.segment_id === segmentId && owner.phone_unit_id === phoneUnitId
  const targetSegmentId = isOwner ? segmentId : owner.segment_id
  const targetPhoneId = isOwner ? phoneUnitId : owner.phone_unit_id
  return segments.map((item) => item.segment_id === targetSegmentId ? {
    ...item,
    phone_units: item.phone_units.map((unit) => unit.phone_unit_id === targetPhoneId ? {
      ...unit,
      pitch_points: points,
      pitch_owner_ref: { segment_id: targetSegmentId, phone_unit_id: targetPhoneId },
    } : unit),
  } : item)
}

export function clampPhoneVibratoStarts(segments: TimelineSegment[]): TimelineSegment[] {
  return segments.map((segment) => ({
    ...segment,
    phone_units: segment.phone_units.map((phone) => {
      const interval = phoneOutputInterval(segment, phone)
      if (!interval) return phone
      return { ...phone, vibrato_start_ms: Math.max(0, Math.min(Math.round(interval.endMs - interval.startMs), phone.vibrato_start_ms ?? PITCH_VIBRATO_START_DEFAULT_MS)) }
    }),
  }))
}

export function resizePhoneOutputDuration(
  segments: TimelineSegment[],
  segmentId: string,
  phoneUnitId: string,
  requestedDurationMs: number,
): TimelineSegment[] {
  if (!Number.isFinite(requestedDurationMs)) return segments
  const selectedSegment = segments.find((segment) => segment.segment_id === segmentId)
  const phone = selectedSegment?.phone_units.find((unit) => unit.phone_unit_id === phoneUnitId)
  if (!selectedSegment || !phone || phone.source_start_ms === null || phone.source_end_ms === null) return segments

  const isolatedRegions = splitEditRegions(selectedSegment.edit_regions, phone.source_start_ms, phone.source_end_ms)
  if (
    isolatedRegions.some((region) => region.source_start_ms < phone.source_start_ms! && region.source_end_ms > phone.source_start_ms!)
    || isolatedRegions.some((region) => region.source_start_ms < phone.source_end_ms! && region.source_end_ms > phone.source_end_ms!)
  ) return segments
  const selectedRegions = isolatedRegions.map((region, index) => ({ region, index }))
    .filter(({ region }) => region.source_start_ms >= phone.source_start_ms! && region.source_end_ms <= phone.source_end_ms!)
  if (!selectedRegions.length) return segments

  const minimums = selectedRegions.map(({ region }) => Math.max(1, Math.ceil((region.source_end_ms - region.source_start_ms) * PROFESSIONAL_MIN_DURATION_PERCENT / 100)))
  const maximums = selectedRegions.map(({ region }, index) => Math.max(minimums[index], Math.floor((region.source_end_ms - region.source_start_ms) * PROFESSIONAL_MAX_DURATION_PERCENT / 100)))
  const currentTotal = selectedRegions.reduce((sum, { region }) => sum + region.output_duration_ms, 0)
  const nextTotal = Math.max(minimums.reduce((sum, value) => sum + value, 0), Math.min(maximums.reduce((sum, value) => sum + value, 0), Math.round(requestedDurationMs)))
  const nextDurations = selectedRegions.map(({ region }, index) => Math.max(minimums[index], Math.min(maximums[index], Math.round(nextTotal * region.output_duration_ms / currentTotal))))
  let difference = nextTotal - nextDurations.reduce((sum, value) => sum + value, 0)
  for (let index = 0; difference !== 0 && index < nextDurations.length; index += 1) {
    const capacity = difference > 0 ? maximums[index] - nextDurations[index] : nextDurations[index] - minimums[index]
    const delta = Math.min(Math.abs(difference), capacity) * Math.sign(difference)
    nextDurations[index] += delta
    difference -= delta
  }
  if (difference !== 0) return segments

  const editRegions = isolatedRegions.map((region, index) => {
    const resizeIndex = selectedRegions.findIndex((selected) => selected.index === index)
    return resizeIndex < 0 ? region : { ...region, output_duration_ms: nextDurations[resizeIndex] }
  })
  const changed = segments.map((segment) => segment.segment_id === segmentId ? {
    ...segment,
    edit_regions: editRegions,
    volume_envelope: warpEnvelopeForRegionDurations(segment.volume_envelope, segment.edit_regions, editRegions),
    pitch_envelope: segment.pitch_envelope
      ? warpEnvelopeForRegionDurations(segment.pitch_envelope, segment.edit_regions, editRegions)
      : undefined,
  } : segment)
  return retimeCompositionSegments(changed, "PROFESSIONAL")
}
