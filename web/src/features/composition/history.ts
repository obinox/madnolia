import { PROFESSIONAL_HISTORY_LIMIT } from "../../constants"
import type { ProfessionalEditableState, ProfessionalHistoryAction, ProfessionalHistoryState } from "../../types"

const same = (left: ProfessionalEditableState, right: ProfessionalEditableState) => JSON.stringify(left) === JSON.stringify(right)

export function createProfessionalHistory(present: ProfessionalEditableState): ProfessionalHistoryState {
  return { present, past: [], future: [], gestureBaseline: null }
}

export function reduceProfessionalHistory(state: ProfessionalHistoryState, action: ProfessionalHistoryAction): ProfessionalHistoryState {
  if (action.type === "reset") return createProfessionalHistory(action.next)
  if (action.type === "begin-gesture") return state.gestureBaseline ? state : { ...state, gestureBaseline: state.present }
  if (action.type === "end-gesture") {
    if (!state.gestureBaseline) return state
    return { ...state, past: same(state.gestureBaseline, state.present) ? state.past : [...state.past, state.gestureBaseline].slice(-PROFESSIONAL_HISTORY_LIMIT), future: same(state.gestureBaseline, state.present) ? state.future : [], gestureBaseline: null }
  }
  if (action.type === "edit") {
    if (same(state.present, action.next)) return state
    if (state.gestureBaseline) return { ...state, present: action.next }
    return { ...state, present: action.next, past: [...state.past, state.present].slice(-PROFESSIONAL_HISTORY_LIMIT), future: [] }
  }
  if (state.gestureBaseline) return state
  if (action.type === "undo") {
    const previous = state.past.at(-1)
    return previous ? { ...state, present: previous, past: state.past.slice(0, -1), future: [state.present, ...state.future] } : state
  }
  const next = state.future[0]
  return next ? { ...state, present: next, past: [...state.past, state.present].slice(-PROFESSIONAL_HISTORY_LIMIT), future: state.future.slice(1) } : state
}
