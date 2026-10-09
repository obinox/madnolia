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

const { PROFESSIONAL_DRAFT_SCHEMA_VERSION } = await import("../src/constants.ts")
const { createProfessionalHistory, reduceProfessionalHistory } = await import("../src/professionalHistory.ts")
const { parseProfessionalCompositionDraft } = await import("../src/features/composition/drafts.ts")

const segment = {
  segment_id: "segment-1", candidate_id: "candidate-1", target_start_index: 0, target_end_index: 1,
  source_id: "source-1", source_start_ms: 120, source_end_ms: 740, timeline_start_ms: 35,
  timeline_end_ms: 655, match_status: "EXACT", target_ipa: ["h"], matched_ipa: ["h"],
  gap_before_ms: 35, stretch_percent: 100, lane: 0,
  phone_units: [{ phone_unit_id: "phone-1", operation: "MATCH", target_index: 0, target_phone_id: "h",
    target_ipa: "h", source_occurrence_id: "occ-1", source_phone_id: "h", source_ipa: "h",
    source_start_ms: 120, source_end_ms: 740, output_duration_ms: 620, source_f0_hz: 180,
    voiced_probability: 0.94, target_pitch_midi: 64, target_pitch_strength_percent: 100,
    formant_shift_semitones: 0, vibrato_depth_cents: 0, vibrato_rate_hz: 5, vibrato_start_ms: 0,
    transition_to_next_ms: 0, transition_strength_percent: 50, transition_center_ms: 50,
    pitch_points: [{ position: 0, midi: 64 }] }],
  edit_regions: [{ region_id: "region-1", source_start_ms: 120, source_end_ms: 740,
    output_duration_ms: 620, relative_pitch_cents: 12, pitch_points: [{ position: 0.5, midi: 64 }] }],
  volume_envelope: [{ position: 0, gain: 0.8 }, { position: 1, gain: 1 }],
  pitch_envelope: [{ position: 0, cents: 0 }, { position: 1, cents: 12 }],
}

const makeDraft = () => {
  const state = { name: "Unsaved route edit", segments: [{ ...segment }], pitchNotes: [], crossfadeMs: 12,
    tempoBpm: 137, beatsPerBar: 3, beatDivision: 8, gridOffsetUnits: 0.25 }
  const history = reduceProfessionalHistory(createProfessionalHistory({ ...state, name: "Before edit" }), { type: "edit", next: state })
  return { version: PROFESSIONAL_DRAFT_SCHEMA_VERSION, project_id: "project-1", document_key: "composition:saved-1",
    composition_id: "saved-1", parent_composition_id: "simple-1", parent_composition_updated_at: "2026-10-07T12:00:00Z",
    schema_version: 2, legacy_mode: false, state, history, saved_at: "2026-10-08T00:00:00Z" }
}

test("complete realistic edited draft restores with matching undo history and document ownership", () => {
  const draft = makeDraft()
  const restored = parseProfessionalCompositionDraft(JSON.stringify(draft), "project-1", "composition:saved-1")
  assert.deepEqual(restored.state, draft.state)
  assert.deepEqual(restored.history.present, draft.state)
  assert.equal(restored.history.past[0].name, "Before edit")
  assert.equal(parseProfessionalCompositionDraft(JSON.stringify(draft), "project-2"), null)
  assert.equal(parseProfessionalCompositionDraft(JSON.stringify(draft), "project-1", "composition:other"), null)
})

test("nested segment corruption and a mismatched history snapshot reject the whole draft", () => {
  const malformedSegment = makeDraft()
  malformedSegment.state.segments[0].phone_units[0].vibrato_depth_cents = "wide"
  malformedSegment.history.present = structuredClone(malformedSegment.state)
  assert.equal(parseProfessionalCompositionDraft(JSON.stringify(malformedSegment), "project-1"), null)

  const mismatchedHistory = makeDraft()
  mismatchedHistory.history.present.name = "Different document state"
  assert.equal(parseProfessionalCompositionDraft(JSON.stringify(mismatchedHistory), "project-1"), null)
})
