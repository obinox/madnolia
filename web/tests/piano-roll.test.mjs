import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import test from "node:test"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try { return nextResolve(`${specifier}.ts`, context) } catch {}
    }
    return nextResolve(specifier, context)
  },
})

const { clampPhoneVibratoStarts, phoneOutputInterval, phonePitchGroupRefs, pianoRollDraggedMidi, pianoRollSyllableGroups, pianoRollUncoveredRegionViews, resizePhoneOutputDuration, setRegionRangePitchPoints, setSyllablePitch, sourceTimeToSegmentOutput, updatePhonePitchPoints } = await import("../src/features/composition/pianoRoll.ts")
const { deriveProfessionalSegments } = await import("../src/features/composition/regions.ts")
const { mergeRegionPitchPoints, splitEditRegions } = await import("../src/features/composition/regions.ts")
const { REGION_PITCH_MERGE_GAP_POSITION } = await import("../src/constants.ts")

function makeSegment() {
  return {
    segment_id: "segment",
    candidate_id: "candidate",
    target_start_index: 0,
    target_end_index: 1,
    source_id: "source",
    source_start_ms: 0,
    source_end_ms: 1000,
    timeline_start_ms: 500,
    timeline_end_ms: 1500,
    match_status: "EXACT",
    target_ipa: ["a"],
    matched_ipa: ["a"],
    gap_before_ms: 0,
    stretch_percent: 100,
    lane: 0,
    phone_units: [{ phone_unit_id: "phone", source_start_ms: 200, source_end_ms: 400, output_duration_ms: 200 }],
    edit_regions: [{ region_id: "all", source_start_ms: 0, source_end_ms: 1000, output_duration_ms: 1000, relative_pitch_cents: 0 }],
    volume_envelope: [{ position: 0, gain: 0.5 }, { position: 0.2, gain: 1 }, { position: 1, gain: 0.5 }],
    pitch_envelope: [{ position: 0, cents: 0 }, { position: 0.2, cents: 100 }, { position: 1, cents: 0 }],
  }
}

test("piano-roll dragging snaps displayed MIDI unless Ctrl enables fine pitch movement", () => {
  assert.equal(pianoRollDraggedMidi(60.23, 0.51, false), 61)
  assert.ok(Math.abs(pianoRollDraggedMidi(60.23, 0.51, true) - 60.74) < 1e-12)
  assert.equal(pianoRollDraggedMidi(60.74, -0.1, false), 61)
  assert.ok(Math.abs(pianoRollDraggedMidi(60.74, -0.1, true) - 60.64) < 1e-12)
  const points = [{ position: 0, midi: 59 }, { position: 1, midi: 61 }]
  const displayedMidi = 60.25
  const snapped = pianoRollDraggedMidi(displayedMidi, 0.3, false)
  const shifted = points.map((point) => ({ ...point, midi: point.midi + snapped - displayedMidi }))
  assert.equal((shifted[0].midi + shifted[1].midi) / 2 + 0.25, 61)
  assert.equal(shifted[1].midi - shifted[0].midi, 2)
})


test("uncovered edit-region ranges stay visible and pitch edits isolate only their source slice", () => {
  const segment = makeSegment()
  segment.edit_regions = [
    { region_id: "left", source_start_ms: 100, source_end_ms: 600, output_duration_ms: 500, relative_pitch_cents: 20, source_f0_hz: 220, pitch_points: [{ position: 0, midi: 60 }, { position: 1, midi: 70 }] },
    { region_id: "middle", source_start_ms: 600, source_end_ms: 650, output_duration_ms: 50, relative_pitch_cents: 0, source_f0_hz: 220 },
    { region_id: "right", source_start_ms: 650, source_end_ms: 1000, output_duration_ms: 350, relative_pitch_cents: 0, source_f0_hz: 220, pitch_points: [{ position: 0, midi: 64 }, { position: 1, midi: 66 }] },
  ]
  const groups = [
    { key: "covered-left", label: "a", nucleus: { segmentId: "segment", phoneUnitId: "phone" }, phones: [], ranges: [{ segmentId: "segment", startMs: 100, endMs: 550 }] },
    { key: "covered-right", label: "b", nucleus: { segmentId: "segment", phoneUnitId: "phone" }, phones: [], ranges: [{ segmentId: "segment", startMs: 650, endMs: 1000 }] },
  ]
  const views = pianoRollUncoveredRegionViews([segment], groups)
  assert.deepEqual(views.map(({ sourceStartMs, sourceEndMs }) => [sourceStartMs, sourceEndMs]), [[550, 600], [600, 650]])
  assert.equal(views[0].pitchPoints[0].midi, 69)
  const changed = setRegionRangePitchPoints([segment], views[0], [{ position: 0, midi: 72 }, { position: 1, midi: 74 }])
  const regions = changed[0].edit_regions
  assert.equal(regions.reduce((sum, region) => sum + region.output_duration_ms, 0), 900)
  assert.deepEqual(regions.filter((region) => region.source_start_ms >= 100 && region.source_end_ms <= 550).map((region) => region.pitch_points?.at(-1)?.midi), [69])
  const edited = regions.find((region) => region.source_start_ms === 550 && region.source_end_ms === 600)
  assert.deepEqual(edited.pitch_points, [{ position: 0, midi: 72 }, { position: 1, midi: 74 }])
  assert.deepEqual(regions.find((region) => region.region_id === "right").pitch_points, segment.edit_regions[2].pitch_points)
  const reset = setRegionRangePitchPoints(changed, views[0], [])
  assert.equal(reset[0].edit_regions.find((region) => region.source_start_ms === 550 && region.source_end_ms === 600).pitch_points, undefined)
  assert.deepEqual(reset[0].edit_regions.find((region) => region.region_id === "right").pitch_points, segment.edit_regions[2].pitch_points)
})

test("phoneme positions map source bounds through edited regions instead of stored phone duration", () => {
  const segment = makeSegment()
  segment.edit_regions = [
    { region_id: "left", source_start_ms: 0, source_end_ms: 200, output_duration_ms: 300, relative_pitch_cents: 0 },
    { region_id: "phone", source_start_ms: 200, source_end_ms: 400, output_duration_ms: 100, relative_pitch_cents: 0 },
    { region_id: "right", source_start_ms: 400, source_end_ms: 1000, output_duration_ms: 900, relative_pitch_cents: 0 },
  ]
  assert.equal(sourceTimeToSegmentOutput(segment, 300), 350)
  assert.deepEqual(phoneOutputInterval(segment, segment.phone_units[0]), { startMs: 300, endMs: 400 })
})

test("phoneme length isolates source boundaries and preserves neighboring timing, envelopes, and segment starts", () => {
  const segment = makeSegment()
  const later = { ...makeSegment(), segment_id: "later", source_start_ms: 1000, source_end_ms: 2000, timeline_start_ms: 1800, timeline_end_ms: 2800 }
  const before = phoneOutputInterval(segment, segment.phone_units[0])
  const changed = resizePhoneOutputDuration([segment, later], "segment", "phone", 350)
  const updated = changed.find((item) => item.segment_id === "segment")
  assert.deepEqual(phoneOutputInterval(updated, updated.phone_units[0]), { startMs: before.startMs, endMs: before.startMs + 350 })
  assert.deepEqual(updated.edit_regions.filter((region) => region.source_end_ms <= 200 || region.source_start_ms >= 400).map((region) => region.output_duration_ms), [200, 600])
  assert.equal(changed.find((item) => item.segment_id === "later").timeline_start_ms, later.timeline_start_ms)
  assert.notDeepEqual(updated.volume_envelope, segment.volume_envelope)
  assert.notDeepEqual(updated.pitch_envelope, segment.pitch_envelope)
})

test("vibrato start is clamped to mapped phone duration after timing edits", () => {
  const segment = makeSegment()
  segment.phone_units[0].vibrato_start_ms = 180
  const resized = resizePhoneOutputDuration([segment], "segment", "phone", 90)
  const changed = clampPhoneVibratoStarts(resized)
  const phone = changed[0].phone_units[0]
  assert.equal(phoneOutputInterval(changed[0], phone).endMs - phoneOutputInterval(changed[0], phone).startMs, 90)
  assert.equal(phone.vibrato_start_ms, 90)
  const legacy = makeSegment()
  delete legacy.phone_units[0].vibrato_start_ms
  assert.equal(clampPhoneVibratoStarts([legacy])[0].phone_units[0].vibrato_start_ms, 0)
})

test("owner pitch edits update one combined curve across contiguous attached phones", () => {
  const first = makeSegment()
  first.phone_units[0] = {
    ...first.phone_units[0],
    phone_unit_id: "consonant",
    pitch_points: [],
    pitch_owner_ref: { segment_id: "later", phone_unit_id: "vowel" },
  }
  const later = { ...makeSegment(), segment_id: "later", timeline_start_ms: 1500, timeline_end_ms: 1800 }
  later.phone_units[0] = {
    ...later.phone_units[0],
    phone_unit_id: "vowel",
    pitch_points: [{ position: 0, midi: 60 }, { position: 1, midi: 60 }],
    pitch_owner_ref: { segment_id: "later", phone_unit_id: "vowel" },
  }
  const originalIntervals = [first, later].map((segment) => phoneOutputInterval(segment, segment.phone_units[0]))
  assert.deepEqual(phonePitchGroupRefs([first, later], { segmentId: "segment", phoneUnitId: "consonant" }), [
    { segmentId: "segment", phoneUnitId: "consonant" },
    { segmentId: "later", phoneUnitId: "vowel" },
  ])
  const curve = [{ position: 0, midi: 62 }, { position: 0.5, midi: 65 }, { position: 1, midi: 62 }]
  const changed = updatePhonePitchPoints([first, later], "later", "vowel", curve)
  assert.deepEqual(changed.map((segment) => segment.phone_units[0].pitch_points), [[], curve])
  assert.deepEqual(changed.map((segment) => phoneOutputInterval(segment, segment.phone_units[0])), originalIntervals)
})

test("pitch edits from an attached phone resolve to its owner curve", () => {
  const owner = makeSegment()
  owner.phone_units[0] = {
    ...owner.phone_units[0],
    phone_unit_id: "vowel",
    pitch_points: [{ position: 0, midi: 60 }, { position: 1, midi: 60 }],
    pitch_owner_ref: { segment_id: "segment", phone_unit_id: "vowel" },
  }
  const attached = { ...makeSegment(), segment_id: "attached" }
  attached.phone_units[0] = {
    ...attached.phone_units[0],
    phone_unit_id: "consonant",
    pitch_points: [],
    pitch_owner_ref: { segment_id: "segment", phone_unit_id: "vowel" },
  }
  const curve = [{ position: 0, midi: 61 }, { position: 1, midi: 61 }]
  const changed = updatePhonePitchPoints([owner, attached], "attached", "consonant", curve)
  assert.deepEqual(changed[0].phone_units[0].pitch_points, curve)
  assert.deepEqual(changed[1].phone_units[0].pitch_points, [])
})

test("older professional phones normalize to empty owner curves", () => {
  const segment = makeSegment()
  delete segment.phone_units[0].pitch_points
  delete segment.phone_units[0].pitch_owner_ref
  const normalized = deriveProfessionalSegments([segment])[0]
  assert.deepEqual(normalized.phone_units[0].pitch_points, [])
  assert.equal(normalized.phone_units[0].pitch_owner_ref, null)
})

test("legacy owner curves migrate across phones with uneven output intervals", () => {
  const first = makeSegment()
  first.phone_units[0] = {
    ...first.phone_units[0],
    phone_unit_id: "owner",
    source_start_ms: 0,
    source_end_ms: 100,
    pitch_points: [{ position: 0, midi: 60 }, { position: 0.5, midi: 70 }, { position: 1, midi: 80 }],
    pitch_owner_ref: { segment_id: "segment", phone_unit_id: "owner" },
  }
  first.source_end_ms = 100
  first.edit_regions = [{ region_id: "first-region", source_start_ms: 0, source_end_ms: 100, output_duration_ms: 100, relative_pitch_cents: 0 }]
  first.timeline_start_ms = 0
  first.timeline_end_ms = 100
  const later = { ...makeSegment(), segment_id: "later", source_start_ms: 100, source_end_ms: 200, timeline_start_ms: 100, timeline_end_ms: 300 }
  later.phone_units[0] = {
    ...later.phone_units[0],
    phone_unit_id: "attached",
    source_start_ms: 100,
    source_end_ms: 200,
    output_duration_ms: 200,
    pitch_points: [],
    pitch_owner_ref: { segment_id: "segment", phone_unit_id: "owner" },
  }
  later.edit_regions = [{ region_id: "later-region", source_start_ms: 100, source_end_ms: 200, output_duration_ms: 200, relative_pitch_cents: 0 }]
  later.volume_envelope = [{ position: 0, gain: 1 }, { position: 1, gain: 1 }]
  const migrated = deriveProfessionalSegments([first, later])
  assert.deepEqual(migrated[0].edit_regions[0].pitch_points, [{ position: 0, midi: 60 }, { position: 1, midi: 66.66666666666667 }])
  assert.deepEqual(migrated[1].edit_regions[0].pitch_points, [{ position: 0, midi: 66.66666666666667 }, { position: 0.25, midi: 70 }, { position: 1, midi: 80 }])
  assert.equal(migrated[1].phone_units[0].pitch_owner_ref.segment_id, "segment")
})

test("legacy adjacent phone curves preserve pitch jumps at their shared boundary", () => {
  const segment = makeSegment()
  segment.source_end_ms = 200
  segment.timeline_start_ms = 0
  segment.timeline_end_ms = 200
  segment.phone_units = [
    { ...segment.phone_units[0], phone_unit_id: "first", source_start_ms: 0, source_end_ms: 100, pitch_owner_ref: null, pitch_points: [{ position: 0, midi: 60 }, { position: 1, midi: 62 }] },
    { ...segment.phone_units[0], phone_unit_id: "second", source_start_ms: 100, source_end_ms: 200, pitch_owner_ref: null, pitch_points: [{ position: 0, midi: 72 }, { position: 1, midi: 74 }] },
  ]
  segment.edit_regions = [{ region_id: "whole", source_start_ms: 0, source_end_ms: 200, output_duration_ms: 200, relative_pitch_cents: 0 }]
  const migrated = deriveProfessionalSegments([segment])[0].edit_regions[0].pitch_points
  const boundary = migrated.filter((point) => point.position > 0.49 && point.position < 0.51)
  assert.equal(boundary.length, 2)
  assert.equal(boundary[0].midi, 62)
  assert.equal(boundary[1].midi, 72)
  assert.ok(boundary[1].position > boundary[0].position)
  assert.ok(Math.abs(boundary[1].position - boundary[0].position - REGION_PITCH_MERGE_GAP_POSITION) < 1e-12)
  assert.ok(migrated.every((point, index) => index === 0 || point.position > migrated[index - 1].position))
})

test("legacy adjacent curves deduplicate matching values at identical boundaries", () => {
  const segment = makeSegment()
  segment.source_end_ms = 200
  segment.timeline_start_ms = 0
  segment.timeline_end_ms = 200
  segment.phone_units = [
    { ...segment.phone_units[0], phone_unit_id: "first", source_start_ms: 0, source_end_ms: 100, pitch_owner_ref: null, pitch_points: [{ position: 0, midi: 60 }, { position: 1, midi: 62 }] },
    { ...segment.phone_units[0], phone_unit_id: "second", source_start_ms: 100, source_end_ms: 200, pitch_owner_ref: null, pitch_points: [{ position: 0, midi: 62 }, { position: 1, midi: 74 }] },
  ]
  segment.edit_regions = [{ region_id: "whole", source_start_ms: 0, source_end_ms: 200, output_duration_ms: 200, relative_pitch_cents: 0 }]
  const migrated = deriveProfessionalSegments([segment])[0].edit_regions[0].pitch_points
  assert.deepEqual(migrated.filter((point) => point.position >= 0.49 && point.position <= 0.51), [{ position: 0.5, midi: 62 }])
  assert.ok(migrated.every((point, index) => index === 0 || point.position > migrated[index - 1].position))
})

test("legacy migration does not pull an owner's curve across an overlapping lane", () => {
  const owner = makeSegment()
  owner.timeline_start_ms = 0
  owner.timeline_end_ms = 100
  owner.phone_units[0] = {
    ...owner.phone_units[0],
    phone_unit_id: "owner",
    source_start_ms: 0,
    source_end_ms: 100,
    pitch_points: [{ position: 0, midi: 60 }, { position: 1, midi: 72 }],
    pitch_owner_ref: { segment_id: "segment", phone_unit_id: "owner" },
  }
  owner.edit_regions = [{ region_id: "owner-region", source_start_ms: 0, source_end_ms: 100, output_duration_ms: 100, relative_pitch_cents: 0 }]
  const overlap = { ...makeSegment(), segment_id: "overlap", timeline_start_ms: 50, timeline_end_ms: 150 }
  overlap.phone_units[0] = {
    ...overlap.phone_units[0],
    source_start_ms: 0,
    source_end_ms: 100,
    pitch_points: [],
    pitch_owner_ref: { segment_id: "segment", phone_unit_id: "owner" },
  }
  overlap.edit_regions = [{ region_id: "overlap-region", source_start_ms: 0, source_end_ms: 100, output_duration_ms: 100, relative_pitch_cents: 0 }]
  const migrated = deriveProfessionalSegments([owner, overlap])
  assert.notEqual(migrated[0].lane, migrated[1].lane)
  assert.equal(migrated[1].edit_regions[0].pitch_points, undefined)
})

test("region pitch splits clip curves and interpolate protected endpoints", () => {
  const regions = splitEditRegions([{
    region_id: "curve",
    source_start_ms: 0,
    source_end_ms: 100,
    output_duration_ms: 100,
    relative_pitch_cents: 0,
    pitch_points: [{ position: 0, midi: 60 }, { position: 0.5, midi: 72 }, { position: 1, midi: 60 }],
  }], 25, 75)
  assert.deepEqual(regions.map((region) => region.pitch_points), [
    [{ position: 0, midi: 60 }, { position: 1, midi: 66 }],
    [{ position: 0, midi: 66 }, { position: 0.5, midi: 72 }, { position: 1, midi: 66 }],
    [{ position: 0, midi: 66 }, { position: 1, midi: 60 }],
  ])
})

test("region pitch merges use output duration mapping and preserve endpoints for one-sided curves", () => {
  const left = { region_id: "left", source_start_ms: 0, source_end_ms: 50, output_duration_ms: 80, relative_pitch_cents: 0, pitch_points: [{ position: 0, midi: 60 }, { position: 1, midi: 62 }] }
  const right = { region_id: "right", source_start_ms: 50, source_end_ms: 100, output_duration_ms: 20, relative_pitch_cents: 100 }
  const merged = mergeRegionPitchPoints(left, right)
  assert.equal(merged[0].position, 0)
  assert.equal(merged.at(-1).position, 1)
  assert.equal(merged[1].position, 0.8)
  assert.ok(Math.abs(merged[2].position - 0.800001) < 1e-12)
  assert.equal(merged[2].midi, 63)
})

test("syllable groups attach onset forward and explicit coda backward using phone IDs", () => {
  const segment = makeSegment()
  segment.source_end_ms = 300
  segment.timeline_start_ms = 0
  segment.timeline_end_ms = 300
  segment.phone_units = [
    { ...segment.phone_units[0], phone_unit_id: "onset-a", source_start_ms: 0, source_end_ms: 40, source_phone_id: "ko.consonant.velar.voiceless", source_ipa: "k", target_ipa: "k" },
    { ...segment.phone_units[0], phone_unit_id: "vowel-a", source_start_ms: 40, source_end_ms: 100, source_phone_id: "ko.vowel.a", source_ipa: "a", target_ipa: "a" },
    { ...segment.phone_units[0], phone_unit_id: "coda-a", source_start_ms: 100, source_end_ms: 130, source_phone_id: "ko.coda.alveolar.nasal", source_ipa: "n", target_ipa: "n" },
    { ...segment.phone_units[0], phone_unit_id: "onset-i", source_start_ms: 130, source_end_ms: 160, source_phone_id: "ko.consonant.alveolar", source_ipa: "t", target_ipa: "t" },
    { ...segment.phone_units[0], phone_unit_id: "vowel-i", source_start_ms: 160, source_end_ms: 220, source_phone_id: "ko.vowel.i", source_ipa: "i", target_ipa: "i" },
    { ...segment.phone_units[0], phone_unit_id: "coda-i", source_start_ms: 220, source_end_ms: 250, source_phone_id: "ko.coda.alveolar", source_ipa: "t", target_ipa: "t" },
  ]
  const groups = pianoRollSyllableGroups([segment])
  assert.equal(groups.length, 2)
  assert.deepEqual(groups.map((group) => group.phones.map((phone) => phone.phoneUnitId)), [
    ["onset-a", "vowel-a", "coda-a"],
    ["onset-i", "vowel-i", "coda-i"],
  ])
  assert.deepEqual(groups.map((group) => group.ranges), [[{ segmentId: "segment", startMs: 0, endMs: 130 }], [{ segmentId: "segment", startMs: 130, endMs: 250 }]])
  const otherLanguage = { ...segment, phone_units: [{ ...segment.phone_units[1], source_phone_id: "en.vowel.a" }] }
  assert.deepEqual(pianoRollSyllableGroups([otherLanguage]), [])
  const separated = { ...segment, phone_units: [
    { ...segment.phone_units[1], phone_unit_id: "first", source_start_ms: 0, source_end_ms: 20 },
    { ...segment.phone_units[0], phone_unit_id: "gap-onset", source_start_ms: 30, source_end_ms: 40 },
    { ...segment.phone_units[4], phone_unit_id: "second", source_start_ms: 50, source_end_ms: 70 },
  ] }
  const separatedGroups = pianoRollSyllableGroups([separated])
  assert.deepEqual(separatedGroups.map((group) => group.phones.map((phone) => phone.phoneUnitId)), [["first"], ["second"]])
  const interrupted = { ...segment, phone_units: [
    { ...segment.phone_units[1], phone_unit_id: "vowel", source_start_ms: 0, source_end_ms: 20 },
    { ...segment.phone_units[0], phone_unit_id: "unknown", source_start_ms: 20, source_end_ms: 30, source_phone_id: "unknown.phone" },
    { ...segment.phone_units[2], phone_unit_id: "coda", source_start_ms: 30, source_end_ms: 40 },
  ] }
  assert.deepEqual(pianoRollSyllableGroups([interrupted])[0].phones.map((phone) => phone.phoneUnitId), ["vowel"])
})

test("absolute syllable note edits split only owned source bounds and preserve timing and volume", () => {
  const segment = makeSegment()
  segment.source_end_ms = 300
  segment.timeline_start_ms = 0
  segment.timeline_end_ms = 300
  segment.edit_regions = [{ region_id: "all", source_start_ms: 0, source_end_ms: 300, output_duration_ms: 300, relative_pitch_cents: 50 }]
  segment.pitch_envelope = [{ position: 0, cents: 0 }, { position: 0.2, cents: 100 }, { position: 1, cents: -50 }]
  segment.phone_units = [
    { ...segment.phone_units[0], phone_unit_id: "vowel-a", source_start_ms: 20, source_end_ms: 80, source_phone_id: "ko.vowel.a", target_ipa: "a", target_pitch_midi: 72, pitch_points: [{ position: 0, midi: 70 }, { position: 1, midi: 74 }], pitch_owner_ref: { segment_id: segment.segment_id, phone_unit_id: "vowel-a" }, vibrato_depth_cents: 25 },
    { ...segment.phone_units[0], phone_unit_id: "coda-a", source_start_ms: 80, source_end_ms: 100, source_phone_id: "ko.coda.alveolar", target_ipa: "n", target_pitch_midi: 72, pitch_points: [{ position: 0, midi: 70 }, { position: 1, midi: 74 }], pitch_owner_ref: { segment_id: segment.segment_id, phone_unit_id: "vowel-a" }, vibrato_depth_cents: 25 },
    { ...segment.phone_units[0], phone_unit_id: "vowel-i", source_start_ms: 120, source_end_ms: 180, source_phone_id: "ko.vowel.i", target_ipa: "i" },
  ]
  const [first] = pianoRollSyllableGroups([segment])
  const changed = setSyllablePitch([segment], first, 64)
  const updated = changed[0]
  assert.deepEqual(updated.edit_regions.map((region) => [region.source_start_ms, region.source_end_ms, region.output_duration_ms]), [[0, 20, 20], [20, 100, 80], [100, 300, 200]])
  assert.deepEqual(updated.edit_regions[1].pitch_points.map((point) => point.position), [0, 0.5, 1])
  for (const point of updated.edit_regions[1].pitch_points) {
    const outputMs = 20 + point.position * 80
    const envelopePosition = outputMs / 300
    const rightIndex = segment.pitch_envelope.findIndex((item) => item.position >= envelopePosition)
    const left = segment.pitch_envelope[rightIndex - 1]
    const right = segment.pitch_envelope[rightIndex]
    const amount = (envelopePosition - left.position) / (right.position - left.position)
    const envelopeCents = left.cents + (right.cents - left.cents) * amount
    assert.ok(Math.abs(point.midi + 0.5 + envelopeCents / 100 - 64) < 1e-9)
  }
  assert.equal(updated.edit_regions[1].relative_pitch_cents, 50)
  assert.deepEqual(updated.phone_units.slice(0, 2).map((phone) => [phone.target_pitch_midi, phone.pitch_points, phone.pitch_owner_ref, phone.vibrato_depth_cents]), [[null, [], null, 0], [null, [], null, 0]])
  assert.equal(updated.edit_regions[0].pitch_points, undefined)
  assert.deepEqual(updated.volume_envelope, segment.volume_envelope)
  assert.deepEqual(updated.pitch_envelope, segment.pitch_envelope)
  assert.equal(updated.edit_regions.reduce((sum, region) => sum + region.output_duration_ms, 0), 300)
  const unrelated = { ...makeSegment(), segment_id: "unrelated" }
  const withUnrelated = setSyllablePitch([segment, unrelated], first, 64)
  assert.equal(withUnrelated[1], unrelated)
  const reset = setSyllablePitch(changed, first, null)
  assert.deepEqual(reset[0].edit_regions[1].pitch_points, undefined)
  assert.equal(reset[0].edit_regions[1].relative_pitch_cents, 0)
  assert.deepEqual(reset[0].pitch_envelope, segment.pitch_envelope)
  assert.deepEqual(reset[0].phone_units.slice(0, 2).map((phone) => phone.target_pitch_midi), [null, null])
  const infeasible = { ...segment, edit_regions: [{ ...segment.edit_regions[0], output_duration_ms: 1 }] }
  assert.equal(setSyllablePitch([infeasible], first, 67), null)
  assert.equal(setSyllablePitch([segment], first, 24), null)
  assert.equal(setSyllablePitch([segment], first, Number.NaN), null)
  const externalOwner = { ...makeSegment(), segment_id: "external-owner" }
  externalOwner.phone_units[0] = { ...externalOwner.phone_units[0], pitch_owner_ref: { segment_id: segment.segment_id, phone_unit_id: "vowel-a" } }
  assert.equal(setSyllablePitch([segment, externalOwner], first, 64), null)
})


