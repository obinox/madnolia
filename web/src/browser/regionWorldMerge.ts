import type { BrowserRenderRegion, BrowserRenderUnit } from "../types/browserAudio"
import type { PianoRollPitchNote, TimelineSegment } from "../types"

export function canCopyRegionAudio(regions: BrowserRenderRegion[], segment: TimelineSegment, notes: PianoRollPitchNote[]): boolean {
  return regions.every(({ region }) => region.output_duration_ms === region.source_end_ms - region.source_start_ms && !region.relative_pitch_cents && !region.pitch_points?.length)
    && !segment.pitch_envelope?.length
    && !segment.phone_units.some((unit) => unit.vibrato_depth_cents > 0)
    && !notes.some((note) => note.start_ms < segment.timeline_end_ms && note.end_ms > segment.timeline_start_ms)
}

export function copyRegionAudio(output: Float32Array, samples: Float32Array, sampleRate: number, regions: BrowserRenderRegion[]): void {
  let cursor = 0
  for (const { region } of regions) {
    const start = Math.max(0, Math.min(samples.length, Math.round(region.source_start_ms * sampleRate / 1000)))
    const end = Math.max(start, Math.min(samples.length, Math.round(region.source_end_ms * sampleRate / 1000)))
    const piece = samples.subarray(start, end)
    const count = Math.max(0, Math.min(piece.length, output.length - cursor))
    output.set(piece.subarray(0, count), cursor)
    cursor += piece.length
  }
}

export function overlayWorldSlices(base: Float32Array, world: Float32Array, ranges: Array<[number, number]>): void {
  for (const [start, end] of ranges) if (end > start) base.set(world.subarray(start, end), start)
}

export function buildWorldVibratoCents(regions: BrowserRenderRegion[], units: BrowserRenderUnit[], sourceTimes: Float64Array): Float64Array {
  const output = new Float64Array(sourceTimes.length)
  const mapSourceToOutput = (sourceMs: number): number | null => {
    let mapped: number | null = null
    for (const { region, startMs } of regions) {
      if (sourceMs < region.source_start_ms || sourceMs >= region.source_end_ms) continue
      const span = Math.max(1, region.source_end_ms - region.source_start_ms)
      mapped = startMs + (sourceMs - region.source_start_ms) * region.output_duration_ms / span
    }
    return mapped
  }
  const unitStarts = units.map(({ unit }) => unit.source_start_ms === null ? null : mapSourceToOutput(unit.source_start_ms))
  for (let index = 0; index < sourceTimes.length; index += 1) {
    const sourceMs = sourceTimes[index]
    const outputMs = mapSourceToOutput(sourceMs)
    if (outputMs === null) continue
    for (const [unitIndex, { unit }] of units.entries()) {
      const startMs = unit.source_start_ms
      const endMs = unit.source_end_ms
      const unitOutputMs = unitStarts[unitIndex]
      if (startMs === null || endMs === null || unitOutputMs === null || sourceMs < startMs || sourceMs >= endMs || unit.vibrato_depth_cents <= 0 || unit.vibrato_rate_hz <= 0) continue
      const elapsedMs = outputMs - unitOutputMs - unit.vibrato_start_ms
      if (elapsedMs >= 0) output[index] += unit.vibrato_depth_cents * Math.sin(2 * Math.PI * unit.vibrato_rate_hz * elapsedMs / 1000)
    }
  }
  return output
}
