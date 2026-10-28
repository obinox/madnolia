import type {
  BrowserAudioData,
  BrowserAnalysisRecord,
  BrowserProjectRecord,
} from "../types"
import type {
  EditRegion,
  PhonePitchPoint,
  PhoneUnit,
  PitchAnalysisResponse,
  CompositionProject,
  ProfessionalAutotuneRequest,
  ProfessionalAutotuneResponse,
  SaveCompositionRequest,
  TimelineSegment,
} from "../types"
import type {
  BrowserCompositionSource,
  BrowserPitchCurve,
  BrowserPitchFrame,
  BrowserProgressCallback,
  BrowserRenderRegion,
  BrowserRenderUnit,
} from "../types/browserAudio"
import {
  BROWSER_AUDIO_MAX_DURATION_MS,
  BROWSER_AUDIO_MAX_F0_HZ,
  BROWSER_AUDIO_MAX_INPUT_BYTES,
  BROWSER_AUDIO_MAX_OUTPUT_SAMPLES,
  BROWSER_AUDIO_MIN_F0_HZ,
  BROWSER_AUDIO_MIN_PERIODICITY,
  BROWSER_AUDIO_MIN_RMS,
  BROWSER_AUDIO_MP4_MAX_DURATION_MS,
  BROWSER_AUDIO_PITCH_HOP_MS,
  BROWSER_AUDIO_PITCH_WINDOW_MS,
  BROWSER_AUDIO_SAMPLE_RATE,
  BROWSER_AUDIO_WAV_BITS,
  BROWSER_FFMPEG_EXEC_TIMEOUT_MS,
} from "../browserAudioConstants"
import { readWorkspaceFile, readWorkspaceJson } from "./workspace"
import { cleanupFfmpegFiles, withBrowserFfmpeg } from "./ffmpeg"
import { encodeWav, estimatePitch, renderPitchCurve, resampleLinear, stretchAudio } from "./audioDsp"

const checkAbort = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError")
}

const report = (callback: BrowserProgressCallback | undefined, percent: number, stage: string): void => {
  callback?.(Math.max(0, Math.min(100, Math.round(percent))), stage)
}

const yieldToBrowser = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const validAudio = (audio: BrowserAudioData): void => {
  if (!Number.isFinite(audio.sampleRate) || audio.sampleRate < 1) {
    throw new Error("오디오 샘플레이트가 올바르지 않습니다.")
  }
  if (audio.samples.length > BROWSER_AUDIO_MAX_OUTPUT_SAMPLES) {
    throw new Error("브라우저 오디오 한도인 30분을 초과했습니다. 파일을 나눠서 처리해 주세요.")
  }
}

const decodeNativeAudio = async (file: Blob, signal?: AbortSignal): Promise<BrowserAudioData> => {
  const context = new AudioContext()
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer())
    checkAbort(signal)
    const length = Math.ceil(decoded.duration * BROWSER_AUDIO_SAMPLE_RATE)
    if (!Number.isFinite(length) || length < 1 || length > BROWSER_AUDIO_MAX_OUTPUT_SAMPLES) {
      throw new Error("브라우저 오디오 한도인 30분을 초과했습니다. 파일을 나눠서 처리해 주세요.")
    }
    if (decoded.numberOfChannels === 1 && decoded.sampleRate === BROWSER_AUDIO_SAMPLE_RATE) {
      return { samples: new Float32Array(decoded.getChannelData(0)), sampleRate: BROWSER_AUDIO_SAMPLE_RATE }
    }
    const offline = new OfflineAudioContext(1, length, BROWSER_AUDIO_SAMPLE_RATE)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start(0)
    const rendered = await offline.startRendering()
    checkAbort(signal)
    return { samples: new Float32Array(rendered.getChannelData(0)), sampleRate: BROWSER_AUDIO_SAMPLE_RATE }
  } finally {
    await context.close()
  }
}

export async function decodeMedia(
  file: Blob,
  signal?: AbortSignal,
  onProgress?: BrowserProgressCallback,
): Promise<BrowserAudioData> {
  checkAbort(signal)
  if (file.size > BROWSER_AUDIO_MAX_INPUT_BYTES) {
    throw new Error("브라우저 디코더가 처리할 수 있는 1 GB 한도를 초과했습니다.")
  }
  const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  if (signature[0] === 0x52 && signature[1] === 0x49 && signature[2] === 0x46 && signature[3] === 0x46) {
    try {
      const result = decodePcmWav(new Uint8Array(await file.arrayBuffer()))
      validAudio(result)
      report(onProgress, 100, "WAV 오디오 준비 완료")
      return result
    } catch (error) {
      if (error instanceof Error && error.message.includes("30분")) throw error
    }
  }
  const videoInput = file.type.startsWith("video/")
  if (!videoInput && typeof AudioContext !== "undefined" && typeof OfflineAudioContext !== "undefined") {
    try {
      report(onProgress, 15, "브라우저에서 오디오 디코딩")
      const result = await decodeNativeAudio(file, signal)
      report(onProgress, 100, "오디오 준비 완료")
      return result
    } catch (error) {
      checkAbort(signal)
      if (error instanceof Error && error.message.includes("30분")) throw error
    }
  }
  return withBrowserFfmpeg(signal, async (ffmpeg) => {
    const inputPath = "madnolia-decode-input.bin"
    const outputPath = "madnolia-decode-output.wav"
    try {
      report(onProgress, 5, "브라우저 미디어 변환기 준비")
      await ffmpeg.writeFile(inputPath, new Uint8Array(await file.arrayBuffer()), { signal })
      report(onProgress, 20, "음성을 16 kHz 모노로 변환")
      const code = await ffmpeg.exec([
        "-i", inputPath, "-vn", "-ac", "1", "-ar", String(BROWSER_AUDIO_SAMPLE_RATE),
        "-c:a", "pcm_s16le", "-f", "wav", outputPath,
      ], BROWSER_FFMPEG_EXEC_TIMEOUT_MS, { signal })
      if (code !== 0) throw new Error("이 파일에서 브라우저가 읽을 수 있는 오디오를 찾지 못했습니다.")
      const bytes = await ffmpeg.readFile(outputPath, undefined, { signal })
      if (typeof bytes === "string") throw new Error("오디오 변환 결과를 읽지 못했습니다.")
      const result = decodePcmWav(new Uint8Array(bytes))
      validAudio(result)
      report(onProgress, 100, "오디오 준비 완료")
      return result
    } finally {
      await cleanupFfmpegFiles(ffmpeg, [inputPath, outputPath])
    }
  })
}

const decodePcmWav = (bytes: Uint8Array): BrowserAudioData => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 44 || view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) {
    throw new Error("변환된 WAV 파일이 올바르지 않습니다.")
  }
  let offset = 12
  let channels = 0
  let sampleRate = 0
  let bits = 0
  let format = 0
  let dataOffset = -1
  let dataLength = 0
  while (offset + 8 <= bytes.length) {
    const id = view.getUint32(offset, false)
    const size = view.getUint32(offset + 4, true)
    const payload = offset + 8
    if (id === 0x666d7420 && size >= 16) {
      format = view.getUint16(payload, true)
      channels = view.getUint16(payload + 2, true)
      sampleRate = view.getUint32(payload + 4, true)
      bits = view.getUint16(payload + 14, true)
    }
    if (id === 0x64617461) {
      dataOffset = payload
      dataLength = Math.min(size, bytes.length - payload)
      break
    }
    offset = payload + size + (size & 1)
  }
  if (format !== 1 || bits !== 16 || channels < 1 || dataOffset < 0 || sampleRate < 1) {
    throw new Error("브라우저 오디오 변환 결과가 16-bit PCM WAV가 아닙니다.")
  }
  const frames = Math.floor(dataLength / (channels * 2))
  const estimatedOutputFrames = Math.ceil(frames * BROWSER_AUDIO_SAMPLE_RATE / sampleRate)
  if (estimatedOutputFrames > BROWSER_AUDIO_MAX_OUTPUT_SAMPLES) {
    throw new Error("브라우저 오디오 한도인 30분을 초과했습니다. 파일을 나눠서 처리해 주세요.")
  }
  const mono = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) {
      sum += view.getInt16(dataOffset + (frame * channels + channel) * 2, true) / 32768
    }
    mono[frame] = sum / channels
  }
  if (sampleRate === BROWSER_AUDIO_SAMPLE_RATE) return { samples: mono, sampleRate }
  return { samples: resampleLinear(mono, sampleRate, BROWSER_AUDIO_SAMPLE_RATE), sampleRate: BROWSER_AUDIO_SAMPLE_RATE }
}

const interpPoints = (position: number, points: PhonePitchPoint[]): number => {
  if (!points.length) return 0
  if (position <= points[0].position) return points[0].midi
  for (let index = 1; index < points.length; index += 1) {
    if (position <= points[index].position) {
      const left = points[index - 1]
      const right = points[index]
      const t = (position - left.position) / Math.max(1e-9, right.position - left.position)
      return left.midi + (right.midi - left.midi) * t
    }
  }
  return points[points.length - 1].midi
}

const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440)
const midiToHz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12)

export const loadBrowserCompositionSources = async (projectId: string, wantedSources: string[] = []): Promise<Map<string, BrowserCompositionSource>> => {
  const project = await readWorkspaceJson<BrowserProjectRecord>(`projects/${projectId}/project.json`)
  const result = new Map<string, BrowserCompositionSource>()
  await Promise.all(project.analysis_ids.map(async (analysisId) => {
    const analysis = await readWorkspaceJson<BrowserAnalysisRecord>(`analyses/${analysisId}/analysis.json`)
    if (wantedSources.length && !wantedSources.includes(analysis.source.source_id)) return
    const audioFile = await readWorkspaceFile(analysis.audio_path)
    const samples = await decodeMedia(audioFile)
    let media: File | null = null
    try { media = await readWorkspaceFile(analysis.media_path) } catch {}
    result.set(analysis.source.source_id, { sourceId: analysis.source.source_id, audio: samples, media, source: analysis.source, mediaPath: analysis.media_path })
  }))
  return result
}

const unitCurve = (unit: PhoneUnit, owner: PhoneUnit | undefined, segment: TimelineSegment, sourcePitch: number | null): BrowserPitchCurve | null => {
  const points = unit.pitch_points?.length ? unit.pitch_points : owner?.pitch_points
  const curveOwner = unit.pitch_points?.length ? unit : owner ?? unit
  if (points?.length && curveOwner.source_start_ms !== null && curveOwner.source_end_ms !== null) {
    return {
      points,
      startMs: curveOwner.source_start_ms,
      endMs: curveOwner.source_end_ms,
    }
  }
  if (unit.target_pitch_midi !== null && unit.target_pitch_strength_percent > 0 && sourcePitch !== null && unit.source_start_ms !== null && unit.source_end_ms !== null) {
    const target = sourcePitch + (unit.target_pitch_midi - sourcePitch) * unit.target_pitch_strength_percent / 100
    return { points: [{ position: 0, midi: target }, { position: 1, midi: target }], startMs: unit.source_start_ms, endMs: unit.source_end_ms }
  }
  void segment
  return null
}

const phoneOutputBounds = (segment: TimelineSegment): BrowserRenderUnit[] => {
  let cursor = 0
  return segment.phone_units.map((unit) => {
    const startMs = cursor
    cursor += Math.max(0, unit.output_duration_ms)
    return { unit, startMs, endMs: cursor }
  })
}

const regionOutputBounds = (segment: TimelineSegment): BrowserRenderRegion[] => {
  let cursor = 0
  return segment.edit_regions.map((region) => {
    const startMs = cursor
    cursor += Math.max(0, region.output_duration_ms)
    return { region, startMs, endMs: cursor }
  })
}

const regionContaining = (regions: BrowserRenderRegion[], sourceMs: number): BrowserRenderRegion | undefined =>
  regions.find(({ region }) => region.source_start_ms <= sourceMs && sourceMs < region.source_end_ms)

const mappedOutputMs = (regions: BrowserRenderRegion[], sourceMs: number): number | null => {
  const region = regionContaining(regions, sourceMs)
  if (!region) return null
  const span = Math.max(1, region.region.source_end_ms - region.region.source_start_ms)
  return region.startMs + (sourceMs - region.region.source_start_ms) * region.region.output_duration_ms / span
}

const sourceSlice = (audio: BrowserAudioData, startMs: number, endMs: number): Float32Array => {
  const start = Math.max(0, Math.min(audio.samples.length, Math.round(startMs * audio.sampleRate / 1000)))
  const end = Math.max(start, Math.min(audio.samples.length, Math.round(endMs * audio.sampleRate / 1000)))
  return audio.samples.slice(start, end)
}

const applyVolumeEnvelope = (samples: Float32Array, points: TimelineSegment["volume_envelope"]): void => {
  if (!points?.length) return
  for (let index = 0; index < samples.length; index += 1) {
    const position = index / Math.max(1, samples.length)
    let gain = points[0].gain
    for (let point = 1; point < points.length; point += 1) {
      if (position <= points[point].position) {
        const left = points[point - 1]
        const right = points[point]
        const t = (position - left.position) / Math.max(1e-9, right.position - left.position)
        gain = left.gain + (right.gain - left.gain) * t
        break
      }
      gain = points[point].gain
    }
    samples[index] *= gain
  }
}

const segmentOutput = async (
  segment: TimelineSegment,
  audio: BrowserAudioData,
  composition: SaveCompositionRequest | CompositionProject,
  allSegments: TimelineSegment[],
  signal?: AbortSignal,
): Promise<Float32Array> => {
  const outputLength = Math.round(Math.max(0, segment.timeline_end_ms - segment.timeline_start_ms) * audio.sampleRate / 1000)
  const output = new Float32Array(outputLength)
  const regions = regionOutputBounds(segment)
  const units = phoneOutputBounds(segment)
  const ownerUnits = new Map<string, PhoneUnit>()
  for (const item of allSegments) for (const unit of item.phone_units) ownerUnits.set(`${item.segment_id}:${unit.phone_unit_id}`, unit)
  if (regions.length) {
    for (const { region, startMs, endMs } of regions) {
      checkAbort(signal)
      const start = Math.max(0, Math.round(startMs * audio.sampleRate / 1000))
      const end = Math.min(output.length, Math.round(endMs * audio.sampleRate / 1000))
      if (end <= start) continue
      let clip = stretchAudio(sourceSlice(audio, region.source_start_ms, region.source_end_ms), end - start)
      const regionF0 = estimatePitch(sourceSlice(audio, region.source_start_ms, region.source_end_ms), audio.sampleRate)
        .filter((frame) => frame.hz !== null)
      const sourceMidi = region.source_f0_hz && region.source_f0_hz > 0
        ? hzToMidi(region.source_f0_hz)
        : regionF0.length ? hzToMidi(regionF0.map((frame) => frame.hz as number).sort((a, b) => a - b)[Math.floor(regionF0.length / 2)]) : null
      const cents = new Float32Array(clip.length)
      const unitsHere = units.filter(({ unit }) => unit.source_start_ms !== null && unit.source_end_ms !== null && unit.source_start_ms < region.source_end_ms && unit.source_end_ms > region.source_start_ms)
      for (let index = 0; index < clip.length; index += 1) {
        const localMs = index * 1000 / audio.sampleRate
        const sourceMs = region.source_start_ms + localMs * (region.source_end_ms - region.source_start_ms) / Math.max(1, endMs - startMs)
        let amount = region.relative_pitch_cents
        if (composition.segments.length && segment.pitch_envelope?.length) {
          const p = (startMs + localMs) / Math.max(1, output.length * 1000 / audio.sampleRate)
          amount += interpolateCents(segment.pitch_envelope, p)
        }
        if (region.pitch_points?.length && sourceMidi !== null) {
          const target = interpPoints((sourceMs - region.source_start_ms) / Math.max(1, region.source_end_ms - region.source_start_ms), region.pitch_points)
          amount += (target - sourceMidi) * 100
        }
        for (const { unit } of unitsHere) {
          if (sourceMs < (unit.source_start_ms ?? -1) || sourceMs > (unit.source_end_ms ?? -1)) continue
          const owner = unit.pitch_owner_ref ? ownerUnits.get(`${unit.pitch_owner_ref.segment_id}:${unit.pitch_owner_ref.phone_unit_id}`) : undefined
          const curve = unitCurve(unit, owner, segment, unit.source_f0_hz ? hzToMidi(unit.source_f0_hz) : sourceMidi)
          if (curve) {
            const midi = interpPoints((sourceMs - curve.startMs) / Math.max(1, curve.endMs - curve.startMs), curve.points)
            if (sourceMidi !== null) amount = (midi - sourceMidi) * 100 + region.relative_pitch_cents
          } else if (unit.vibrato_depth_cents > 0 && unit.vibrato_rate_hz > 0) {
            const unitStartOutput = mappedOutputMs(regions, unit.source_start_ms ?? sourceMs) ?? 0
            const elapsed = startMs + localMs - unitStartOutput - unit.vibrato_start_ms
            if (elapsed >= 0) amount += unit.vibrato_depth_cents * Math.sin(2 * Math.PI * unit.vibrato_rate_hz * elapsed / 1000)
          }
          amount += unit.formant_shift_semitones * 0
        }
        cents[index] = amount
      }
      clip = await renderPitchCurve(clip, cents, signal, unitsHere.reduce((value, item) => value + item.unit.formant_shift_semitones, 0) / Math.max(1, unitsHere.length))
      output.set(clip.slice(0, end - start), start)
    }
  } else if (units.length) {
    for (const [unitIndex, { unit, startMs, endMs }] of units.entries()) {
      checkAbort(signal)
      if (unit.source_start_ms === null || unit.source_end_ms === null) continue
      const start = Math.max(0, Math.round(startMs * audio.sampleRate / 1000))
      const end = Math.min(output.length, Math.round(endMs * audio.sampleRate / 1000))
      if (end <= start) continue
      const source = sourceSlice(audio, unit.source_start_ms, unit.source_end_ms)
      let clip = stretchAudio(source, end - start)
      const measured = estimatePitch(source, audio.sampleRate).filter((frame) => frame.hz !== null)
      const measuredMidi = measured.length ? hzToMidi(measured.map((frame) => frame.hz as number).sort((a, b) => a - b)[Math.floor(measured.length / 2)]) : unit.source_f0_hz ? hzToMidi(unit.source_f0_hz) : null
      const owner = unit.pitch_owner_ref ? ownerUnits.get(`${unit.pitch_owner_ref.segment_id}:${unit.pitch_owner_ref.phone_unit_id}`) : undefined
      const curve = unitCurve(unit, owner, segment, measuredMidi)
      const cents = new Float32Array(clip.length)
      for (let index = 0; index < clip.length; index += 1) {
        const position = index / Math.max(1, clip.length)
        let amount = segment.pitch_envelope?.length ? interpolateCents(segment.pitch_envelope, (start + index) / Math.max(1, output.length)) : 0
        let targetMidi = curve ? interpPoints((unit.source_start_ms + position * (unit.source_end_ms - unit.source_start_ms) - curve.startMs) / Math.max(1, curve.endMs - curve.startMs), curve.points) : measuredMidi
        if (targetMidi !== null && measuredMidi !== null) {
          const localMs = position * Math.max(0, endMs - startMs)
          const edge = (from: number, to: number, amountMs: number): number => {
            const t = Math.max(0, Math.min(1, amountMs))
            return from + (to - from) * t * t * (3 - 2 * t)
          }
          const effectiveTarget = (neighbor: PhoneUnit, fallback: number): number => neighbor.target_pitch_midi === null
            ? fallback
            : fallback + (neighbor.target_pitch_midi - fallback) * neighbor.target_pitch_strength_percent / 100
          const neighborPitch = (neighbor: PhoneUnit): number => neighbor.source_f0_hz && neighbor.source_f0_hz > 0 ? hzToMidi(neighbor.source_f0_hz) : targetMidi as number
          const previous = units[unitIndex - 1]?.unit
          const next = units[unitIndex + 1]?.unit
          if (previous && previous.transition_to_next_ms > 0 && previous.transition_strength_percent > 0) {
            const duration = previous.transition_to_next_ms
            const before = Math.min(duration, Math.max(0, duration / 2 - previous.transition_center_ms))
            const after = duration - before
            const leftTarget = effectiveTarget(previous, neighborPitch(previous))
            const rightTarget = effectiveTarget(unit, measuredMidi)
            const boundary = leftTarget + (rightTarget - leftTarget) * before / duration
            const incoming = rightTarget + (boundary - rightTarget) * previous.transition_strength_percent / 100
            if (after > 0 && localMs < after) targetMidi = edge(incoming, targetMidi, localMs / after)
          }
          if (next && unit.transition_to_next_ms > 0 && unit.transition_strength_percent > 0) {
            const duration = unit.transition_to_next_ms
            const before = Math.min(duration, Math.max(0, duration / 2 - unit.transition_center_ms))
            const rightTarget = effectiveTarget(next, neighborPitch(next))
            const leftTarget = effectiveTarget(unit, measuredMidi)
            const boundary = leftTarget + (rightTarget - leftTarget) * before / duration
            const outgoing = leftTarget + (boundary - leftTarget) * unit.transition_strength_percent / 100
            const remaining = Math.max(0, endMs - startMs - localMs)
            if (before > 0 && remaining < before) targetMidi = edge(targetMidi, outgoing, 1 - remaining / before)
          }
          amount += (targetMidi - measuredMidi) * 100
        }
        if (unit.vibrato_depth_cents > 0 && unit.vibrato_rate_hz > 0 && index / audio.sampleRate * 1000 >= unit.vibrato_start_ms) {
          amount += unit.vibrato_depth_cents * Math.sin(2 * Math.PI * unit.vibrato_rate_hz * (index / audio.sampleRate * 1000 - unit.vibrato_start_ms) / 1000)
        }
        cents[index] = amount
      }
      clip = await renderPitchCurve(clip, cents, signal, unit.formant_shift_semitones)
      output.set(clip.slice(0, end - start), start)
    }
  } else {
    const source = sourceSlice(audio, segment.source_start_ms, segment.source_end_ms)
    const clip = stretchAudio(source, output.length)
    output.set(clip.slice(0, output.length))
    if (segment.pitch_envelope?.length) {
      const cents = new Float32Array(output.length)
      for (let index = 0; index < cents.length; index += 1) cents[index] = interpolateCents(segment.pitch_envelope, index / Math.max(1, cents.length))
      output.set(await renderPitchCurve(output, cents, signal))
    }
  }
  const activeNotes = (composition.pitch_notes ?? []).filter((note) => note.start_ms < segment.timeline_end_ms && note.end_ms > segment.timeline_start_ms)
  for (const note of activeNotes) {
    const start = Math.max(0, Math.round((note.start_ms - segment.timeline_start_ms) * audio.sampleRate / 1000))
    const end = Math.min(output.length, Math.round((note.end_ms - segment.timeline_start_ms) * audio.sampleRate / 1000))
    if (end <= start) continue
    const local = output.slice(start, end)
    const frames = estimatePitch(local, audio.sampleRate)
    const cents = new Float32Array(local.length)
    for (let index = 0; index < local.length; index += 1) {
      const frame = frames[Math.min(frames.length - 1, Math.round(index / audio.sampleRate * 1000 / BROWSER_AUDIO_PITCH_HOP_MS))]
      const timelineMs = segment.timeline_start_ms + (start + index) * 1000 / audio.sampleRate
      const position = (timelineMs - note.start_ms) / Math.max(1, note.end_ms - note.start_ms)
      if (frame?.hz) cents[index] = (interpPoints(position, note.pitch_points) - hzToMidi(frame.hz)) * 100
    }
    output.set(await renderPitchCurve(local, cents, signal), start)
  }
  applyVolumeEnvelope(output, segment.volume_envelope)
  return output
}

const interpolateCents = (points: TimelineSegment["pitch_envelope"], position: number): number => {
  if (!points?.length) return 0
  if (position <= points[0].position) return points[0].cents
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index]
    if (position <= right.position) {
      const left = points[index - 1]
      const t = (position - left.position) / Math.max(1e-9, right.position - left.position)
      return left.cents + (right.cents - left.cents) * t
    }
  }
  return points[points.length - 1].cents
}

export async function renderBrowserComposition(
  projectId: string,
  body: SaveCompositionRequest | CompositionProject,
  signal?: AbortSignal,
  onProgress?: BrowserProgressCallback,
): Promise<Blob> {
  checkAbort(signal)
  if (!body.segments.length) return encodeWav({ samples: new Float32Array(0), sampleRate: BROWSER_AUDIO_SAMPLE_RATE })
  const ordered = [...body.segments].sort((a, b) => a.timeline_start_ms - b.timeline_start_ms || a.lane - b.lane)
  const durationMs = Math.max(...ordered.map((segment) => segment.timeline_end_ms))
  const length = Math.round(durationMs * BROWSER_AUDIO_SAMPLE_RATE / 1000)
  if (durationMs > BROWSER_AUDIO_MAX_DURATION_MS || length > BROWSER_AUDIO_MAX_OUTPUT_SAMPLES) {
    throw new Error("브라우저 합성은 30분까지 지원합니다. composition을 나눠서 내보내 주세요.")
  }
  const sources = await loadBrowserCompositionSources(projectId, [...new Set(body.segments.map((segment) => segment.source_id))])
  const output = new Float32Array(length)
  const weights = body.mode === "SIMPLE" || !ordered.some((segment) => segment.edit_regions.length)
    ? new Float32Array(length)
    : null
  for (let index = 0; index < ordered.length; index += 1) {
    checkAbort(signal)
    const segment = ordered[index]
    const source = sources.get(segment.source_id)
    if (!source) throw new Error(`프로젝트 오디오를 찾을 수 없습니다: ${segment.source_id}`)
    report(onProgress, 8 + index * 80 / ordered.length, "편집 구간 음성 합성")
    const clip = await segmentOutput(segment, source.audio, body, ordered, signal)
    const start = Math.max(0, Math.round(segment.timeline_start_ms * BROWSER_AUDIO_SAMPLE_RATE / 1000))
    const end = Math.min(output.length, start + clip.length)
    const leftSegment = ordered[index - 1]
    const rightSegment = ordered[index + 1]
    const leftOverlap = leftSegment ? Math.max(0, Math.min(segment.crossfade_ms ?? body.crossfade_ms, leftSegment.timeline_end_ms - segment.timeline_start_ms)) : 0
    const rightOverlap = rightSegment ? Math.max(0, Math.min(rightSegment.crossfade_ms ?? body.crossfade_ms, segment.timeline_end_ms - rightSegment.timeline_start_ms)) : 0
    for (let sample = start; sample < end; sample += 1) {
      const local = sample - start
      let gain = 1
      const fadeIn = Math.round(leftOverlap * BROWSER_AUDIO_SAMPLE_RATE / 1000)
      const fadeOut = Math.round(rightOverlap * BROWSER_AUDIO_SAMPLE_RATE / 1000)
      if (fadeIn && local < fadeIn) gain = Math.min(gain, local / fadeIn)
      if (fadeOut && clip.length - local <= fadeOut) gain = Math.min(gain, Math.max(0, (clip.length - local) / fadeOut))
      output[sample] += clip[local] * gain
      if (weights) weights[sample] += gain
    }
  }
  if (weights) {
    for (let index = 0; index < output.length; index += 1) if (weights[index] > 1) output[index] /= weights[index]
  }
  for (let index = 0; index < output.length; index += 1) output[index] = Math.max(-1, Math.min(1, Number.isFinite(output[index]) ? output[index] : 0))
  report(onProgress, 94, "WAV 작성")
  const result = encodeWav({ samples: output, sampleRate: BROWSER_AUDIO_SAMPLE_RATE })
  report(onProgress, 100, "합성 완료")
  return result
}

const pitchPointsFor = (frames: BrowserPitchFrame[], durationMs: number, strength: number, speed: number, initial: number | null): PhonePitchPoint[] => {
  const voiced = frames.filter((frame) => frame.hz !== null)
  if (!voiced.length || strength <= 0) return []
  const result: PhonePitchPoint[] = []
  let correction = 0
  let previousMs = 0
  for (const frame of voiced) {
    const midi = hzToMidi(frame.hz as number)
    const target = Math.round(midi)
    const raw = (target - midi) * strength / 100
    const elapsed = Math.max(0, frame.timeMs - previousMs)
    const alpha = speed <= 0 ? 1 : 1 - Math.exp(-elapsed / speed)
    correction += alpha * (raw - correction)
    result.push({ position: Math.max(0, Math.min(1, frame.timeMs / Math.max(1, durationMs))), midi: midi + correction })
    previousMs = frame.timeMs
  }
  if (!result.length) return []
  result[0] = { position: 0, midi: result[0].midi }
  result[result.length - 1] = { position: 1, midi: result[result.length - 1].midi }
  if (result.length === 1) return [{ position: 0, midi: result[0].midi }, { position: 1, midi: result[0].midi }]
  void initial
  return result
}

export async function analyzeBrowserPitch(
  projectId: string,
  body: SaveCompositionRequest,
  signal?: AbortSignal,
): Promise<PitchAnalysisResponse> {
  checkAbort(signal)
  const sources = await loadBrowserCompositionSources(projectId, [...new Set(body.segments.map((segment) => segment.source_id))])
  const segments = []
  for (const segment of body.segments) {
    checkAbort(signal)
    const source = sources.get(segment.source_id)
    if (!source) continue
    const phones = []
    const bounds = phoneOutputBounds(segment)
    for (const { unit, startMs, endMs } of bounds) {
      if (unit.source_start_ms === null || unit.source_end_ms === null) continue
      const sourceStart = unit.source_start_ms
      const sourceEnd = unit.source_end_ms
      const samples = sourceSlice(source.audio, sourceStart, sourceEnd)
      const frames = estimatePitch(samples, source.audio.sampleRate)
      const original = frames.map((frame) => ({ position: Math.max(0, Math.min(1, (startMs + frame.timeMs * unit.output_duration_ms / Math.max(1, sourceEnd - sourceStart)) / Math.max(1, segment.timeline_end_ms - segment.timeline_start_ms))), hz: frame.hz }))
      const points = unit.pitch_points ?? []
      const corrected = frames.map((frame, frameIndex) => {
        if (!frame.hz) return { position: original[frameIndex]?.position ?? 0, hz: null }
        const midi = points.length ? interpPoints(frame.timeMs / Math.max(1, samples.length * 1000 / source.audio.sampleRate), points) : unit.target_pitch_midi !== null ? hzToMidi(frame.hz) + (unit.target_pitch_midi - hzToMidi(frame.hz)) * unit.target_pitch_strength_percent / 100 : hzToMidi(frame.hz)
        return { position: original[frameIndex]?.position ?? 0, hz: midiToHz(midi) }
      })
      phones.push({ phone_unit_id: unit.phone_unit_id, source_start_ms: unit.source_start_ms, source_end_ms: unit.source_end_ms, output_start_ms: Math.round(startMs), output_end_ms: Math.round(endMs), original, corrected })
    }
    const regions = []
    let offset = 0
    for (const region of segment.edit_regions) {
      const samples = sourceSlice(source.audio, region.source_start_ms, region.source_end_ms)
      const frames = estimatePitch(samples, source.audio.sampleRate)
      const original = frames.map((frame) => ({ position: Math.min(1, (offset + frame.timeMs * region.output_duration_ms / Math.max(1, region.source_end_ms - region.source_start_ms)) / Math.max(1, segment.timeline_end_ms - segment.timeline_start_ms)), hz: frame.hz }))
      const corrected = frames.map((frame, frameIndex) => {
        if (!frame.hz) return { position: original[frames.indexOf(frame)]?.position ?? 0, hz: null }
        const pos = frame.timeMs / Math.max(1, samples.length * 1000 / source.audio.sampleRate)
        const midi = region.pitch_points?.length ? interpPoints(pos, region.pitch_points) : hzToMidi(frame.hz) + region.relative_pitch_cents / 100
        return { position: original[frameIndex]?.position ?? 0, hz: midiToHz(midi) }
      })
      regions.push({ region_id: region.region_id, source_start_ms: region.source_start_ms, source_end_ms: region.source_end_ms, output_start_ms: Math.round(offset), output_end_ms: Math.round(offset + region.output_duration_ms), original, corrected })
      offset += region.output_duration_ms
    }
    segments.push({ segment_id: segment.segment_id, phones, regions })
  }
  return { segments }
}

export async function autotuneBrowserComposition(
  projectId: string,
  body: ProfessionalAutotuneRequest,
  signal?: AbortSignal,
): Promise<ProfessionalAutotuneResponse> {
  checkAbort(signal)
  const sources = await loadBrowserCompositionSources(projectId, [...new Set(body.composition.segments.map((segment) => segment.source_id))])
  const segments = []
  let previousCorrection = 0
  for (const segment of body.composition.segments) {
    checkAbort(signal)
    const source = sources.get(segment.source_id)
    if (!source) continue
    const editRegions = segment.edit_regions.map((region) => ({ ...region, pitch_points: [] as PhonePitchPoint[], source_f0_hz: null as number | null }))
    const units = segment.phone_units.map((unit) => ({ ...unit, pitch_points: [] as PhonePitchPoint[], pitch_owner_ref: null as PhoneUnit["pitch_owner_ref"] }))
    if (body.strength_percent > 0) {
      if (editRegions.length) {
        let outputOffset = 0
        for (const entry of editRegions) {
          const samples = sourceSlice(source.audio, entry.source_start_ms, entry.source_end_ms)
          const frames = estimatePitch(samples, source.audio.sampleRate).filter((frame) => frame.hz !== null)
          const pitches = frames.map((frame) => hzToMidi(frame.hz as number))
          if (pitches.length) entry.source_f0_hz = midiToHz([...pitches].sort((a, b) => a - b)[Math.floor(pitches.length / 2)])
          const points = pitchPointsFor(frames, entry.source_end_ms - entry.source_start_ms, body.strength_percent, body.speed_ms, null)
          if (points.length) entry.pitch_points = points
          else if (entry.source_f0_hz) entry.pitch_points = [{ position: 0, midi: hzToMidi(entry.source_f0_hz) }, { position: 1, midi: hzToMidi(entry.source_f0_hz) }]
          outputOffset += entry.output_duration_ms
        }
        void outputOffset
      } else {
        for (const [index, unit] of units.entries()) {
          if (unit.source_start_ms === null || unit.source_end_ms === null) continue
          const samples = sourceSlice(source.audio, unit.source_start_ms, unit.source_end_ms)
          const frames = estimatePitch(samples, source.audio.sampleRate).filter((frame) => frame.hz !== null)
          const points = pitchPointsFor(frames, samples.length * 1000 / source.audio.sampleRate, body.strength_percent, body.speed_ms, unit.source_f0_hz)
          if (points.length) {
            unit.source_f0_hz = midiToHz(points.map((point) => point.midi).sort((a, b) => a - b)[Math.floor(points.length / 2)])
            unit.pitch_points = points
          }
          if (unit.source_f0_hz && body.strength_percent > 0) {
            const midi = points.length ? points[0].midi : Math.round(hzToMidi(unit.source_f0_hz))
            unit.pitch_points = [{ position: 0, midi }, { position: 1, midi }]
          }
          if (index && unit.source_f0_hz === null) previousCorrection = 0
        }
        const vowels = units.map((unit, index) => unit.pitch_points.length ? index : -1).filter((index) => index >= 0)
        for (const [index, unit] of units.entries()) {
          if (unit.pitch_points.length) {
            unit.pitch_owner_ref = { segment_id: segment.segment_id, phone_unit_id: unit.phone_unit_id }
            continue
          }
          const ownerIndex = vowels.find((vowel) => vowel > index) ?? [...vowels].reverse().find((vowel) => vowel < index)
          if (ownerIndex !== undefined) unit.pitch_owner_ref = { segment_id: segment.segment_id, phone_unit_id: units[ownerIndex].phone_unit_id }
        }
      }
    }
    segments.push({ segment_id: segment.segment_id, phone_units: units, edit_regions: editRegions })
  }
  void previousCorrection
  return { segments }
}

export const browserAudioSourcePath = (analysisId: string): string => `analyses/${analysisId}/analysis.json`
