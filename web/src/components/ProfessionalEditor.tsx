import { memo, useEffect, useLayoutEffect, useRef, useState } from "react"

import { fetchWaveform } from "../api"
import { mapWaveformToOutput, resizeProfessionalHandle } from "../composition"
import {
  MAX_CROSSFADE_MS, PROFESSIONAL_ENVELOPE_POSITION_EPSILON, PROFESSIONAL_GAIN_MAX,
  PROFESSIONAL_GAIN_MIN,
  PROFESSIONAL_PITCH_MAX_CENTS, PROFESSIONAL_PITCH_MIN_CENTS, PROFESSIONAL_TIMELINE_LABEL_WIDTH,
  PROFESSIONAL_EDITOR_INITIAL_SCALE, PROFESSIONAL_EDITOR_MIN_SCALE, PROFESSIONAL_EDITOR_MAX_SCALE, PROFESSIONAL_CURVE_VERTICAL_INSET, PROFESSIONAL_CURVE_POINT_MIN_GAP_PX, PROFESSIONAL_MINIMUM_VISUAL_TIMELINE_WIDTH, PROFESSIONAL_TIMELINE_TAIL_WIDTH, PROFESSIONAL_TEMPO_MIN_BPM, PROFESSIONAL_TEMPO_MAX_BPM, PROFESSIONAL_BEATS_PER_BAR_MIN, PROFESSIONAL_BEATS_PER_BAR_MAX, PROFESSIONAL_TEMPO_DEFAULT_BPM, PROFESSIONAL_BEATS_PER_BAR_DEFAULT, PROFESSIONAL_BEAT_DIVISIONS, PROFESSIONAL_LANE_ROW_HEIGHT,
} from "../constants"
import type { PitchEnvelopePoint, ProfessionalEditorProps, ProfessionalLane, ProfessionalSelectedPoint, ProfessionalSourceRange, ProfessionalWaveformRequest, ProfessionalZoomAnchor, TimelineSegment, VolumeEnvelopePoint } from "../types"
import { formatTime } from "./Timeline"

export const ProfessionalEditor = memo(function ProfessionalEditor(props: ProfessionalEditorProps) {
  const { projectId, segments, selectedSegmentId, playheadMs, tempoBpm, beatsPerBar, beatDivision, gridOffsetUnits, onTempoChange, onBeatsPerBarChange, onBeatDivisionChange, onGridOffsetChange, onSelectSegment, onPlayheadChange, onApplyHandleDrag, onAddGuide, onRemoveGuide, onUpdatePitchEnvelope, onUpdateEnvelope, onUpdateSegment, onReorderSegment, onDeleteSegment } = props
  const [scale, setScale] = useState(PROFESSIONAL_EDITOR_INITIAL_SCALE)
  const [tempoText, setTempoText] = useState(String(tempoBpm))
  const [beatsText, setBeatsText] = useState(String(beatsPerBar))
  const [hint, setHint] = useState("")
  const [selectedPoint, setSelectedPoint] = useState<ProfessionalSelectedPoint | null>(null)
  const [selectedRange, setSelectedRange] = useState<ProfessionalSourceRange | null>(null)
  const [waveforms, setWaveforms] = useState<Record<string, number[]>>({})
  const waveformRequests = useRef(new Map<string, ProfessionalWaveformRequest>())
  const scrollRef = useRef<HTMLDivElement>(null)
  const pendingZoomAnchor = useRef<ProfessionalZoomAnchor | null>(null)
  const zoomScale = useRef(scale)
  const dragCleanup = useRef<(() => void) | null>(null)
  const totalMs = Math.max(1, segments.reduce((maximum, segment) => Math.max(maximum, segment.timeline_end_ms), 0))
  const width = Math.max(PROFESSIONAL_MINIMUM_VISUAL_TIMELINE_WIDTH, totalMs * scale + PROFESSIONAL_TIMELINE_TAIL_WIDTH + PROFESSIONAL_TIMELINE_LABEL_WIDTH)
  const selected = segments.find((segment) => segment.segment_id === selectedSegmentId) ?? null
  const beatMs = 60000 / tempoBpm
  const gridMs = beatMs * 4 / beatDivision
  const barMs = beatMs * beatsPerBar
  const gridOffsetMs = gridOffsetUnits * beatMs / 24
  const firstVisibleBar = Math.ceil(-gridOffsetMs / barMs)
  const lastVisibleBar = Math.floor((totalMs - gridOffsetMs) / barMs)
  const laneCount = Math.max(1, ...segments.map((segment) => segment.lane + 1))

  useEffect(() => {
    const activeKeys = new Set(segments.map((segment) => `${projectId}:${segment.source_id}:${segment.source_start_ms}:${segment.source_end_ms}`))
    waveformRequests.current.forEach(({ controller }, key) => {
      if (!activeKeys.has(key)) { controller.abort(); waveformRequests.current.delete(key) }
    })
    segments.forEach((segment) => {
      const key = `${projectId}:${segment.source_id}:${segment.source_start_ms}:${segment.source_end_ms}`
      let request = waveformRequests.current.get(key)
      if (!request) {
        const controller = new AbortController()
        request = { controller, promise: fetchWaveform(projectId, segment.source_id, segment.source_start_ms, segment.source_end_ms, 500, controller.signal).then((data) => data.peaks) }
        waveformRequests.current.set(key, request)
      }
      const capturedRequest = request
      const capturedSegmentId = segment.segment_id
      capturedRequest.promise.then((peaks) => {
        const active = segments.some((item) => item.segment_id === capturedSegmentId && `${projectId}:${item.source_id}:${item.source_start_ms}:${item.source_end_ms}` === key)
        if (!capturedRequest.controller.signal.aborted && waveformRequests.current.get(key) === capturedRequest && active) setWaveforms((current) => ({ ...current, [key]: peaks }))
      }).catch(() => { if (waveformRequests.current.get(key) === capturedRequest) waveformRequests.current.delete(key) })
    })
  }, [projectId, segments])
  useEffect(() => () => { waveformRequests.current.forEach(({ controller }) => controller.abort()); waveformRequests.current.clear() }, [])

  useEffect(() => () => dragCleanup.current?.(), [])
  useEffect(() => setTempoText(String(tempoBpm)), [tempoBpm])
  useEffect(() => setBeatsText(String(beatsPerBar)), [beatsPerBar])
  useLayoutEffect(() => {
    const anchor = pendingZoomAnchor.current
    const node = scrollRef.current
    if (!anchor || !node) return
    pendingZoomAnchor.current = null
    node.scrollLeft = Math.max(0, Math.min(node.scrollWidth - node.clientWidth, PROFESSIONAL_TIMELINE_LABEL_WIDTH + anchor.timeAtCursor * scale - anchor.cursorLocalX))
  }, [scale])
  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      if (event.shiftKey) {
        const rawDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
        const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? rawDelta * 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? rawDelta * node.clientWidth : rawDelta
        node.scrollLeft = Math.max(0, Math.min(node.scrollWidth - node.clientWidth, node.scrollLeft + delta))
        return
      }
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaX * 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? event.deltaX * node.clientWidth : event.deltaX
        node.scrollLeft = Math.max(0, Math.min(node.scrollWidth - node.clientWidth, node.scrollLeft + delta))
        return
      }
      const rect = node.getBoundingClientRect()
      const cursor = event.clientX - rect.left
      const factor = Math.exp(-Math.max(-240, Math.min(240, event.deltaY)) * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 0.012 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 0.18 : 0.002))
      const currentScale = zoomScale.current
      const next = Math.max(PROFESSIONAL_EDITOR_MIN_SCALE, Math.min(PROFESSIONAL_EDITOR_MAX_SCALE, currentScale * factor))
      if (next === currentScale) return
      const pending = pendingZoomAnchor.current
      const currentScrollLeft = pending ? PROFESSIONAL_TIMELINE_LABEL_WIDTH + pending.timeAtCursor * currentScale - pending.cursorLocalX : node.scrollLeft
      const timeAtCursor = Math.max(0, (currentScrollLeft + cursor - PROFESSIONAL_TIMELINE_LABEL_WIDTH) / currentScale)
      pendingZoomAnchor.current = { timeAtCursor, cursorLocalX: cursor }
      zoomScale.current = next
      setScale(next)
    }
    node.addEventListener("wheel", wheel, { passive: false })
    return () => node.removeEventListener("wheel", wheel)
  }, [scale])

  const pixelsAt = (timeMs: number) => timeMs * scale
  const waveformKey = (segment: TimelineSegment) => `${projectId}:${segment.source_id}:${segment.source_start_ms}:${segment.source_end_ms}`
  const timeAt = (clientX: number) => Math.max(0, (clientX - (scrollRef.current?.getBoundingClientRect().left ?? 0) + (scrollRef.current?.scrollLeft ?? 0) - PROFESSIONAL_TIMELINE_LABEL_WIDTH) / scale)
  const mapOutputToSource = (segment: TimelineSegment, outputMs: number) => {
    let passed = 0
    for (const region of segment.edit_regions) {
      if (outputMs <= passed + region.output_duration_ms) return Math.round(region.source_start_ms + Math.max(0, Math.min(region.output_duration_ms, outputMs - passed)) / region.output_duration_ms * (region.source_end_ms - region.source_start_ms))
      passed += region.output_duration_ms
    }
    return segment.source_end_ms
  }

  const mapSourceToOutput = (segment: TimelineSegment, sourceMs: number) => {
    let output = 0
    for (const region of segment.edit_regions) {
      if (sourceMs <= region.source_start_ms) return output
      if (sourceMs < region.source_end_ms) return output + (sourceMs - region.source_start_ms) / (region.source_end_ms - region.source_start_ms) * region.output_duration_ms
      output += region.output_duration_ms
    }
    return output
  }

  const selectIntervalAt = (event: React.PointerEvent<Element>, segment: TimelineSegment) => {
    const outputMs = Math.max(0, timeAt(event.clientX) - segment.timeline_start_ms)
    let offset = 0
    const foundIndex = segment.edit_regions.findIndex((region) => { offset += region.output_duration_ms; return outputMs < offset })
    const index = foundIndex < 0 ? segment.edit_regions.length - 1 : foundIndex
    const region = segment.edit_regions[index] ?? segment.edit_regions.at(-1)
    if (region) setSelectedRange({ segmentId: segment.segment_id, startMs: region.source_start_ms, endMs: region.source_end_ms })
    onSelectSegment(segment.segment_id)
  }

  const dragHandle = (event: React.PointerEvent<HTMLElement>, segment: TimelineSegment, selectedIndex: number, boundaryIndex: number) => {
    if (event.button !== 0 || event.altKey) return
    event.preventDefault(); event.stopPropagation(); onSelectSegment(segment.segment_id)
    const region = segment.edit_regions[selectedIndex]
    if (region) setSelectedRange({ segmentId: segment.segment_id, startMs: region.source_start_ms, endMs: region.source_end_ms })
    const mode = event.shiftKey ? "shift" : event.ctrlKey ? "ctrl" : "normal"
    const startX = event.clientX
    const apply = (pointer: PointerEvent) => {
      const result = resizeProfessionalHandle(segment, selectedIndex, boundaryIndex, mode, (pointer.clientX - startX) / scale)
      onApplyHandleDrag(segment, result.startMs, result.durations)
    }
    const finish = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish); dragCleanup.current = null }
    const move = (pointer: PointerEvent) => apply(pointer)
    dragCleanup.current?.(); dragCleanup.current = finish
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish); window.addEventListener("pointercancel", finish)
  }

  const backgroundPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest(".professional-audio-fragment, .professional-curve-fragment, .professional-timeline-tools, strong")) return
    onPlayheadChange(timeAt(event.clientX))
  }

  const pointContext = (event: React.MouseEvent<SVGSVGElement>, segment: TimelineSegment, lane: ProfessionalLane) => {
    event.preventDefault(); event.stopPropagation()
    const bounds = event.currentTarget.getBoundingClientRect()
    const position = Math.max(PROFESSIONAL_ENVELOPE_POSITION_EPSILON, Math.min(1 - PROFESSIONAL_ENVELOPE_POSITION_EPSILON, (event.clientX - bounds.left) / bounds.width))
    if (lane === "pitch") {
      const points = segment.pitch_envelope ?? [{ position: 0, cents: 0 }, { position: 1, cents: 0 }]
      const target = event.target instanceof SVGEllipseElement ? event.target : null
      const existing = target ? Array.from(event.currentTarget.querySelectorAll("ellipse")).indexOf(target) : -1
      if (existing >= 0) {
        if (existing === 0 || existing === points.length - 1) { setHint("양 끝 기준점은 곡선의 전체 구간을 정의하므로 삭제할 수 없습니다."); return }
        onUpdatePitchEnvelope(segment.segment_id, points.filter((_, index) => index !== existing)); setSelectedPoint(null); setHint("")
      } else {
        if (points.some((point) => Math.abs(point.position - position) * bounds.width < PROFESSIONAL_CURVE_POINT_MIN_GAP_PX)) return
        const cents = Math.round((50 - (event.clientY - bounds.top) / bounds.height * 100) * PROFESSIONAL_PITCH_MAX_CENTS / (50 - PROFESSIONAL_CURVE_VERTICAL_INSET))
        onUpdatePitchEnvelope(segment.segment_id, [...points, { position, cents: Math.max(PROFESSIONAL_PITCH_MIN_CENTS, Math.min(PROFESSIONAL_PITCH_MAX_CENTS, cents)) }].sort((a, b) => a.position - b.position)); setHint("")
      }
    } else {
      const points = segment.volume_envelope?.length ? segment.volume_envelope : [{ position: 0, gain: 1 }, { position: 1, gain: 1 }]
      const target = event.target instanceof SVGEllipseElement ? event.target : null
      const existing = target ? Array.from(event.currentTarget.querySelectorAll("ellipse")).indexOf(target) : -1
      if (existing >= 0) {
        if (existing === 0 || existing === points.length - 1) { setHint("양 끝 기준점은 곡선의 전체 구간을 정의하므로 삭제할 수 없습니다."); return }
        onUpdateEnvelope(segment.segment_id, points.filter((_, index) => index !== existing)); setSelectedPoint(null); setHint("")
      } else {
        if (points.some((point) => Math.abs(point.position - position) * bounds.width < PROFESSIONAL_CURVE_POINT_MIN_GAP_PX)) return
        const gain = Math.max(PROFESSIONAL_GAIN_MIN, Math.min(PROFESSIONAL_GAIN_MAX, (50 - (event.clientY - bounds.top) / bounds.height * 100) * PROFESSIONAL_GAIN_MAX / (50 - PROFESSIONAL_CURVE_VERTICAL_INSET)))
        onUpdateEnvelope(segment.segment_id, [...points, { position, gain }].sort((a, b) => a.position - b.position)); setHint("")
      }
    }
  }

  const dragPoint = (event: React.PointerEvent<SVGEllipseElement>, segment: TimelineSegment, lane: ProfessionalLane, index: number, points: VolumeEnvelopePoint[] | PitchEnvelopePoint[]) => {
    if (event.button !== 0) return
    event.preventDefault(); event.stopPropagation(); setSelectedPoint({ lane, segmentId: segment.segment_id, index }); onSelectSegment(segment.segment_id)
    const bounds = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
    if (!bounds) return
    const move = (pointer: PointerEvent) => {
      const gap = PROFESSIONAL_CURVE_POINT_MIN_GAP_PX / bounds.width
      const min = index === 0 ? 0 : points[index - 1].position + gap
      const max = index === points.length - 1 ? 1 : points[index + 1].position - gap
      const position = index === 0 ? 0 : index === points.length - 1 ? 1 : Math.max(min, Math.min(max, (pointer.clientX - bounds.left) / bounds.width))
      if (lane === "pitch") {
        const pitchPoints = points as PitchEnvelopePoint[]
        const cents = Math.round((50 - (pointer.clientY - bounds.top) / bounds.height * 100) * PROFESSIONAL_PITCH_MAX_CENTS / (50 - PROFESSIONAL_CURVE_VERTICAL_INSET))
        onUpdatePitchEnvelope(segment.segment_id, pitchPoints.map((point, item) => item === index ? { position, cents: Math.max(PROFESSIONAL_PITCH_MIN_CENTS, Math.min(PROFESSIONAL_PITCH_MAX_CENTS, cents)) } : point))
      } else {
        const volumePoints = points as VolumeEnvelopePoint[]
        const gain = Math.max(PROFESSIONAL_GAIN_MIN, Math.min(PROFESSIONAL_GAIN_MAX, (50 - (pointer.clientY - bounds.top) / bounds.height * 100) * PROFESSIONAL_GAIN_MAX / (50 - PROFESSIONAL_CURVE_VERTICAL_INSET)))
        onUpdateEnvelope(segment.segment_id, volumePoints.map((point, item) => item === index ? { position, gain } : point))
      }
    }
    const finish = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish); dragCleanup.current = null }
    dragCleanup.current?.(); dragCleanup.current = finish; window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish); window.addEventListener("pointercancel", finish)
  }

  const drawLane = (segment: TimelineSegment, lane: ProfessionalLane) => {
    const pitchLane = lane === "pitch"
    const points = pitchLane ? (segment.pitch_envelope?.length ? segment.pitch_envelope : [{ position: 0, cents: 0 }, { position: 1, cents: 0 }]) : (segment.volume_envelope?.length ? segment.volume_envelope : [{ position: 0, gain: 1 }, { position: 1, gain: 1 }])
    const y = (point: VolumeEnvelopePoint | PitchEnvelopePoint) => pitchLane ? 50 - ("cents" in point ? point.cents : 0) / PROFESSIONAL_PITCH_MAX_CENTS * (50 - PROFESSIONAL_CURVE_VERTICAL_INSET) : 50 - ("gain" in point ? point.gain : 1) / PROFESSIONAL_GAIN_MAX * (50 - PROFESSIONAL_CURVE_VERTICAL_INSET)
    return <svg className={`professional-curve ${lane}`} viewBox="0 0 1000 100" preserveAspectRatio="none" aria-label={pitchLane ? "피치 곡선" : "음량 곡선"} onContextMenu={(event) => pointContext(event, segment, lane)} onPointerDown={(event) => { if (event.button === 0 && !(event.target instanceof SVGEllipseElement)) selectIntervalAt(event, segment) }}>
      <line x1="0" y1="50" x2="1000" y2="50"/><polyline points={points.map((point) => `${point.position * 1000},${y(point)}`).join(" ")}/>
      {segment.edit_regions.slice(1).map((region, index) => { const offset = segment.edit_regions.slice(0, index + 1).reduce((sum, item) => sum + item.output_duration_ms, 0); const userGuide = (segment.user_guide_source_ms ?? []).includes(region.source_start_ms) || !segment.phone_units.some((unit) => unit.source_start_ms === region.source_start_ms); return <line key={region.region_id} className={`professional-guide-line ${userGuide ? "user-guide" : "phone-guide"}`} data-region-duration-ms={segment.edit_regions[index]?.output_duration_ms} x1={offset / (segment.timeline_end_ms - segment.timeline_start_ms) * 1000} x2={offset / (segment.timeline_end_ms - segment.timeline_start_ms) * 1000} y1="0" y2="100"/> })}
      {points.map((point, index) => <ellipse key={index} className={index > 0 && index < points.length - 1 ? "user-point" : "endpoint"} cx={point.position * 1000} cy={y(point)} rx={Math.max(7, 7000 / Math.max(1, pixelsAt(segment.timeline_end_ms - segment.timeline_start_ms)))} ry="7.5" tabIndex={0} aria-label={pitchLane ? `${"cents" in point ? point.cents : 0} cents` : `${"gain" in point ? point.gain.toFixed(2) : 1} gain`} onPointerDown={(event) => dragPoint(event, segment, lane, index, points)} />)}
    </svg>
  }

  const crossfadeWidth = (segment: TimelineSegment) => {
    const index = segments.indexOf(segment)
    const previous = segments[index - 1]
    const requested = segment.crossfade_ms ?? Math.min(MAX_CROSSFADE_MS, -segment.gap_before_ms)
    return Math.max(0, Math.min(MAX_CROSSFADE_MS, requested, Math.max(0, (previous?.timeline_end_ms ?? segment.timeline_start_ms) - segment.timeline_start_ms), segment.timeline_end_ms - segment.timeline_start_ms))
  }

  return <section className="vocal-editor professional-editor" aria-label="전문 합성 타임라인 편집기">
    <header className="vocal-timeline-header"><div><strong>전문 합성 타임라인</strong><span>{formatTime(playheadMs)} / {formatTime(totalMs)}</span></div><span>세로 휠: 확대·축소 · 가로 휠 또는 Shift+휠: 가로 이동 · 우클릭: 점 추가·삭제</span></header>
    <div className="professional-timeline-tools"><label>BPM<input aria-label="BPM" type="number" min={PROFESSIONAL_TEMPO_MIN_BPM} max={PROFESSIONAL_TEMPO_MAX_BPM} step="1" value={tempoText} onChange={(event) => { const value = event.target.value; setTempoText(value); const parsed = Number(value); if (Number.isInteger(parsed) && parsed >= PROFESSIONAL_TEMPO_MIN_BPM && parsed <= PROFESSIONAL_TEMPO_MAX_BPM) onTempoChange(parsed) }} onBlur={() => { const value = Math.max(PROFESSIONAL_TEMPO_MIN_BPM, Math.min(PROFESSIONAL_TEMPO_MAX_BPM, Math.trunc(Number(tempoText) || PROFESSIONAL_TEMPO_DEFAULT_BPM))); setTempoText(String(value)); onTempoChange(value) }}/></label><label>박자<input aria-label="박자" type="number" min={PROFESSIONAL_BEATS_PER_BAR_MIN} max={PROFESSIONAL_BEATS_PER_BAR_MAX} step="1" value={beatsText} onChange={(event) => { const value = event.target.value; setBeatsText(value); const parsed = Number(value); if (Number.isInteger(parsed) && parsed >= PROFESSIONAL_BEATS_PER_BAR_MIN && parsed <= PROFESSIONAL_BEATS_PER_BAR_MAX) onBeatsPerBarChange(parsed) }} onBlur={() => { const value = Math.max(PROFESSIONAL_BEATS_PER_BAR_MIN, Math.min(PROFESSIONAL_BEATS_PER_BAR_MAX, Math.trunc(Number(beatsText) || PROFESSIONAL_BEATS_PER_BAR_DEFAULT))); setBeatsText(String(value)); onBeatsPerBarChange(value) }}/></label><label>눈금<select aria-label="눈금" value={beatDivision} onChange={(event) => onBeatDivisionChange(Number(event.target.value) as typeof PROFESSIONAL_BEAT_DIVISIONS[number])}>{PROFESSIONAL_BEAT_DIVISIONS.map((value) => <option key={value} value={value}>1/{value}</option>)}</select></label><label>마디 오프셋 (1/96)<input aria-label="마디 오프셋 (1/96)" type="number" step="1" value={gridOffsetUnits} onChange={(event) => { const value = Number(event.target.value); if (Number.isSafeInteger(value)) onGridOffsetChange(value) }}/></label><span>{tempoBpm} BPM · {beatsPerBar}/4 · {formatTime(gridMs)} /눈금</span></div>
    <div className="professional-timeline-scroll" ref={scrollRef}>
      <div className="professional-timeline-content" data-playhead-ms={playheadMs} onPointerDown={backgroundPointerDown} style={{ width, backgroundImage: `linear-gradient(to right, #71859b 1.5px, transparent 1.5px), linear-gradient(to right, #425264 1px, transparent 1px), linear-gradient(to right, #34414e 1px, transparent 1px), linear-gradient(to right, #34414e 1px, transparent 1px)`, backgroundSize: `${barMs * scale}px 100%, ${barMs / 4 * scale}px 100%, ${beatMs * scale}px 100%, ${gridMs * scale}px 100%`, backgroundPositionX: `${PROFESSIONAL_TIMELINE_LABEL_WIDTH + gridOffsetMs * scale}px, ${PROFESSIONAL_TIMELINE_LABEL_WIDTH + gridOffsetMs * scale}px, ${PROFESSIONAL_TIMELINE_LABEL_WIDTH + gridOffsetMs * scale}px, ${PROFESSIONAL_TIMELINE_LABEL_WIDTH + gridOffsetMs * scale}px` }}>
      <div className="professional-time-ruler" style={{ left: PROFESSIONAL_TIMELINE_LABEL_WIDTH }}>{Array.from({ length: Math.max(0, lastVisibleBar - firstVisibleBar + 1) }, (_, index) => { const bar = firstVisibleBar + index; return <span key={bar} style={{ left: (bar * barMs + gridOffsetMs) * scale }}>{bar - firstVisibleBar + 1}</span> })}</div>
        <div className="professional-audio-lane" style={{ minHeight: laneCount * PROFESSIONAL_LANE_ROW_HEIGHT }}><strong>오디오</strong>{segments.map((segment) => { const range = selectedRange?.segmentId === segment.segment_id ? selectedRange : null; const rangeStart = range ? mapSourceToOutput(segment, range.startMs) : 0; const rangeEnd = range ? mapSourceToOutput(segment, range.endMs) : 0; const selectedIndex = range ? segment.edit_regions.findIndex((region) => region.source_start_ms === range.startMs && region.source_end_ms === range.endMs) : -1; const rangeRegion = selectedIndex >= 0 ? segment.edit_regions[selectedIndex] : null; return <div key={segment.segment_id} className={`professional-audio-fragment ${segment.segment_id === selectedSegmentId ? "selected" : ""}`} data-source-start-ms={segment.source_start_ms} data-source-end-ms={segment.source_end_ms} data-lane={segment.lane} style={{ left: PROFESSIONAL_TIMELINE_LABEL_WIDTH + pixelsAt(segment.timeline_start_ms), top: 28 + segment.lane * PROFESSIONAL_LANE_ROW_HEIGHT, width: Math.max(0, pixelsAt(segment.timeline_end_ms - segment.timeline_start_ms)) }} onPointerDown={(event) => { if (event.button !== 0) return; if ((event.target as HTMLElement).closest(".professional-fragment-label, .professional-guides, .professional-edge-handle, .professional-range-selection")) return; event.preventDefault(); event.stopPropagation(); selectIntervalAt(event, segment) }} onContextMenu={(event) => { if ((event.target as HTMLElement).closest(".professional-guides i")) return; event.preventDefault(); onAddGuide(segment.segment_id, mapOutputToSource(segment, Math.max(0, Math.min(segment.timeline_end_ms - segment.timeline_start_ms, timeAt(event.clientX) - segment.timeline_start_ms)))) }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData("text/plain"); if (id) onReorderSegment(id, segment.segment_id) }} title="구간을 클릭하여 선택합니다. 우클릭하여 원본 분할점을 추가합니다."><span className="professional-fragment-label" draggable onPointerDown={(event) => { event.stopPropagation(); if (event.button === 0) selectIntervalAt(event, segment) }} onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.setData("text/plain", segment.segment_id) }}>{segment.target_ipa.join(" · ")}</span><div className="professional-fragment-body"><svg className="professional-waveform" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true"><polyline points={mapWaveformToOutput(segment, waveforms[waveformKey(segment)] ?? [])} /></svg></div><button className="professional-edge-handle left" aria-label="앞 경계" title="앞 경계" data-source-start-ms={segment.source_start_ms} data-source-end-ms={segment.source_start_ms} onPointerDown={(event) => dragHandle(event, segment, 0, 0)} onContextMenu={(event) => event.preventDefault()}/><button className="professional-edge-handle right" aria-label="뒤 경계" title="뒤 경계" data-source-start-ms={segment.source_end_ms} data-source-end-ms={segment.source_end_ms} onPointerDown={(event) => dragHandle(event, segment, segment.edit_regions.length - 1, segment.edit_regions.length)} onContextMenu={(event) => event.preventDefault()}/><div className="professional-guides">{segment.edit_regions.slice(1).map((region, index) => { const offset = segment.edit_regions.slice(0, index + 1).reduce((sum, item) => sum + item.output_duration_ms, 0); const userGuide = (segment.user_guide_source_ms ?? []).includes(region.source_start_ms) || !segment.phone_units.some((unit) => unit.source_start_ms === region.source_start_ms); return <i key={region.region_id} className={userGuide ? "user-guide" : "phone-guide"} data-source-start-ms={region.source_start_ms} data-source-end-ms={region.source_end_ms} style={{ left: `${offset / (segment.timeline_end_ms - segment.timeline_start_ms) * 100}%` }} title={userGuide ? "사용자 경계 (우클릭하여 제거)" : "음소 경계 (우클릭하여 사용자 표시 추가)"} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); if ((segment.user_guide_source_ms ?? []).includes(region.source_start_ms)) onRemoveGuide(segment.segment_id, region.region_id); else onAddGuide(segment.segment_id, region.source_start_ms) }} onPointerDown={(event) => { const boundary = index + 1; const active = segment.edit_regions.findIndex((item) => item.source_start_ms === range?.startMs && item.source_end_ms === range?.endMs); const interval = active === boundary ? boundary : boundary - 1; dragHandle(event, segment, interval, boundary) }} />})}</div>{range && <div className="professional-range-selection" data-source-start-ms={range.startMs} data-source-end-ms={range.endMs} style={{ left: pixelsAt(rangeStart), width: Math.max(1, pixelsAt(rangeEnd - rangeStart)) }}>{rangeRegion && <><button aria-label="선택 구간 앞 경계" title="선택 구간 앞 경계" data-source-start-ms={rangeRegion.source_start_ms} data-source-end-ms={rangeRegion.source_start_ms} onPointerDown={(event) => dragHandle(event, segment, selectedIndex, selectedIndex)} onContextMenu={(event) => event.preventDefault()}/><button aria-label="선택 구간 뒤 경계" title="선택 구간 뒤 경계" data-source-start-ms={rangeRegion.source_end_ms} data-source-end-ms={rangeRegion.source_end_ms} onPointerDown={(event) => dragHandle(event, segment, selectedIndex, selectedIndex + 1)} onContextMenu={(event) => event.preventDefault()}/></>}</div>}{segment.gap_before_ms < 0 && <i className="professional-crossfade" style={{ width: pixelsAt(crossfadeWidth(segment)) }}/>}</div>})}</div>
        {(["pitch", "volume"] as const).map((lane) => <div className={`professional-curve-lane ${lane}`} key={lane} style={{ minHeight: laneCount * PROFESSIONAL_LANE_ROW_HEIGHT }}><strong>{lane === "pitch" ? "피치 (cent)" : "음량 (gain)"}</strong>{segments.map((segment) => <div key={segment.segment_id} className="professional-curve-fragment" data-lane={segment.lane} style={{ left: PROFESSIONAL_TIMELINE_LABEL_WIDTH + pixelsAt(segment.timeline_start_ms), top: segment.lane * PROFESSIONAL_LANE_ROW_HEIGHT, width: Math.max(0, pixelsAt(segment.timeline_end_ms - segment.timeline_start_ms)) }}>{drawLane(segment, lane)}</div>)}</div>)}
        <div className="professional-playhead" style={{ left: PROFESSIONAL_TIMELINE_LABEL_WIDTH + pixelsAt(playheadMs) }}/>
      </div>
    </div>
    {selected && <div className="professional-selection-tools"><strong>{selected.target_ipa.join(" · ")}</strong><span>구간을 클릭하여 선택합니다. 일반 드래그는 공통 경계를 조정하고, Ctrl은 앞이나 뒤 구간을 이동하며, Shift는 음절 전체를 이동합니다.</span><label>피치 점 (cent)<input aria-label="피치 cent fine adjustment" type="number" min={PROFESSIONAL_PITCH_MIN_CENTS} max={PROFESSIONAL_PITCH_MAX_CENTS} step="1" disabled={selectedPoint?.lane !== "pitch" || selectedPoint.segmentId !== selected.segment_id} value={selected.pitch_envelope?.[selectedPoint?.index ?? -1]?.cents ?? 0} onChange={(event) => { const points = selected.pitch_envelope ?? [{ position: 0, cents: 0 }, { position: 1, cents: 0 }]; const index = selectedPoint?.index ?? -1; if (index >= 0) onUpdatePitchEnvelope(selected.segment_id, points.map((point, item) => item === index ? { ...point, cents: Math.max(PROFESSIONAL_PITCH_MIN_CENTS, Math.min(PROFESSIONAL_PITCH_MAX_CENTS, Math.trunc(Number.isFinite(Number(event.target.value)) ? Number(event.target.value) : 0))) } : point)) }}/></label><label>음량 점 (gain)<input aria-label="음량 gain fine adjustment" type="number" min={0} max={2} step="0.01" disabled={selectedPoint?.lane !== "volume" || selectedPoint.segmentId !== selected.segment_id} value={selected.volume_envelope?.[selectedPoint?.index ?? -1]?.gain ?? 1} onChange={(event) => { const points = selected.volume_envelope ?? [{ position: 0, gain: 1 }, { position: 1, gain: 1 }]; const index = selectedPoint?.index ?? -1; if (index >= 0) onUpdateEnvelope(selected.segment_id, points.map((point, item) => item === index ? { ...point, gain: Math.max(PROFESSIONAL_GAIN_MIN, Math.min(PROFESSIONAL_GAIN_MAX, Number.isFinite(Number(event.target.value)) ? Number(event.target.value) : PROFESSIONAL_GAIN_MIN)) } : point)) }}/></label><label>단편 사이 크로스페이드 (ms)<input type="number" min="0" max={MAX_CROSSFADE_MS} disabled={segments[0]?.segment_id === selected.segment_id} value={selected.crossfade_ms ?? Math.max(0, Math.min(MAX_CROSSFADE_MS, -selected.gap_before_ms))} onChange={(event) => onUpdateSegment(selected.segment_id, { crossfade_ms: Math.max(0, Math.min(MAX_CROSSFADE_MS, Number.isFinite(Number(event.target.value)) ? Math.trunc(Number(event.target.value)) : 0)) })}/></label><button onClick={() => onDeleteSegment(selected.segment_id)}>단편 삭제</button>{hint && <span role="status">{hint}</span>}</div>}
  </section>
})

export function reorderSegments(segments: TimelineSegment[], sourceId: string, destinationId: string): TimelineSegment[] {
  const from = segments.findIndex((segment) => segment.segment_id === sourceId)
  const to = segments.findIndex((segment) => segment.segment_id === destinationId)
  if (from < 0 || to < 0 || from === to) return segments
  const result = [...segments]
  const [item] = result.splice(from, 1)
  result.splice(to, 0, item)
  return result
}
