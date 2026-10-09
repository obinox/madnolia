import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react"

import { analyzeCompositionPitch } from "../api/compositions"
import {
  PIANO_ROLL_ANALYSIS_DEBOUNCE_MS,
  PIANO_ROLL_NOTE_MIN_DURATION_MS,
  PIANO_ROLL_PITCH_POINT_MIN_GAP,
  PIANO_ROLL_SELECTION_DRAG_THRESHOLD_PX,
  PIANO_ROLL_BLACK_KEY_PITCH_CLASSES,
  PIANO_ROLL_GRID_BACKGROUND_IMAGE,
  PIANO_ROLL_SEGMENT_COLORS,
  PIANO_ROLL_KEYBOARD_WIDTH,
  PIANO_ROLL_SEMITONE_HEIGHT_DEFAULT,
  PIANO_ROLL_SEMITONE_HEIGHT_MAX,
  PIANO_ROLL_SEMITONE_HEIGHT_MIN,
  PIANO_ROLL_SELECTED_PHONE_SEPARATOR,
  PIANO_ROLL_SEMITONE_NAMES,
  PROFESSIONAL_EDITOR_INITIAL_SCALE,
  PROFESSIONAL_EDITOR_MAX_SCALE,
  PROFESSIONAL_EDITOR_MIN_SCALE,
  PIANO_ROLL_VOLUME_HEIGHT,
  PIANO_ROLL_VOLUME_MIN_LANE_HEIGHT,
  PIANO_ROLL_UNPITCHED_LANE_HEIGHT,
  PITCH_MAX_MIDI,
  PITCH_MIN_MIDI,
  PITCH_TARGET_STRENGTH_DEFAULT_PERCENT,
  PROFESSIONAL_BEATS_PER_BAR_DEFAULT,
  PROFESSIONAL_BEATS_PER_BAR_MAX,
  PROFESSIONAL_BEATS_PER_BAR_MIN,
  PROFESSIONAL_BEAT_DIVISIONS,
  PROFESSIONAL_TEMPO_DEFAULT_BPM,
  PROFESSIONAL_TEMPO_MAX_BPM,
  PROFESSIONAL_TEMPO_MIN_BPM,
  PITCH_TRANSITION_DEFAULT_MS,
  PITCH_TRANSITION_DEFAULT_STRENGTH,
  PITCH_VIBRATO_DEPTH_DEFAULT_CENTS,
  PITCH_VIBRATO_DEPTH_MAX_CENTS,
  PITCH_VIBRATO_RATE_DEFAULT_HZ,
  PITCH_VIBRATO_START_DEFAULT_MS,
  PROFESSIONAL_GAIN_MAX,
  PROFESSIONAL_GAIN_MIN,
} from "../constants"
import { phoneOutputInterval, phonePitchGroupRefs, phonePitchOwnerRef, pianoRollDraggedMidi, pianoRollSyllableGroups, pianoRollUncoveredRegionViews, sourceTimeToSegmentOutput } from "../features/composition/pianoRoll"
import type {
  PianoRollRegionRef,
  PitchAnalysisPhone,
  PitchAnalysisPoint,
  PitchAnalysisResponse,
  PianoRollEditorProps,
  PianoRollDragPitchBadge,
  PianoRollPhoneRef,
  PianoRollRegionView,
  PianoRollPitchNote,
  PianoRollSelectionBox,
  PianoRollSyllableGroup,
  PianoRollLoopRange,
  PianoRollZoomAnchor,
  ProfessionalBeatDivision,
  PhonePitchPoint,
  PhoneUnit,
  TimelineSegment,
  VolumeEnvelopePoint,
} from "../types"
import { formatTime } from "./Timeline"

function midiFromHz(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440)
}

function hzFromMidi(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12)
}

function phoneKey(segmentId: string, phoneId: string): string {
  return `${segmentId}${PIANO_ROLL_SELECTED_PHONE_SEPARATOR}${phoneId}`
}

function analysisPhone(response: PitchAnalysisResponse | null, segmentId: string, phoneId: string): PitchAnalysisPhone | null {
  return response?.segments.find((segment) => segment.segment_id === segmentId)?.phones.find((phone) => phone.phone_unit_id === phoneId) ?? null
}

function averageMidi(points: PitchAnalysisPoint[]): number | null {
  const voiced = points.filter((point) => point.hz !== null && point.hz > 0).map((point) => midiFromHz(point.hz!))
  return voiced.length ? voiced.reduce((sum, value) => sum + value, 0) / voiced.length : null
}

function interpolateMidi(points: PitchAnalysisPoint[], position: number): number | null {
  if (!points.length) return null
  const nextIndex = points.findIndex((point) => point.position >= position)
  if (nextIndex < 0) {
    const edge = points[points.length - 1]
    return edge.hz !== null && edge.hz > 0 ? midiFromHz(edge.hz) : null
  }
  const right = points[nextIndex]
  if (right.position === position) return right.hz !== null && right.hz > 0 ? midiFromHz(right.hz) : null
  if (nextIndex === 0) return right.hz !== null && right.hz > 0 ? midiFromHz(right.hz) : null
  const left = points[nextIndex - 1]
  if (left.hz === null || right.hz === null || left.hz <= 0 || right.hz <= 0) return null
  const amount = (position - left.position) / Math.max(Number.EPSILON, right.position - left.position)
  return midiFromHz(left.hz) + (midiFromHz(right.hz) - midiFromHz(left.hz)) * amount
}

function volumeEnvelope(segment: TimelineSegment) {
  return segment.volume_envelope.length ? segment.volume_envelope : [{ position: 0, gain: 1 }, { position: 1, gain: 1 }]
}

function midiLabel(midi: number): string {
  return `${PIANO_ROLL_SEMITONE_NAMES[((Math.round(midi) % 12) + 12) % 12]}${Math.floor(Math.round(midi) / 12) - 1}`
}

function phonePitchGroup(segments: TimelineSegment[], segmentId: string, phoneUnitId: string) {
  const segment = segments.find((item) => item.segment_id === segmentId)
  const phone = segment?.phone_units.find((item) => item.phone_unit_id === phoneUnitId)
  if (!segment || !phone) return null
  const owner = phonePitchOwnerRef(segment, phone)
  const ownerSegment = segments.find((item) => item.segment_id === owner.segment_id)
  const ownerPhone = ownerSegment?.phone_units.find((item) => item.phone_unit_id === owner.phone_unit_id)
  if (!ownerSegment || !ownerPhone) return null
  const members = phonePitchGroupRefs(segments, { segmentId, phoneUnitId }).flatMap((reference) => {
    const memberSegment = segments.find((item) => item.segment_id === reference.segmentId)
    const memberPhone = memberSegment?.phone_units.find((item) => item.phone_unit_id === reference.phoneUnitId)
    const interval = memberSegment && memberPhone ? phoneOutputInterval(memberSegment, memberPhone) : null
    return memberSegment && memberPhone && interval ? [{ segment: memberSegment, phone: memberPhone, interval }] : []
  }).sort((left, right) => left.segment.timeline_start_ms + left.interval.startMs - right.segment.timeline_start_ms - right.interval.startMs)
  if (!members.length) return null
  const startMs = Math.min(...members.map((member) => member.segment.timeline_start_ms + member.interval.startMs))
  const endMs = Math.max(...members.map((member) => member.segment.timeline_start_ms + member.interval.endMs))
  return { ownerSegment, ownerPhone, members, startMs, endMs }
}

function phonePitchGroupBaseMidi(group: NonNullable<ReturnType<typeof phonePitchGroup>>, response: PitchAnalysisResponse | null): number | null {
  const phone = group.ownerPhone
  if (phone.target_pitch_midi !== null && phone.target_pitch_midi !== undefined) return phone.target_pitch_midi
  if (phone.source_f0_hz !== null && phone.source_f0_hz > 0) return midiFromHz(phone.source_f0_hz)
  const measured = analysisPhone(response, group.ownerSegment.segment_id, phone.phone_unit_id)
  return measured ? averageMidi(measured.original) ?? averageMidi(measured.corrected) : null
}

function phonePitchGroupPoints(group: NonNullable<ReturnType<typeof phonePitchGroup>>, response: PitchAnalysisResponse | null): PhonePitchPoint[] {
  if (group.ownerPhone.pitch_points?.length) return group.ownerPhone.pitch_points
  const midi = phonePitchGroupBaseMidi(group, response)
  return midi === null ? [] : [{ position: 0, midi }, { position: 1, midi }]
}

function midiAtPhonePitch(points: PhonePitchPoint[], position: number): number | null {
  const rightIndex = points.findIndex((point) => point.position >= position)
  if (rightIndex < 0) return points.at(-1)?.midi ?? null
  if (rightIndex === 0) return points[0]?.midi ?? null
  const left = points[rightIndex - 1]
  const right = points[rightIndex]
  const amount = (position - left.position) / Math.max(Number.EPSILON, right.position - left.position)
  return left.midi + (right.midi - left.midi) * amount
}

function pitchEnvelopeCentsAtSourceTime(segment: TimelineSegment, sourceTimeMs: number): number {
  const points = segment.pitch_envelope ?? []
  if (!points.length) return 0
  const duration = segment.edit_regions.reduce((sum, region) => sum + region.output_duration_ms, 0)
  const position = sourceTimeToSegmentOutput(segment, sourceTimeMs) / Math.max(1, duration)
  const rightIndex = points.findIndex((point) => point.position >= position)
  if (rightIndex < 0) return points.at(-1)!.cents
  if (rightIndex === 0) return points[0].cents
  const left = points[rightIndex - 1]
  const right = points[rightIndex]
  const amount = (position - left.position) / Math.max(Number.EPSILON, right.position - left.position)
  return left.cents + (right.cents - left.cents) * amount
}

function regionPhoneLabel(segment: TimelineSegment, region: TimelineSegment["edit_regions"][number]): string {
  return segment.phone_units
    .filter((phone) => phone.source_start_ms !== null && phone.source_end_ms !== null && phone.source_start_ms < region.source_end_ms && phone.source_end_ms > region.source_start_ms)
    .map((phone) => phone.target_ipa ?? phone.source_ipa ?? "")
    .filter(Boolean)
    .join(" · ")
}

export function PianoRollEditor(props: PianoRollEditorProps) {
  const {
    visible, analysisHold, projectId, request, segments, pitchNotes, tempoBpm, beatsPerBar, beatDivision, gridOffsetUnits, selectedSegmentId, playheadMs, isPlaying, loopEnabled, auditionMode,
    onPlayheadChange, onSelectSegment, onTogglePlayback, onToggleLoop, onAuditionModeChange, onLoopRangeChange,
    onTempoChange, onBeatsPerBarChange, onBeatDivisionChange, onGridOffsetChange, onUpdatePitchNotes,
    onUpdatePhones, onUpdateEnvelope, onUpdateRegionPitchPoints, onUpdateRegionRangePitchPoints, onUpdateSyllablePitch, onBeginGesture, onEndGesture,
  } = props
  const [analysis, setAnalysis] = useState<PitchAnalysisResponse | null>(null)
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [analysisError, setAnalysisError] = useState("")
  const [retryIndex, setRetryIndex] = useState(0)
  const [timeScale, setTimeScale] = useState(PROFESSIONAL_EDITOR_INITIAL_SCALE)
  const [semitoneHeight, setSemitoneHeight] = useState(PIANO_ROLL_SEMITONE_HEIGHT_DEFAULT)
  const [viewportWidth, setViewportWidth] = useState(800)
  const [horizontalScrollLeft, setHorizontalScrollLeft] = useState(0)
  const [selectedPhones, setSelectedPhones] = useState<string[]>([])
  const [selectedRegion, setSelectedRegion] = useState<PianoRollRegionRef | null>(null)
  const [selectedSyllableKey, setSelectedSyllableKey] = useState("")
  const [selectedPitchNoteIds, setSelectedPitchNoteIds] = useState<string[]>([])
  const [pitchNoteSelectionBox, setPitchNoteSelectionBox] = useState<PianoRollSelectionBox | null>(null)
  const [pitchEditMessage, setPitchEditMessage] = useState("")
  const [dragPitchBadge, setDragPitchBadge] = useState<PianoRollDragPitchBadge | null>(null)
  const [selectedRegionView, setSelectedRegionView] = useState<PianoRollRegionView | null>(null)
  const [didInitialPitchCenter, setDidInitialPitchCenter] = useState(false)
  const [tempoText, setTempoText] = useState(String(tempoBpm))
  const [beatsText, setBeatsText] = useState(String(beatsPerBar))
  const timeScrollRef = useRef<HTMLDivElement | null>(null)
  const mainRef = useRef<HTMLDivElement | null>(null)
  const pitchScrollRef = useRef<HTMLDivElement | null>(null)
  const volumeScrollRef = useRef<HTMLDivElement | null>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const dragMoveRef = useRef<((pointer: globalThis.PointerEvent) => void) | null>(null)
  const lastPointerRef = useRef<globalThis.PointerEvent | null>(null)
  const semitoneHeightRef = useRef(semitoneHeight)
  semitoneHeightRef.current = semitoneHeight
  const pendingZoomAnchor = useRef<PianoRollZoomAnchor | null>(null)
  const pitchNoteSelectionBoxRef = useRef<PianoRollSelectionBox | null>(null)
  const selectedPitchNoteIdsRef = useRef(selectedPitchNoteIds)
  const suppressPitchNoteClickRef = useRef(false)
  selectedPitchNoteIdsRef.current = selectedPitchNoteIds
  const editorRef = useRef<HTMLElement | null>(null)
  const beatMs = 60000 / tempoBpm
  const barMs = beatMs * beatsPerBar
  const gridMs = beatMs * 4 / beatDivision
  const gridOffsetMs = gridOffsetUnits * beatMs / 24
  const requestKey = JSON.stringify([projectId, request.segments, request.pitch_notes])
  const totalMs = Math.max(1, ...segments.map((segment) => segment.timeline_end_ms))
  const scale = timeScale
  const rulerGridStyle = {
    backgroundImage: PIANO_ROLL_GRID_BACKGROUND_IMAGE,
    backgroundSize: `${barMs * scale}px 100%, ${barMs / 2 * scale}px 100%, ${barMs / 4 * scale}px 100%, ${gridMs * scale}px 100%`,
    backgroundPositionX: `${PIANO_ROLL_KEYBOARD_WIDTH + gridOffsetMs * scale}px`,
  }
  const gridStyle = {
    backgroundImage: PIANO_ROLL_GRID_BACKGROUND_IMAGE,
    backgroundSize: `${barMs * scale}px 100%, ${barMs / 2 * scale}px 100%, ${barMs / 4 * scale}px 100%, ${gridMs * scale}px 100%`,
    backgroundPositionX: `${gridOffsetMs * scale}px`,
  }
  const noteTimelineEndMs = pitchNotes.reduce((end, note) => Math.max(end, note.end_ms), totalMs)
  const contentWidth = Math.max(viewportWidth, noteTimelineEndMs * scale)
  const pitchRange = PITCH_MAX_MIDI - PITCH_MIN_MIDI + 1
  const pitchHeight = pitchRange * semitoneHeight + PIANO_ROLL_UNPITCHED_LANE_HEIGHT
  const volumeLaneCount = Math.max(1, ...segments.map((segment) => segment.lane + 1))
  const volumeChartHeight = Math.max(PIANO_ROLL_VOLUME_HEIGHT - 31, volumeLaneCount * PIANO_ROLL_VOLUME_MIN_LANE_HEIGHT)
  const volumeLaneHeight = volumeChartHeight / volumeLaneCount
  const syllableGroups = useMemo(() => pianoRollSyllableGroups(segments), [segments])
  const regionViews = useMemo(() => pianoRollUncoveredRegionViews(segments, syllableGroups), [segments, syllableGroups])
  const segmentColors = useMemo(() => {
    const ordered = [...segments].sort((left, right) => left.timeline_start_ms - right.timeline_start_ms || left.lane - right.lane || left.segment_id.localeCompare(right.segment_id))
    const nextIndexByLane = new Map<number, number>()
    const colors = new Map<string, string>()
    for (const segment of ordered) {
      const index = nextIndexByLane.get(segment.lane) ?? 0
      colors.set(segment.segment_id, PIANO_ROLL_SEGMENT_COLORS[index % PIANO_ROLL_SEGMENT_COLORS.length])
      nextIndexByLane.set(segment.lane, index + 1)
    }
    return colors
  }, [segments])
  const selectedSyllable = syllableGroups.find((group) => group.key === selectedSyllableKey) ?? null
  const selectedRefs = selectedPhones.map((key) => { const [segmentId, phoneUnitId] = key.split(PIANO_ROLL_SELECTED_PHONE_SEPARATOR); return { segmentId, phoneUnitId } })
  const selectedUnits = selectedRefs.map((reference) => ({
    reference,
    segment: segments.find((segment) => segment.segment_id === reference.segmentId)!,
    phone: segments.find((segment) => segment.segment_id === reference.segmentId)!.phone_units.find((unit) => unit.phone_unit_id === reference.phoneUnitId)!,
  }))
  const selectedRangeView = selectedRegionView ? regionViews.find((view) => view.segmentId === selectedRegionView.segmentId && view.sourceStartMs === selectedRegionView.sourceStartMs && view.sourceEndMs === selectedRegionView.sourceEndMs) ?? selectedRegionView : null
  const selectedPitchRegion = selectedRangeView
    ? segments.find((segment) => segment.segment_id === selectedRangeView.segmentId)?.edit_regions.find((region) => region.source_start_ms <= selectedRangeView.sourceStartMs && region.source_end_ms >= selectedRangeView.sourceEndMs)
    : selectedRegion ? segments.find((segment) => segment.segment_id === selectedRegion.segmentId)?.edit_regions.find((region) => region.region_id === selectedRegion.regionId) : null
  const selectedPhone = selectedUnits[0]?.phone ?? null
  const selectedRangePitchPoints = selectedRangeView?.pitchPoints ?? selectedPitchRegion?.pitch_points
  const selectedRangeSegment = selectedRangeView ? segments.find((segment) => segment.segment_id === selectedRangeView.segmentId) : null
  const selectedRangeSourceMid = selectedRangeView ? (selectedRangeView.sourceStartMs + selectedRangeView.sourceEndMs) / 2 : 0
  const selectedRangeEnvelopeCents = selectedRangeSegment ? pitchEnvelopeCentsAtSourceTime(selectedRangeSegment, selectedRangeSourceMid) : 0
  const selectedRangeMidi = selectedRangePitchPoints?.length
    ? (midiAtPhonePitch(selectedRangePitchPoints, 0.5) ?? 60) + (selectedPitchRegion?.relative_pitch_cents ?? 0) / 100 + selectedRangeEnvelopeCents / 100
    : selectedPitchRegion?.source_f0_hz && selectedPitchRegion.source_f0_hz > 0
      ? midiFromHz(selectedPitchRegion.source_f0_hz) + (selectedPitchRegion.relative_pitch_cents ?? 0) / 100 + selectedRangeEnvelopeCents / 100
      : selectedPhone?.target_pitch_midi ?? null
  const pitchCurveActive = Boolean(selectedRangePitchPoints?.length)

  useEffect(() => {
    const node = mainRef.current
    if (!node) return
    const observer = new ResizeObserver(() => setViewportWidth(Math.max(280, node.clientWidth - PIANO_ROLL_KEYBOARD_WIDTH)))
    observer.observe(node)
    setViewportWidth(Math.max(280, node.clientWidth - PIANO_ROLL_KEYBOARD_WIDTH))
    return () => observer.disconnect()
  }, [])

  useEffect(() => setTempoText(String(tempoBpm)), [tempoBpm])
  useEffect(() => setBeatsText(String(beatsPerBar)), [beatsPerBar])

  useLayoutEffect(() => {
    const anchor = pendingZoomAnchor.current
    const timeNode = timeScrollRef.current
    const pitchNode = pitchScrollRef.current
    if (!anchor || !timeNode || !pitchNode) return
    pendingZoomAnchor.current = null
    if (anchor.axis === "time") {
      timeNode.scrollLeft = Math.max(0, Math.min(timeNode.scrollWidth - timeNode.clientWidth, PIANO_ROLL_KEYBOARD_WIDTH + anchor.timeAtCursor * scale - anchor.cursorLocalX))
      syncScroll("time", timeNode.scrollLeft)
    } else {
      pitchNode.scrollTop = Math.max(0, Math.min(pitchNode.scrollHeight - pitchNode.clientHeight, (PITCH_MAX_MIDI - anchor.midiAtCursor) * semitoneHeight + semitoneHeight / 2 - anchor.cursorLocalY))
    }
  }, [scale, semitoneHeight])

  useEffect(() => {
    const node = editorRef.current
    if (!node) return
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      const pitchNode = pitchScrollRef.current
      const timeNode = timeScrollRef.current
      if (!pitchNode || !timeNode) return
      const delta = Math.max(-240, Math.min(240, event.deltaY))
      const factor = Math.exp(-delta * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 0.012 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 0.18 : 0.002))
      if (event.shiftKey) {
        const currentScale = timeScale
        const nextZoom = Math.max(PROFESSIONAL_EDITOR_MIN_SCALE, Math.min(PROFESSIONAL_EDITOR_MAX_SCALE, currentScale * factor))
        if (nextZoom === currentScale) return
        const bounds = timeNode.getBoundingClientRect()
        const cursorLocalX = event.clientX - bounds.left
        const currentScrollLeft = timeNode.scrollLeft
        pendingZoomAnchor.current = { axis: "time", cursorLocalX, cursorLocalY: 0, timeAtCursor: Math.max(0, (currentScrollLeft + cursorLocalX - PIANO_ROLL_KEYBOARD_WIDTH) / scale), midiAtCursor: 0 }
        setTimeScale(nextZoom)
      } else {
        if (!pitchNode.contains(event.target as Node)) return
        const currentHeight = semitoneHeight
        const nextHeight = Math.max(PIANO_ROLL_SEMITONE_HEIGHT_MIN, Math.min(PIANO_ROLL_SEMITONE_HEIGHT_MAX, currentHeight * factor))
        if (nextHeight === currentHeight) return
        const bounds = pitchNode.getBoundingClientRect()
        const cursorLocalY = event.clientY - bounds.top
        pendingZoomAnchor.current = { axis: "pitch", cursorLocalX: 0, cursorLocalY, timeAtCursor: 0, midiAtCursor: PITCH_MAX_MIDI - (pitchNode.scrollTop + cursorLocalY - currentHeight / 2) / currentHeight }
        setSemitoneHeight(nextHeight)
      }
    }
    node.addEventListener("wheel", wheel, { passive: false })
    return () => node.removeEventListener("wheel", wheel)
  }, [scale, semitoneHeight, timeScale])

  useEffect(() => {
    if (!visible || analysisHold) {
      setAnalysisLoading(false)
      return
    }
    const controller = new AbortController()
    setAnalysisLoading(true)
    setAnalysisError("")
    const runAnalysis = () => {
      if (controller.signal.aborted) return
      void analyzeCompositionPitch(projectId, request, controller.signal).then((result) => {
        if (!controller.signal.aborted) setAnalysis(result)
      }).catch((error: Error) => {
        if (!controller.signal.aborted) {
          setAnalysisError(error.message)
        }
      }).finally(() => {
        if (!controller.signal.aborted) setAnalysisLoading(false)
      })
    }
    let timer = window.setTimeout(runAnalysis, PIANO_ROLL_ANALYSIS_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [visible, analysisHold, projectId, requestKey, retryIndex])

  useLayoutEffect(() => {
    const node = pitchScrollRef.current
    if (didInitialPitchCenter || !visible || !node || node.clientHeight <= 0 || !segments.length) return
    const preferred = segments.flatMap((segment) => segment.edit_regions.map((region) => {
      const points = region.pitch_points ?? []
      const midi = points.length ? midiAtPhonePitch(points, 0.5) : region.source_f0_hz && region.source_f0_hz > 0 ? midiFromHz(region.source_f0_hz) : null
      return midi === null ? null : midi + region.relative_pitch_cents / 100
    })).filter((midi): midi is number => midi !== null)
    const analyzed = analysis?.segments.flatMap((segment) => (segment.regions?.length ? segment.regions : segment.phones).flatMap((region) => region.corrected.concat(region.original))) ?? []
    const measured = averageMidi(analyzed)
    if (analysisError) {
      setDidInitialPitchCenter(true)
      return
    }
    if (!preferred.length && measured === null && !analysis) return
    const centerMidi = preferred.length ? preferred.reduce((sum, midi) => sum + midi, 0) / preferred.length : measured ?? 60
    node.scrollTop = measured === null && preferred.length === 0
      ? Math.max(0, pitchHeight - node.clientHeight)
      : Math.max(0, yAtMidi(centerMidi) - node.clientHeight / 2)
    setDidInitialPitchCenter(true)
  }, [visible, segments, semitoneHeight, didInitialPitchCenter, analysis, analysisError, pitchHeight])

  useEffect(() => () => dragCleanupRef.current?.(), [])

  useEffect(() => {
    const activePitchNotes = new Set(pitchNotes.map((note) => note.note_id))
    setSelectedPitchNoteIds((current) => current.filter((noteId) => activePitchNotes.has(noteId)))
    const active = new Set(segments.flatMap((segment) => segment.phone_units.map((phone) => phoneKey(segment.segment_id, phone.phone_unit_id))))
    setSelectedPhones((current) => current.filter((phone) => active.has(phone)))
    if (selectedRegion && !segments.some((segment) => segment.segment_id === selectedRegion.segmentId && segment.edit_regions.some((region) => region.region_id === selectedRegion.regionId))) setSelectedRegion(null)
  }, [segments, selectedRegion, pitchNotes])

  const loopRange = useMemo<PianoRollLoopRange | null>(() => {
    if (selectedRegionView) {
      const segment = segments.find((item) => item.segment_id === selectedRegionView.segmentId)
      if (segment) return {
        startMs: segment.timeline_start_ms + sourceTimeToSegmentOutput(segment, selectedRegionView.sourceStartMs),
        endMs: segment.timeline_start_ms + sourceTimeToSegmentOutput(segment, selectedRegionView.sourceEndMs),
      }
    }
    if (selectedRegion) {
      const segment = segments.find((item) => item.segment_id === selectedRegion.segmentId)
      const region = segment?.edit_regions.find((item) => item.region_id === selectedRegion.regionId)
      if (segment && region) return {
        startMs: segment.timeline_start_ms + sourceTimeToSegmentOutput(segment, region.source_start_ms),
        endMs: segment.timeline_start_ms + sourceTimeToSegmentOutput(segment, region.source_end_ms),
      }
    }
    const selectedIntervals = selectedUnits.flatMap(({ reference, segment, phone }) => {
      const interval = phoneOutputInterval(segment, phone)
      return interval ? [{ startMs: segment.timeline_start_ms + interval.startMs, endMs: segment.timeline_start_ms + interval.endMs }] : []
    })
    if (!selectedIntervals.length) return null
    return { startMs: Math.min(...selectedIntervals.map((interval) => interval.startMs)), endMs: Math.max(...selectedIntervals.map((interval) => interval.endMs)) }
  }, [selectedRegionView, selectedRegion, selectedPhones, segments])

  useEffect(() => onLoopRangeChange(loopRange), [loopRange, onLoopRangeChange])

  const syncScroll = (source: "time" | "pitch" | "volume", scrollLeft: number) => {
    const sourceNode = source === "time" ? timeScrollRef.current : source === "pitch" ? pitchScrollRef.current : volumeScrollRef.current
    for (const target of [timeScrollRef.current, volumeScrollRef.current]) {
      if (target && target !== sourceNode && Math.abs(target.scrollLeft - scrollLeft) > 1) target.scrollLeft = scrollLeft
    }
    if (source === "time") setHorizontalScrollLeft(scrollLeft)
  }

  const xAt = (timeMs: number) => PIANO_ROLL_KEYBOARD_WIDTH + timeMs * scale
  const yAtMidi = (midi: number) => (PITCH_MAX_MIDI - midi) * semitoneHeight + semitoneHeight / 2
  const midiAtY = (clientY: number, bounds: DOMRect) => Math.max(PITCH_MIN_MIDI, Math.min(PITCH_MAX_MIDI, PITCH_MAX_MIDI - (clientY - bounds.top - semitoneHeight / 2) / semitoneHeight))
  const seekAt = (clientX: number, bounds: DOMRect) => onPlayheadChange(Math.max(0, Math.min(totalMs, (clientX - bounds.left) / scale)))
  const snapNoteTime = (timeMs: number, free: boolean) => Math.max(0, Math.round(free ? timeMs : gridOffsetMs + Math.round((timeMs - gridOffsetMs) / gridMs) * gridMs))
  const midiAtClientY = (clientY: number) => {
    const node = pitchScrollRef.current
    if (!node) return 60
    const contentY = clientY - node.getBoundingClientRect().top + node.scrollTop
    return Math.max(PITCH_MIN_MIDI, Math.min(PITCH_MAX_MIDI, PITCH_MAX_MIDI - (contentY - semitoneHeight / 2) / semitoneHeight))
  }
  const updatePitchNoteSelection = (update: (current: string[]) => string[]) => {
    setSelectedPitchNoteIds((current) => {
      const next = update(current)
      selectedPitchNoteIdsRef.current = next
      return next
    })
  }
  const pitchSelectionContentPoint = (clientX: number, clientY: number) => {
    const viewport = pitchScrollRef.current
    if (!viewport) return { x: 0, y: 0 }
    const bounds = viewport.getBoundingClientRect()
    return { x: clientX - bounds.left + (timeScrollRef.current?.scrollLeft ?? horizontalScrollLeft) - PIANO_ROLL_KEYBOARD_WIDTH, y: clientY - bounds.top + viewport.scrollTop }
  }
  const beginPitchNoteBoxSelection = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = pitchSelectionContentPoint(event.clientX, event.clientY)
    let moved = false
    const updateBox = (clientX: number, clientY: number) => {
      const point = pitchSelectionContentPoint(clientX, clientY)
      const box = { left: Math.min(start.x, point.x), top: Math.min(start.y, point.y), width: Math.abs(point.x - start.x), height: Math.abs(point.y - start.y) }
      pitchNoteSelectionBoxRef.current = box
      setPitchNoteSelectionBox(box)
      return point
    }
    event.preventDefault(); event.stopPropagation()
    updatePitchNoteSelection(() => [])
    setSelectedPhones([]); setSelectedRegion(null); setSelectedRegionView(null); setSelectedSyllableKey("")
    startGesture(event.nativeEvent, (pointer) => {
      if (!moved && Math.hypot(pointer.clientX - event.clientX, pointer.clientY - event.clientY) < PIANO_ROLL_SELECTION_DRAG_THRESHOLD_PX) return
      moved = true
      updateBox(pointer.clientX, pointer.clientY)
    }, () => {
      const box = pitchNoteSelectionBoxRef.current ?? { left: start.x, top: start.y, width: 0, height: 0 }
      const selected = pitchNotes.filter((note) => {
        const lowMidi = Math.min(...note.pitch_points.map((point) => point.midi))
        const highMidi = Math.max(...note.pitch_points.map((point) => point.midi))
        const noteLeft = note.start_ms * scale
        const noteRight = note.end_ms * scale
        const noteTop = yAtMidi(Math.min(PITCH_MAX_MIDI, highMidi + 0.5))
        const noteBottom = noteTop + Math.max(semitoneHeight, (Math.min(PITCH_MAX_MIDI, highMidi + 0.5) - Math.max(PITCH_MIN_MIDI, lowMidi - 0.5)) * semitoneHeight)
        return noteRight >= box.left && noteLeft <= box.left + box.width && noteBottom >= box.top && noteTop <= box.top + box.height
      }).map((note) => note.note_id)
      updatePitchNoteSelection(() => selected)
      pitchNoteSelectionBoxRef.current = null
      setPitchNoteSelectionBox(null)
    })
  }
  const createPitchNote = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest(".piano-region-note, .piano-syllable-note, .piano-target-note")) return
    if (event.shiftKey) { beginPitchNoteBoxSelection(event); return }
    event.preventDefault(); event.stopPropagation()
    updatePitchNoteSelection(() => [])
    const bounds = event.currentTarget.getBoundingClientRect()
    const initialTime = Math.max(0, (event.clientX - bounds.left) / scale)
    const initialMidi = Math.max(PITCH_MIN_MIDI, Math.min(PITCH_MAX_MIDI, Math.round(midiAtClientY(event.clientY))))
    const noteId = `note_${crypto.randomUUID()}`
    let created = false
    startGesture(event.nativeEvent, (pointer) => {
      const rawTime = Math.max(0, (pointer.clientX - bounds.left) / scale)
      if (!created && Math.abs(pointer.clientX - event.clientX) < 4) return
      created = true
      const startMs = snapNoteTime(Math.min(initialTime, rawTime), pointer.altKey)
      const snappedEnd = snapNoteTime(Math.max(initialTime, rawTime), pointer.altKey)
      const endMs = pointer.altKey ? Math.max(startMs + PIANO_ROLL_NOTE_MIN_DURATION_MS, snappedEnd) : Math.max(Math.round(startMs + Math.ceil(PIANO_ROLL_NOTE_MIN_DURATION_MS / gridMs) * gridMs), snappedEnd)
      const note: PianoRollPitchNote = { note_id: noteId, start_ms: startMs, end_ms: endMs, pitch_points: [{ position: 0, midi: initialMidi }, { position: 1, midi: initialMidi }] }
      updatePitchNoteSelection(() => [note.note_id])
      setSelectedPhones([]); setSelectedRegion(null); setSelectedRegionView(null); setSelectedSyllableKey("")
      onUpdatePitchNotes([...pitchNotes, note])
    }, () => { if (!created) seekAt(event.clientX, bounds) })
  }
  const movePitchNote = (event: React.PointerEvent<HTMLButtonElement>, note: PianoRollPitchNote) => {
    if (event.button !== 0) return
    event.preventDefault(); event.stopPropagation()
    const noteWasSelected = selectedPitchNoteIdsRef.current.includes(note.note_id)
    const selectedIds = noteWasSelected ? selectedPitchNoteIdsRef.current : event.ctrlKey || event.metaKey ? [...selectedPitchNoteIdsRef.current, note.note_id] : [note.note_id]
    if (!noteWasSelected && !event.ctrlKey && !event.metaKey) updatePitchNoteSelection(() => selectedIds)
    setSelectedPhones([]); setSelectedRegion(null); setSelectedRegionView(null); setSelectedSyllableKey("")
    const startX = event.clientX
    const startY = event.clientY
    let moved = false
    startGesture(event.nativeEvent, (pointer) => {
      if (!moved && Math.hypot(pointer.clientX - startX, pointer.clientY - startY) < PIANO_ROLL_SELECTION_DRAG_THRESHOLD_PX) return
      moved = true
      suppressPitchNoteClickRef.current = true
      updatePitchNoteSelection(() => selectedIds)
      const group = pitchNotes.filter((item) => selectedIds.includes(item.note_id))
      const groupMinStart = Math.min(...group.map((item) => item.start_ms))
      const rawDeltaMs = (pointer.clientX - startX) / scale
      const snappedDeltaMs = snapNoteTime(note.start_ms + rawDeltaMs, pointer.altKey) - note.start_ms
      const deltaMs = Math.max(-groupMinStart, snappedDeltaMs)
      const rawDeltaMidi = (startY - pointer.clientY) / semitoneHeight
      const snappedDeltaMidi = pointer.ctrlKey || event.ctrlKey ? rawDeltaMidi : Math.round(rawDeltaMidi)
      const minimumMidi = Math.min(...group.flatMap((item) => item.pitch_points.map((point) => point.midi)))
      const maximumMidi = Math.max(...group.flatMap((item) => item.pitch_points.map((point) => point.midi)))
      const deltaMidi = Math.max(PITCH_MIN_MIDI - minimumMidi, Math.min(PITCH_MAX_MIDI - maximumMidi, snappedDeltaMidi))
      onUpdatePitchNotes(pitchNotes.map((item) => selectedIds.includes(item.note_id) ? {
        ...item,
        start_ms: item.start_ms + deltaMs,
        end_ms: item.end_ms + deltaMs,
        pitch_points: item.pitch_points.map((point) => ({ ...point, midi: point.midi + deltaMidi })),
      } : item))
      setDragPitchBadge({ midi: note.pitch_points[0].midi + deltaMidi, x: pointer.clientX + 14, y: pointer.clientY - 22 })
    }, () => { if (moved) window.setTimeout(() => { suppressPitchNoteClickRef.current = false }, 0) })
  }
  const resizePitchNote = (event: React.PointerEvent<HTMLSpanElement>, note: PianoRollPitchNote) => {
    if (event.button !== 0) return
    event.preventDefault(); event.stopPropagation(); updatePitchNoteSelection(() => [note.note_id])
    const startX = event.clientX
    startGesture(event.nativeEvent, (pointer) => {
      const endMs = snapNoteTime(note.end_ms + (pointer.clientX - startX) / scale, pointer.altKey)
      if (endMs - note.start_ms < PIANO_ROLL_NOTE_MIN_DURATION_MS) return
      onUpdatePitchNotes(pitchNotes.map((item) => item.note_id === note.note_id ? { ...note, end_ms: endMs } : item))
    })
  }
  const dragPitchNotePoint = (event: React.PointerEvent<SVGCircleElement>, note: PianoRollPitchNote, index: number) => {
    if (event.button !== 0) return
    event.preventDefault(); event.stopPropagation(); updatePitchNoteSelection(() => [note.note_id])
    const svg = event.currentTarget.ownerSVGElement!
    const bounds = svg.getBoundingClientRect()
    startGesture(event.nativeEvent, (pointer) => {
      const position = index === 0 ? 0 : index === note.pitch_points.length - 1 ? 1 : (() => {
        const left = note.pitch_points[index - 1].position
        const right = note.pitch_points[index + 1].position
        const gap = Math.min(PIANO_ROLL_PITCH_POINT_MIN_GAP, (right - left) / 2)
        return Math.max(left + gap, Math.min(right - gap, (pointer.clientX - bounds.left) / bounds.width))
      })()
      const midi = midiAtClientY(pointer.clientY)
      const points = note.pitch_points.map((point, item) => item === index ? { ...point, position, midi } : point).sort((left, right) => left.position - right.position)
      onUpdatePitchNotes(pitchNotes.map((item) => item.note_id === note.note_id ? { ...note, pitch_points: points } : item))
      setDragPitchBadge({ midi, x: pointer.clientX + 14, y: pointer.clientY - 22 })
    })
  }
  const addPitchNotePoint = (event: React.MouseEvent<HTMLButtonElement>, note: PianoRollPitchNote) => {
    event.preventDefault(); event.stopPropagation()
    const bounds = event.currentTarget.getBoundingClientRect()
    const position = Math.max(PIANO_ROLL_PITCH_POINT_MIN_GAP, Math.min(1 - PIANO_ROLL_PITCH_POINT_MIN_GAP, (event.clientX - bounds.left) / bounds.width))
    if (note.pitch_points.some((point) => Math.abs(point.position - position) < PIANO_ROLL_PITCH_POINT_MIN_GAP)) return
    const midi = midiAtClientY(event.clientY)
    const points = [...note.pitch_points, { position, midi }].sort((left, right) => left.position - right.position)
    updatePitchNoteSelection(() => [note.note_id])
    onUpdatePitchNotes(pitchNotes.map((item) => item.note_id === note.note_id ? { ...note, pitch_points: points } : item))
  }
  const deleteSelectedPitchNote = () => {
    if (!selectedPitchNoteIdsRef.current.length || dragCleanupRef.current || analysisHold) return
    const selected = new Set(selectedPitchNoteIdsRef.current)
    onUpdatePitchNotes(pitchNotes.filter((note) => !selected.has(note.note_id)))
    updatePitchNoteSelection(() => [])
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!visible || !selectedPitchNoteIdsRef.current.length || event.isComposing || event.keyCode === 229 || !["Delete", "Backspace"].includes(event.key)) return
      if (event.target instanceof HTMLElement && (event.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName))) return
      event.preventDefault(); deleteSelectedPitchNote()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [visible, selectedPitchNoteIds, pitchNotes, analysisHold, onUpdatePitchNotes])
  const syllableMidi = (group: PianoRollSyllableGroup): number | null => {
    const segment = segments.find((item) => item.segment_id === group.nucleus.segmentId)
    const phone = segment?.phone_units.find((item) => item.phone_unit_id === group.nucleus.phoneUnitId)
    if (!segment || !phone) return null
    const nucleusMid = ((phone.source_start_ms ?? segment.source_start_ms) + (phone.source_end_ms ?? segment.source_end_ms)) / 2
    const region = segment.edit_regions.find((item) => item.source_start_ms <= nucleusMid && item.source_end_ms > nucleusMid)
    if (region?.pitch_points?.length) {
      const regionPosition = (nucleusMid - region.source_start_ms) / Math.max(1, region.source_end_ms - region.source_start_ms)
      const outputMs = sourceTimeToSegmentOutput(segment, nucleusMid)
      const outputDuration = segment.edit_regions.reduce((sum, item) => sum + item.output_duration_ms, 0)
      const envelopePoints = segment.pitch_envelope ?? []
      let envelopeCents = 0
      if (envelopePoints.length) {
        const position = outputMs / Math.max(1, outputDuration)
        const rightIndex = envelopePoints.findIndex((point) => point.position >= position)
        if (rightIndex < 0) envelopeCents = envelopePoints.at(-1)!.cents
        else if (rightIndex === 0) envelopeCents = envelopePoints[0].cents
        else {
          const left = envelopePoints[rightIndex - 1]
          const right = envelopePoints[rightIndex]
          const amount = (position - left.position) / Math.max(Number.EPSILON, right.position - left.position)
          envelopeCents = left.cents + (right.cents - left.cents) * amount
        }
      }
      return (midiAtPhonePitch(region.pitch_points, regionPosition) ?? 60) + region.relative_pitch_cents / 100 + envelopeCents / 100
    }
    if (phone.target_pitch_midi !== null && phone.target_pitch_midi !== undefined) return phone.target_pitch_midi
    const measured = analysisPhone(analysis, segment.segment_id, phone.phone_unit_id)
    const measuredPhoneMidi = measured ? averageMidi(measured.original) : null
    if (measuredPhoneMidi !== null) return measuredPhoneMidi
    const measuredRegion = analysis?.segments.find((item) => item.segment_id === segment.segment_id)?.regions?.find((item) => item.source_start_ms < (phone.source_end_ms ?? 0) && item.source_end_ms > (phone.source_start_ms ?? Number.POSITIVE_INFINITY))
    const measuredRegionMidi = measuredRegion ? averageMidi(measuredRegion.original) : null
    if (measuredRegionMidi !== null) return measuredRegionMidi
    if (phone.source_f0_hz && phone.source_f0_hz > 0) return midiFromHz(phone.source_f0_hz)
    return region?.source_f0_hz && region.source_f0_hz > 0 ? midiFromHz(region.source_f0_hz) : null
  }

  const applySyllablePitch = (group: PianoRollSyllableGroup, midi: number | null) => {
    const applied = onUpdateSyllablePitch(group, midi)
    setPitchEditMessage(applied ? "" : "경계, 피치 자동화 또는 공유 피치 연결을 안전하게 처리할 수 없어 변경하지 않았습니다. 구간 경계를 조정하거나 연결된 피치를 먼저 정리하세요.")
    return applied
  }

  const startGesture = (event: globalThis.PointerEvent, move: (pointer: globalThis.PointerEvent) => void, finishGesture?: () => void) => {
    if (event.button !== 0) return
    event.preventDefault()
    dragCleanupRef.current?.()
    onBeginGesture()
    dragMoveRef.current = move
    lastPointerRef.current = event
    const onMove = (pointer: globalThis.PointerEvent) => {
      lastPointerRef.current = pointer
      dragMoveRef.current?.(pointer)
    }
    const finish = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", finish)
      window.removeEventListener("pointercancel", finish)
      if (dragCleanupRef.current === finish) dragCleanupRef.current = null
      dragMoveRef.current = null
      lastPointerRef.current = null
      setDragPitchBadge(null)
      finishGesture?.()
      onEndGesture()
    }
    dragCleanupRef.current = finish
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", finish)
    window.addEventListener("pointercancel", finish)
  }

  const replayDragOnPitchScroll = () => {
    const pointer = lastPointerRef.current
    if (pointer) dragMoveRef.current?.(pointer)
  }

  const choosePhone = (segmentId: string, phoneId: string, event: ReactMouseEvent) => {
    updatePitchNoteSelection(() => [])
    setSelectedSyllableKey("")
    const groupRefs = phonePitchGroupRefs(segments, { segmentId, phoneUnitId: phoneId })
    const keys = groupRefs.map((reference) => phoneKey(reference.segmentId, reference.phoneUnitId))
    onSelectSegment(segmentId)
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      setSelectedPhones((current) => keys.some((key) => current.includes(key)) ? current.filter((item) => !keys.includes(item)) : [...new Set([...current, ...keys])])
    } else setSelectedPhones(keys)
  }

  const updateSelectedPhones = (updates: Partial<PhoneUnit>) => {
    if (selectedRefs.length) onUpdatePhones(selectedRefs, updates)
  }

  const firstVisibleBar = Math.ceil(Math.max(0, -gridOffsetMs) / barMs)
  const lastVisibleBar = Math.floor((noteTimelineEndMs - gridOffsetMs) / barMs)
  const bars = Array.from({ length: Math.max(0, lastVisibleBar - firstVisibleBar + 1) }, (_, index) => firstVisibleBar + index)
  const pitchY = (midi: number) => yAtMidi(Math.max(PITCH_MIN_MIDI, Math.min(PITCH_MAX_MIDI, midi)))
  const selectedPitchNotes = pitchNotes.filter((note) => selectedPitchNoteIds.includes(note.note_id))

  return <section ref={editorRef} className={`piano-roll-editor ${selectedSyllable ? "syllable-selected" : ""} ${selectedRegionView ? "region-range-selected" : ""} ${selectedPitchNoteIds.length ? "target-note-selected" : ""}`} title="Ctrl+드래그: 음정 미세 이동 · Ctrl+휠: 피치 확대/축소 · Ctrl+Shift+휠: 시간 확대/축소" aria-label="음소 피아노 롤 편집기" style={{ display: visible ? "flex" : "none" }}>
    <div className="piano-roll-toolbar">
      <div className="piano-roll-transport">
        <button type="button" onClick={onTogglePlayback}>{isPlaying ? "일시정지" : "재생"}</button>
        <button type="button" className={loopEnabled ? "active" : ""} disabled={!loopRange} onClick={onToggleLoop}>선택 구간 반복</button>
        <button type="button" className={auditionMode === "corrected" ? "active" : ""} onClick={() => onAuditionModeChange("corrected")}>보정 후</button>
        <button type="button" className={auditionMode === "original" ? "active" : ""} onClick={() => onAuditionModeChange("original")}>원본 비교</button>
        <span>{formatTime(playheadMs)} / {formatTime(totalMs)}</span>
      </div>
      <label>{"\uC2DC\uAC04 \uD655\uB300"}<input aria-label={"\uC2DC\uAC04 \uD655\uB300"} type="range" min={PROFESSIONAL_EDITOR_MIN_SCALE} max={PROFESSIONAL_EDITOR_MAX_SCALE} step="0.005" value={timeScale} onChange={(event) => setTimeScale(Number(event.target.value))}/><small>{(timeScale / PROFESSIONAL_EDITOR_INITIAL_SCALE).toFixed(1)}{"\u00d7"}</small></label>
      <label>{"\uD53C\uCE58 \uD655\uB300"}<input aria-label={"\uD53C\uCE58 \uD655\uB300"} type="range" min={PIANO_ROLL_SEMITONE_HEIGHT_MIN} max={PIANO_ROLL_SEMITONE_HEIGHT_MAX} step="0.1" value={semitoneHeight} onChange={(event) => setSemitoneHeight(Number(event.target.value))}/><small>{(semitoneHeight / PIANO_ROLL_SEMITONE_HEIGHT_DEFAULT).toFixed(1)}{"\u00d7"}</small></label>
      <button type="button" onClick={() => { if (pitchScrollRef.current) pitchScrollRef.current.scrollTop = Math.max(0, pitchHeight - pitchScrollRef.current.clientHeight) }}>무성 음소 보기</button>
    </div>

    <div className="piano-roll-grid-controls" aria-label="마디 그리드 설정">
      <label>BPM<input aria-label="BPM" type="number" min={PROFESSIONAL_TEMPO_MIN_BPM} max={PROFESSIONAL_TEMPO_MAX_BPM} value={tempoText} onChange={(event) => { const text = event.target.value; setTempoText(text); const value = Number(text); if (Number.isInteger(value) && value >= PROFESSIONAL_TEMPO_MIN_BPM && value <= PROFESSIONAL_TEMPO_MAX_BPM) onTempoChange(value) }} onBlur={() => { const value = Math.max(PROFESSIONAL_TEMPO_MIN_BPM, Math.min(PROFESSIONAL_TEMPO_MAX_BPM, Math.trunc(Number(tempoText) || PROFESSIONAL_TEMPO_DEFAULT_BPM))); setTempoText(String(value)); onTempoChange(value) }}/></label>
      <label>{"\uBC15\uC790/\uB9C8\uB514"}<input aria-label="&#48149;&#51088;/&#47560;&#46356;" type="number" min={PROFESSIONAL_BEATS_PER_BAR_MIN} max={PROFESSIONAL_BEATS_PER_BAR_MAX} value={beatsText} onChange={(event) => { const text = event.target.value; setBeatsText(text); const value = Number(text); if (Number.isInteger(value) && value >= PROFESSIONAL_BEATS_PER_BAR_MIN && value <= PROFESSIONAL_BEATS_PER_BAR_MAX) onBeatsPerBarChange(value) }} onBlur={() => { const value = Math.max(PROFESSIONAL_BEATS_PER_BAR_MIN, Math.min(PROFESSIONAL_BEATS_PER_BAR_MAX, Math.trunc(Number(beatsText) || PROFESSIONAL_BEATS_PER_BAR_DEFAULT))); setBeatsText(String(value)); onBeatsPerBarChange(value) }}/></label>
      <label>{"\uB208\uAE08"}<select aria-label="&#45576;&#44552;" value={beatDivision} onChange={(event) => onBeatDivisionChange(Number(event.target.value) as ProfessionalBeatDivision)}>{PROFESSIONAL_BEAT_DIVISIONS.map((value) => <option key={value} value={value}>1/{value}</option>)}</select></label>
      <label>{"\uB9C8\uB514 \uC624\uD504\uC14B (1/96)"}<input aria-label="&#47560;&#46356; &#50724;&#54532;&#49483; (1/96)" type="number" step="1" value={gridOffsetUnits} onChange={(event) => { const value = Number(event.target.value); if (Number.isSafeInteger(value)) onGridOffsetChange(value) }}/></label>
    </div>

    <div className="piano-roll-analysis-slot" aria-live="polite">
      {(analysisLoading || analysisError) && <div className={`piano-roll-analysis ${analysisError ? "error" : ""}`} role={analysisError ? "alert" : "status"}>
        {analysisLoading ? "실제 원본·보정 피치 분석 중…" : <><span title={analysisError}>피치 분석을 불러오지 못했습니다. {analysisError}</span><button type="button" onClick={() => setRetryIndex((value) => value + 1)}>다시 시도</button></>}
      </div>}
    </div>

    <div className="piano-roll-main" ref={mainRef}>
      <div className="piano-roll-horizontal-viewport">
        <div className="piano-roll-ruler-viewport">
          <div className="piano-roll-ruler" style={{ ...rulerGridStyle, width: PIANO_ROLL_KEYBOARD_WIDTH + contentWidth, transform: `translateX(-${horizontalScrollLeft}px)` }}>{bars.map((bar) => { const time = bar * barMs + gridOffsetMs; return <span key={bar} style={{ left: xAt(time), transform: time >= totalMs ? "translateX(-100%)" : undefined }}>{bar + 1}</span> })}</div>
          <strong className="piano-roll-ruler-label">{"\uB9C8\uB514"}</strong>
        </div>
        <div className="piano-roll-pitch-scroll" ref={pitchScrollRef} onScroll={replayDragOnPitchScroll}>
        <div className="piano-roll-pitch-content" style={{ width: PIANO_ROLL_KEYBOARD_WIDTH + contentWidth, height: pitchHeight, "--semitone-height": `${semitoneHeight}px` } as CSSProperties}>
          <div className="piano-roll-keyboard" style={{ width: PIANO_ROLL_KEYBOARD_WIDTH, height: pitchHeight }}>
            {Array.from({ length: pitchRange }, (_, index) => PITCH_MAX_MIDI - index).map((midi) => { const black = PIANO_ROLL_BLACK_KEY_PITCH_CLASSES.includes((midi % 12) as typeof PIANO_ROLL_BLACK_KEY_PITCH_CLASSES[number]); return <span key={midi} className={`${black ? "black-key" : "white-key"} ${midi % 12 === 0 ? "octave" : ""}`} style={{ height: semitoneHeight }}>{midiLabel(midi)}</span> })}
            <span className="unpitched-key" style={{ height: PIANO_ROLL_UNPITCHED_LANE_HEIGHT }}>무성</span>
          </div>
          <div className="piano-roll-chart-content" style={{ width: PIANO_ROLL_KEYBOARD_WIDTH + contentWidth, height: pitchHeight, transform: `translateX(-${horizontalScrollLeft}px)` }}>
          <div className="piano-roll-chart" style={{ left: PIANO_ROLL_KEYBOARD_WIDTH, width: contentWidth, height: pitchHeight }} onPointerDown={createPitchNote} onContextMenu={(event) => event.preventDefault()}>
            <div className="piano-roll-bpm-grid" style={gridStyle}/>
            {Array.from({ length: pitchRange }, (_, index) => { const midi = PITCH_MAX_MIDI - index; const black = PIANO_ROLL_BLACK_KEY_PITCH_CLASSES.includes((midi % 12) as typeof PIANO_ROLL_BLACK_KEY_PITCH_CLASSES[number]); return <i key={`pitch-${index}`} className={`piano-pitch-gridline ${black ? "black-key" : "white-key"} ${midi % 12 === 0 ? "octave" : ""}`} style={{ top: index * semitoneHeight, height: semitoneHeight }}/ > })}
            {pitchNotes.map((note) => {
              const minimumMidi = Math.min(...note.pitch_points.map((point) => point.midi))
              const maximumMidi = Math.max(...note.pitch_points.map((point) => point.midi))
              const topMidi = Math.min(PITCH_MAX_MIDI, maximumMidi + 0.5)
              const top = yAtMidi(topMidi)
              const height = Math.max(semitoneHeight, (topMidi - Math.max(PITCH_MIN_MIDI, minimumMidi - 0.5)) * semitoneHeight)
              const noteWidth = Math.max(6, (note.end_ms - note.start_ms) * scale)
              const points = note.pitch_points.map((point) => `${point.position * noteWidth},${(topMidi - point.midi) * semitoneHeight}`).join(" ")
              const selected = selectedPitchNoteIds.includes(note.note_id)
              return <button key={note.note_id} type="button" className={`piano-target-note ${selected ? "selected" : ""}`} data-note-id={note.note_id} data-start-ms={note.start_ms} data-end-ms={note.end_ms} aria-label={`목표 음정 ${midiLabel(note.pitch_points[0].midi)}`} title="드래그: 선택 노트 이동 · Ctrl+클릭: 선택 전환 · 우클릭: 음정 곡선 점 추가" style={{ left: note.start_ms * scale, top, width: noteWidth, height }} onClick={(event) => {
                if (suppressPitchNoteClickRef.current) { suppressPitchNoteClickRef.current = false; return }
                if (event.ctrlKey || event.metaKey) updatePitchNoteSelection((current) => current.includes(note.note_id) ? current.filter((id) => id !== note.note_id) : [...current, note.note_id])
                else if (!selectedPitchNoteIdsRef.current.includes(note.note_id)) updatePitchNoteSelection(() => [note.note_id])
              }} onContextMenu={(event) => addPitchNotePoint(event, note)} onPointerDown={(event) => movePitchNote(event, note)}>
                <svg viewBox={`0 0 ${noteWidth} ${height}`} preserveAspectRatio="none" aria-hidden="true"><polyline points={points}/>{note.pitch_points.map((point, index) => <circle key={`${point.position}:${index}`} cx={point.position * noteWidth} cy={(topMidi - point.midi) * semitoneHeight} r="5" onPointerDown={(event) => dragPitchNotePoint(event, note, index)} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); if (index > 0 && index < note.pitch_points.length - 1) onUpdatePitchNotes(pitchNotes.map((item) => item.note_id === note.note_id ? { ...note, pitch_points: note.pitch_points.filter((_, itemIndex) => itemIndex !== index) } : item)) }}/>)}</svg>
                <span className="piano-target-note-resize" onPointerDown={(event) => resizePitchNote(event, note)}/>
              </button>
            })}
            {pitchNoteSelectionBox && <i className="piano-note-selection-box" aria-hidden="true" style={{ left: pitchNoteSelectionBox.left, top: pitchNoteSelectionBox.top, width: pitchNoteSelectionBox.width, height: pitchNoteSelectionBox.height }} />}
            {regionViews.map((view) => {
              const segment = segments.find((item) => item.segment_id === view.segmentId)
              const region = segment?.edit_regions.find((item) => item.region_id === view.regionId && item.source_start_ms <= view.sourceStartMs && item.source_end_ms >= view.sourceEndMs)
              if (!segment || !region) return null
              const startMs = sourceTimeToSegmentOutput(segment, view.sourceStartMs)
              const endMs = sourceTimeToSegmentOutput(segment, view.sourceEndMs)
              const points = view.pitchPoints ?? []
              const measuredRegions = analysis?.segments.find((item) => item.segment_id === segment.segment_id)?.regions ?? []
              const measuredRegion = measuredRegions.find((item) => item.region_id === region.region_id)
                ?? measuredRegions.find((item) => item.source_start_ms < view.sourceEndMs && item.source_end_ms > view.sourceStartMs)
              const measuredMidi = measuredRegion ? averageMidi(measuredRegion.original) ?? averageMidi(measuredRegion.corrected.map((point) => ({ ...point, hz: point.hz === null ? null : point.hz * 2 ** (-region.relative_pitch_cents / 1200) }))) : null
              const baseMidi = points.length ? midiAtPhonePitch(points, 0.5) : region.source_f0_hz && region.source_f0_hz > 0 ? midiFromHz(region.source_f0_hz) : measuredMidi
              const midi = baseMidi === null ? null : baseMidi + region.relative_pitch_cents / 100 + pitchEnvelopeCentsAtSourceTime(segment, (view.sourceStartMs + view.sourceEndMs) / 2) / 100
              const unpitched = midi === null
              const top = unpitched ? pitchRange * semitoneHeight + 1 : pitchY(midi) - semitoneHeight / 2
              const left = (segment.timeline_start_ms + startMs) * scale
              const width = Math.max(9, (endMs - startMs) * scale)
              const selected = selectedRegionView?.segmentId === segment.segment_id && selectedRegionView.sourceStartMs === view.sourceStartMs && selectedRegionView.sourceEndMs === view.sourceEndMs
              return <button
                key={`${segment.segment_id}:${view.sourceStartMs}:${view.sourceEndMs}`}
                type="button"
                className={`piano-region-note ${selected ? "selected" : ""} ${unpitched ? "unpitched" : ""} ${points.length ? "targeted" : ""}`}
                data-segment-id={segment.segment_id}
                data-region-id={region.region_id}
                data-source-start-ms={view.sourceStartMs}
                data-source-end-ms={view.sourceEndMs}
                style={{ left, top, width, height: unpitched ? PIANO_ROLL_UNPITCHED_LANE_HEIGHT - 2 : Math.max(1, semitoneHeight - 2), "--segment-color": segmentColors.get(segment.segment_id) } as CSSProperties}
                title={`${regionPhoneLabel(segment, region)}${region.source_f0_hz ? ` ? \uC6D0\uBCF8 F0 ${region.source_f0_hz.toFixed(1)} Hz` : ""}`}
                onClick={() => {
                  updatePitchNoteSelection(() => [])
                  setSelectedSyllableKey("")
                  setSelectedRegionView(view)
                  setSelectedRegion({ segmentId: segment.segment_id, regionId: region.region_id })
                  const refs = segment.phone_units.filter((phone) => phone.source_start_ms !== null && phone.source_end_ms !== null && phone.source_start_ms < region.source_end_ms && phone.source_end_ms > region.source_start_ms).map((phone) => phoneKey(segment.segment_id, phone.phone_unit_id))
                  setSelectedPhones(refs)
                  onSelectSegment(segment.segment_id)
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0) return
                  event.stopPropagation()
                  updatePitchNoteSelection(() => [])
                  setSelectedSyllableKey("")
                  setSelectedRegionView(view)
                  setSelectedRegion({ segmentId: segment.segment_id, regionId: region.region_id })
                  const refs = segment.phone_units.filter((phone) => phone.source_start_ms !== null && phone.source_end_ms !== null && phone.source_start_ms < region.source_end_ms && phone.source_end_ms > region.source_start_ms).map((phone) => phoneKey(segment.segment_id, phone.phone_unit_id))
                  setSelectedPhones(refs)
                  onSelectSegment(segment.segment_id)
                  const pitchNode = pitchScrollRef.current!
                  const initialCursorMidi = PITCH_MAX_MIDI - (event.clientY - pitchNode.getBoundingClientRect().top + pitchNode.scrollTop - semitoneHeightRef.current / 2) / semitoneHeightRef.current
                  let didMove = false
                  startGesture(event.nativeEvent, (pointer) => {
                    const contentY = pointer.clientY - pitchNode.getBoundingClientRect().top + pitchNode.scrollTop
                    const cursorMidi = PITCH_MAX_MIDI - (contentY - semitoneHeightRef.current / 2) / semitoneHeightRef.current
                    const delta = cursorMidi - initialCursorMidi
                    if (!didMove && Math.abs(delta) < 0.04) return
                    didMove = true
                    const targetMidi = pianoRollDraggedMidi(midi ?? 60, delta, pointer.ctrlKey)
                    const pitchDelta = targetMidi - (midi ?? 60)
                    const currentPoints = points.length ? points : [{ position: 0, midi: baseMidi ?? 60 }, { position: 1, midi: baseMidi ?? 60 }]
                    const nextPoints = currentPoints.map((point) => ({ ...point, midi: Math.max(PITCH_MIN_MIDI, Math.min(PITCH_MAX_MIDI, point.midi + pitchDelta)) }))
                    const boundedMidi = Math.max(PITCH_MIN_MIDI, Math.min(PITCH_MAX_MIDI, targetMidi))
                    if (onUpdateRegionRangePitchPoints(view, nextPoints)) setDragPitchBadge({ midi: boundedMidi, x: pointer.clientX + 14, y: pointer.clientY - 22 })
                    else setPitchEditMessage("이 구간의 경계나 피치를 안전하게 나눌 수 없어 변경하지 않았습니다.")
                  })
                }}
              >{regionPhoneLabel(segment, region) || "??"}</button>
            })}
            {syllableGroups.flatMap((group) => group.ranges.map((range) => {
              const segment = segments.find((item) => item.segment_id === range.segmentId)
              if (!segment) return []
              const startMs = sourceTimeToSegmentOutput(segment, range.startMs)
              const endMs = sourceTimeToSegmentOutput(segment, range.endMs)
              const midi = syllableMidi(group)
              const selected = selectedSyllableKey === group.key
              const top = midi === null ? pitchRange * semitoneHeight + 1 : pitchY(midi) - semitoneHeight / 2
              return [<button
                key={`${group.key}:${range.segmentId}`}
                type="button"
                className={`piano-syllable-note ${selected ? "selected" : ""} ${midi === null ? "unpitched" : ""} ${midi !== null ? "targeted" : ""}`}
                style={{ left: (segment.timeline_start_ms + startMs) * scale, top, width: Math.max(12, (endMs - startMs) * scale), height: midi === null ? PIANO_ROLL_UNPITCHED_LANE_HEIGHT - 2 : Math.max(1, semitoneHeight - 2), "--segment-color": segmentColors.get(segment.segment_id) } as CSSProperties}
                aria-label={`${group.label} ${midi === null ? "원본 음정" : midiLabel(midi)}`}
                title={`${group.label}${midi === null ? " · 원본 음정" : ` · ${midiLabel(midi)}`}`}
                onClick={() => {
                  updatePitchNoteSelection(() => [])
                  setSelectedSyllableKey(group.key)
                  setSelectedRegionView(null)
                  setSelectedRegion(null)
                  setSelectedPhones(group.phones.map((phone) => phoneKey(phone.segmentId, phone.phoneUnitId)))
                  onSelectSegment(range.segmentId)
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0) return
                  event.stopPropagation()
                  updatePitchNoteSelection(() => [])
                  setSelectedSyllableKey(group.key)
                  setSelectedRegion(null)
                  setSelectedRegionView(null)
                  setSelectedPhones(group.phones.map((phone) => phoneKey(phone.segmentId, phone.phoneUnitId)))
                  onSelectSegment(range.segmentId)
                  const baseMidi = syllableMidi(group)
                  const pitchNode = pitchScrollRef.current!
                  const initialCursorMidi = PITCH_MAX_MIDI - (event.clientY - pitchNode.getBoundingClientRect().top + pitchNode.scrollTop - semitoneHeightRef.current / 2) / semitoneHeightRef.current
                  let didMove = false
                  startGesture(event.nativeEvent, (pointer) => {
                    const contentY = pointer.clientY - pitchNode.getBoundingClientRect().top + pitchNode.scrollTop
                    const cursorMidi = PITCH_MAX_MIDI - (contentY - semitoneHeightRef.current / 2) / semitoneHeightRef.current
                    const delta = cursorMidi - initialCursorMidi
                    if (!didMove && Math.abs(delta) < 0.04) return
                    didMove = true
                    const startingMidi = baseMidi ?? initialCursorMidi
                    const targetMidi = pianoRollDraggedMidi(startingMidi, delta, pointer.ctrlKey)
                    const boundedMidi = Math.max(PITCH_MIN_MIDI, Math.min(PITCH_MAX_MIDI, targetMidi))
                    if (applySyllablePitch(group, boundedMidi)) setDragPitchBadge({ midi: boundedMidi, x: pointer.clientX + 14, y: pointer.clientY - 22 })
                  })
                }}
              >{group.label}{midi === null ? "" : ` ${midiLabel(midi)}`}</button>]
            }))}
            <i className="piano-playhead" style={{ left: playheadMs * scale }}/>
          </div>
          </div>
        </div>
      </div>
      </div>
      <div className="piano-roll-horizontal-scroll" ref={timeScrollRef} onScroll={(event) => syncScroll("time", event.currentTarget.scrollLeft)}><div style={{ width: PIANO_ROLL_KEYBOARD_WIDTH + contentWidth, height: 1 }}/></div>
    </div>
      {dragPitchBadge && <div className="piano-roll-drag-badge" style={{ left: dragPitchBadge.x, top: dragPitchBadge.y }}>{midiLabel(dragPitchBadge.midi)} <small>{`${(dragPitchBadge.midi - Math.round(dragPitchBadge.midi)) * 100 > 0 ? "+" : ""}${((dragPitchBadge.midi - Math.round(dragPitchBadge.midi)) * 100).toFixed(0)}¢`}</small></div>}
      <div className="piano-roll-controls" aria-label="선택 음소 설정">
        <div className="piano-selection-heading"><strong>{selectedPitchNotes.length ? `${selectedPitchNotes.length}\uAC1C \uBAA9\uD45C \uB178\uD2B8 \uC120\uD0DD` : selectedUnits.length ? `${selectedUnits.length}\uAC1C \uC74C\uC18C \uC120\uD0DD` : "\uC74C\uC18C\uB97C \uC120\uD0DD\uD558\uC138\uC694"}</strong>{selectedPitchNotes.length ? <><small>{"Ctrl+\uD074\uB9AD \uB178\uD2B8 \uCD94\uAC00/\uD574\uC81C \u00B7 Shift+\uB4DC\uB798\uADF8 \uC0AC\uAC01\uD615 \uC120\uD0DD \u00B7 \uC120\uD0DD \uB178\uD2B8 \uB4DC\uB798\uADF8 \uC774\uB3D9"}</small><button type="button" className="piano-note-delete" disabled={Boolean(dragCleanupRef.current) || analysisHold} onClick={deleteSelectedPitchNote}>{"\uB178\uD2B8 \uC0AD\uC81C"}</button></> : <small>{"\uCC28\uD2B8 \uB4DC\uB798\uADF8\uB85C \uB178\uD2B8 \uC0DD\uC131 \u00B7 \uB178\uD2B8 \uC6B0\uD074\uB9AD\uC73C\uB85C \uACE1\uC120 \uC810 \uCD94\uAC00"}</small>}{analysisError && selectedPhone?.source_f0_hz !== null && selectedPhone?.source_f0_hz !== undefined && <small>{"\uD53C\uCE58 \uBD84\uC11D\uC774 \uC548 \uB420 \uB54C \uC6D0\uBCF8 \uCE21\uC815\uAC12\uC73C\uB85C \uAE30\uC900 \uD53C\uCE58\uB9CC \uD45C\uC2DC\uD569\uB2C8\uB2E4."}</small>}</div>
        {selectedSyllable && <div className="piano-syllable-controls"><strong>{selectedSyllable.label} 목표 음표</strong><label>목표 음표 MIDI<input aria-label="음절 목표 음표 MIDI" type="number" min={PITCH_MIN_MIDI} max={PITCH_MAX_MIDI} step="1" value={syllableMidi(selectedSyllable) === null ? "" : Math.round(syllableMidi(selectedSyllable)!)} onChange={(event) => {
          const value = event.target.value === "" ? null : Math.max(PITCH_MIN_MIDI, Math.min(PITCH_MAX_MIDI, Math.round(Number(event.target.value))))
          if (value === null || Number.isFinite(value)) applySyllablePitch(selectedSyllable, value)
        }}/></label><button type="button" onClick={() => applySyllablePitch(selectedSyllable, null)}>음절 피치 초기화</button>{pitchEditMessage && <small role="status">{pitchEditMessage}</small>}</div>}
        <label title="직접 피치 포인트를 사용하는 동안 비활성화됩니다.">목표 음정<input aria-label="목표 음정 MIDI" type="number" min={PITCH_MIN_MIDI} max={PITCH_MAX_MIDI} disabled={!selectedUnits.length && !selectedRegion} value={selectedRangeMidi ?? ""} placeholder="원본" onChange={(event) => {
          const value = event.target.value === "" ? null : Math.max(PITCH_MIN_MIDI, Math.min(PITCH_MAX_MIDI, Math.round(Number(event.target.value))))
          if (value === null || Number.isFinite(value)) {
            if (selectedRangeView && value !== null) {
              const relativeCents = (selectedPitchRegion?.relative_pitch_cents ?? 0) / 100 + selectedRangeEnvelopeCents / 100
              const delta = value - (selectedRangeMidi ?? value)
              const next = selectedRangePitchPoints?.length
                ? selectedRangePitchPoints.map((point) => ({ ...point, midi: Math.max(PITCH_MIN_MIDI, Math.min(PITCH_MAX_MIDI, point.midi + delta)) }))
                : [{ position: 0, midi: value - relativeCents }, { position: 1, midi: value - relativeCents }]
              onUpdateRegionRangePitchPoints(selectedRangeView, next)
            } else if (value === null && selectedRangeView) onUpdateRegionRangePitchPoints(selectedRangeView, [])
            else if (selectedRegion && value !== null) {
              const region = selectedPitchRegion
              if (!region) return
              const points = region.pitch_points ?? []
              const currentMidi = points.length ? (midiAtPhonePitch(points, 0.5) ?? selectedPhone?.target_pitch_midi ?? value) + (region.relative_pitch_cents ?? 0) / 100 : selectedPhone?.target_pitch_midi ?? value
              const delta = value - currentMidi
              const next = points.length ? points.map((point) => ({ ...point, midi: Math.max(PITCH_MIN_MIDI, Math.min(PITCH_MAX_MIDI, point.midi + delta)) })) : [{ position: 0, midi: value - (region.relative_pitch_cents ?? 0) / 100 }, { position: 1, midi: value - (region.relative_pitch_cents ?? 0) / 100 }]
              onUpdateRegionPitchPoints(selectedRegion.segmentId, selectedRegion.regionId, next)
            } else if (value === null && selectedRegion) onUpdateRegionPitchPoints(selectedRegion.segmentId, selectedRegion.regionId, [])
            else updateSelectedPhones({ target_pitch_midi: value })
          }
        }}/></label>
        <label title="직접 피치 포인트를 사용하는 동안 비활성화됩니다.">강도 (%)<input aria-label="목표 음정 강도" type="number" min="0" max="100" disabled={!selectedUnits.length || pitchCurveActive} value={selectedPhone?.target_pitch_strength_percent ?? PITCH_TARGET_STRENGTH_DEFAULT_PERCENT} onChange={(event) => updateSelectedPhones({ target_pitch_strength_percent: Math.max(0, Math.min(100, Math.round(Number(event.target.value) || 0))) })}/></label>
        <label title="직접 피치 포인트를 사용하는 동안 비활성화됩니다.">포르타멘토 (ms)<input aria-label="포르타멘토 길이" type="number" min="0" max="500" disabled={!selectedUnits.length || pitchCurveActive} value={selectedPhone?.transition_to_next_ms ?? PITCH_TRANSITION_DEFAULT_MS} onChange={(event) => updateSelectedPhones({ transition_to_next_ms: Math.max(0, Math.min(500, Math.round(Number(event.target.value) || 0))) })}/></label>
        <label title="직접 피치 포인트를 사용하는 동안 비활성화됩니다.">전환 강도 (%)<input aria-label="전환 강도" type="number" min="0" max="100" disabled={!selectedUnits.length || pitchCurveActive} value={selectedPhone?.transition_strength_percent ?? PITCH_TRANSITION_DEFAULT_STRENGTH} onChange={(event) => updateSelectedPhones({ transition_strength_percent: Math.max(0, Math.min(100, Math.round(Number(event.target.value) || 0))) })}/></label>
        <label>비브라토 깊이 (cent)<input aria-label="비브라토 깊이" type="number" min="0" max={PITCH_VIBRATO_DEPTH_MAX_CENTS} disabled={!selectedUnits.length} value={selectedPhone?.vibrato_depth_cents ?? PITCH_VIBRATO_DEPTH_DEFAULT_CENTS} onChange={(event) => updateSelectedPhones({ vibrato_depth_cents: Math.max(0, Math.min(PITCH_VIBRATO_DEPTH_MAX_CENTS, Math.round(Number(event.target.value) || 0))) })}/></label>
        <label>비브라토 속도 (Hz)<input aria-label="비브라토 속도" type="number" min="0" max="20" step="0.1" disabled={!selectedUnits.length} value={selectedPhone?.vibrato_rate_hz ?? PITCH_VIBRATO_RATE_DEFAULT_HZ} onChange={(event) => updateSelectedPhones({ vibrato_rate_hz: Math.max(0, Math.min(20, Number(event.target.value) || 0)) })}/></label>
        <label>시작 지연 (ms)<input aria-label="비브라토 시작 지연" type="number" min="0" max="5000" disabled={!selectedUnits.length} value={selectedPhone?.vibrato_start_ms ?? PITCH_VIBRATO_START_DEFAULT_MS} onChange={(event) => updateSelectedPhones({ vibrato_start_ms: Math.max(0, Math.round(Number(event.target.value) || 0)) })}/></label>
        {analysisError && <span className="piano-roll-fallback-note">원본 측정 F0는 기준 음정에만 사용하고 윤곽선으로 그리지 않습니다.</span>}
      </div>

    <section className="piano-volume-panel" aria-label="전체 음량 편집기" style={{ height: PIANO_ROLL_VOLUME_HEIGHT }}>
      <div className="piano-volume-heading"><strong>전체 음량</strong><span>하단 점을 움직이면 음량 곡선이 바뀝니다.</span></div>
      <div className="piano-volume-scroll" ref={volumeScrollRef} onScroll={(event) => syncScroll("volume", event.currentTarget.scrollLeft)}>
        <div className="piano-volume-content" style={{ width: PIANO_ROLL_KEYBOARD_WIDTH + contentWidth, height: PIANO_ROLL_VOLUME_HEIGHT - 31 }}>
          <div className="piano-volume-label">gain</div>
          <svg className="piano-volume-chart" style={{ left: PIANO_ROLL_KEYBOARD_WIDTH, backgroundImage: PIANO_ROLL_GRID_BACKGROUND_IMAGE, backgroundSize: `${barMs * scale}px 100%, ${barMs / 2 * scale}px 100%, ${barMs / 4 * scale}px 100%, ${gridMs * scale}px 100%`, backgroundPositionX: `${gridOffsetMs * scale}px` }} width={contentWidth} height={volumeChartHeight} onContextMenu={(event) => {
            event.preventDefault()
            const segment = segments.find((item) => item.segment_id === selectedSegmentId)
            if (!segment) return
            const bounds = event.currentTarget.getBoundingClientRect()
            const position = Math.max(0.001, Math.min(0.999, ((event.clientX - bounds.left) / scale - segment.timeline_start_ms) / Math.max(1, segment.timeline_end_ms - segment.timeline_start_ms)))
            const points = volumeEnvelope(segment)
            if (points.some((point) => Math.abs(point.position - position) < 0.015)) return
            const rowTop = segment.lane * volumeLaneHeight
            const plotHeight = Math.max(1, volumeLaneHeight - 7)
            const gain = Math.max(PROFESSIONAL_GAIN_MIN, Math.min(PROFESSIONAL_GAIN_MAX, (rowTop + volumeLaneHeight - 4 - (event.clientY - bounds.top)) / plotHeight * PROFESSIONAL_GAIN_MAX))
            onUpdateEnvelope(segment.segment_id, [...points, { position, gain }].sort((left, right) => left.position - right.position))
          }}>
            {segments.map((segment) => {
              const points = volumeEnvelope(segment)
              const duration = Math.max(1, segment.timeline_end_ms - segment.timeline_start_ms)
              const rowTop = segment.lane * volumeLaneHeight
              const pointAt = (point: VolumeEnvelopePoint) => ({
                x: segment.timeline_start_ms * scale + point.position * duration * scale,
                y: rowTop + volumeLaneHeight - 4 - point.gain / PROFESSIONAL_GAIN_MAX * (volumeLaneHeight - 7),
              })
              return <g key={segment.segment_id} className={segment.segment_id === selectedSegmentId ? "selected" : ""}>
                <text x={segment.timeline_start_ms * scale + 4} y={rowTop + 11}>{segment.target_ipa.join(" · ")}</text>
                <polyline points={points.map((point) => { const mapped = pointAt(point); return `${mapped.x},${mapped.y}` }).join(" ")}/>
                {points.map((point, index) => {
                  const mapped = pointAt(point)
                  return <circle key={index} cx={mapped.x} cy={mapped.y} r="4" tabIndex={0} aria-label={`음량 ${point.gain.toFixed(2)}`} onContextMenu={(event) => {
                    event.preventDefault(); event.stopPropagation()
                    if (index > 0 && index < points.length - 1) onUpdateEnvelope(segment.segment_id, points.filter((_, item) => item !== index))
                  }} onPointerDown={(event) => {
                    event.stopPropagation()
                    const svg = event.currentTarget.ownerSVGElement!
                    const bounds = svg.getBoundingClientRect()
                    startGesture(event.nativeEvent, (pointer) => {
                      const position = index === 0 ? 0 : index === points.length - 1 ? 1 : Math.max(points[index - 1].position + 0.001, Math.min(points[index + 1].position - 0.001, ((pointer.clientX - bounds.left) / scale - segment.timeline_start_ms) / duration))
                      const rowY = pointer.clientY - bounds.top
                      const gain = Math.max(PROFESSIONAL_GAIN_MIN, Math.min(PROFESSIONAL_GAIN_MAX, (rowTop + volumeLaneHeight - 4 - rowY) / Math.max(1, volumeLaneHeight - 7) * PROFESSIONAL_GAIN_MAX))
                      onUpdateEnvelope(segment.segment_id, points.map((current, item) => item === index ? { ...current, position, gain } : current))
                    })
                  }}/>
                })}
              </g>
            })}
            <line className="piano-playhead-line" x1={playheadMs * scale} x2={playheadMs * scale} y1="0" y2={volumeChartHeight}/>
          </svg>
        </div>
      </div>
    </section>
  </section>
}
