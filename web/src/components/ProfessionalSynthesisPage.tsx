import { useEffect, useMemo, useReducer, useRef, useState } from "react"

import { autotuneComposition, createComposition, exportComposition, fetchCompositions, previewComposition, updateComposition } from "../api/compositions"
import { applyProfessionalHandleDrag, changeRegionBoundary, deriveProfessionalSegments, moveProfessionalTimelineSuffix, retimeCompositionSegments, splitEditRegions, updateEditRegion, updateSelectedRange, warpEnvelopeForRegionDurations, mergeRegionPitchPoints } from "../composition"
import { createProfessionalHistory, reduceProfessionalHistory } from "../professionalHistory"
import { COLLAGE_EXPORT_TARGETS, DEFAULT_CROSSFADE_MS, PIANO_ROLL_SELECTED_PHONE_SEPARATOR, PITCH_MAX_MIDI, PITCH_MIN_MIDI, PROFESSIONAL_AUTOTUNE_SPEED_DEFAULT_MS, PROFESSIONAL_AUTOTUNE_STRENGTH_DEFAULT_PERCENT, PROFESSIONAL_COMPOSITION_SCHEMA_VERSION, PROFESSIONAL_DRAFT_ACTIVE_PREFIX, PROFESSIONAL_DRAFT_SCHEMA_VERSION, PROFESSIONAL_DRAFT_STORAGE_PREFIX, PROFESSIONAL_ENVELOPE_DEFAULT, PROFESSIONAL_PITCH_MAX_CENTS, PROFESSIONAL_PITCH_MIN_CENTS, PROFESSIONAL_TEMPO_DEFAULT_BPM, PROFESSIONAL_BEATS_PER_BAR_DEFAULT, PROFESSIONAL_BEAT_DIVISION_DEFAULT, PROFESSIONAL_GRID_OFFSET_UNITS_DEFAULT, PROFESSIONAL_STEP_CORRECTION, PROFESSIONAL_STEP_TIMING } from "../constants"
import type {
  CompositionProject,
  PianoRollPitchNote,
  ExportJob,
  ExportTarget,
  PianoRollAuditionMode,
  PianoRollLoopRange,
  PianoRollPhoneRef,
  PianoRollRegionView,
  PianoRollSyllableGroup,
  PhonePitchPoint,
  PhoneUnit,
  PitchEnvelopePoint,
  ProfessionalBeatDivision,
  EditRegion,
  VolumeEnvelopePoint,
  ProfessionalSynthesisPageProps,
  ProfessionalPreviewIntent,
  SaveCompositionRequest,
  TimelineSegment,
  ProfessionalEditableState,
  ProfessionalSynthesisStep,
  ProfessionalAutotuneSettings,
  ProfessionalCompositionDraft,
  ProfessionalHistoryAction,
} from "../types"
import { ProfessionalEditor, reorderSegments } from "./ProfessionalEditor"
import { ExportProgress } from "./ExportProgress"
import { PianoRollEditor } from "./PianoRollEditor"
import { clampPhoneVibratoStarts, resizePhoneOutputDuration, setRegionRangePitchPoints, setSyllablePitch } from "../features/composition/pianoRoll"
import { useGlobalTask } from "../globalTask"
import { parseProfessionalCompositionDraft } from "../features/composition/drafts"
import { remoteTaskStage } from "../api/remoteTasks"

export function ProfessionalSynthesisPage({
  projectId,
  initialCompositionId,
}: ProfessionalSynthesisPageProps) {
  const [compositions, setCompositions] = useState<CompositionProject[]>([])
  const [compositionId, setCompositionId] = useState("")
  const [parentId, setParentId] = useState("")
  const [parentUpdatedAt, setParentUpdatedAt] = useState("")
  const [name, setName] = useState("전문 합성")
  const [segments, setSegments] = useState<TimelineSegment[]>([])
  const [pitchNotes, setPitchNotes] = useState<ProfessionalEditableState["pitchNotes"]>([])
  const [selectedSegmentId, setSelectedSegmentId] = useState("")
  const [playheadMs, setPlayheadMs] = useState(0)
  const [crossfadeMs, setCrossfadeMs] = useState(DEFAULT_CROSSFADE_MS)
  const [tempoBpm, setTempoBpm] = useState(PROFESSIONAL_TEMPO_DEFAULT_BPM)
  const [beatsPerBar, setBeatsPerBar] = useState(PROFESSIONAL_BEATS_PER_BAR_DEFAULT)
  const [beatDivision, setBeatDivision] = useState<ProfessionalBeatDivision>(PROFESSIONAL_BEAT_DIVISION_DEFAULT)
  const [gridOffsetUnits, setGridOffsetUnits] = useState(PROFESSIONAL_GRID_OFFSET_UNITS_DEFAULT)
  const [history, dispatchHistoryReducer] = useReducer(reduceProfessionalHistory, createProfessionalHistory({ name, segments, pitchNotes, crossfadeMs, tempoBpm, beatsPerBar, beatDivision, gridOffsetUnits }))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [listRefreshFailed, setListRefreshFailed] = useState(false)
  const listRefreshFailedRef = useRef(false)
  const [exportProgress, setExportProgress] = useState<ExportJob | null>(null)
  const [legacyMode, setLegacyMode] = useState(false)
  const [legacySchemaVersion, setLegacySchemaVersion] = useState(PROFESSIONAL_COMPOSITION_SCHEMA_VERSION)
  const [draftReady, setDraftReady] = useState(false)
  const [step, setStep] = useState<ProfessionalSynthesisStep>(PROFESSIONAL_STEP_TIMING)
  const [editorDocumentRevision, setEditorDocumentRevision] = useState(0)
  const [autotuneSettings, setAutotuneSettings] = useState<ProfessionalAutotuneSettings>({ strength_percent: PROFESSIONAL_AUTOTUNE_STRENGTH_DEFAULT_PERCENT, speed_ms: PROFESSIONAL_AUTOTUNE_SPEED_DEFAULT_MS })
  const [isPlaying, setIsPlaying] = useState(false)
  const [loopEnabled, setLoopEnabled] = useState(false)
  const [loopRange, setLoopRange] = useState<PianoRollLoopRange | null>(null)
  const [auditionMode, setAuditionMode] = useState<PianoRollAuditionMode>("corrected")
  const [previewUrl, setPreviewUrl] = useState("")
  const { beginTask, updateTask, finishTask, isTaskActive } = useGlobalTask()
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const lastEditInput = useRef<HTMLElement | null>(null)
  const inputDispatchTarget = useRef<EventTarget | null>(null)
  const previewController = useRef<AbortController | null>(null)
  const autotuneController = useRef<AbortController | null>(null)
  const exportController = useRef<AbortController | null>(null)
  const currentProjectId = useRef(projectId)
  currentProjectId.current = projectId
  const previewSignature = useRef("")
  const currentSignature = useRef("")
  const currentRenderSignature = useRef("")
  const previewIntent = useRef<ProfessionalPreviewIntent | null>(null)
  const renderPromise = useRef<Promise<void> | null>(null)
  const previewTaskId = useRef<string | null>(null)
  const loopRangeRef = useRef<PianoRollLoopRange | null>(null)
  const loopEnabledRef = useRef(false)
  const loopSeekRef = useRef(false)
  loopRangeRef.current = loopRange
  loopEnabledRef.current = loopEnabled
  const editableRef = useRef<ProfessionalEditableState>({ name, segments, pitchNotes, crossfadeMs, tempoBpm, beatsPerBar, beatDivision, gridOffsetUnits })
  editableRef.current = { name, segments, pitchNotes, crossfadeMs, tempoBpm, beatsPerBar, beatDivision, gridOffsetUnits }
  const historyRef = useRef(history)
  historyRef.current = history
  const dispatchHistory = (action: ProfessionalHistoryAction) => {
    historyRef.current = reduceProfessionalHistory(historyRef.current, action)
    dispatchHistoryReducer(action)
  }
  const draftMetaRef = useRef({ projectId, compositionId, parentId, parentUpdatedAt, legacyMode, legacySchemaVersion })
  draftMetaRef.current = { projectId, compositionId, parentId, parentUpdatedAt, legacyMode, legacySchemaVersion }
  const draftOwnerRef = useRef("")
  const readyDraftMetaRef = useRef<typeof draftMetaRef.current | null>(null)
  if (draftOwnerRef.current === projectId && readyDraftMetaRef.current) readyDraftMetaRef.current = { ...draftMetaRef.current }
  const explicitParentRouteRef = useRef(false)
  const draftKey = (targetProjectId: string, documentKey: string) => `${PROFESSIONAL_DRAFT_STORAGE_PREFIX}${targetProjectId}.${encodeURIComponent(documentKey)}`

  const writeDraft = (targetProjectId: string, flushGesture = false) => {
    try {
      if (draftOwnerRef.current !== targetProjectId || !readyDraftMetaRef.current) return
      const currentHistory = historyRef.current
      if (currentHistory.gestureBaseline && !flushGesture) return
      const draftHistory = currentHistory.gestureBaseline
        ? reduceProfessionalHistory(currentHistory, { type: "end-gesture" })
        : currentHistory
      const meta = readyDraftMetaRef.current
      const documentKey = meta.compositionId ? `composition:${meta.compositionId}` : meta.parentId ? `parent:${meta.parentId}` : "new"
      const draft: ProfessionalCompositionDraft = {
        version: PROFESSIONAL_DRAFT_SCHEMA_VERSION,
        project_id: targetProjectId,
        document_key: documentKey,
        composition_id: meta.compositionId,
        parent_composition_id: meta.parentId,
        parent_composition_updated_at: meta.parentUpdatedAt,
        schema_version: meta.legacySchemaVersion,
        legacy_mode: meta.legacyMode,
        state: draftHistory.present,
        history: draftHistory,
        saved_at: new Date().toISOString(),
      }
      window.localStorage.setItem(draftKey(targetProjectId, documentKey), JSON.stringify(draft))
      if (!initialCompositionId || explicitParentRouteRef.current) window.localStorage.setItem(`${PROFESSIONAL_DRAFT_ACTIVE_PREFIX}${targetProjectId}`, documentKey)
    } catch {
      setMessage("브라우저 저장 공간이 부족해 편집 내용을 저장하지 못했습니다.")
    }
  }

  useEffect(() => {
    const flushDraft = () => writeDraft(currentProjectId.current, true)
    window.addEventListener("pagehide", flushDraft)
    window.addEventListener("beforeunload", flushDraft)
    return () => {
      window.removeEventListener("pagehide", flushDraft)
      window.removeEventListener("beforeunload", flushDraft)
    }
  }, [])

  const applyEdit = (next: ProfessionalEditableState) => {
    const previous = editableRef.current
    const changed = next.name !== previous.name || next.segments !== previous.segments || next.pitchNotes !== previous.pitchNotes
      || next.crossfadeMs !== previous.crossfadeMs || next.tempoBpm !== previous.tempoBpm
      || next.beatsPerBar !== previous.beatsPerBar || next.beatDivision !== previous.beatDivision
      || next.gridOffsetUnits !== previous.gridOffsetUnits
    if (changed && !inputDispatchTarget.current) lastEditInput.current = null
    editableRef.current = next
    dispatchHistory({ type: "edit", next })
    setName(next.name); setSegments(next.segments); setPitchNotes(next.pitchNotes); setCrossfadeMs(next.crossfadeMs); setTempoBpm(next.tempoBpm)
    setBeatsPerBar(next.beatsPerBar); setBeatDivision(next.beatDivision); setGridOffsetUnits(next.gridOffsetUnits)
  }
  const editSegments = (transform: (current: TimelineSegment[]) => TimelineSegment[]) => {
    const before = editableRef.current
    const transformed = transform(before.segments)
    if (transformed !== before.segments) {
      const segmentsNext = clampPhoneVibratoStarts(transformed)
      if (!inputDispatchTarget.current) lastEditInput.current = null
      applyEdit({ ...before, segments: segmentsNext })
    }
  }
  const resetHistory = (next: ProfessionalEditableState) => { editableRef.current = next; dispatchHistory({ type: "reset", next }) }

  const simpleCompositions = useMemo(
    () => compositions.filter((item) => item.mode === "SIMPLE"),
    [compositions],
  )
  const professionalCompositions = useMemo(
    () => compositions.filter((item) => item.mode === "PROFESSIONAL"),
    [compositions],
  )
  const parent = simpleCompositions.find((item) => item.composition_id === parentId) ?? null
  const dependencyChanged = Boolean(parent && parentUpdatedAt && parent.updated_at !== parentUpdatedAt)

  useEffect(() => {
    let active = true
    exportController.current?.abort()
    exportController.current = null
    setExportProgress(null)
    setBusy(false)
    setDraftReady(false)
    listRefreshFailedRef.current = false
    setListRefreshFailed(false)
    explicitParentRouteRef.current = false
    setCompositions([])
    setCompositionId("")
    setStep(PROFESSIONAL_STEP_TIMING)
    setParentId("")
    fetchCompositions(projectId).then((items) => {
      if (!active) return
      setCompositions((current) => [...items, ...current.filter((saved) => !items.some((item) => item.composition_id === saved.composition_id))])
      const requested = items.find((item) => item.composition_id === initialCompositionId)
      const restore = (draft: ProfessionalCompositionDraft) => {
        setCompositionId(draft.composition_id)
        setParentId(draft.parent_composition_id)
        setParentUpdatedAt(draft.parent_composition_updated_at)
        setLegacyMode(draft.legacy_mode)
        setLegacySchemaVersion(draft.schema_version)
        setName(draft.state.name)
        setSegments(draft.state.segments)
        setPitchNotes(draft.state.pitchNotes ?? [])
        setCrossfadeMs(draft.state.crossfadeMs)
        setTempoBpm(draft.state.tempoBpm)
        setBeatsPerBar(draft.state.beatsPerBar)
        setBeatDivision(draft.state.beatDivision)
        setGridOffsetUnits(draft.state.gridOffsetUnits)
        editableRef.current = draft.state
        dispatchHistory({ type: "restore", history: draft.history ?? createProfessionalHistory(draft.state) })
        setSelectedSegmentId(draft.state.segments[0]?.segment_id ?? "")
        setMessage("전문 편집 초안을 복원했습니다.")
      }
      let restoredDraft = false
      if (requested?.mode === "PROFESSIONAL") {
        const key = `composition:${requested.composition_id}`
        const raw = window.localStorage.getItem(draftKey(projectId, key))
        const draft = raw ? parseProfessionalCompositionDraft(raw, projectId, key) : null
        if (draft) {
          restore(draft)
          restoredDraft = true
        } else {
          setLegacySchemaVersion(requested.schema_version)
          applyProfessional(requested)
        }
      } else if (!requested && !initialCompositionId) {
        const activeKey = window.localStorage.getItem(`${PROFESSIONAL_DRAFT_ACTIVE_PREFIX}${projectId}`)
        const raw = activeKey ? window.localStorage.getItem(draftKey(projectId, activeKey))
          : window.localStorage.getItem(`${PROFESSIONAL_DRAFT_STORAGE_PREFIX}${projectId}`)
        const draft = raw ? parseProfessionalCompositionDraft(raw, projectId, activeKey ?? undefined) : null
        if (draft) {
          restore(draft)
          restoredDraft = true
        } else if (raw) {
          try { window.localStorage.removeItem(activeKey ? draftKey(projectId, activeKey) : `${PROFESSIONAL_DRAFT_STORAGE_PREFIX}${projectId}`) } catch { }
        }
      }
      const firstParent = requested?.mode === "SIMPLE" ? requested : !initialCompositionId ? items.find((item) => item.mode === "SIMPLE") : null
      if (firstParent && !restoredDraft) {
        explicitParentRouteRef.current = Boolean(initialCompositionId)
        applyParent(firstParent)
      } else if (!restoredDraft && !firstParent && requested?.mode !== "PROFESSIONAL") {
        const empty: ProfessionalEditableState = { name: "?꾨Ц ?⑹꽦", segments: [], pitchNotes: [], crossfadeMs: DEFAULT_CROSSFADE_MS, tempoBpm: PROFESSIONAL_TEMPO_DEFAULT_BPM, beatsPerBar: PROFESSIONAL_BEATS_PER_BAR_DEFAULT, beatDivision: PROFESSIONAL_BEAT_DIVISION_DEFAULT, gridOffsetUnits: PROFESSIONAL_GRID_OFFSET_UNITS_DEFAULT }
        setCompositionId("")
        setParentId("")
        setParentUpdatedAt("")
        setName(empty.name)
        setSegments(empty.segments)
        setPitchNotes(empty.pitchNotes)
        setCrossfadeMs(empty.crossfadeMs)
        setTempoBpm(empty.tempoBpm)
        setBeatsPerBar(empty.beatsPerBar)
        setBeatDivision(empty.beatDivision)
        setGridOffsetUnits(empty.gridOffsetUnits)
        resetHistory(empty)
      }
      draftOwnerRef.current = projectId
      readyDraftMetaRef.current = { projectId, compositionId: requested?.mode === "PROFESSIONAL" && !restoredDraft ? requested.composition_id : compositionId, parentId, parentUpdatedAt, legacyMode, legacySchemaVersion }
      setDraftReady(true)
    }).catch((error: Error) => {
      if (active) setMessage(error.message)
    })
    return () => {
      active = false
      writeDraft(projectId, true)
      draftOwnerRef.current = ""
      readyDraftMetaRef.current = null
      exportController.current?.abort()
      previewController.current?.abort()
      autotuneController.current?.abort()
      previewIntent.current = null
      renderPromise.current = null
      if (previewTaskId.current) finishTask(previewTaskId.current)
      previewTaskId.current = null
    }
  }, [initialCompositionId, projectId])

  useEffect(() => {
    if (!draftReady || history.gestureBaseline) return
    const timer = window.setTimeout(() => writeDraft(projectId), 300)
    return () => window.clearTimeout(timer)
  }, [draftReady, projectId, name, segments, pitchNotes, crossfadeMs, tempoBpm, beatsPerBar, beatDivision, gridOffsetUnits, compositionId, parentId, parentUpdatedAt, legacyMode, legacySchemaVersion, history])

  useEffect(() => () => {
    previewController.current?.abort()
    if (previewUrl) URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  useEffect(() => () => {
    previewController.current?.abort()
    autotuneController.current?.abort()
    exportController.current?.abort()
    exportController.current = null
    previewIntent.current = null
    renderPromise.current = null
    if (previewTaskId.current) finishTask(previewTaskId.current)
    previewTaskId.current = null
  }, [])

  const applyParent = (nextParent: CompositionProject) => {
    explicitParentRouteRef.current = true
    setEditorDocumentRevision((current) => current + 1)
    setStep(PROFESSIONAL_STEP_TIMING)
    const nextSegments = deriveProfessionalSegments(nextParent.segments)
    setLegacyMode(false)
    setCompositionId("")
    setParentId(nextParent.composition_id)
    setParentUpdatedAt(nextParent.updated_at)
    setName(`${nextParent.name} (전문)`)
    setCrossfadeMs(nextParent.crossfade_ms)
    setTempoBpm(PROFESSIONAL_TEMPO_DEFAULT_BPM); setBeatsPerBar(PROFESSIONAL_BEATS_PER_BAR_DEFAULT); setBeatDivision(PROFESSIONAL_BEAT_DIVISION_DEFAULT); setGridOffsetUnits(PROFESSIONAL_GRID_OFFSET_UNITS_DEFAULT)
    setSegments(nextSegments)
    setPitchNotes([])
    resetHistory({ name: `${nextParent.name} (전문)`, segments: nextSegments, pitchNotes: [], crossfadeMs: nextParent.crossfade_ms, tempoBpm: PROFESSIONAL_TEMPO_DEFAULT_BPM, beatsPerBar: PROFESSIONAL_BEATS_PER_BAR_DEFAULT, beatDivision: PROFESSIONAL_BEAT_DIVISION_DEFAULT, gridOffsetUnits: PROFESSIONAL_GRID_OFFSET_UNITS_DEFAULT })
    setSelectedSegmentId(nextSegments[0]?.segment_id ?? "")
    setPlayheadMs(0)
    setMessage("원본 단순 합성에서 전문 편집용 본을 만들었습니다.")
  }

  const applyProfessional = (composition: CompositionProject) => {
    explicitParentRouteRef.current = false
    setEditorDocumentRevision((current) => current + 1)
    setStep(PROFESSIONAL_STEP_TIMING)
    const legacy = composition.mode === "PROFESSIONAL" && composition.segments.some((segment) => !segment.edit_regions.length)
    setLegacyMode(legacy)
    setLegacySchemaVersion(composition.schema_version)
    setCompositionId(composition.composition_id)
    setParentId(composition.parent_composition_id ?? "")
    setParentUpdatedAt(composition.parent_composition_updated_at ?? "")
    setName(composition.name)
    setCrossfadeMs(composition.crossfade_ms)
    setPitchNotes(composition.pitch_notes ?? [])
    setTempoBpm(composition.tempo_bpm ?? PROFESSIONAL_TEMPO_DEFAULT_BPM); setBeatsPerBar(composition.beats_per_bar ?? PROFESSIONAL_BEATS_PER_BAR_DEFAULT); setBeatDivision(composition.beat_division ?? PROFESSIONAL_BEAT_DIVISION_DEFAULT); setGridOffsetUnits(composition.grid_offset_units ?? PROFESSIONAL_GRID_OFFSET_UNITS_DEFAULT)
    setSegments(legacy ? composition.segments : retimeCompositionSegments(composition.segments.map((segment) => ({
      ...segment,
      volume_envelope: segment.volume_envelope.length ? segment.volume_envelope : PROFESSIONAL_ENVELOPE_DEFAULT,
    })), "PROFESSIONAL"))
    resetHistory({ name: composition.name, segments: legacy ? composition.segments : deriveProfessionalSegments(composition.segments), pitchNotes: composition.pitch_notes ?? [], crossfadeMs: composition.crossfade_ms, tempoBpm: composition.tempo_bpm ?? PROFESSIONAL_TEMPO_DEFAULT_BPM, beatsPerBar: composition.beats_per_bar ?? PROFESSIONAL_BEATS_PER_BAR_DEFAULT, beatDivision: composition.beat_division ?? PROFESSIONAL_BEAT_DIVISION_DEFAULT, gridOffsetUnits: composition.grid_offset_units ?? PROFESSIONAL_GRID_OFFSET_UNITS_DEFAULT })
    setSelectedSegmentId(composition.segments[0]?.segment_id ?? "")
    setPlayheadMs(0)
    setMessage(`전문 합성을 불러왔습니다. · ${composition.updated_at}`)
  }

  const buildRequest = (): SaveCompositionRequest => ({
    name,
    target_text: parent?.target_text ?? "",
    target_pronunciation: parent?.target_pronunciation ?? "",
    crossfade_ms: crossfadeMs,
    segments,
    tempo_bpm: tempoBpm,
    beats_per_bar: beatsPerBar,
    beat_division: beatDivision,
    grid_offset_units: gridOffsetUnits,
    pitch_notes: pitchNotes,
    mode: "PROFESSIONAL",
    schema_version: legacyMode ? legacySchemaVersion : PROFESSIONAL_COMPOSITION_SCHEMA_VERSION,
    parent_composition_id: parentId || null,
    parent_composition_updated_at: parentUpdatedAt || null,
  })

  const buildPreviewRequest = (mode: PianoRollAuditionMode): SaveCompositionRequest => {
    const body = buildRequest()
    if (mode !== "original") return body
    return {
      ...body,
      pitch_notes: [],
      segments: body.segments.map((segment) => ({
        ...segment,
        pitch_envelope: [],
        edit_regions: segment.edit_regions.map((region) => ({ ...region, relative_pitch_cents: 0, pitch_points: [], source_f0_hz: null })),
        phone_units: segment.phone_units.map((phone) => ({ ...phone, target_pitch_midi: null, pitch_points: [], pitch_owner_ref: null, vibrato_depth_cents: 0 })),
      })),
    }
  }

  const signature = JSON.stringify(buildRequest())
  currentSignature.current = signature
  const renderSignature = JSON.stringify([signature, auditionMode])
  currentRenderSignature.current = renderSignature
  const requestRef = useRef(buildRequest())
  requestRef.current = buildPreviewRequest(auditionMode)
  const autotuneSnapshotRef = useRef({ projectId, compositionId, parentId, signature, settings: autotuneSettings })
  autotuneSnapshotRef.current = { projectId, compositionId, parentId, signature, settings: autotuneSettings }

  useEffect(() => {
    autotuneController.current?.abort()
  }, [projectId, compositionId, parentId, signature, autotuneSettings])

  const reload = async (): Promise<void> => {
    setCompositions(await fetchCompositions(projectId))
  }

  const persist = async (): Promise<CompositionProject> => {
    const saved = compositionId
      ? await updateComposition(compositionId, buildRequest())
      : await createComposition(projectId, buildRequest())
    setCompositionId(saved.composition_id)
    setParentUpdatedAt(saved.parent_composition_updated_at ?? "")
    setLegacySchemaVersion(saved.schema_version)
    draftMetaRef.current = { ...draftMetaRef.current, compositionId: saved.composition_id, parentUpdatedAt: saved.parent_composition_updated_at ?? "" }
    setCompositions((current) => [saved, ...current.filter((item) => item.composition_id !== saved.composition_id)])
    return saved
  }

  const refreshList = async () => {
    await reload()
    listRefreshFailedRef.current = false
    setListRefreshFailed(false)
  }

  const save = async () => {
    if (historyRef.current.gestureBaseline) return
    const taskId = beginTask({ label: "전문 합성 저장", stage: "저장 중" })
    if (!taskId) return
    setBusy(true)
    setMessage("")
    try {
      const saved = await persist()
      try {
        await refreshList()
        setMessage(`전문 합성을 저장했습니다. ${saved.composition_id}`)
      } catch (error) {
        listRefreshFailedRef.current = true
        setListRefreshFailed(true)
        setMessage(`전문 합성을 저장했습니다. ${saved.composition_id}. 목록 새로고침 실패: ${error instanceof Error ? error.message : String(error)}`)
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
      finishTask(taskId)
    }
  }

  const applyAutotune = async () => {
    if (historyRef.current.gestureBaseline || busy || !parent || dependencyChanged || legacyMode || !segments.length) return
    const taskId = beginTask({ label: "자동 음정 보정", stage: "음정 보정 중" })
    if (!taskId) return
    const controller = new AbortController()
    autotuneController.current?.abort()
    autotuneController.current = controller
    const captured = autotuneSnapshotRef.current
    const capturedSettings = { ...captured.settings }
    setBusy(true)
    setMessage("")
    try {
      const result = await autotuneComposition(projectId, {
        composition: buildRequest(),
        strength_percent: capturedSettings.strength_percent,
        speed_ms: capturedSettings.speed_ms,
      }, controller.signal)
      if (controller.signal.aborted) return
      const latest = autotuneSnapshotRef.current
      if (
        captured.signature !== currentSignature.current
        || captured.projectId !== latest.projectId
        || captured.compositionId !== latest.compositionId
        || captured.parentId !== latest.parentId
        || capturedSettings.strength_percent !== latest.settings.strength_percent
        || capturedSettings.speed_ms !== latest.settings.speed_ms
      ) {
        setMessage("편집 내용이 바뀐 결과 보정을 적용하지 않았습니다.")
        return
      }
      const sourceSegments = new Map(segments.map((segment) => [segment.segment_id, segment]))
      const responseRegions = new Map<string, EditRegion[]>()
      const seenSegments = new Set<string>()
      const validPoints = (points: PhonePitchPoint[]) => {
        if (!points.length) return true
        if (points.length < 2 || points[0]?.position !== 0 || points.at(-1)?.position !== 1) return false
        let previous = -1
        for (const point of points) {
          if (!point || !Number.isFinite(point.position) || point.position < 0 || point.position > 1 || point.position <= previous || !Number.isFinite(point.midi) || point.midi < PITCH_MIN_MIDI || point.midi > PITCH_MAX_MIDI) return false
          previous = point.position
        }
        return true
      }
      if (!Array.isArray(result.segments) || result.segments.length !== segments.length) throw new Error("Autotune result does not match the current segments.")
      for (const item of result.segments) {
        const source = item && sourceSegments.get(item.segment_id)
        if (!item || !source || seenSegments.has(item.segment_id) || !Array.isArray(item.edit_regions) || item.edit_regions.length !== source.edit_regions.length) throw new Error("Autotune result does not match the current regions.")
        const sourceRegions = new Map(source.edit_regions.map((region) => [region.region_id, region]))
        const seenRegions = new Set<string>()
        for (const region of item.edit_regions) {
          const original = region && source.edit_regions.find((sourceRegion, index) => sourceRegion.region_id === region.region_id && index === seenRegions.size)
          if (!original || seenRegions.has(region.region_id) || region.source_start_ms !== original.source_start_ms || region.source_end_ms !== original.source_end_ms || region.output_duration_ms !== original.output_duration_ms || region.relative_pitch_cents !== original.relative_pitch_cents || !Array.isArray(region.pitch_points) || !validPoints(region.pitch_points)) throw new Error("Autotune returned invalid region boundaries or pitch points.")
          if (region.source_f0_hz != null && (!Number.isFinite(region.source_f0_hz) || region.source_f0_hz <= 0)) throw new Error("Autotune returned an invalid source pitch.")
          seenRegions.add(region.region_id)
        }
        responseRegions.set(item.segment_id, item.edit_regions)
        seenSegments.add(item.segment_id)
      }
      editSegments((current) => current.map((segment) => ({
        ...segment,
        pitch_envelope: [],
        edit_regions: responseRegions.get(segment.segment_id) ?? segment.edit_regions,
        phone_units: segment.phone_units.map((phone) => ({ ...phone, pitch_points: [], pitch_owner_ref: null })),
      })))
      setMessage("\uC790\uB3D9 \uBCF4\uC815 \uACE1\uC120\uC744 \uC801\uC6A9\uD588\uC2B5\uB2C8\uB2E4. \uD53C\uC544\uB178 \uB864\uC5D0\uC11C \uC74C\uC808\uBCC4 \uBAA9\uD45C \uC74C\uD45C\uB97C \uD655\uC778\uD558\uACE0 \uD3B8\uC9D1\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.")
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      if (autotuneController.current === controller) autotuneController.current = null
      setBusy(false)
      finishTask(taskId)
    }
  }

  const renderPreview = (intent: ProfessionalPreviewIntent): Promise<void> => {
    if (historyRef.current.gestureBaseline) return Promise.resolve()
    if (renderPromise.current) {
      previewIntent.current = intent
      return renderPromise.current
    }
    if (!previewTaskId.current) {
      const taskId = beginTask({ label: "전문 합성 미리보기", stage: "미리보기 생성 중" })
      if (!taskId) return Promise.resolve()
      previewTaskId.current = taskId
    }
    previewController.current?.abort()
    const controller = new AbortController()
    previewController.current = controller
    previewIntent.current = intent
    setBusy(true)
    setMessage("")
    const requestSignature = currentRenderSignature.current
    let stale = false
    const pending = (async () => {
      try {
        const blob = await previewComposition(projectId, requestRef.current, controller.signal)
        if (!controller.signal.aborted && requestSignature === currentRenderSignature.current) {
          previewSignature.current = requestSignature
          setPreviewUrl(URL.createObjectURL(blob))
        } else if (!controller.signal.aborted) stale = true
      } catch (error) {
        if (!controller.signal.aborted) { previewIntent.current = null; setMessage(error instanceof Error ? error.message : String(error)) }
      } finally {
        if (previewController.current === controller) {
          previewController.current = null
          renderPromise.current = null
          const intent = previewIntent.current
          if (stale && intent) void renderPreview(intent)
          else {
            setBusy(false)
            const taskId = previewTaskId.current
            previewTaskId.current = null
            if (taskId) finishTask(taskId)
          }
        }
      }
    })()
    renderPromise.current = pending
    return pending
  }

  const transport = (timeMs: number, autoplay: boolean) => {
    if (historyRef.current.gestureBaseline) return
    if (renderPromise.current) {
      previewIntent.current = { timeMs, autoplay }
      return
    }
    const audio = audioRef.current
    if (previewUrl && previewSignature.current === currentRenderSignature.current) {
      if (!audio || !Number.isFinite(audio.duration)) {
        previewIntent.current = { timeMs, autoplay }
        return
      }
      previewIntent.current = null
      audio.pause()
      audio.currentTime = Math.max(0, Math.min(audio.duration, timeMs / 1000))
      setPlayheadMs(audio.currentTime * 1000)
      if (autoplay) void audio.play().catch((error: Error) => setMessage(error.message))
      return
    }
    void renderPreview({ timeMs, autoplay })
  }

  const pendingAuditionIntent = useRef<ProfessionalPreviewIntent | null>(null)
  const changeAuditionMode = (mode: PianoRollAuditionMode) => {
    if (historyRef.current.gestureBaseline) return
    if (mode === auditionMode) return
    const audio = audioRef.current
    const autoplay = Boolean(audio && !audio.paused)
    audio?.pause()
    pendingAuditionIntent.current = { timeMs: playheadMs, autoplay }
    setAuditionMode(mode)
  }

  useEffect(() => {
    const intent = pendingAuditionIntent.current
    if (!intent) return
    pendingAuditionIntent.current = null
    transport(intent.timeMs, intent.autoplay)
  }, [auditionMode, renderSignature])

  const togglePlayback = () => {
    const audio = audioRef.current
    if (audio && !audio.paused) {
      audio.pause()
      setIsPlaying(false)
      return
    }
    const range = loopRangeRef.current
    const startMs = loopEnabledRef.current && range && (playheadMs < range.startMs || playheadMs >= range.endMs)
      ? range.startMs
      : playheadMs
    transport(startMs, true)
  }

  useEffect(() => {
    if (!isPlaying) return
    let frame = 0
    const monitor = () => {
      const audio = audioRef.current
      const range = loopRangeRef.current
      if (audio && loopEnabledRef.current && range && audio.currentTime * 1_000 >= range.endMs) {
        audio.currentTime = Math.max(0, range.startMs) / 1_000
        loopSeekRef.current = true
      }
      frame = requestAnimationFrame(monitor)
    }
    frame = requestAnimationFrame(monitor)
    return () => cancelAnimationFrame(frame)
  }, [isPlaying, loopEnabled, loopRange])

  const preview = () => {
    if (historyRef.current.gestureBaseline) return
    transport(0, true)
  }

  useEffect(() => {
    const isEditableInput = (target: EventTarget | null): target is HTMLElement => (
      target instanceof HTMLElement
      && (target.isContentEditable || ["INPUT", "TEXTAREA"].includes(target.tagName))
    )
    const onInputCapture = (event: Event) => {
      if (!isEditableInput(event.target)) return
      inputDispatchTarget.current = event.target
      queueMicrotask(() => {
        if (inputDispatchTarget.current === event.target) inputDispatchTarget.current = null
      })
    }
    const onInput = (event: Event) => {
      if (!isEditableInput(event.target)) return
      lastEditInput.current = event.target
      if (inputDispatchTarget.current === event.target) inputDispatchTarget.current = null
    }
    window.addEventListener("input", onInputCapture, true)
    window.addEventListener("input", onInput)
    return () => {
      window.removeEventListener("input", onInputCapture, true)
      window.removeEventListener("input", onInput)
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat || event.altKey) return
      const saveShortcut = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "s"
      const undo = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z"
      const redo = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y"
      if (history.gestureBaseline) {
        if (saveShortcut || undo || redo || event.code === "Space") event.preventDefault()
        return
      }
      if (isTaskActive()) return
      if (saveShortcut) {
        event.preventDefault()
        if (!busy && parent && !dependencyChanged) void save()
        return
      }
      const target = event.target
      const isEditableInput = target instanceof HTMLElement
        && (target.isContentEditable || ["INPUT", "TEXTAREA"].includes(target.tagName))
      if (isEditableInput && target === lastEditInput.current && (undo || redo)) return
      if (undo || redo) {
        event.preventDefault()
        if (history.gestureBaseline) return
        previewController.current?.abort(); previewController.current = null; renderPromise.current = null; previewIntent.current = null; setBusy(false)
        audioRef.current?.pause()
        dispatchHistory({ type: undo ? "undo" : "redo" })
        return
      }
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return
      if (event.code !== "Space" || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return
      event.preventDefault()
      if (event.shiftKey) { transport(0, true); return }
      if (renderPromise.current) {
        previewIntent.current = previewIntent.current?.autoplay
          ? { timeMs: playheadMs, autoplay: false }
          : { timeMs: playheadMs, autoplay: true }
        return
      }
      const audio = audioRef.current
      if (audio && !audio.paused) { previewIntent.current = null; audio.pause(); return }
      transport(playheadMs, true)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [playheadMs, previewUrl, signature, history.gestureBaseline, busy, parent, dependencyChanged, save, name, compositionId, isTaskActive])

  useEffect(() => {
    const restored = history.present
    editableRef.current = restored
    setName(restored.name); setSegments(restored.segments); setPitchNotes(restored.pitchNotes ?? []); setCrossfadeMs(restored.crossfadeMs); setTempoBpm(restored.tempoBpm)
    setBeatsPerBar(restored.beatsPerBar); setBeatDivision(restored.beatDivision); setGridOffsetUnits(restored.gridOffsetUnits)
    setLegacyMode(restored.segments.some((segment) => !segment.edit_regions.length))
    setSelectedSegmentId((current) => restored.segments.some((segment) => segment.segment_id === current) ? current : restored.segments[0]?.segment_id ?? "")
  }, [history.present])

  const runExport = async (target: ExportTarget) => {
    if (historyRef.current.gestureBaseline) return
    const taskId = beginTask({ label: `${target} 전문 내보내기`, stage: "합성 저장 중" })
    if (!taskId) return
    const controller = new AbortController()
    exportController.current?.abort()
    exportController.current = controller
    setBusy(true)
    setMessage("")
    setExportProgress(null)
    try {
      const saved = await persist()
      if (controller.signal.aborted || currentProjectId.current !== projectId) return
      try { await refreshList() } catch {
        listRefreshFailedRef.current = true
        setListRefreshFailed(true)
        setMessage(`전문 합성을 저장했습니다. ${saved.composition_id}. 목록 새로고침 실패`)
      }
      updateTask(taskId, { stage: `${target} 내보내기`, percent: null })
      await exportComposition(saved.composition_id, target, (job) => {
        if (exportController.current === controller && currentProjectId.current === projectId) {
          setExportProgress(job)
          updateTask(taskId, { stage: remoteTaskStage(job.stage), percent: job.percent })
        }
      }, controller.signal, {
        kind: "export",
        project_id: projectId,
        composition_id: saved.composition_id,
        target,
        label: `${target} 전문 내보내기`,
      }, (stage, percent) => updateTask(taskId, percent === undefined ? { stage } : { stage, percent }))
      if (listRefreshFailedRef.current) setMessage(`내보내기를 완료했습니다. 목록 새로고침은 실패했습니다.`)
      else setMessage(`${target} 내보내기를 완료했습니다.`)
    } catch (error) {
      if (!controller.signal.aborted && currentProjectId.current === projectId) {
        setExportProgress(null)
        setMessage(error instanceof Error ? error.message : String(error))
      }
    } finally {
      const isCurrentExport = exportController.current === controller && currentProjectId.current === projectId
      if (exportController.current === controller) exportController.current = null
      if (isCurrentExport) setBusy(false)
      finishTask(taskId)
    }
  }

  const updatePhone = (segmentId: string, phoneUnitId: string, updates: Partial<PhoneUnit>) => {
    editSegments((current) => retimeCompositionSegments(current.map((segment) => (
      segment.segment_id === segmentId
        ? {
            ...segment,
            phone_units: segment.phone_units.map((unit) => unit.phone_unit_id === phoneUnitId ? { ...unit, ...updates } : unit),
          }
        : segment
    )), "PROFESSIONAL"))
  }

  const updatePhones = (phones: PianoRollPhoneRef[], updates: Partial<PhoneUnit>) => {
    const selected = new Set(phones.map((phone) => `${phone.segmentId}${PIANO_ROLL_SELECTED_PHONE_SEPARATOR}${phone.phoneUnitId}`))
    editSegments((current) => retimeCompositionSegments(current.map((segment) => ({
      ...segment,
      phone_units: segment.phone_units.map((phone) => selected.has(`${segment.segment_id}${PIANO_ROLL_SELECTED_PHONE_SEPARATOR}${phone.phone_unit_id}`)
        ? { ...phone, ...updates }
        : phone),
    })), "PROFESSIONAL"))
  }

  const updatePhoneDurations = (phones: PianoRollPhoneRef[], durationMs: number) => {
    editSegments((current) => phones.reduce((next, phone) => resizePhoneOutputDuration(next, phone.segmentId, phone.phoneUnitId, durationMs), current))
  }

  const updateRegion = (segmentId: string, regionId: string, updates: Partial<EditRegion>) => {
    editSegments((current) => {
      if (updates.source_start_ms !== undefined || updates.source_end_ms !== undefined) {
        const segment = current.find((item) => item.segment_id === segmentId)
        if (!segment) return current
        const index = segment.edit_regions.findIndex((item) => item.region_id === regionId)
        const oldBoundary = updates.source_start_ms !== undefined
          ? segment.edit_regions[index]?.source_start_ms
          : segment.edit_regions[index + 1]?.source_start_ms
        const changed = changeRegionBoundary(current, segmentId, regionId, updates.source_start_ms !== undefined ? "source_start_ms" : "source_end_ms", updates.source_start_ms ?? updates.source_end_ms!)
        const nextSegment = changed.find((item) => item.segment_id === segmentId)
        const nextBoundary = nextSegment?.edit_regions[index + 1]?.source_start_ms
        if (oldBoundary === undefined || nextBoundary === undefined || oldBoundary === nextBoundary || !(segment.user_guide_source_ms ?? []).includes(oldBoundary)) return changed
        return changed.map((item) => item.segment_id === segmentId ? { ...item, user_guide_source_ms: (item.user_guide_source_ms ?? []).map((sourceMs) => sourceMs === oldBoundary ? nextBoundary : sourceMs) } : item)
      }
      return updateEditRegion(current, segmentId, regionId, updates)
    })
  }

  const applyRange = (segmentId: string, startMs: number, endMs: number, updates: Partial<EditRegion>) => {
    editSegments((current) => {
      const before = current.find((segment) => segment.segment_id === segmentId)
      const changed = updateSelectedRange(current, segmentId, startMs, endMs, updates)
      const after = changed.find((segment) => segment.segment_id === segmentId)
      if (!before || !after) return changed
      return changed.map((segment) => segment.segment_id === segmentId ? {
        ...segment,
        volume_envelope: warpEnvelopeForRegionDurations(before.volume_envelope, before.edit_regions, after.edit_regions),
        pitch_envelope: segment.pitch_envelope ? warpEnvelopeForRegionDurations(segment.pitch_envelope, before.edit_regions, after.edit_regions) : undefined,
      } : segment)
    })
  }

  const addGuide = (segmentId: string, sourceMs: number) => editSegments((current) => current.map((segment) => {
    if (segment.segment_id !== segmentId) return segment
    const marker = Math.trunc(sourceMs)
    const edit_regions = splitEditRegions(segment.edit_regions, marker, marker)
    if (!edit_regions.some((region, index) => index > 0 && region.source_start_ms === marker)) return segment
    return { ...segment, user_guide_source_ms: [...new Set([...(segment.user_guide_source_ms ?? []), marker])], edit_regions }
  }))

  const removeGuide = (segmentId: string, regionId: string) => editSegments((current) => current.map((segment) => {
    if (segment.segment_id !== segmentId) return segment
    const index = segment.edit_regions.findIndex((region) => region.region_id === regionId)
    if (index <= 0) return segment
    const merged = [...segment.edit_regions]
    const left = merged[index - 1]
    const right = merged[index]
    const removed = right.source_start_ms
    const generatedPhoneBoundary = segment.phone_units.some((unit) => unit.source_start_ms === removed)
    if (generatedPhoneBoundary) return { ...segment, user_guide_source_ms: (segment.user_guide_source_ms ?? []).filter((sourceMs) => sourceMs !== removed) }
    merged.splice(index - 1, 2, { ...left, source_end_ms: right.source_end_ms, output_duration_ms: left.output_duration_ms + right.output_duration_ms, pitch_points: mergeRegionPitchPoints(left, right), source_f0_hz: left.source_f0_hz ?? right.source_f0_hz ?? null })
    return { ...segment, user_guide_source_ms: (segment.user_guide_source_ms ?? []).filter((sourceMs) => sourceMs !== removed), edit_regions: merged }
  }))

  const updateEnvelope = (segmentId: string, points: VolumeEnvelopePoint[]) => {
    editSegments((current) => current.map((segment) => segment.segment_id === segmentId ? { ...segment, volume_envelope: points } : segment))
  }

  const updatePitchEnvelope = (segmentId: string, points: PitchEnvelopePoint[]) => {
    editSegments((current) => current.map((segment) => segment.segment_id === segmentId ? { ...segment, pitch_envelope: points } : segment))
  }

  const updateRegionPitchPoints = (segmentId: string, regionId: string, points: PhonePitchPoint[]) => {
    editSegments((current) => current.map((segment) => segment.segment_id === segmentId ? { ...segment, edit_regions: segment.edit_regions.map((region) => region.region_id === regionId ? { ...region, pitch_points: points } : region) } : segment))
  }

  const updateRegionRangePitchPoints = (view: PianoRollRegionView, points: PhonePitchPoint[]) => {
    let applied = false
    editSegments((current) => {
      const next = setRegionRangePitchPoints(current, view, points)
      if (next) applied = true
      return next ?? current
    })
    return applied
  }

  const updatePitchNotes = (next: PianoRollPitchNote[]) => applyEdit({ ...editableRef.current, pitchNotes: next })

  const updateSyllablePitch = (group: PianoRollSyllableGroup, midi: number | null) => {
    let applied = false
    editSegments((current) => {
      const next = setSyllablePitch(current, group, midi)
      if (next) applied = true
      return next ?? current
    })
    return applied
  }

  const updateSegment = (segmentId: string, updates: Partial<TimelineSegment>) => {
    editSegments((current) => retimeCompositionSegments(current.map((segment) => {
      if (segment.segment_id !== segmentId) return segment
      const phoneUnits = [...segment.phone_units]
      if (updates.source_start_ms !== undefined && phoneUnits[0]?.source_start_ms !== null) {
        phoneUnits[0] = { ...phoneUnits[0], source_start_ms: updates.source_start_ms }
      }
      if (updates.source_end_ms !== undefined && phoneUnits.at(-1)?.source_end_ms !== null) {
        const last = phoneUnits.length - 1
        phoneUnits[last] = { ...phoneUnits[last], source_end_ms: updates.source_end_ms }
      }
      return { ...segment, ...updates, phone_units: phoneUnits }
    }), "PROFESSIONAL"))
  }

  const applyHandleDrag = (original: TimelineSegment, startMs: number, durations: number[]) => {
    editSegments((current) => applyProfessionalHandleDrag(current, original, startMs, durations))
  }

  const moveTimelineSuffix = (original: TimelineSegment[], segmentId: string, deltaMs: number) => {
    editSegments((current) => moveProfessionalTimelineSuffix(current, original, segmentId, deltaMs))
  }

  const changeOrder = (segmentId: string, offset: number) => {
    editSegments((current) => {
      const index = current.findIndex((segment) => segment.segment_id === segmentId)
      const destination = index + offset
      if (index < 0 || destination < 0 || destination >= current.length) return current
      const next = [...current]
      ;[next[index], next[destination]] = [next[destination], next[index]]
      return retimeCompositionSegments(next, "PROFESSIONAL")
    })
  }

  return (
    <section className={`professional-page ${!legacyMode ? "piano-roll-active" : ""} ${step === PROFESSIONAL_STEP_CORRECTION && !legacyMode ? "piano-roll-correction-active" : ""}`}>
      <div className="professional-toolbar panel">
        <div className="professional-file-controls">
          <label className="control-field">
            <span>단순 합성 선택</span>
            <select value={parentId} onChange={(event) => {
              const nextParent = simpleCompositions.find((item) => item.composition_id === event.target.value)
              if (nextParent) applyParent(nextParent)
            }}>
              <option value="">단순 합성을 선택하세요</option>
              {simpleCompositions.map((item) => <option key={item.composition_id} value={item.composition_id}>{item.name}</option>)}
            </select>
          </label>
          <label className="control-field">
            <span>전문 합성 선택</span>
            <select value={compositionId} onChange={(event) => {
              const selected = professionalCompositions.find((item) => item.composition_id === event.target.value)
              if (selected) applyProfessional(selected)
            }}>
              <option value="">전문 합성을 선택하세요</option>
              {professionalCompositions.map((item) => <option key={item.composition_id} value={item.composition_id}>{item.name}</option>)}
            </select>
          </label>
          <label className="control-field professional-name-field">
            <span>이름</span>
            <input value={name} onChange={(event) => applyEdit({ ...editableRef.current, name: event.target.value })} />
          </label>
        </div>
        <div className="professional-actions">
          {dependencyChanged && parent && <button onClick={() => applyParent(parent)}>원본 변경사항 적용</button>}
          <button disabled={busy || Boolean(history.gestureBaseline) || !parent || dependencyChanged} onClick={() => void preview()}>미리 듣기</button>
          <button className="primary-action" disabled={busy || Boolean(history.gestureBaseline) || !parent || dependencyChanged} onClick={() => void save()}>전문 합성 저장</button>
        </div>
      </div>

      <div className={`dependency-bar ${dependencyChanged ? "stale" : ""}`}>
        <strong>{dependencyChanged ? "원본 변경됨" : "원본 연결 안정"}</strong>
        <span>{parent ? `${parent.name} · ${parent.updated_at}` : "저장된 단순 합성을 선택하세요"}</span>
      </div>

      <nav className="professional-step-nav" aria-label="전문 편집 단계">
        <button className={step === PROFESSIONAL_STEP_TIMING ? "active" : ""} aria-current={step === PROFESSIONAL_STEP_TIMING ? "step" : undefined} onClick={() => setStep(PROFESSIONAL_STEP_TIMING)}>1. 배치 · 자르기 · 길이 조정</button>
        <button className={step === PROFESSIONAL_STEP_CORRECTION ? "active" : ""} aria-current={step === PROFESSIONAL_STEP_CORRECTION ? "step" : undefined} disabled={!parent || !segments.length || legacyMode} onClick={() => setStep(PROFESSIONAL_STEP_CORRECTION)}>2. 음정 · 음량 보정</button>
      </nav>

      {legacyMode && <div className="legacy-editor-notice"><strong>기존 편집 형식</strong><span>기존 음소 설정을 유지합니다. 구간 형식으로 변환하면 음소별 설정은 초기화됩니다.</span><button onClick={() => { editSegments(() => deriveProfessionalSegments(segments)); setLegacyMode(false); setMessage("구간 편집으로 변환했습니다.") }}>구간 편집으로 변환</button></div>}

      {!legacyMode && <section className={`professional-autotune panel ${step === PROFESSIONAL_STEP_TIMING ? "placeholder" : ""}`} aria-hidden={step !== PROFESSIONAL_STEP_CORRECTION} inert={step !== PROFESSIONAL_STEP_CORRECTION} aria-label="자동 음정 보정">
        <div className="professional-autotune-copy">
          <strong>자동 음정 보정</strong>
          <span>원음에 가까운 반음으로 맞춘 곡선을 만든 뒤 직접 다듬을 수 있습니다.</span>
        </div>
        <label>보정 강도 (%)<input aria-label="자동 보정 강도" disabled={step !== PROFESSIONAL_STEP_CORRECTION} type="number" min="0" max="100" step="1" value={autotuneSettings.strength_percent} onChange={(event) => {
          const value = Number(event.target.value)
          if (Number.isFinite(value)) setAutotuneSettings((current) => ({ ...current, strength_percent: Math.max(0, Math.min(100, Math.trunc(value))) }))
        }}/></label>
        <label>보정 속도 (ms)<input aria-label="자동 보정 속도" disabled={step !== PROFESSIONAL_STEP_CORRECTION} type="number" min="0" step="1" value={autotuneSettings.speed_ms} onChange={(event) => {
          const value = Number(event.target.value)
          if (Number.isFinite(value)) setAutotuneSettings((current) => ({ ...current, speed_ms: Math.max(0, Math.trunc(value)) }))
        }}/></label>
        <button className="primary-action" disabled={busy || Boolean(history.gestureBaseline) || !parent || dependencyChanged || !segments.length || legacyMode || step !== PROFESSIONAL_STEP_CORRECTION} onClick={() => void applyAutotune()}>자동 보정 적용</button>
        <small>적용하면 현재 음정 곡선을 교체하고 음량 곡선은 유지합니다. 속도 0ms는 즉시 보정합니다.</small>
      </section>}

      {previewUrl && <audio
        ref={audioRef}
        className="professional-preview"
        src={previewUrl}
        controls
        onCanPlay={(event) => {
          const intent = previewIntent.current
          if (!intent || previewSignature.current !== currentRenderSignature.current) return
          previewIntent.current = null
          event.currentTarget.currentTime = Math.max(0, Math.min(event.currentTarget.duration || 0, intent.timeMs / 1000))
          setPlayheadMs(event.currentTarget.currentTime * 1000)
          if (intent.autoplay) void event.currentTarget.play().catch((error: Error) => setMessage(error.message))
        }}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          const range = loopRangeRef.current
          if (!loopEnabledRef.current || !range || !audioRef.current) return
          audioRef.current.currentTime = range.startMs / 1_000
          void audioRef.current.play().catch((error: Error) => setMessage(error.message))
        }}
        onTimeUpdate={(event) => {
          const audio = event.currentTarget
          setPlayheadMs(audio.currentTime * 1_000)
          const range = loopRangeRef.current
          if (loopEnabledRef.current && range && !loopSeekRef.current && audio.currentTime * 1_000 >= range.endMs) {
            loopSeekRef.current = true
            audio.currentTime = range.startMs / 1_000
          } else if (loopSeekRef.current && range && audio.currentTime * 1_000 < range.endMs) loopSeekRef.current = false
        }}
        onSeeked={(event) => setPlayheadMs(event.currentTarget.currentTime * 1000)}
      />}

      {parent && segments.length && !legacyMode ? <><ProfessionalEditor
        key={`${projectId}:${editorDocumentRevision}`}
        visible={step === PROFESSIONAL_STEP_TIMING}
        step={PROFESSIONAL_STEP_TIMING}
        projectId={projectId}
        segments={segments}
        selectedSegmentId={selectedSegmentId}
        playheadMs={playheadMs}
        tempoBpm={tempoBpm} beatsPerBar={beatsPerBar} beatDivision={beatDivision}
        gridOffsetUnits={gridOffsetUnits}
        onTempoChange={(value) => applyEdit({ ...editableRef.current, tempoBpm: value })} onBeatsPerBarChange={(value) => applyEdit({ ...editableRef.current, beatsPerBar: value })} onBeatDivisionChange={(value) => applyEdit({ ...editableRef.current, beatDivision: value })}
        onGridOffsetChange={(value) => applyEdit({ ...editableRef.current, gridOffsetUnits: value })}
        onSelectSegment={setSelectedSegmentId}
        onPlayheadChange={(timeMs) => {
          previewIntent.current = null
          audioRef.current?.pause()
          setPlayheadMs(timeMs)
          if (audioRef.current && Number.isFinite(audioRef.current.duration)) {
            audioRef.current.currentTime = Math.max(0, Math.min(audioRef.current.duration, timeMs / 1000))
          }
        }}
        onUpdatePhone={updatePhone}
        onUpdateRegion={updateRegion}
        onApplyRange={applyRange}
        onApplyHandleDrag={applyHandleDrag}
        onMoveTimelineSuffix={moveTimelineSuffix}
        onBeginGesture={() => dispatchHistory({ type: "begin-gesture" })}
        onEndGesture={() => dispatchHistory({ type: "end-gesture" })}
        onAddGuide={addGuide}
        onRemoveGuide={removeGuide}
        onUpdateEnvelope={updateEnvelope}
        onUpdatePitchEnvelope={updatePitchEnvelope}
        onUpdateSegment={updateSegment}
        onReorderSegment={(sourceId, destinationId) => editSegments((current) => (
          retimeCompositionSegments(reorderSegments(current, sourceId, destinationId), "PROFESSIONAL")
        ))}
        onChangeOrder={changeOrder}
        onDeleteSegment={(segmentId) => editSegments((current) => {
          const next = retimeCompositionSegments(
            current.filter((segment) => segment.segment_id !== segmentId),
            "PROFESSIONAL",
          )
          setSelectedSegmentId(next[0]?.segment_id ?? "")
          return next
        })}
      /><PianoRollEditor
        key={`piano:${projectId}:${editorDocumentRevision}`}
        visible={step === PROFESSIONAL_STEP_CORRECTION}
        analysisHold={Boolean(history.gestureBaseline)}
        projectId={projectId}
        request={buildRequest()}
        segments={segments}
        pitchNotes={pitchNotes}
        tempoBpm={tempoBpm}
        beatsPerBar={beatsPerBar}
        beatDivision={beatDivision}
        gridOffsetUnits={gridOffsetUnits}
        selectedSegmentId={selectedSegmentId}
        playheadMs={playheadMs}
        isPlaying={isPlaying}
        loopEnabled={loopEnabled}
        auditionMode={auditionMode}
        onPlayheadChange={(timeMs) => {
          previewIntent.current = null
          if (audioRef.current && Number.isFinite(audioRef.current.duration)) {
            audioRef.current.currentTime = Math.max(0, Math.min(audioRef.current.duration, timeMs / 1_000))
          }
          setPlayheadMs(timeMs)
        }}
        onSelectSegment={setSelectedSegmentId}
        onTogglePlayback={togglePlayback}
        onToggleLoop={() => setLoopEnabled((enabled) => !enabled)}
        onAuditionModeChange={changeAuditionMode}
        onLoopRangeChange={setLoopRange}
        onTempoChange={(value) => applyEdit({ ...editableRef.current, tempoBpm: value })}
        onBeatsPerBarChange={(value) => applyEdit({ ...editableRef.current, beatsPerBar: value })}
        onBeatDivisionChange={(value) => applyEdit({ ...editableRef.current, beatDivision: value })}
        onGridOffsetChange={(value) => applyEdit({ ...editableRef.current, gridOffsetUnits: value })}
        onUpdatePitchNotes={updatePitchNotes}
        onUpdatePhones={updatePhones}
        onUpdatePhoneDurations={updatePhoneDurations}
        onUpdateEnvelope={updateEnvelope}
        onUpdateRegionPitchPoints={updateRegionPitchPoints}
        onUpdateRegionRangePitchPoints={updateRegionRangePitchPoints}
        onUpdateSyllablePitch={updateSyllablePitch}
        onBeginGesture={() => dispatchHistory({ type: "begin-gesture" })}
        onEndGesture={() => dispatchHistory({ type: "end-gesture" })}
      /></> : legacyMode ? <div className="professional-empty panel">기존 편집 형식으로 열었습니다. 기존 설정을 그대로 사용합니다.</div> : <div className="professional-empty panel">저장된 단순 합성을 선택하면 전문 구간을 편집할 수 있습니다.</div>}

      <div className="professional-footer panel">
        {!legacyMode && parent && segments.length > 0 && (step === PROFESSIONAL_STEP_TIMING
          ? <button onClick={() => setStep(PROFESSIONAL_STEP_CORRECTION)}>다음: 음정 · 음량 보정</button>
          : <button onClick={() => setStep(PROFESSIONAL_STEP_TIMING)}>배치 · 길이 조정으로 돌아가기</button>)}
        {(step === PROFESSIONAL_STEP_CORRECTION || legacyMode) && <div className="export-row">
          {COLLAGE_EXPORT_TARGETS.map((target) => (
            <button key={target} disabled={busy || Boolean(history.gestureBaseline) || !parent || dependencyChanged} onClick={() => void runExport(target)}>{target}</button>
          ))}
        </div>}
        {message && <span className="assembly-message"><strong>INFO</strong>{message}</span>}
        {listRefreshFailed && <button type="button" disabled={busy} onClick={() => void refreshList().then(() => setMessage("저장 목록을 새로고침했습니다." )).catch((error: Error) => setMessage(`목록 새로고침 실패: ${error.message}`))}>목록만 다시 불러오기</button>}
        {exportProgress && <ExportProgress job={exportProgress} />}
      </div>
    </section>
  )
}
