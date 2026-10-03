import { useEffect, useMemo, useReducer, useRef, useState } from "react"

import { createComposition, exportComposition, fetchCompositions, previewComposition, updateComposition } from "../api/compositions"
import { applyProfessionalHandleDrag, changeRegionBoundary, deriveProfessionalSegments, moveProfessionalTimelineSuffix, retimeCompositionSegments, splitEditRegions, updateEditRegion, updateSelectedRange, warpEnvelopeForRegionDurations } from "../composition"
import { createProfessionalHistory, reduceProfessionalHistory } from "../professionalHistory"
import { COLLAGE_EXPORT_TARGETS, DEFAULT_CROSSFADE_MS, PROFESSIONAL_COMPOSITION_SCHEMA_VERSION, PROFESSIONAL_ENVELOPE_DEFAULT, PROFESSIONAL_TEMPO_DEFAULT_BPM, PROFESSIONAL_BEATS_PER_BAR_DEFAULT, PROFESSIONAL_BEAT_DIVISION_DEFAULT, PROFESSIONAL_GRID_OFFSET_UNITS_DEFAULT } from "../constants"
import type {
  CompositionProject,
  ExportTarget,
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
} from "../types"
import { ProfessionalEditor, reorderSegments } from "./ProfessionalEditor"

export function ProfessionalSynthesisPage({
  projectId,
  initialCompositionId,
}: ProfessionalSynthesisPageProps) {
  const [compositions, setCompositions] = useState<CompositionProject[]>([])
  const [compositionId, setCompositionId] = useState("")
  const [parentId, setParentId] = useState("")
  const [parentUpdatedAt, setParentUpdatedAt] = useState("")
  const [name, setName] = useState("새 전문 합성")
  const [segments, setSegments] = useState<TimelineSegment[]>([])
  const [selectedSegmentId, setSelectedSegmentId] = useState("")
  const [playheadMs, setPlayheadMs] = useState(0)
  const [crossfadeMs, setCrossfadeMs] = useState(DEFAULT_CROSSFADE_MS)
  const [tempoBpm, setTempoBpm] = useState(PROFESSIONAL_TEMPO_DEFAULT_BPM)
  const [beatsPerBar, setBeatsPerBar] = useState(PROFESSIONAL_BEATS_PER_BAR_DEFAULT)
  const [beatDivision, setBeatDivision] = useState<ProfessionalBeatDivision>(PROFESSIONAL_BEAT_DIVISION_DEFAULT)
  const [gridOffsetUnits, setGridOffsetUnits] = useState(PROFESSIONAL_GRID_OFFSET_UNITS_DEFAULT)
  const [history, dispatchHistory] = useReducer(reduceProfessionalHistory, createProfessionalHistory({ name, segments, crossfadeMs, tempoBpm, beatsPerBar, beatDivision, gridOffsetUnits }))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [legacyMode, setLegacyMode] = useState(false)
  const [previewUrl, setPreviewUrl] = useState("")
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const previewController = useRef<AbortController | null>(null)
  const previewSignature = useRef("")
  const currentSignature = useRef("")
  const previewIntent = useRef<ProfessionalPreviewIntent | null>(null)
  const renderPromise = useRef<Promise<void> | null>(null)
  const editableRef = useRef<ProfessionalEditableState>({ name, segments, crossfadeMs, tempoBpm, beatsPerBar, beatDivision, gridOffsetUnits })
  editableRef.current = { name, segments, crossfadeMs, tempoBpm, beatsPerBar, beatDivision, gridOffsetUnits }

  const applyEdit = (next: ProfessionalEditableState) => {
    editableRef.current = next
    dispatchHistory({ type: "edit", next })
    setName(next.name); setSegments(next.segments); setCrossfadeMs(next.crossfadeMs); setTempoBpm(next.tempoBpm)
    setBeatsPerBar(next.beatsPerBar); setBeatDivision(next.beatDivision); setGridOffsetUnits(next.gridOffsetUnits)
  }
  const editSegments = (transform: (current: TimelineSegment[]) => TimelineSegment[]) => {
    const before = editableRef.current
    const segmentsNext = transform(before.segments)
    if (segmentsNext !== before.segments) applyEdit({ ...before, segments: segmentsNext })
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
    resetHistory({ ...editableRef.current, segments: [] })
    setCompositions([])
    setCompositionId("")
    setParentId("")
    setSegments([])
    fetchCompositions(projectId).then((items) => {
      if (!active) return
      setCompositions(items)
      const requested = items.find((item) => item.composition_id === initialCompositionId)
      if (requested?.mode === "PROFESSIONAL") {
        applyProfessional(requested)
      } else {
        const firstParent = requested?.mode === "SIMPLE"
          ? requested
          : items.find((item) => item.mode === "SIMPLE")
        if (firstParent) applyParent(firstParent)
      }
    }).catch((error: Error) => {
      if (active) setMessage(error.message)
    })
    return () => { active = false }
  }, [initialCompositionId, projectId])

  useEffect(() => () => {
    previewController.current?.abort()
    if (previewUrl) URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  useEffect(() => () => {
    previewController.current?.abort()
    previewIntent.current = null
    renderPromise.current = null
  }, [])

  const applyParent = (nextParent: CompositionProject) => {
    const nextSegments = deriveProfessionalSegments(nextParent.segments)
    setLegacyMode(false)
    setCompositionId("")
    setParentId(nextParent.composition_id)
    setParentUpdatedAt(nextParent.updated_at)
    setName(`${nextParent.name} (전문)`)
    setCrossfadeMs(nextParent.crossfade_ms)
    setTempoBpm(PROFESSIONAL_TEMPO_DEFAULT_BPM); setBeatsPerBar(PROFESSIONAL_BEATS_PER_BAR_DEFAULT); setBeatDivision(PROFESSIONAL_BEAT_DIVISION_DEFAULT); setGridOffsetUnits(PROFESSIONAL_GRID_OFFSET_UNITS_DEFAULT)
    setSegments(nextSegments)
    resetHistory({ name: `${nextParent.name} (전문)`, segments: nextSegments, crossfadeMs: nextParent.crossfade_ms, tempoBpm: PROFESSIONAL_TEMPO_DEFAULT_BPM, beatsPerBar: PROFESSIONAL_BEATS_PER_BAR_DEFAULT, beatDivision: PROFESSIONAL_BEAT_DIVISION_DEFAULT, gridOffsetUnits: PROFESSIONAL_GRID_OFFSET_UNITS_DEFAULT })
    setSelectedSegmentId(nextSegments[0]?.segment_id ?? "")
    setPlayheadMs(0)
    setMessage("원본 단순 합성에서 전문 편집본을 만들었습니다.")
  }

  const applyProfessional = (composition: CompositionProject) => {
    const legacy = composition.mode === "PROFESSIONAL" && composition.segments.some((segment) => !segment.edit_regions.length)
    setLegacyMode(legacy)
    setCompositionId(composition.composition_id)
    setParentId(composition.parent_composition_id ?? "")
    setParentUpdatedAt(composition.parent_composition_updated_at ?? "")
    setName(composition.name)
    setCrossfadeMs(composition.crossfade_ms)
    setTempoBpm(composition.tempo_bpm ?? PROFESSIONAL_TEMPO_DEFAULT_BPM); setBeatsPerBar(composition.beats_per_bar ?? PROFESSIONAL_BEATS_PER_BAR_DEFAULT); setBeatDivision(composition.beat_division ?? PROFESSIONAL_BEAT_DIVISION_DEFAULT); setGridOffsetUnits(composition.grid_offset_units ?? PROFESSIONAL_GRID_OFFSET_UNITS_DEFAULT)
    setSegments(legacy ? composition.segments : retimeCompositionSegments(composition.segments.map((segment) => ({
      ...segment,
      volume_envelope: segment.volume_envelope.length ? segment.volume_envelope : PROFESSIONAL_ENVELOPE_DEFAULT,
    })), "PROFESSIONAL"))
    resetHistory({ name: composition.name, segments: legacy ? composition.segments : retimeCompositionSegments(composition.segments.map((segment) => ({ ...segment, volume_envelope: segment.volume_envelope.length ? segment.volume_envelope : PROFESSIONAL_ENVELOPE_DEFAULT })), "PROFESSIONAL"), crossfadeMs: composition.crossfade_ms, tempoBpm: composition.tempo_bpm ?? PROFESSIONAL_TEMPO_DEFAULT_BPM, beatsPerBar: composition.beats_per_bar ?? PROFESSIONAL_BEATS_PER_BAR_DEFAULT, beatDivision: composition.beat_division ?? PROFESSIONAL_BEAT_DIVISION_DEFAULT, gridOffsetUnits: composition.grid_offset_units ?? PROFESSIONAL_GRID_OFFSET_UNITS_DEFAULT })
    setSelectedSegmentId(composition.segments[0]?.segment_id ?? "")
    setPlayheadMs(0)
    setMessage(`전문 합성 불러옴 · ${composition.updated_at}`)
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
    mode: "PROFESSIONAL",
    schema_version: legacyMode ? (compositions.find((item) => item.composition_id === compositionId)?.schema_version ?? 1) : PROFESSIONAL_COMPOSITION_SCHEMA_VERSION,
    parent_composition_id: parentId || null,
    parent_composition_updated_at: parentUpdatedAt || null,
  })

  const signature = JSON.stringify(buildRequest())
  currentSignature.current = signature
  const requestRef = useRef(buildRequest())
  requestRef.current = buildRequest()

  const reload = async (): Promise<void> => {
    setCompositions(await fetchCompositions(projectId))
  }

  const persist = async (): Promise<CompositionProject> => {
    const saved = compositionId
      ? await updateComposition(compositionId, buildRequest())
      : await createComposition(projectId, buildRequest())
    setCompositionId(saved.composition_id)
    setParentUpdatedAt(saved.parent_composition_updated_at ?? "")
    await reload()
    return saved
  }

  const save = async () => {
    setBusy(true)
    setMessage("")
    try {
      const saved = await persist()
      setMessage(`전문 합성 저장됨 · ${saved.composition_id}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const renderPreview = (intent: ProfessionalPreviewIntent): Promise<void> => {
    if (renderPromise.current) {
      previewIntent.current = intent
      return renderPromise.current
    }
    previewController.current?.abort()
    const controller = new AbortController()
    previewController.current = controller
    previewIntent.current = intent
    setBusy(true)
    setMessage("")
    const requestSignature = currentSignature.current
    let stale = false
    const pending = (async () => {
      try {
        const blob = await previewComposition(projectId, requestRef.current, controller.signal)
        if (!controller.signal.aborted && requestSignature === currentSignature.current) {
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
          else setBusy(false)
        }
      }
    })()
    renderPromise.current = pending
    return pending
  }

  const transport = (timeMs: number, autoplay: boolean) => {
    if (renderPromise.current) {
      previewIntent.current = { timeMs, autoplay }
      return
    }
    const audio = audioRef.current
    if (previewUrl && previewSignature.current === currentSignature.current) {
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

  const preview = () => transport(0, true)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return
      if (event.repeat || event.altKey) return
      const undo = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z"
      const redo = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y"
      if (undo || redo) {
        event.preventDefault()
        if (history.gestureBaseline) return
        previewController.current?.abort(); previewController.current = null; renderPromise.current = null; previewIntent.current = null; setBusy(false)
        audioRef.current?.pause()
        dispatchHistory({ type: undo ? "undo" : "redo" })
        return
      }
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
  }, [playheadMs, previewUrl, signature, history.gestureBaseline])

  useEffect(() => {
    const restored = history.present
    editableRef.current = restored
    setName(restored.name); setSegments(restored.segments); setCrossfadeMs(restored.crossfadeMs); setTempoBpm(restored.tempoBpm)
    setBeatsPerBar(restored.beatsPerBar); setBeatDivision(restored.beatDivision); setGridOffsetUnits(restored.gridOffsetUnits)
    setLegacyMode(restored.segments.some((segment) => !segment.edit_regions.length))
    setSelectedSegmentId((current) => restored.segments.some((segment) => segment.segment_id === current) ? current : restored.segments[0]?.segment_id ?? "")
  }, [history.present])

  const runExport = async (target: ExportTarget) => {
    setBusy(true)
    setMessage("")
    try {
      const saved = await persist()
      await exportComposition(saved.composition_id, target)
      setMessage(`${target} 익스포트 완료`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const updatePhone = (segmentId: string, phoneUnitId: string, updates: Partial<PhoneUnit>) => {
    editSegments((current) => retimeCompositionSegments(current.map((segment) => (
      segment.segment_id === segmentId
        ? {
            ...segment,
            phone_units: segment.phone_units.map((unit) => (
              unit.phone_unit_id === phoneUnitId ? { ...unit, ...updates } : unit
            )),
          }
        : segment
    )), "PROFESSIONAL"))
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
    merged.splice(index - 1, 2, { ...left, source_end_ms: right.source_end_ms, output_duration_ms: left.output_duration_ms + right.output_duration_ms })
    return { ...segment, user_guide_source_ms: (segment.user_guide_source_ms ?? []).filter((sourceMs) => sourceMs !== removed), edit_regions: merged }
  }))

  const updateEnvelope = (segmentId: string, points: VolumeEnvelopePoint[]) => {
    editSegments((current) => current.map((segment) => segment.segment_id === segmentId ? { ...segment, volume_envelope: points } : segment))
  }

  const updatePitchEnvelope = (segmentId: string, points: PitchEnvelopePoint[]) => {
    editSegments((current) => current.map((segment) => segment.segment_id === segmentId ? { ...segment, pitch_envelope: points } : segment))
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
    <section className="professional-page">
      <div className="professional-toolbar panel">
        <div className="professional-file-controls">
          <label className="control-field">
            <span>원본 단순 합성</span>
            <select value={parentId} onChange={(event) => {
              const nextParent = simpleCompositions.find((item) => item.composition_id === event.target.value)
              if (nextParent) applyParent(nextParent)
            }}>
              <option value="">단순 합성을 선택하세요</option>
              {simpleCompositions.map((item) => <option key={item.composition_id} value={item.composition_id}>{item.name}</option>)}
            </select>
          </label>
          <label className="control-field">
            <span>전문 편집본</span>
            <select value={compositionId} onChange={(event) => {
              const selected = professionalCompositions.find((item) => item.composition_id === event.target.value)
              if (selected) applyProfessional(selected)
            }}>
              <option value="">새 전문 편집본</option>
              {professionalCompositions.map((item) => <option key={item.composition_id} value={item.composition_id}>{item.name}</option>)}
            </select>
          </label>
          <label className="control-field professional-name-field">
            <span>이름</span>
            <input value={name} onChange={(event) => applyEdit({ ...editableRef.current, name: event.target.value })} />
          </label>
        </div>
        <div className="professional-actions">
          {dependencyChanged && parent && <button onClick={() => applyParent(parent)}>원본에서 다시 만들기</button>}
          <button disabled={busy || !parent || dependencyChanged} onClick={() => void preview()}>미리 듣기</button>
          <button className="primary-action" disabled={busy || !parent || dependencyChanged} onClick={() => void save()}>전문 합성 저장</button>
        </div>
      </div>

      <div className={`dependency-bar ${dependencyChanged ? "stale" : ""}`}>
        <strong>{dependencyChanged ? "원본 변경됨" : "원본 연결됨"}</strong>
        <span>{parent ? `${parent.name} · ${parent.updated_at}` : "3. 합성에서 저장한 단순 합성을 선택하세요."}</span>
      </div>

      {legacyMode && <div className="legacy-editor-notice"><strong>기존 전문 합성 형식</strong><span>기존 형식은 음소별 길이·무음·포먼트 이동·전환을 유지합니다. 변환하면 음소별 피치·길이 편집은 초기화되고 조각 전체 길이는 유지됩니다. 포먼트 이동·전환과 삭제 무음은 새 형식에 포함되지 않습니다.</span><button onClick={() => { editSegments(() => deriveProfessionalSegments(segments)); setLegacyMode(false); setMessage("구간 편집 형식으로 변환했습니다. 음소별 피치·길이 편집은 초기화되고 조각 전체 길이는 유지됩니다. 포먼트 이동·전환과 삭제 무음은 새 형식에 포함되지 않습니다.") }}>구간 편집으로 변환</button></div>}

      {previewUrl && <audio
        ref={audioRef}
        className="professional-preview"
        src={previewUrl}
        controls
        onCanPlay={(event) => {
          const intent = previewIntent.current
          if (!intent || previewSignature.current !== currentSignature.current) return
          previewIntent.current = null
          event.currentTarget.currentTime = Math.max(0, Math.min(event.currentTarget.duration || 0, intent.timeMs / 1000))
          setPlayheadMs(event.currentTarget.currentTime * 1000)
          if (intent.autoplay) void event.currentTarget.play().catch((error: Error) => setMessage(error.message))
        }}
        onTimeUpdate={(event) => setPlayheadMs(event.currentTarget.currentTime * 1000)}
        onSeeked={(event) => setPlayheadMs(event.currentTarget.currentTime * 1000)}
      />}

      {parent && segments.length && !legacyMode ? <ProfessionalEditor
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
      /> : legacyMode ? <div className="professional-empty panel">기존 음소 기반 편집 형식으로 열었습니다. 미리 듣기·내보내기·저장은 기존 음소 설정을 그대로 사용합니다.</div> : <div className="professional-empty panel">저장된 단순 합성을 선택하면 전문 구간을 편집할 수 있습니다.</div>}

      <div className="professional-footer panel">
        <div className="export-row">
          {COLLAGE_EXPORT_TARGETS.map((target) => (
            <button key={target} disabled={busy || !parent || dependencyChanged} onClick={() => void runExport(target)}>{target}</button>
          ))}
        </div>
        {message && <span className="assembly-message"><strong>INFO</strong>{message}</span>}
      </div>
    </section>
  )
}
