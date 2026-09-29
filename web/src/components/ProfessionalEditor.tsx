import { useMemo, useState } from "react"

import {
  FORMANT_SHIFT_MAX_SEMITONES,
  FORMANT_SHIFT_MIN_SEMITONES,
  PITCH_MAX_MIDI,
  PITCH_MIN_MIDI,
  PITCH_TRANSITION_CENTER_MAX_MS,
  PITCH_TRANSITION_CENTER_MIN_MS,
  PITCH_TRANSITION_MAX_MS,
  PROFESSIONAL_PIANO_ROLL_HEIGHT,
  PROFESSIONAL_TIMELINE_PIXELS_PER_MS,
  PROFESSIONAL_MAX_DURATION_PERCENT,
  PROFESSIONAL_MIN_DURATION_PERCENT,
} from "../constants"
import type { ProfessionalEditorProps, TimelineSegment } from "../types"
import { formatTime } from "./Timeline"

export function ProfessionalEditor({
  segments,
  selectedSegmentId,
  playheadMs,
  onSelectSegment,
  onPlayheadChange,
  onUpdatePhone,
  onUpdateSegment,
  onReorderSegment,
  onDeleteSegment,
  onChangeOrder,
}: ProfessionalEditorProps) {
  const [selectedPhoneId, setSelectedPhoneId] = useState("")
  const selected = segments.find((segment) => segment.segment_id === selectedSegmentId) ?? null
  const phone = selected?.phone_units.find((unit) => unit.phone_unit_id === selectedPhoneId)
    ?? selected?.phone_units[0] ?? null
  const width = Math.max(960, (segments.at(-1)?.timeline_end_ms ?? 0) * PROFESSIONAL_TIMELINE_PIXELS_PER_MS + 80)
  const phoneOffsets = useMemo(() => {
    const offsets = new Map<string, number>()
    let cursor = 0
    for (const unit of selected?.phone_units ?? []) {
      offsets.set(unit.phone_unit_id, cursor)
      cursor += unit.output_duration_ms
    }
    return offsets
  }, [selected])

  const timelineClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    onPlayheadChange(Math.max(0, (event.clientX - bounds.left + (event.currentTarget.parentElement?.scrollLeft ?? 0)) / PROFESSIONAL_TIMELINE_PIXELS_PER_MS))
  }

  return (
    <section className="vocal-editor" aria-label="Professional synthesis editor">
      <div className="vocal-timeline-header">
        <div>
          <strong>ARRANGEMENT</strong>
          <span>{formatTime(playheadMs)} / {formatTime(segments.at(-1)?.timeline_end_ms ?? 0)}</span>
        </div>
        <div className="vocal-legend"><span>A TRACK</span><span>B TRACK</span><span>PHONE / PITCH</span></div>
      </div>
      <div className="vocal-timeline-scroll">
        <div className="vocal-timeline" style={{ width }} onClick={timelineClick}>
          <div className="vocal-ruler">
            {Array.from({ length: Math.ceil(width / 110) }, (_, index) => (
              <span key={index} style={{ left: index * 110 }}>{formatTime(index * 500)}</span>
            ))}
          </div>
          {[0, 1].map((lane) => (
            <div className="vocal-lane" key={lane}>
              <span className="vocal-lane-name">{lane ? "B" : "A"}</span>
              {segments.filter((segment) => segment.lane === lane).map((segment) => {
                const start = segment.timeline_start_ms * PROFESSIONAL_TIMELINE_PIXELS_PER_MS
                const partWidth = Math.max(24, (segment.timeline_end_ms - segment.timeline_start_ms) * PROFESSIONAL_TIMELINE_PIXELS_PER_MS)
                return (
                  <button
                    key={segment.segment_id}
                    draggable
                    className={`vocal-part ${selectedSegmentId === segment.segment_id ? "selected" : ""}`}
                    style={{ left: start, width: partWidth }}
                    onClick={(event) => { event.stopPropagation(); onSelectSegment(segment.segment_id) }}
                    onDragStart={(event) => event.dataTransfer.setData("text/plain", segment.segment_id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault()
                      const sourceId = event.dataTransfer.getData("text/plain")
                      if (sourceId && sourceId !== segment.segment_id) onReorderSegment(sourceId, segment.segment_id)
                    }}
                    title={`${formatTime(segment.timeline_start_ms)} – ${formatTime(segment.timeline_end_ms)} · drag to reorder`}
                  >
                    {segment.target_ipa.join(" · ")}
                    {segment.gap_before_ms < 0 && <i style={{ width: Math.min(partWidth / 2, -segment.gap_before_ms * PROFESSIONAL_TIMELINE_PIXELS_PER_MS) }} />}
                  </button>
                )
              })}
            </div>
          ))}
          <div className="vocal-playhead" style={{ left: playheadMs * PROFESSIONAL_TIMELINE_PIXELS_PER_MS }} />
        </div>
      </div>

      {selected ? (
        <div className="vocal-workspace">
          <div className="vocal-roll-column">
            <div className="vocal-roll-toolbar">
              <strong>PIANO ROLL</strong><span>{selected.target_ipa.join(" · ")}</span>
              <div><button onClick={() => onChangeOrder(selected.segment_id, -1)}>←</button><button onClick={() => onChangeOrder(selected.segment_id, 1)}>→</button></div>
            </div>
            <div className="vocal-roll-scroll">
              <div className="vocal-piano-roll" style={{ width: Math.max(640, selected.phone_units.reduce((sum, unit) => sum + unit.output_duration_ms, 0) * PROFESSIONAL_TIMELINE_PIXELS_PER_MS + 60) }}>
                <div className="vocal-keyboard">
                  {Array.from({ length: 15 }, (_, index) => {
                    const midi = PITCH_MAX_MIDI - index * 6
                    return <span key={midi}>{midiName(midi)}</span>
                  })}
                </div>
                <div className="vocal-grid" style={{ height: PROFESSIONAL_PIANO_ROLL_HEIGHT }}>
                  {Array.from({ length: 15 }, (_, index) => <div key={index} className={`vocal-grid-row ${index % 2 ? "dark" : ""}`} />)}
                  {selected.phone_units.map((unit) => {
                    const pitch = unit.target_pitch_midi
                    const top = pitch === null ? PROFESSIONAL_PIANO_ROLL_HEIGHT - 26 : Math.max(0, Math.min(PROFESSIONAL_PIANO_ROLL_HEIGHT - 24, (PITCH_MAX_MIDI - pitch) * PROFESSIONAL_PIANO_ROLL_HEIGHT / (PITCH_MAX_MIDI - PITCH_MIN_MIDI)))
                    const unitWidth = Math.max(25, unit.output_duration_ms * PROFESSIONAL_TIMELINE_PIXELS_PER_MS)
                    const sourceDuration = unit.source_start_ms !== null && unit.source_end_ms !== null ? unit.source_end_ms - unit.source_start_ms : 0
                    const origin = phoneOffsets.get(unit.phone_unit_id) ?? 0
                    return (
                      <div key={unit.phone_unit_id} className="vocal-note-wrap" style={{ left: origin * PROFESSIONAL_TIMELINE_PIXELS_PER_MS, width: unitWidth }}>
                        <button
                          className={`vocal-note ${unit.operation.toLowerCase()} ${phone?.phone_unit_id === unit.phone_unit_id ? "selected" : ""} ${pitch === null ? "unvoiced" : ""}`}
                          style={{ top, height: 24 }}
                          onClick={() => setSelectedPhoneId(unit.phone_unit_id)}
                          onPointerDown={(event) => {
                            if ((event.target as HTMLElement).dataset.handle) return
                            event.currentTarget.setPointerCapture(event.pointerId)
                            const y = event.clientY
                            const initialPitch = unit.target_pitch_midi
                            const move = (pointer: PointerEvent) => {
                              if (initialPitch === null || !selected) return
                              onUpdatePhone(selected.segment_id, unit.phone_unit_id, {
                                target_pitch_midi: Math.max(PITCH_MIN_MIDI, Math.min(PITCH_MAX_MIDI, initialPitch - (pointer.clientY - y) * 0.12)),
                              })
                            }
                            const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up) }
                            window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true })
                          }}
                          title="Drag vertically to adjust pitch"
                        >
                          <span>{unit.target_ipa ?? unit.source_ipa ?? "—"}</span>
                          <i
                            data-handle="left"
                            className="vocal-note-handle left"
                            onPointerDown={(event) => {
                              event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId)
                              const x = event.clientX, initialDuration = unit.output_duration_ms
                              const move = (pointer: PointerEvent) => {
                                if (!selected) return
                                const min = sourceDuration ? Math.max(1, Math.round(sourceDuration * PROFESSIONAL_MIN_DURATION_PERCENT / 100)) : 1
                                const max = sourceDuration ? Math.round(sourceDuration * PROFESSIONAL_MAX_DURATION_PERCENT / 100) : 60_000
                                onUpdatePhone(selected.segment_id, unit.phone_unit_id, { output_duration_ms: Math.max(min, Math.min(max, initialDuration - Math.round((pointer.clientX - x) / PROFESSIONAL_TIMELINE_PIXELS_PER_MS))) })
                              }
                              const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up) }
                              window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true })
                            }}
                          />
                          <i
                            data-handle="right"
                            className="vocal-note-handle right"
                            onPointerDown={(event) => {
                              event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId)
                              const x = event.clientX, initialDuration = unit.output_duration_ms
                              const move = (pointer: PointerEvent) => {
                                if (!selected) return
                                const min = sourceDuration ? Math.max(1, Math.round(sourceDuration * PROFESSIONAL_MIN_DURATION_PERCENT / 100)) : 1
                                const max = sourceDuration ? Math.round(sourceDuration * PROFESSIONAL_MAX_DURATION_PERCENT / 100) : 60_000
                                onUpdatePhone(selected.segment_id, unit.phone_unit_id, { output_duration_ms: Math.max(min, Math.min(max, initialDuration + Math.round((pointer.clientX - x) / PROFESSIONAL_TIMELINE_PIXELS_PER_MS))) })
                              }
                              const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up) }
                              window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true })
                            }}
                          />
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
            <div className="vocal-roll-hint">음표를 위아래로 드래그해 피치를, 좌우 끝을 드래그해 길이를 조절하세요. 길이 변경은 뒤 음소를 상대적으로 밀어냅니다.</div>
          </div>
          <aside className="vocal-inspector">
            <div className="vocal-inspector-heading"><strong>INSPECTOR</strong><button onClick={() => onDeleteSegment(selected.segment_id)}>삭제</button></div>
            <label>Part source in (ms)<input type="number" value={selected.source_start_ms} onChange={(event) => onUpdateSegment(selected.segment_id, { source_start_ms: Math.max(0, Math.min(selected.source_end_ms - 1, Number(event.target.value))) })} /></label>
            <label>Part source out (ms)<input type="number" value={selected.source_end_ms} onChange={(event) => onUpdateSegment(selected.segment_id, { source_end_ms: Math.max(selected.source_start_ms + 1, Number(event.target.value)) })} /></label>
            <label>이전 Part와 간격 / 크로스페이드 (ms)<input type="number" disabled={segments[0]?.segment_id === selected.segment_id} value={selected.gap_before_ms} onChange={(event) => onUpdateSegment(selected.segment_id, { gap_before_ms: Math.max(-PITCH_TRANSITION_MAX_MS, Math.min(PITCH_TRANSITION_MAX_MS, Number(event.target.value))) })} /></label>
            {phone && <>
              <div className="vocal-inspector-divider">SELECTED PHONE</div>
              <strong className="vocal-inspector-phone">{phone.target_ipa ?? phone.source_ipa ?? "—"}</strong>
              <label>재생 길이 (ms)<input type="number" min={1} value={phone.output_duration_ms} onChange={(event) => onUpdatePhone(selected.segment_id, phone.phone_unit_id, { output_duration_ms: Math.max(1, Number(event.target.value)) })} /></label>
              {phone.source_start_ms !== null && <label>Source in (ms)<input type="number" min={0} max={(phone.source_end_ms ?? (phone.source_start_ms ?? 0) + 1) - 1} value={phone.source_start_ms} onChange={(event) => onUpdatePhone(selected.segment_id, phone.phone_unit_id, { source_start_ms: Math.max(0, Math.min((phone.source_end_ms ?? (phone.source_start_ms ?? 0) + 1) - 1, Number(event.target.value))) })} /></label>}
              {phone.source_end_ms !== null && <label>Source out (ms)<input type="number" min={(phone.source_start_ms ?? 0) + 1} value={phone.source_end_ms} onChange={(event) => onUpdatePhone(selected.segment_id, phone.phone_unit_id, { source_end_ms: Math.max((phone.source_start_ms ?? 0) + 1, Number(event.target.value)) })} /></label>}
              {phone.target_pitch_midi !== null && <label>Pitch (MIDI)<input type="number" min={PITCH_MIN_MIDI} max={PITCH_MAX_MIDI} step={0.01} value={phone.target_pitch_midi} onChange={(event) => onUpdatePhone(selected.segment_id, phone.phone_unit_id, { target_pitch_midi: Math.max(PITCH_MIN_MIDI, Math.min(PITCH_MAX_MIDI, Number(event.target.value))) })} /></label>}
              <label>Formant (semitone)<input type="number" min={FORMANT_SHIFT_MIN_SEMITONES} max={FORMANT_SHIFT_MAX_SEMITONES} step={0.1} value={phone.formant_shift_semitones} onChange={(event) => onUpdatePhone(selected.segment_id, phone.phone_unit_id, { formant_shift_semitones: Math.max(FORMANT_SHIFT_MIN_SEMITONES, Math.min(FORMANT_SHIFT_MAX_SEMITONES, Number(event.target.value))) })} /></label>
              {phone.target_pitch_midi !== null && <>
                <label>Pitch transition (ms)<input type="number" min={0} max={PITCH_TRANSITION_MAX_MS} value={phone.transition_to_next_ms} onChange={(event) => onUpdatePhone(selected.segment_id, phone.phone_unit_id, { transition_to_next_ms: Math.max(0, Math.min(PITCH_TRANSITION_MAX_MS, Number(event.target.value))) })} /></label>
                <label>Transition strength (%)<input type="number" min={0} max={100} value={phone.transition_strength_percent} onChange={(event) => onUpdatePhone(selected.segment_id, phone.phone_unit_id, { transition_strength_percent: Math.max(0, Math.min(100, Number(event.target.value))) })} /></label>
                <label>Transition center (ms)<input type="number" min={PITCH_TRANSITION_CENTER_MIN_MS} max={PITCH_TRANSITION_CENTER_MAX_MS} value={phone.transition_center_ms} onChange={(event) => onUpdatePhone(selected.segment_id, phone.phone_unit_id, { transition_center_ms: Math.max(PITCH_TRANSITION_CENTER_MIN_MS, Math.min(PITCH_TRANSITION_CENTER_MAX_MS, Number(event.target.value))) })} /></label>
              </>}
            </>}
          </aside>
        </div>
      ) : <p className="muted">타임라인에 파트를 추가하고 선택하세요.</p>}
    </section>
  )
}

function midiName(midi: number): string {
  const names = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"]
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
}

export function reorderSegments(segments: TimelineSegment[], sourceId: string, destinationId: string): TimelineSegment[] {
  const from = segments.findIndex((segment) => segment.segment_id === sourceId)
  const to = segments.findIndex((segment) => segment.segment_id === destinationId)
  if (from < 0 || to < 0 || from === to) return segments
  const reordered = [...segments]
  const [item] = reordered.splice(from, 1)
  reordered.splice(to, 0, item)
  return reordered
}
