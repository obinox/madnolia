import {
  PROFESSIONAL_WAVEFORM_AMPLITUDE,
  PROFESSIONAL_WAVEFORM_CENTER_Y,
  PROFESSIONAL_WAVEFORM_COLUMN_COUNT,
  PROFESSIONAL_WAVEFORM_VIEW_WIDTH,
} from "../../constants"
import type { TimelineSegment } from "../../types"

export function mapWaveformToOutput(segment: TimelineSegment, peaks: number[]): string {
  if (!peaks.length) return ""
  const sourceLength = segment.source_end_ms - segment.source_start_ms
  const duration = segment.edit_regions.reduce((sum, region) => sum + region.output_duration_ms, 0)
  if (duration <= 0 || sourceLength <= 0) return ""
  const upper: string[] = []
  const lower: string[] = []
  let regionOutput = 0
  const appendPoint = (region: TimelineSegment["edit_regions"][number], interval: number, point: number) => {
    const regionLength = region.source_end_ms - region.source_start_ms
    const outputAt = regionOutput + region.output_duration_ms * point / interval
    const sourceAt = region.source_start_ms + regionLength * point / interval
    const halfWindow = regionLength / interval / 2
    const from = Math.max(region.source_start_ms, sourceAt - halfWindow)
    const to = Math.min(region.source_end_ms, sourceAt + halfWindow)
    const firstPeak = Math.max(0, Math.floor((from - segment.source_start_ms) / sourceLength * peaks.length))
    const endBin = (to - segment.source_start_ms) / sourceLength * peaks.length
    const lastPeak = Math.min(peaks.length - 1, Math.max(firstPeak, Math.ceil(endBin) - 1))
    let peak = 0
    for (let index = firstPeak; index <= lastPeak; index += 1) peak = Math.max(peak, Number.isFinite(peaks[index]) ? Math.abs(peaks[index]) : 0)
    const amplitude = Math.min(1, peak) * PROFESSIONAL_WAVEFORM_AMPLITUDE
    const x = outputAt / duration * PROFESSIONAL_WAVEFORM_VIEW_WIDTH
    upper.push(`${x},${PROFESSIONAL_WAVEFORM_CENTER_Y - amplitude}`)
    lower.push(`${x},${PROFESSIONAL_WAVEFORM_CENTER_Y + amplitude}`)
  }
  for (const region of segment.edit_regions) {
    const intervals = Math.max(2, Math.round(PROFESSIONAL_WAVEFORM_COLUMN_COUNT * region.output_duration_ms / duration))
    for (let point = 0; point <= intervals; point += 1) appendPoint(region, intervals, point)
    regionOutput += region.output_duration_ms
  }
  return [...upper, ...lower.reverse()].join(" ")
}
