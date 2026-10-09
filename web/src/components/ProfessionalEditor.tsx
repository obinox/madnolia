import { memo, useEffect, useLayoutEffect, useRef, useState } from "react"

import { fetchWaveform } from "../api/projects"
import { resizeProfessionalHandle } from "../composition"
import { mapWaveformToOutput } from "../features/composition/waveform"
import { reorderSegments } from "../features/composition/timeline"
import {
  MAX_CROSSFADE_MS, PROFESSIONAL_GRID_BACKGROUND_IMAGE, PROFESSIONAL_ENVELOPE_POSITION_EPSILON, PROFESSIONAL_GAIN_MAX,
  PROFESSIONAL_GAIN_MIN,
  PROFESSIONAL_PITCH_MAX_CENTS, PROFESSIONAL_PITCH_MIN_CENTS, PROFESSIONAL_PITCH_DISPLAY_RANGES_CENTS, PROFESSIONAL_PITCH_DISPLAY_RANGE_DEFAULT_CENTS, PROFESSIONAL_TIMELINE_LABEL_WIDTH,
  PROFESSIONAL_AUDIO_LANE_TOP_PADDING, PROFESSIONAL_WAVEFORM_CENTER_Y, PROFESSIONAL_WAVEFORM_VIEW_HEIGHT, PROFESSIONAL_WAVEFORM_VIEW_WIDTH,
  PROFESSIONAL_EDITOR_INITIAL_SCALE, PROFESSIONAL_EDITOR_MIN_SCALE, PROFESSIONAL_EDITOR_MAX_SCALE, PROFESSIONAL_CURVE_VERTICAL_INSET, PROFESSIONAL_CURVE_POINT_MIN_GAP_PX, PROFESSIONAL_MINIMUM_VISUAL_TIMELINE_WIDTH, PROFESSIONAL_TIMELINE_TAIL_WIDTH, PROFESSIONAL_TEMPO_MIN_BPM, PROFESSIONAL_TEMPO_MAX_BPM, PROFESSIONAL_BEATS_PER_BAR_MIN, PROFESSIONAL_BEATS_PER_BAR_MAX, PROFESSIONAL_TEMPO_DEFAULT_BPM, PROFESSIONAL_BEATS_PER_BAR_DEFAULT, PROFESSIONAL_BEAT_DIVISIONS, PROFESSIONAL_LANE_ROW_HEIGHT, PROFESSIONAL_STEP_CORRECTION, PROFESSIONAL_STEP_TIMING,
} from "../constants"
import type { PitchEnvelopePoint, ProfessionalEditorProps, ProfessionalLane, ProfessionalPitchDisplayRange, ProfessionalSelectedPoint, ProfessionalSourceRange, ProfessionalWaveformRequest, ProfessionalZoomAnchor, TimelineSegment, VolumeEnvelopePoint } from "../types"
import { formatTime } from "./Timeline"

const initialPitchDisplayRange = (segments: TimelineSegment[]): ProfessionalPitchDisplayRange => {
  const maximumCents = segments.reduce((maximum, segment) => Math.max(
    maximum,
    ...(segment.pitch_envelope ?? []).map((point) => Math.abs(point.cents)),
  ), PROFESSIONAL_PITCH_DISPLAY_RANGE_DEFAULT_CENTS)
  return PROFESSIONAL_PITCH_DISPLAY_RANGES_CENTS.find((range) => range >= maximumCents)
    ?? PROFESSIONAL_PITCH_DISPLAY_RANGES_CENTS.at(-1)!
}

export const ProfessionalEditor = memo(function ProfessionalEditor(props: ProfessionalEditorProps) {
  const { visible, step, projectId, segments, selectedSegmentId, playheadMs, tempoBpm, beatsPerBar, beatDivision, gridOffsetUnits, onTempoChange, onBeatsPerBarChange, onBeatDivisionChange, onGridOffsetChange, onSelectSegment, onPlayheadChange, onApplyHandleDrag, onMoveTimelineSuffix, onBeginGesture, onEndGesture, onAddGuide, onRemoveGuide, onUpdatePitchEnvelope, onUpdateEnvelope, onUpdateSegment, onReorderSegment, onDeleteSegment } = props
  const timingStep = step === PROFESSIONAL_STEP_TIMING
  const correctionStep = step === PROFESSIONAL_STEP_CORRECTION
  const [scale, setScale] = useState(PROFESSIONAL_EDITOR_INITIAL_SCALE)
  const [pitchDisplayRange, setPitchDisplayRange] = useState<ProfessionalPitchDisplayRange>(() => initialPitchDisplayRange(segments))
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
  const gridBackgroundSize = `${barMs * scale}px 100%, ${barMs / 2 * scale}px 100%, ${barMs / 4 * scale}px 100%, ${gridMs * scale}px 100%`
  const firstVisibleBar = Math.ceil(Math.max(0, -gridOffsetMs) / barMs)
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
  useEffect(() => {
    if (selectedRange) {
      const segment = segments.find((item) => item.segment_id === selectedRange.segmentId)
      if (!segment) setSelectedRange(null)
      else if (!segment.edit_regions.some((region) => region.source_start_ms === selectedRange.startMs && region.source_end_ms === selectedRange.endMs)) {
        const region = segment.edit_regions[0]
        setSelectedRange(region ? { segmentId: segment.segment_id, startMs: region.source_start_ms, endMs: region.source_end_ms } : null)
      }
    }
    if (selectedPoint) {
      const segment = segments.find((item) => item.segment_id === selectedPoint.segmentId)
      const points = selectedPoint.lane === "pitch" ? segment?.pitch_envelope : segment?.volume_envelope
      if (!segment || !points?.[selectedPoint.index] || selectedPoint.position !== undefined && Math.abs(points[selectedPoint.index].position - selectedPoint.position) > PROFESSIONAL_ENVELOPE_POSITION_EPSILON) setSelectedPoint(null)
    }
  }, [segments, selectedPoint, selectedRange])
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
      if (event.ctrlKey) {
        event.preventDefault()
        if (!event.shiftKey) return
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
        return
      }
      if (event.shiftKey) {
        event.preventDefault()
        const rawDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
        const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? rawDelta * 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? rawDelta * node.clientWidth : rawDelta
        node.scrollLeft = Math.max(0, Math.min(node.scrollWidth - node.clientWidth, node.scrollLeft + delta))
        return
      }
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault()
        const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaX * 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? event.deltaX * node.clientWidth : event.deltaX
        node.scrollLeft = Math.max(0, Math.min(node.scrollWidth - node.clientWidth, node.scrollLeft + delta))
        return
      }
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
    if (!timingStep) return
    if (event.button !== 0) return
    event.preventDefault(); event.stopPropagation(); onSelectSegment(segment.segment_id)
    const region = segment.edit_regions[selectedIndex]
    if (region) setSelectedRange({ segmentId: segment.segment_id, startMs: region.source_start_ms, endMs: region.source_end_ms })
    if (event.ctrlKey && event.shiftKey) { dragSegment(event, segment); return }
    dragCleanup.current?.()
    const mode = event.shiftKey ? "shift" : event.ctrlKey ? "ctrl" : "normal"
    onBeginGesture()
    const startX = event.clientX
    const apply = (pointer: PointerEvent) => {
      const requestedDelta = (pointer.clientX - startX) / scale
      const boundaryStartMs = segment.timeline_start_ms + segment.edit_regions.slice(0, boundaryIndex).reduce((sum, item) => sum + item.output_duration_ms, 0)
      const requestedBoundaryMs = boundaryStartMs + requestedDelta
      const snappedBoundaryMs = gridOffsetMs + Math.round((requestedBoundaryMs - gridOffsetMs) / gridMs) * gridMs
      const delta = pointer.altKey || mode === "shift" ? requestedDelta : snappedBoundaryMs - boundaryStartMs
      const result = resizeProfessionalHandle(segment, selectedIndex, boundaryIndex, mode, delta)
      onApplyHandleDrag(segment, result.startMs, result.durations)
    }
    const finish = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish); dragCleanup.current = null; onEndGesture() }
    const move = (pointer: PointerEvent) => apply(pointer)
    dragCleanup.current = finish
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish); window.addEventListener("pointercancel", finish)
  }

  const dragSegment = (event: React.PointerEvent<HTMLElement>, segment: TimelineSegment) => {
    if (!timingStep || event.button !== 0 || event.altKey || !event.ctrlKey || !event.shiftKey) return
    event.preventDefault(); event.stopPropagation(); onSelectSegment(segment.segment_id); dragCleanup.current?.(); onBeginGesture()
    const startX = event.clientX
    const originals = segments
    const move = (pointer: PointerEvent) => onMoveTimelineSuffix(originals, segment.segment_id, (pointer.clientX - startX) / scale)
    const finish = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish); dragCleanup.current = null; onEndGesture() }
    dragCleanup.current = finish
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish); window.addEventListener("pointercancel", finish)
  }

  const dragSyllable = (event: React.PointerEvent<HTMLElement>, segment: TimelineSegment) => {
    if (!timingStep || event.button !== 0 || event.altKey || event.ctrlKey && event.shiftKey) return
    event.preventDefault(); event.stopPropagation(); selectIntervalAt(event, segment); dragCleanup.current?.(); onBeginGesture()
    const startX = event.clientX
    const move = (pointer: PointerEvent) => {
      const result = resizeProfessionalHandle(segment, 0, 0, "shift", (pointer.clientX - startX) / scale)
      onApplyHandleDrag(segment, result.startMs, result.durations)
    }
    const finish = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish); dragCleanup.current = null; onEndGesture() }
    dragCleanup.current = finish
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish); window.addEventListener("pointercancel", finish)
  }

  const backgroundPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest(".professional-audio-fragment, .professional-curve-fragment, .professional-timeline-tools, strong")) return
    onPlayheadChange(timeAt(event.clientX))
  }

  const pointContext = (event: React.MouseEvent<SVGSVGElement>, segment: TimelineSegment, lane: ProfessionalLane) => {
    event.preventDefault(); event.stopPropagation()
    if (!correctionStep) return
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
        const cents = Math.round((50 - (event.clientY - bounds.top) / bounds.height * 100) * pitchDisplayRange / (50 - PROFESSIONAL_CURVE_VERTICAL_INSET))
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
    if (!correctionStep || event.button !== 0) return
    event.preventDefault(); event.stopPropagation(); setSelectedPoint({ lane, segmentId: segment.segment_id, index, position: points[index].position }); onSelectSegment(segment.segment_id)
    const bounds = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
    if (!bounds) return
    const move = (pointer: PointerEvent) => {
      const previous = points[index - 1]?.position ?? 0
      const next = points[index + 1]?.position ?? 1
      const currentPosition = points[index].position
      const availableGap = Math.min(
        PROFESSIONAL_CURVE_POINT_MIN_GAP_PX / bounds.width,
        (currentPosition - previous) / 2,
        (next - currentPosition) / 2,
      )
      const min = index === 0 ? 0 : previous + availableGap
      const max = index === points.length - 1 ? 1 : next - availableGap
      const position = index === 0 ? 0 : index === points.length - 1 ? 1 : Math.max(min, Math.min(max, (pointer.clientX - bounds.left) / bounds.width))
      setSelectedPoint({ lane, segmentId: segment.segment_id, index, position })
      if (lane === "pitch") {
        const pitchPoints = points as PitchEnvelopePoint[]
        const cents = Math.round((50 - (pointer.clientY - bounds.top) / bounds.height * 100) * pitchDisplayRange / (50 - PROFESSIONAL_CURVE_VERTICAL_INSET))
        onUpdatePitchEnvelope(segment.segment_id, pitchPoints.map((point, item) => item === index ? { position, cents: Math.max(PROFESSIONAL_PITCH_MIN_CENTS, Math.min(PROFESSIONAL_PITCH_MAX_CENTS, cents)) } : point))
      } else {
        const volumePoints = points as VolumeEnvelopePoint[]
        const gain = Math.max(PROFESSIONAL_GAIN_MIN, Math.min(PROFESSIONAL_GAIN_MAX, (50 - (pointer.clientY - bounds.top) / bounds.height * 100) * PROFESSIONAL_GAIN_MAX / (50 - PROFESSIONAL_CURVE_VERTICAL_INSET)))
        onUpdateEnvelope(segment.segment_id, volumePoints.map((point, item) => item === index ? { position, gain } : point))
      }
    }
    dragCleanup.current?.(); onBeginGesture()
    const finish = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish); dragCleanup.current = null; onEndGesture() }
    dragCleanup.current = finish; window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish); window.addEventListener("pointercancel", finish)
  }

  const drawLane = (segment: TimelineSegment, lane: ProfessionalLane) => {
    const pitchLane = lane === "pitch"
    const points = pitchLane ? (segment.pitch_envelope?.length ? segment.pitch_envelope : [{ position: 0, cents: 0 }, { position: 1, cents: 0 }]) : (segment.volume_envelope?.length ? segment.volume_envelope : [{ position: 0, gain: 1 }, { position: 1, gain: 1 }])
    const y = (point: VolumeEnvelopePoint | PitchEnvelopePoint) => pitchLane ? 50 - ("cents" in point ? point.cents : 0) / pitchDisplayRange * (50 - PROFESSIONAL_CURVE_VERTICAL_INSET) : 50 - ("gain" in point ? point.gain : 1) / PROFESSIONAL_GAIN_MAX * (50 - PROFESSIONAL_CURVE_VERTICAL_INSET)
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

  return <section className={`vocal-editor professional-editor ${timingStep ? "timing-step" : "correction-step"}`} aria-label="전문 합성 타임라인 편집기" style={{ display: visible ? "flex" : "none" }}>
    <header className="vocal-timeline-header"><div><strong>{timingStep ? "배치·자르기·길이" : "피치·음량 보정"}</strong><span>{formatTime(playheadMs)} / {formatTime(totalMs)}</span></div><span>{timingStep ? "길이 조절은 눈금에 맞춤 · Alt+드래그: 자유 조절 · Ctrl+Shift+휠: 커서 기준 시간 확대·축소 · 세로 휠: 세로 이동 · Shift+휠: 가로 이동 · 우클릭: 분할점" : "Ctrl+Shift+휠: 커서 기준 시간 확대·축소 · 휠: 타임라인 이동 · 우클릭: 곡선 점 추가·삭제"}</span></header>
    {correctionStep && <div className="professional-timeline-tools"><label>피치 표시 범위 (±cent)<select aria-label="피치 그래프 표시 범위" value={pitchDisplayRange} onChange={(event) => setPitchDisplayRange(Number(event.target.value) as ProfessionalPitchDisplayRange)}>{PROFESSIONAL_PITCH_DISPLAY_RANGES_CENTS.map((range) => <option key={range} value={range}>±{range}</option>)}</select></label><span>표시 범위는 그래프 확대만 바꾸며, 피치 값은 cent 단위로 유지됩니다.</span></div>}
    {timingStep && <div className="professional-timeline-tools"><label>BPM<input aria-label="BPM" type="number" min={PROFESSIONAL_TEMPO_MIN_BPM} max={PROFESSIONAL_TEMPO_MAX_BPM} step="1" value={tempoText} onChange={(event) => { const value = event.target.value; setTempoText(value); const parsed = Number(value); if (Number.isInteger(parsed) && parsed >= PROFESSIONAL_TEMPO_MIN_BPM && parsed <= PROFESSIONAL_TEMPO_MAX_BPM) onTempoChange(parsed) }} onBlur={() => { const value = Math.max(PROFESSIONAL_TEMPO_MIN_BPM, Math.min(PROFESSIONAL_TEMPO_MAX_BPM, Math.trunc(Number(tempoText) || PROFESSIONAL_TEMPO_DEFAULT_BPM))); setTempoText(String(value)); onTempoChange(value) }}/></label><label>박자<input aria-label="박자" type="number" min={PROFESSIONAL_BEATS_PER_BAR_MIN} max={PROFESSIONAL_BEATS_PER_BAR_MAX} step="1" value={beatsText} onChange={(event) => { const value = event.target.value; setBeatsText(value); const parsed = Number(value); if (Number.isInteger(parsed) && parsed >= PROFESSIONAL_BEATS_PER_BAR_MIN && parsed <= PROFESSIONAL_BEATS_PER_BAR_MAX) onBeatsPerBarChange(parsed) }} onBlur={() => { const value = Math.max(PROFESSIONAL_BEATS_PER_BAR_MIN, Math.min(PROFESSIONAL_BEATS_PER_BAR_MAX, Math.trunc(Number(beatsText) || PROFESSIONAL_BEATS_PER_BAR_DEFAULT))); setBeatsText(String(value)); onBeatsPerBarChange(value) }}/></label><label>눈금<select aria-label="눈금" value={beatDivision} onChange={(event) => onBeatDivisionChange(Number(event.target.value) as typeof PROFESSIONAL_BEAT_DIVISIONS[number])}>{PROFESSIONAL_BEAT_DIVISIONS.map((value) => <option key={value} value={value}>1/{value}</option>)}</select></label><label>마디 오프셋 (1/96)<input aria-label="마디 오프셋 (1/96)" type="number" step="1" value={gridOffsetUnits} onChange={(event) => { const value = Number(event.target.value); if (Number.isSafeInteger(value)) onGridOffsetChange(value) }}/></label><span>{tempoBpm} BPM · {beatsPerBar}/4 · {formatTime(gridMs)} /눈금</span></div>}
    <div className="professional-timeline-scroll" ref={scrollRef} onPointerDownCapture={(event) => { const target = event.target as HTMLElement; if (event.button !== 0 || !event.ctrlKey || !event.shiftKey) return; const fragment = target.closest<HTMLElement>(".professional-audio-fragment"); const lane = fragment?.parentElement; const index = fragment && lane ? Array.from(lane.querySelectorAll(".professional-audio-fragment")).indexOf(fragment) : -1; const segment = index >= 0 ? segments[index] : undefined; if (segment) dragSegment(event, segment) }}>
      <div className="professional-timeline-content" data-playhead-ms={playheadMs} onPointerDown={backgroundPointerDown} style={{ width }}>
      <div className="professional-time-ruler" style={{ left: PROFESSIONAL_TIMELINE_LABEL_WIDTH }}>{Array.from({ length: Math.max(0, lastVisibleBar - firstVisibleBar + 1) }, (_, index) => { const bar = firstVisibleBar + index; return <span key={bar} style={{ left: (bar * barMs + gridOffsetMs) * scale }}>{index + 1}</span> })}</div>
      <div className="professional-grid-layer" aria-hidden="true" style={{ left: PROFESSIONAL_TIMELINE_LABEL_WIDTH, width: Math.max(0, width - PROFESSIONAL_TIMELINE_LABEL_WIDTH) }}><div className="professional-grid-before" style={{ width: Math.min(Math.max(0, gridOffsetMs * scale), width - PROFESSIONAL_TIMELINE_LABEL_WIDTH), backgroundImage: PROFESSIONAL_GRID_BACKGROUND_IMAGE, backgroundSize: gridBackgroundSize, backgroundPositionX: `${gridOffsetMs * scale}px` }}/><div className="professional-grid-after" style={{ left: Math.max(0, gridOffsetMs * scale), width: Math.max(0, width - PROFESSIONAL_TIMELINE_LABEL_WIDTH - Math.max(0, gridOffsetMs * scale)), backgroundImage: PROFESSIONAL_GRID_BACKGROUND_IMAGE, backgroundSize: gridBackgroundSize, backgroundPositionX: `${Math.min(0, gridOffsetMs) * scale}px` }}/></div>
      <div className="professional-audio-lane" style={{ minHeight: PROFESSIONAL_AUDIO_LANE_TOP_PADDING + laneCount * PROFESSIONAL_LANE_ROW_HEIGHT }}><strong>오디오</strong>{segments.map((segment) => { const range = selectedRange?.segmentId === segment.segment_id ? selectedRange : null; const rangeStart = range ? mapSourceToOutput(segment, range.startMs) : 0; const rangeEnd = range ? mapSourceToOutput(segment, range.endMs) : 0; const selectedIndex = range ? segment.edit_regions.findIndex((region) => region.source_start_ms === range.startMs && region.source_end_ms === range.endMs) : -1; const rangeRegion = selectedIndex >= 0 ? segment.edit_regions[selectedIndex] : null; return <div key={segment.segment_id} className={`professional-audio-fragment ${segment.segment_id === selectedSegmentId ? "selected" : ""}`} data-source-start-ms={segment.source_start_ms} data-source-end-ms={segment.source_end_ms} data-lane={segment.lane} style={{ left: PROFESSIONAL_TIMELINE_LABEL_WIDTH + pixelsAt(segment.timeline_start_ms), top: PROFESSIONAL_AUDIO_LANE_TOP_PADDING + segment.lane * PROFESSIONAL_LANE_ROW_HEIGHT, width: Math.max(0, pixelsAt(segment.timeline_end_ms - segment.timeline_start_ms)) }} onPointerDown={(event) => { if (event.button !== 0) return; if ((event.target as HTMLElement).closest(".professional-fragment-label, .professional-guides, .professional-edge-handle, .professional-range-selection")) return; event.preventDefault(); event.stopPropagation(); selectIntervalAt(event, segment) }} onContextMenu={(event) => { event.preventDefault(); if (timingStep && !(event.target as HTMLElement).closest(".professional-guides i")) onAddGuide(segment.segment_id, mapOutputToSource(segment, Math.max(0, Math.min(segment.timeline_end_ms - segment.timeline_start_ms, timeAt(event.clientX) - segment.timeline_start_ms)))) }} onDragOver={(event) => { if (timingStep) event.preventDefault() }} onDrop={(event) => { event.preventDefault(); if (timingStep) { const id = event.dataTransfer.getData("text/plain"); if (id) onReorderSegment(id, segment.segment_id) } }} title={timingStep ? "구간을 클릭하여 선택합니다. 우클릭하여 원본 분할점을 추가합니다." : "구간을 클릭하여 선택하고 피치·음량 곡선을 편집합니다."}><span className="professional-fragment-label" onPointerDown={(event) => { if (event.button !== 0) return; if (timingStep) dragSyllable(event, segment); else { event.stopPropagation(); selectIntervalAt(event, segment) } }}>{segment.target_ipa.join(" · ")}</span><div className="professional-fragment-body"><svg className="professional-waveform" viewBox={`0 0 ${PROFESSIONAL_WAVEFORM_VIEW_WIDTH} ${PROFESSIONAL_WAVEFORM_VIEW_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true"><polygon points={mapWaveformToOutput(segment, waveforms[waveformKey(segment)] ?? [])} /><line x1="0" x2={PROFESSIONAL_WAVEFORM_VIEW_WIDTH} y1={PROFESSIONAL_WAVEFORM_CENTER_Y} y2={PROFESSIONAL_WAVEFORM_CENTER_Y} /></svg></div><button className="professional-edge-handle left" aria-label="앞 경계" title="앞 경계" data-source-start-ms={segment.source_start_ms} data-source-end-ms={segment.source_start_ms} onPointerDown={(event) => dragHandle(event, segment, 0, 0)} onContextMenu={(event) => event.preventDefault()}/><button className="professional-edge-handle right" aria-label="뒤 경계" title="뒤 경계" data-source-start-ms={segment.source_end_ms} data-source-end-ms={segment.source_end_ms} onPointerDown={(event) => dragHandle(event, segment, segment.edit_regions.length - 1, segment.edit_regions.length)} onContextMenu={(event) => event.preventDefault()}/><div className="professional-guides">{segment.edit_regions.slice(1).map((region, index) => { const offset = segment.edit_regions.slice(0, index + 1).reduce((sum, item) => sum + item.output_duration_ms, 0); const userGuide = (segment.user_guide_source_ms ?? []).includes(region.source_start_ms) || !segment.phone_units.some((unit) => unit.source_start_ms === region.source_start_ms); return <i key={region.region_id} className={userGuide ? "user-guide" : "phone-guide"} data-source-start-ms={region.source_start_ms} data-source-end-ms={region.source_end_ms} style={{ left: `${offset / (segment.timeline_end_ms - segment.timeline_start_ms) * 100}%` }} title={userGuide ? "사용자 경계 (우클릭하여 제거)" : "음소 경계 (우클릭하여 사용자 표시 추가)"} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); if (timingStep) { if ((segment.user_guide_source_ms ?? []).includes(region.source_start_ms)) onRemoveGuide(segment.segment_id, region.region_id); else onAddGuide(segment.segment_id, region.source_start_ms) } }} onPointerDown={(event) => { const boundary = index + 1; const active = segment.edit_regions.findIndex((item) => item.source_start_ms === range?.startMs && item.source_end_ms === range?.endMs); const interval = active === boundary ? boundary : boundary - 1; dragHandle(event, segment, interval, boundary) }} />})}</div>{range && <div className="professional-range-selection" data-source-start-ms={range.startMs} data-source-end-ms={range.endMs} style={{ left: pixelsAt(rangeStart), width: Math.max(1, pixelsAt(rangeEnd - rangeStart)) }}>{rangeRegion && <><button aria-label="선택 구간 앞 경계" title="선택 구간 앞 경계" data-source-start-ms={rangeRegion.source_start_ms} data-source-end-ms={rangeRegion.source_start_ms} onPointerDown={(event) => dragHandle(event, segment, selectedIndex, selectedIndex)} onContextMenu={(event) => event.preventDefault()}/><button aria-label="선택 구간 뒤 경계" title="선택 구간 뒤 경계" data-source-start-ms={rangeRegion.source_end_ms} data-source-end-ms={rangeRegion.source_end_ms} onPointerDown={(event) => dragHandle(event, segment, selectedIndex, selectedIndex + 1)} onContextMenu={(event) => event.preventDefault()}/></>}</div>}{segment.gap_before_ms < 0 && <i className="professional-crossfade" style={{ width: pixelsAt(crossfadeWidth(segment)) }}/>}</div>})}</div>
        {correctionStep && (["pitch", "volume"] as const).map((lane) => <div className={`professional-curve-lane ${lane}`} key={lane} style={{ minHeight: laneCount * PROFESSIONAL_LANE_ROW_HEIGHT }}><strong>{lane === "pitch" ? "피치 (cent)" : "음량 (gain)"}</strong>{segments.map((segment) => <div key={segment.segment_id} className="professional-curve-fragment" data-lane={segment.lane} style={{ left: PROFESSIONAL_TIMELINE_LABEL_WIDTH + pixelsAt(segment.timeline_start_ms), top: segment.lane * PROFESSIONAL_LANE_ROW_HEIGHT, width: Math.max(0, pixelsAt(segment.timeline_end_ms - segment.timeline_start_ms)) }}>{drawLane(segment, lane)}</div>)}</div>)}
        <div className="professional-playhead" style={{ left: PROFESSIONAL_TIMELINE_LABEL_WIDTH + pixelsAt(playheadMs) }}/>
      </div>
    </div>
    {selected && <div className="professional-selection-tools"><strong>{selected.target_ipa.join(" · ")}</strong><span>{timingStep ? "일반 드래그는 공통 경계를 눈금에 맞추고, Ctrl은 앞이나 뒤 구간 길이를 눈금에 맞춥니다. Alt+드래그는 자유 길이 조절, Shift는 음절 전체 이동, Ctrl+Shift는 뒤 음절들을 함께 이동합니다." : "곡선의 점을 드래그하거나 우클릭하여 추가·삭제합니다."}</span>{correctionStep && (<label>피치 점 (cent)<input aria-label="피치 cent fine adjustment" type="number" min={PROFESSIONAL_PITCH_MIN_CENTS} max={PROFESSIONAL_PITCH_MAX_CENTS} step="1" disabled={selectedPoint?.lane !== "pitch" || selectedPoint.segmentId !== selected.segment_id} value={selected.pitch_envelope?.[selectedPoint?.index ?? -1]?.cents ?? 0} onChange={(event) => { const points = selected.pitch_envelope ?? [{ position: 0, cents: 0 }, { position: 1, cents: 0 }]; const index = selectedPoint?.index ?? -1; if (index >= 0) onUpdatePitchEnvelope(selected.segment_id, points.map((point, item) => item === index ? { ...point, cents: Math.max(PROFESSIONAL_PITCH_MIN_CENTS, Math.min(PROFESSIONAL_PITCH_MAX_CENTS, Math.trunc(Number.isFinite(Number(event.target.value)) ? Number(event.target.value) : 0))) } : point)) }}/></label>)}{correctionStep && (<label>음량 점 (gain)<input aria-label="음량 gain fine adjustment" type="number" min={0} max={2} step="0.01" disabled={selectedPoint?.lane !== "volume" || selectedPoint.segmentId !== selected.segment_id} value={selected.volume_envelope?.[selectedPoint?.index ?? -1]?.gain ?? 1} onChange={(event) => { const points = selected.volume_envelope ?? [{ position: 0, gain: 1 }, { position: 1, gain: 1 }]; const index = selectedPoint?.index ?? -1; if (index >= 0) onUpdateEnvelope(selected.segment_id, points.map((point, item) => item === index ? { ...point, gain: Math.max(PROFESSIONAL_GAIN_MIN, Math.min(PROFESSIONAL_GAIN_MAX, Number.isFinite(Number(event.target.value)) ? Number(event.target.value) : PROFESSIONAL_GAIN_MIN)) } : point)) }}/></label>)}{timingStep && (<label>단편 사이 크로스페이드 (ms)<input type="number" min="0" max={MAX_CROSSFADE_MS} disabled={segments[0]?.segment_id === selected.segment_id} value={selected.crossfade_ms ?? Math.max(0, Math.min(MAX_CROSSFADE_MS, -selected.gap_before_ms))} onChange={(event) => onUpdateSegment(selected.segment_id, { crossfade_ms: Math.max(0, Math.min(MAX_CROSSFADE_MS, Number.isFinite(Number(event.target.value)) ? Math.trunc(Number(event.target.value)) : 0)) })}/></label>)}{timingStep && (<button onClick={() => onDeleteSegment(selected.segment_id)}>단편 삭제</button>)}{hint && <span role="status">{hint}</span>}</div>}
  </section>
})

export { reorderSegments } from "../features/composition/timeline"
