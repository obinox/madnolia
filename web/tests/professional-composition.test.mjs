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

const { applyProfessionalHandleDrag, changeRegionBoundary, mapWaveformToOutput, resizeProfessionalHandle, retimeCompositionSegments, splitEditRegions, updateSelectedRange, warpEnvelopeForRegionDurations } = await import("../src/composition.ts")

function segment(id, start, regions) {
  const duration = regions.reduce((sum, region) => sum + region.output_duration_ms, 0)
  return {
    segment_id: id, candidate_id: id, target_start_index: 0, target_end_index: 1,
    source_id: "source", source_start_ms: start, source_end_ms: start + 100,
    timeline_start_ms: 0, timeline_end_ms: duration, match_status: "EXACT",
    target_ipa: ["a"], matched_ipa: ["a"], gap_before_ms: 0, stretch_percent: 100,
    lane: 0, phone_units: [], edit_regions: regions, volume_envelope: [],
  }
}

test("selection stretch preserves all other absolute positions and region details", () => {
  const first = { ...segment("a", 0, [{ region_id: "r", source_start_ms: 0, source_end_ms: 100, output_duration_ms: 100, relative_pitch_cents: 0 }]),
    volume_envelope: [{ position: 0, gain: 0.5 }, { position: 0.2, gain: 0.8 }, { position: 0.5, gain: 1 }, { position: 0.8, gain: 0.7 }, { position: 1, gain: 0.5 }],
    pitch_envelope: [{ position: 0, cents: 0 }, { position: 0.2, cents: 100 }, { position: 0.5, cents: 200 }, { position: 0.8, cents: -100 }, { position: 1, cents: 0 }] }
  const second = { ...segment("b", 100, [{ region_id: "s", source_start_ms: 100, source_end_ms: 200, output_duration_ms: 100, relative_pitch_cents: 0 }]), timeline_start_ms: 240, timeline_end_ms: 340 }
  const changed = updateSelectedRange([first, second], "a", 20, 80, { output_duration_ms: 120, relative_pitch_cents: 75 })
  assert.deepEqual(changed[0].edit_regions.map((region) => [region.source_start_ms, region.source_end_ms]), [[0, 20], [20, 80], [80, 100]])
  assert.equal(changed[0].edit_regions.reduce((sum, region) => sum + region.output_duration_ms, 0), 160, JSON.stringify(changed[0].edit_regions))
  assert.equal(changed[0].timeline_end_ms, 160)
  assert.equal(changed[1].timeline_start_ms, 240)
  assert.equal(changed[0].edit_regions[1].relative_pitch_cents, 75)
  assert.deepEqual(changed[0].edit_regions.map((region) => [region.source_start_ms, region.source_end_ms]), [[0, 20], [20, 80], [80, 100]])
  assert.equal(changed[0].volume_envelope.length, 5)
  assert.equal(changed[0].pitch_envelope.length, 5)
  assert.deepEqual(changed[0].volume_envelope.map((point) => point.position), [0, .125, .5, .875, 1])
  assert.deepEqual(changed[0].pitch_envelope.map((point) => point.position), [0, .125, .5, .875, 1])
  assert.deepEqual(changed[0].volume_envelope.map((point) => point.gain), [0.5, 0.8, 1, 0.7, 0.5])
  assert.deepEqual(changed[0].pitch_envelope.map((point) => point.cents), [0, 100, 200, -100, 0])
})

test("whole-fragment duration edits preserve following fragment positions", () => {
  const first = segment("a", 0, [
    { region_id: "start", source_start_ms: 0, source_end_ms: 40, output_duration_ms: 40, relative_pitch_cents: 0 },
    { region_id: "end", source_start_ms: 40, source_end_ms: 100, output_duration_ms: 60, relative_pitch_cents: 0 },
  ])
  const second = { ...segment("b", 100, [{ region_id: "later", source_start_ms: 100, source_end_ms: 200, output_duration_ms: 100, relative_pitch_cents: 0 }]), timeline_start_ms: 180, timeline_end_ms: 280 }
  const changed = updateSelectedRange([first, second], "a", 0, 100, { output_duration_ms: 150 })
  assert.equal(changed[0].timeline_end_ms - changed[0].timeline_start_ms, 150)
  assert.deepEqual(changed[0].edit_regions.map((region) => [region.source_start_ms, region.source_end_ms]), [[0, 40], [40, 100]])
  assert.equal(changed[1].timeline_start_ms, 180)
})

test("positive start gaps move first and later fragments without changing their audio duration", () => {
  const first = { ...segment("a", 0, [{ region_id: "a", source_start_ms: 0, source_end_ms: 100, output_duration_ms: 100, relative_pitch_cents: 0 }]), timeline_start_ms: 40, timeline_end_ms: 140, gap_before_ms: 40 }
  const second = { ...segment("b", 100, [{ region_id: "b", source_start_ms: 100, source_end_ms: 200, output_duration_ms: 100, relative_pitch_cents: 0 }]), timeline_start_ms: 165, timeline_end_ms: 265, gap_before_ms: 25 }
  const moved = retimeCompositionSegments([{ ...first, gap_before_ms: 40 }, second], "PROFESSIONAL")
  assert.deepEqual(moved.map((item) => [item.timeline_start_ms, item.timeline_end_ms]), [[40, 140], [165, 265]])
  assert.deepEqual(moved.map((item) => item.gap_before_ms), [40, 25])
  assert.deepEqual(moved.map((item) => item.edit_regions[0].output_duration_ms), [100, 100])
})

test("waveform samples follow source mapping across stretched edit regions", () => {
  const stretched = segment("a", 0, [
    { region_id: "left", source_start_ms: 0, source_end_ms: 50, output_duration_ms: 200, relative_pitch_cents: 0 },
    { region_id: "right", source_start_ms: 50, source_end_ms: 100, output_duration_ms: 50, relative_pitch_cents: 0 },
  ])
  const path = mapWaveformToOutput(stretched, [0.1, 0.2, 0.6, 0.8]).split(" ").map((point) => point.split(",").map(Number))
  assert.equal(path[0][0], 0)
  assert.equal(path.at(-1)[0], 1000)
  const seam = path.find(([x]) => x === 800)
  assert.ok(seam)
  assert.equal(seam[1], 50 - 0.6 * 44)
})

test("moving an internal source guide preserves neighboring absolute positions", () => {
  const first = segment("a", 0, [
    { region_id: "left", source_start_ms: 0, source_end_ms: 50, output_duration_ms: 100, relative_pitch_cents: 0 },
    { region_id: "right", source_start_ms: 50, source_end_ms: 100, output_duration_ms: 50, relative_pitch_cents: 0 },
  ])
  const second = { ...segment("b", 100, [{ region_id: "later", source_start_ms: 100, source_end_ms: 200, output_duration_ms: 100, relative_pitch_cents: 0 }]), timeline_start_ms: 300, timeline_end_ms: 400 }
  const changed = changeRegionBoundary([first, second], "a", "right", "source_start_ms", 60)
  assert.deepEqual(changed[0].edit_regions.map((region) => [region.source_start_ms, region.source_end_ms, region.output_duration_ms]), [[0, 60, 120], [60, 100, 40]])
  assert.equal(changed[0].timeline_end_ms, 160)
  assert.equal(changed[1].timeline_start_ms, 300)
  const retimed = retimeCompositionSegments(changed, "PROFESSIONAL")
  assert.equal(retimed[0].source_start_ms, 0)
})

test("rear resizing changes only the last edit region and overlapping starts receive stable lanes", () => {
  const first = segment("a", 0, [
    { region_id: "early", source_start_ms: 0, source_end_ms: 40, output_duration_ms: 80, relative_pitch_cents: 120 },
    { region_id: "last", source_start_ms: 40, source_end_ms: 100, output_duration_ms: 60, relative_pitch_cents: -20 },
  ])
  first.volume_envelope = [{ position: 0, gain: 0.4 }, { position: 0.25, gain: 0.9 }, { position: 1, gain: 0.4 }]
  first.pitch_envelope = [{ position: 0, cents: 0 }, { position: 0.25, cents: 240 }, { position: 1, cents: 0 }]
  first.user_guide_source_ms = [40]
  const preserved = { ...first.edit_regions[0] }
  const resized = updateSelectedRange([first], "a", 40, 100, { output_duration_ms: 90 })[0]
  assert.deepEqual(resized.edit_regions[0], preserved)
  assert.equal(resized.edit_regions[1].output_duration_ms, 90)
  assert.equal(resized.timeline_start_ms, first.timeline_start_ms)
  assert.deepEqual(resized.volume_envelope.map((point) => point.gain), [0.4, 0.9, 0.4])
  assert.deepEqual(resized.pitch_envelope.map((point) => point.cents), [0, 240, 0])
  assert.equal(resized.volume_envelope[1].position * 170, 35)
  assert.deepEqual(resized.user_guide_source_ms, [40])

  const moved = retimeCompositionSegments([
    { ...first, timeline_start_ms: 125 },
    { ...segment("later", 200, [{ region_id: "later", source_start_ms: 200, source_end_ms: 300, output_duration_ms: 100, relative_pitch_cents: 0 }]), timeline_start_ms: 450 },
  ], "PROFESSIONAL")
  assert.deepEqual(moved.map((item) => item.timeline_start_ms), [125, 450])
  const third = { ...segment("third", 300, [{ region_id: "third", source_start_ms: 300, source_end_ms: 400, output_duration_ms: 100, relative_pitch_cents: 0 }]), timeline_start_ms: 700 }
  const deleted = retimeCompositionSegments([...moved, third].filter((item) => item.segment_id !== "a"), "PROFESSIONAL")
  assert.deepEqual(deleted.map((item) => item.timeline_start_ms), [450, 700])

  const intervals = [
    { ...segment("a", 0, [{ region_id: "x", source_start_ms: 0, source_end_ms: 100, output_duration_ms: 100, relative_pitch_cents: 0 }]), timeline_start_ms: 0 },
    { ...segment("b", 100, [{ region_id: "y", source_start_ms: 100, source_end_ms: 250, output_duration_ms: 150, relative_pitch_cents: 0 }]), timeline_start_ms: 50 },
    { ...segment("c", 250, [{ region_id: "z", source_start_ms: 250, source_end_ms: 350, output_duration_ms: 100, relative_pitch_cents: 0 }]), timeline_start_ms: 80 },
    { ...segment("d", 350, [{ region_id: "w", source_start_ms: 350, source_end_ms: 400, output_duration_ms: 50, relative_pitch_cents: 0 }]), timeline_start_ms: 100 },
  ]
  const lanes = retimeCompositionSegments(intervals, "PROFESSIONAL")
  assert.deepEqual(lanes.map((item) => item.lane), [0, 1, 2, 0])
  assert.deepEqual(lanes.map((item) => item.timeline_start_ms), [0, 50, 80, 100])
})

test("guide boundaries clamp to the immediately adjacent source interval and keep fragment edges fixed", () => {
  const source = segment("a", 100, [
    { region_id: "a", source_start_ms: 100, source_end_ms: 140, output_duration_ms: 80, relative_pitch_cents: 0 },
    { region_id: "b", source_start_ms: 140, source_end_ms: 175, output_duration_ms: 70, relative_pitch_cents: 0 },
    { region_id: "c", source_start_ms: 175, source_end_ms: 200, output_duration_ms: 50, relative_pitch_cents: 0 },
  ])
  const firstMoved = changeRegionBoundary([source], "a", "a", "source_end_ms", 190)[0]
  assert.equal(firstMoved.edit_regions[0].source_end_ms, 174)
  assert.equal(firstMoved.edit_regions[1].source_start_ms, 174)
  assert.equal(firstMoved.source_start_ms, 100)
  assert.equal(firstMoved.source_end_ms, 200)
  const secondMoved = changeRegionBoundary([source], "a", "b", "source_end_ms", 200)[0]
  assert.equal(secondMoved.edit_regions[1].source_end_ms, 199)
  assert.equal(secondMoved.edit_regions[2].source_start_ms, 199)
  const outerStart = changeRegionBoundary([source], "a", "a", "source_start_ms", 115)[0]
  assert.deepEqual(outerStart.edit_regions, source.edit_regions)
})

test("multi-guide range allocates one requested duration across pieces and rejects non-finite updates", () => {
  const first = segment("a", 100, [
    { region_id: "a", source_start_ms: 100, source_end_ms: 140, output_duration_ms: 40, relative_pitch_cents: 0 },
    { region_id: "b", source_start_ms: 140, source_end_ms: 175, output_duration_ms: 35, relative_pitch_cents: 20 },
    { region_id: "c", source_start_ms: 175, source_end_ms: 200, output_duration_ms: 25, relative_pitch_cents: 0 },
  ])
  const changed = updateSelectedRange([first], "a", 130, 190, { output_duration_ms: 120, relative_pitch_cents: 50 })[0]
  assert.equal(changed.edit_regions.reduce((sum, item) => sum + item.output_duration_ms, 0), 160)
  assert.deepEqual(changed.edit_regions.map((item) => item.relative_pitch_cents), [0, 50, 50, 50, 0])
  assert.deepEqual(changed.edit_regions.map((item) => [item.source_start_ms, item.source_end_ms]).flat(), [100, 130, 130, 140, 140, 175, 175, 190, 190, 200])
  const pitchOnly = updateSelectedRange([changed], "a", 130, 190, { relative_pitch_cents: -25 })[0]
  assert.equal(pitchOnly.edit_regions.reduce((sum, item) => sum + item.output_duration_ms, 0), 160)
  assert.equal(pitchOnly.edit_regions.filter((item) => item.source_start_ms >= 130 && item.source_end_ms <= 190).every((item) => item.relative_pitch_cents === -25), true)
  assert.equal(updateSelectedRange([first], "a", 130, 190, { output_duration_ms: Number.NaN })[0], first)
  const clipped = updateSelectedRange([first], "a", 90, 150, { output_duration_ms: 50 })[0]
  assert.equal(clipped.edit_regions.reduce((sum, item) => sum + item.output_duration_ms, 0), 100)
})

test("guide splits preserve feasible 25 percent durations and leave infeasible cuts untouched", () => {
  const low = segment("a", 100, [{ region_id: "low", source_start_ms: 100, source_end_ms: 200, output_duration_ms: 25, relative_pitch_cents: 0 }]).edit_regions
  assert.equal(splitEditRegions(low, 101, 101).length, 1)
  const feasible = splitEditRegions(low, 104, 104)
  assert.equal(feasible.length, 2)
  assert.deepEqual(feasible.map((item) => item.output_duration_ms), [1, 24])
  assert.ok(feasible.every((item) => item.output_duration_ms >= Math.ceil((item.source_end_ms - item.source_start_ms) * 0.25)))
})

test("professional handles resize adjacent intervals from the captured segment", () => {
  const source = segment("a", 0, [200, 300, 400].map((duration, index) => ({
    region_id: `r${index}`, source_start_ms: index * 100, source_end_ms: (index + 1) * 100,
    output_duration_ms: duration, relative_pitch_cents: index * 25,
  })))
  source.timeline_start_ms = 100
  source.volume_envelope = [{ position: 0, gain: .5 }, { position: .25, gain: .8 }, { position: 1, gain: .5 }]
  source.pitch_envelope = [{ position: 0, cents: 0 }, { position: .25, cents: 80 }, { position: 1, cents: 0 }]
  const result = (selected, boundary, mode, delta) => resizeProfessionalHandle(source, selected, boundary, mode, delta)
  assert.deepEqual(result(1, 1, "normal", 40), { startMs: 100, durations: [240, 260, 400] })
  assert.deepEqual(result(1, 2, "normal", 40), { startMs: 100, durations: [200, 340, 360] })
  assert.deepEqual(result(1, 1, "ctrl", 40), { startMs: 140, durations: [200, 260, 400] })
  assert.deepEqual(result(1, 2, "ctrl", 40), { startMs: 100, durations: [200, 340, 400] })
  assert.deepEqual(result(1, 2, "shift", 40), { startMs: 140, durations: [200, 300, 400] })
  assert.deepEqual(result(0, 0, "normal", 40), { startMs: 140, durations: [160, 300, 400] })
  assert.deepEqual(result(2, 3, "normal", 40), { startMs: 100, durations: [200, 300, 440] })
  assert.deepEqual(result(1, 2, "normal", -1000), { startMs: 100, durations: [200, 25, 675] })
  assert.deepEqual(result(0, 0, "normal", -500), { startMs: 0, durations: [300, 300, 400] })
  assert.deepEqual(result(1, 1, "normal", 1000), { startMs: 100, durations: [475, 25, 400] })
  const twice = result(1, 1, "normal", 40)
  const later = { ...segment("later", 0, [{ region_id: "later", source_start_ms: 300, source_end_ms: 400, output_duration_ms: 100, relative_pitch_cents: 0 }]), timeline_start_ms: 1200, timeline_end_ms: 1300 }
  const firstApply = applyProfessionalHandleDrag([source, later], source, twice.startMs, twice.durations)
  const secondApply = applyProfessionalHandleDrag(firstApply, source, twice.startMs, twice.durations)
  const changed = firstApply[0]
  assert.equal(firstApply[1].timeline_start_ms, later.timeline_start_ms)
  assert.deepEqual(secondApply, firstApply, "Repeated movement at one pointer position accumulated from the last update")
  assert.deepEqual(changed.edit_regions.map((region) => region.relative_pitch_cents), [0, 25, 50])
  assert.deepEqual(changed.volume_envelope, warpEnvelopeForRegionDurations(source.volume_envelope, source.edit_regions, twice.durations.map((duration, index) => ({ ...source.edit_regions[index], output_duration_ms: duration }))))
  assert.deepEqual(changed.pitch_envelope, warpEnvelopeForRegionDurations(source.pitch_envelope, source.edit_regions, twice.durations.map((duration, index) => ({ ...source.edit_regions[index], output_duration_ms: duration }))))
})
