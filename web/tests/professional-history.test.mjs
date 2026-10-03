import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import test from "node:test"

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    try { return nextResolve(`${specifier}.ts`, context) } catch {}
  }
  return nextResolve(specifier, context)
} })

const { createProfessionalHistory, reduceProfessionalHistory } = await import("../src/professionalHistory.ts")
const state = (segments = []) => ({ name: "편집", segments, crossfadeMs: 8, tempoBpm: 120, beatsPerBar: 4, beatDivision: 4, gridOffsetUnits: 0 })

test("a multi-update gesture is one undo step and new edits discard redo", () => {
  let history = createProfessionalHistory(state())
  history = reduceProfessionalHistory(history, { type: "begin-gesture" })
  history = reduceProfessionalHistory(history, { type: "edit", next: state([{ id: "moved", x: 1 }]) })
  history = reduceProfessionalHistory(history, { type: "edit", next: state([{ id: "moved", x: 2 }]) })
  history = reduceProfessionalHistory(history, { type: "end-gesture" })
  assert.equal(history.past.length, 1)
  history = reduceProfessionalHistory(history, { type: "undo" })
  assert.deepEqual(history.present, state())
  history = reduceProfessionalHistory(history, { type: "redo" })
  assert.equal(history.present.segments[0].x, 2)
  history = reduceProfessionalHistory(history, { type: "edit", next: state([{ id: "split", regions: [1, 2], envelope: [{ position: 0.5, gain: 0.4 }] }]) })
  assert.equal(history.future.length, 0)
  history = reduceProfessionalHistory(history, { type: "undo" })
  assert.equal(history.present.segments[0].x, 2)
  history = reduceProfessionalHistory(history, { type: "redo" })
  assert.deepEqual(history.present.segments[0].regions, [1, 2])
  assert.deepEqual(history.present.segments[0].envelope, [{ position: 0.5, gain: 0.4 }])
})

test("no-op gestures create no history; reset clears both directions and active gestures ignore undo", () => {
  let history = createProfessionalHistory(state())
  history = reduceProfessionalHistory(history, { type: "begin-gesture" })
  history = reduceProfessionalHistory(history, { type: "end-gesture" })
  assert.equal(history.past.length, 0)
  history = reduceProfessionalHistory(history, { type: "begin-gesture" })
  assert.equal(reduceProfessionalHistory(history, { type: "undo" }), history)
  history = reduceProfessionalHistory(history, { type: "edit", next: state([{ id: "split" }]) })
  history = reduceProfessionalHistory(history, { type: "end-gesture" })
  history = reduceProfessionalHistory(history, { type: "reset", next: state([{ id: "loaded" }]) })
  assert.equal(history.past.length, 0)
  assert.equal(history.future.length, 0)
  assert.equal(history.gestureBaseline, null)
})

test("a gesture returned to its baseline preserves redo and creates no history", () => {
  let history = createProfessionalHistory(state())
  history = reduceProfessionalHistory(history, { type: "edit", next: state([{ id: "first" }]) })
  history = reduceProfessionalHistory(history, { type: "undo" })
  const redo = history.future
  history = reduceProfessionalHistory(history, { type: "begin-gesture" })
  history = reduceProfessionalHistory(history, { type: "edit", next: state([{ id: "moved" }]) })
  history = reduceProfessionalHistory(history, { type: "edit", next: state() })
  history = reduceProfessionalHistory(history, { type: "end-gesture" })
  assert.equal(history.past.length, 0)
  assert.deepEqual(history.future, redo)
})
