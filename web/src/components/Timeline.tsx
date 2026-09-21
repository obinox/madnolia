import { useEffect, useRef, useState } from "react"
import type { MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from "react"

import { COLORS, MIN_VIEW_DURATION_MS, TIMELINE_HEIGHT, TIMELINE_PADDING } from "../constants"
import type { PhoneOccurrence, TimelineProps, TimelineSelection, TranscriptWord } from "../types"

export function Timeline({
  durationMs,
  viewStartMs,
  viewEndMs,
  currentMs,
  waveform,
  timeline,
  selection,
  onSeek,
  onViewChange,
  onSelect,
}: TimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragStartRef = useRef<number | null>(null)
  const dragViewRef = useRef<[number, number] | null>(null)
  const [width, setWidth] = useState(800)

  useEffect(() => {
    if (!containerRef.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(320, entry.contentRect.width)))
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ratio = window.devicePixelRatio || 1
    canvas.width = width * ratio
    canvas.height = TIMELINE_HEIGHT * ratio
    canvas.style.width = `${width}px`
    canvas.style.height = `${TIMELINE_HEIGHT}px`
    const context = canvas.getContext("2d")
    if (!context) return
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    drawTimeline(
      context,
      width,
      viewStartMs,
      viewEndMs,
      currentMs,
      waveform,
      timeline,
      selection,
    )
  }, [currentMs, selection, timeline, viewEndMs, viewStartMs, waveform, width])

  const positionToTime = (clientX: number): number => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return viewStartMs
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left - TIMELINE_PADDING) / (rect.width - 2 * TIMELINE_PADDING)))
    return viewStartMs + ratio * (viewEndMs - viewStartMs)
  }

  const handleClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (dragStartRef.current !== null) return
    const timeMs = positionToTime(event.clientX)
    onSeek(timeMs)
    onSelect(findSelection(timeMs, timeline))
  }

  const handleWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault()
    const anchor = positionToTime(event.clientX)
    const currentSpan = viewEndMs - viewStartMs
    const nextSpan = Math.max(MIN_VIEW_DURATION_MS, Math.min(durationMs, currentSpan * Math.exp(event.deltaY * 0.0015)))
    const anchorRatio = (anchor - viewStartMs) / currentSpan
    let start = anchor - nextSpan * anchorRatio
    start = Math.max(0, Math.min(durationMs - nextSpan, start))
    onViewChange(start, start + nextSpan)
  }

  const handleMouseDown = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    dragStartRef.current = event.clientX
    dragViewRef.current = [viewStartMs, viewEndMs]
  }

  const handleMouseMove = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (dragStartRef.current === null || dragViewRef.current === null) return
    const [start, end] = dragViewRef.current
    const span = end - start
    const shift = ((dragStartRef.current - event.clientX) / width) * span
    const nextStart = Math.max(0, Math.min(durationMs - span, start + shift))
    onViewChange(nextStart, nextStart + span)
  }

  const handleMouseUp = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const moved = dragStartRef.current !== null && Math.abs(event.clientX - dragStartRef.current) > 3
    dragStartRef.current = null
    dragViewRef.current = null
    if (!moved) handleClick(event)
  }

  return (
    <div className="timeline-shell" ref={containerRef}>
      <canvas
        ref={canvasRef}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          dragStartRef.current = null
          dragViewRef.current = null
        }}
      />
    </div>
  )
}

function drawTimeline(
  context: CanvasRenderingContext2D,
  width: number,
  startMs: number,
  endMs: number,
  currentMs: number,
  waveform: TimelineProps["waveform"],
  timeline: TimelineProps["timeline"],
  selection: TimelineProps["selection"],
) {
  const innerWidth = width - TIMELINE_PADDING * 2
  const span = endMs - startMs
  const x = (timeMs: number) => TIMELINE_PADDING + ((timeMs - startMs) / span) * innerWidth
  context.fillStyle = COLORS.background
  context.fillRect(0, 0, width, TIMELINE_HEIGHT)
  drawGrid(context, width, startMs, endMs, x)

  timeline?.audio_regions.forEach((region) => {
    context.fillStyle = region.region_type === "SPEECH" ? COLORS.speech : COLORS.nonSpeech
    context.fillRect(x(Math.max(startMs, region.start_ms)), 22, Math.max(1, x(Math.min(endMs, region.end_ms)) - x(Math.max(startMs, region.start_ms))), 14)
  })

  if (waveform) {
    context.fillStyle = COLORS.waveform
    waveform.peaks.forEach((peak, index) => {
      const barX = TIMELINE_PADDING + (index / waveform.peaks.length) * innerWidth
      const height = Math.max(1, peak * 42)
      context.globalAlpha = 0.72
      context.fillRect(barX, 78 - height, Math.max(1, innerWidth / waveform.peaks.length), height * 2)
    })
    context.globalAlpha = 1
  }

  timeline?.words.forEach((word, index) => {
    const left = x(Math.max(startMs, word.start_ms))
    const right = x(Math.min(endMs, word.end_ms))
    context.fillStyle = index % 2 === 0 ? COLORS.word : "#8b78dc"
    context.fillRect(left, 108, Math.max(1, right - left), 25)
    if (right - left > 28) drawLabel(context, word.text, left + 3, 125, right - left - 6)
  })

  timeline?.phones.forEach((phone, index) => {
    const left = x(Math.max(startMs, phone.start_ms))
    const right = x(Math.min(endMs, phone.end_ms))
    context.fillStyle = index % 2 === 0 ? COLORS.phone : COLORS.phoneAlt
    context.fillRect(left, 142, Math.max(1, right - left), 27)
    if (right - left > 16) drawLabel(context, phone.ipa, left + 3, 160, right - left - 6)
  })

  if (selection) {
    context.strokeStyle = COLORS.selected
    context.lineWidth = 2
    const top = selection.kind === "PHONE" ? 141 : 107
    const height = selection.kind === "PHONE" ? 29 : 27
    context.strokeRect(x(selection.start_ms), top, Math.max(2, x(selection.end_ms) - x(selection.start_ms)), height)
  }

  if (currentMs >= startMs && currentMs <= endMs) {
    context.strokeStyle = COLORS.playhead
    context.lineWidth = 2
    context.beginPath()
    context.moveTo(x(currentMs), 10)
    context.lineTo(x(currentMs), TIMELINE_HEIGHT - 8)
    context.stroke()
  }
}

function drawGrid(
  context: CanvasRenderingContext2D,
  width: number,
  startMs: number,
  endMs: number,
  x: (timeMs: number) => number,
) {
  const step = gridStep(endMs - startMs)
  const first = Math.ceil(startMs / step) * step
  context.font = "11px ui-monospace, monospace"
  context.fillStyle = COLORS.mutedText
  context.strokeStyle = COLORS.grid
  context.lineWidth = 1
  for (let time = first; time <= endMs; time += step) {
    const left = x(time)
    context.beginPath()
    context.moveTo(left, 8)
    context.lineTo(left, TIMELINE_HEIGHT - 8)
    context.stroke()
    context.fillText(formatTime(time), Math.min(width - 58, left + 3), 15)
  }
}

function gridStep(spanMs: number): number {
  if (spanMs <= 10_000) return 1_000
  if (spanMs <= 60_000) return 5_000
  if (spanMs <= 10 * 60_000) return 60_000
  if (spanMs <= 60 * 60_000) return 5 * 60_000
  return 10 * 60_000
}

function drawLabel(context: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number) {
  context.fillStyle = "#111820"
  context.font = "12px Pretendard, system-ui, sans-serif"
  context.save()
  context.beginPath()
  context.rect(x, y - 13, maxWidth, 16)
  context.clip()
  context.fillText(text, x, y)
  context.restore()
}

function findSelection(timeMs: number, timeline: TimelineProps["timeline"]): TimelineSelection | null {
  const phone = timeline?.phones.find((item: PhoneOccurrence) => item.start_ms <= timeMs && item.end_ms >= timeMs)
  if (phone) {
    return {
      kind: "PHONE",
      label: phone.ipa,
      start_ms: phone.start_ms,
      end_ms: phone.end_ms,
      pronunciation: phone.pronunciation,
      phone_id: phone.phone_id,
      alignment_method: phone.alignment_method,
    }
  }
  const word = timeline?.words.find((item: TranscriptWord) => item.start_ms <= timeMs && item.end_ms >= timeMs)
  return word
    ? {
        kind: "WORD",
        label: word.text,
        start_ms: word.start_ms,
        end_ms: word.end_ms,
        pronunciation: null,
        phone_id: null,
        alignment_method: null,
      }
    : null
}

export function formatTime(timeMs: number): string {
  const totalSeconds = Math.max(0, timeMs) / 1000
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.floor(totalSeconds % 60)
  const milliseconds = Math.floor(timeMs % 1000)
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`
}
