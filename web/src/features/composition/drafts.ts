import { PIANO_ROLL_NOTE_MIN_DURATION_MS, PROFESSIONAL_BEAT_DIVISIONS, PROFESSIONAL_DRAFT_SCHEMA_VERSION, PITCH_MAX_MIDI, PITCH_MIN_MIDI } from "../../constants"
import type { ProfessionalCompositionDraft, ProfessionalEditableState, ProfessionalHistoryState } from "../../types"

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

export function isProfessionalEditableState(value: unknown): value is ProfessionalEditableState {
  if (!value || typeof value !== "object") return false
  const state = value as ProfessionalEditableState
  if (typeof state.name !== "string" || !Array.isArray(state.segments)
    || !finite(state.crossfadeMs) || state.crossfadeMs < 0
    || !finite(state.tempoBpm) || state.tempoBpm <= 0
    || !finite(state.beatsPerBar) || state.beatsPerBar <= 0
    || !PROFESSIONAL_BEAT_DIVISIONS.includes(state.beatDivision)
    || !Array.isArray(state.pitchNotes ?? [])
    || !finite(state.gridOffsetUnits)) return false
  if (!(state.pitchNotes ?? []).every((note) => note && typeof note.note_id === "string" && !!note.note_id
    && finite(note.start_ms) && note.start_ms >= 0 && finite(note.end_ms) && note.end_ms - note.start_ms >= PIANO_ROLL_NOTE_MIN_DURATION_MS
    && Array.isArray(note.pitch_points) && note.pitch_points.length >= 2
    && note.pitch_points[0].position === 0 && note.pitch_points.at(-1)?.position === 1
    && note.pitch_points.every((point, index) => point && finite(point.position) && 0 <= point.position && point.position <= 1
      && finite(point.midi) && PITCH_MIN_MIDI <= point.midi && point.midi <= PITCH_MAX_MIDI
      && (index === 0 || note.pitch_points[index - 1].position < point.position)))) return false
  return state.segments.every((segment) => {
    if (!segment || typeof segment.segment_id !== "string" || !segment.segment_id || typeof segment.candidate_id !== "string" || typeof segment.source_id !== "string" || !segment.source_id
      || !finite(segment.target_start_index) || !finite(segment.target_end_index) || !finite(segment.lane)
      || !finite(segment.source_start_ms) || !finite(segment.source_end_ms) || segment.source_end_ms < segment.source_start_ms
      || !finite(segment.timeline_start_ms) || !finite(segment.timeline_end_ms) || segment.timeline_end_ms < segment.timeline_start_ms
      || !finite(segment.gap_before_ms) || !finite(segment.stretch_percent)
      || !Array.isArray(segment.phone_units) || !Array.isArray(segment.edit_regions)
      || !Array.isArray(segment.volume_envelope) || !Array.isArray(segment.target_ipa) || !segment.target_ipa.every((item) => typeof item === "string") || !Array.isArray(segment.matched_ipa) || !segment.matched_ipa.every((item) => typeof item === "string")) return false
    if (!segment.phone_units.every((phone) => phone && typeof phone.phone_unit_id === "string" && !!phone.phone_unit_id
      && (phone.source_start_ms === null || finite(phone.source_start_ms))
      && (phone.source_end_ms === null || finite(phone.source_end_ms)) && finite(phone.output_duration_ms)
      && finite(phone.target_pitch_strength_percent) && finite(phone.formant_shift_semitones)
      && finite(phone.vibrato_depth_cents) && finite(phone.vibrato_rate_hz) && finite(phone.vibrato_start_ms)
      && finite(phone.transition_to_next_ms) && finite(phone.transition_strength_percent) && finite(phone.transition_center_ms)
      && (phone.pitch_points === undefined || (Array.isArray(phone.pitch_points) && phone.pitch_points.every((point) => point && finite(point.position) && finite(point.midi)))))) return false
    if (!segment.edit_regions.every((region) => region && typeof region.region_id === "string" && !!region.region_id
      && finite(region.source_start_ms) && finite(region.source_end_ms) && finite(region.output_duration_ms)
      && finite(region.relative_pitch_cents)
      && (region.pitch_points === undefined || (Array.isArray(region.pitch_points) && region.pitch_points.every((point) => point && finite(point.position) && finite(point.midi)))))) return false
    if (!segment.volume_envelope.every((point) => point && finite(point.position) && finite(point.gain))) return false
    if (segment.pitch_envelope !== undefined && (!Array.isArray(segment.pitch_envelope)
      || !segment.pitch_envelope.every((point) => point && finite(point.position) && finite(point.cents)))) return false
    return true
  })
}

export function parseProfessionalCompositionDraft(raw: string, projectId: string, documentKey?: string): ProfessionalCompositionDraft | null {
  try {
    const draft = JSON.parse(raw) as ProfessionalCompositionDraft
    if (!draft || draft.version !== PROFESSIONAL_DRAFT_SCHEMA_VERSION || draft.project_id !== projectId
      || typeof draft.document_key !== "string" || (documentKey !== undefined && draft.document_key !== documentKey)
      || typeof draft.composition_id !== "string" || typeof draft.parent_composition_id !== "string"
      || typeof draft.parent_composition_updated_at !== "string" || typeof draft.legacy_mode !== "boolean"
      || !finite(draft.schema_version) || typeof draft.saved_at !== "string" || !isProfessionalEditableState(draft.state)
      || (draft.history !== undefined && (!isProfessionalHistoryState(draft.history) || JSON.stringify(draft.history.present) !== JSON.stringify(draft.state)))) return null
    const normalizeState = (state: ProfessionalEditableState) => ({ ...state, pitchNotes: state.pitchNotes ?? [] })
    const normalizeHistory = (history: ProfessionalHistoryState | undefined) => history ? {
      ...history,
      present: normalizeState(history.present),
      past: history.past.map(normalizeState),
      future: history.future.map(normalizeState),
      gestureBaseline: history.gestureBaseline ? normalizeState(history.gestureBaseline) : null,
    } : undefined
    return { ...draft, state: normalizeState(draft.state), history: normalizeHistory(draft.history) }
  } catch {
    return null
  }
}

function isProfessionalHistoryState(value: unknown): value is ProfessionalHistoryState {
  if (!value || typeof value !== "object") return false
  const history = value as ProfessionalHistoryState
  return isProfessionalEditableState(history.present)
    && Array.isArray(history.past) && history.past.every(isProfessionalEditableState)
    && Array.isArray(history.future) && history.future.every(isProfessionalEditableState)
    && (history.gestureBaseline === null || isProfessionalEditableState(history.gestureBaseline))
}
