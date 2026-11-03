import type { BrowserExportArtifact, CompositionProject, ExportTarget } from "../types"
import type { BrowserProgressCallback } from "../types/browserAudio"
import {
  BROWSER_AUDIO_MAX_INPUT_BYTES,
  BROWSER_FFMPEG_EXEC_TIMEOUT_MS,
  BROWSER_AUDIO_MP4_MAX_DURATION_MS,
  BROWSER_AUDIO_SAMPLE_RATE,
} from "../browserAudioConstants"
import { readWorkspaceFile, readWorkspaceJson, writeWorkspaceJson } from "./workspace"
import type { BrowserAnalysisRecord, BrowserProjectRecord } from "../types"
import type { BrowserCompositionSource } from "../types/browserAudio"
import type { BrowserVideoOutputSpec, BrowserVideoProbeLogEvent } from "../types/browserVideoMetadata"
import { loadBrowserCompositionSources, renderBrowserComposition } from "./audio"
import { cleanupFfmpegFiles, withBrowserFfmpeg } from "./ffmpeg"
import { browserVideoBaseInputArgs, browserVideoEncoderArgs, browserVideoScalePadFilter, edlText, fcpxmlText, videoClips } from "./exportsFormats"
import { backfillAnalysisRecordVideoMetadata, mergeProbedVideoMetadata, probeOptionalSourceVideoMetadata, resolveBrowserVideoOutputSpec, validSourceVideoMetadata } from "./videoMetadata"

const filenameFor = (composition: CompositionProject, target: ExportTarget): string => {
  const name = composition.name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ") || composition.composition_id
  return `${name}.${target.toLowerCase()}`
}

const resolveOutputSpec = async (
  projectId: string,
  sources: Map<string, BrowserCompositionSource>,
  signal?: AbortSignal,
  textOutput = false,
): Promise<BrowserVideoOutputSpec> => {
  if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError")
  const project = await readWorkspaceJson<BrowserProjectRecord>(`projects/${projectId}/project.json`)
  const manifestSource = project.detail.manifest.sources[0]
  if (!manifestSource) return resolveBrowserVideoOutputSpec(null)
  const firstSourceId = manifestSource.source_id
  const selected = sources.get(firstSourceId)
  let record: BrowserAnalysisRecord | null = null
  let recordId: string | null = null
  const mappedId = project.detail.manifest.source_analyses[firstSourceId]
  const attemptedIds = new Set<string>()
  if (mappedId) {
    attemptedIds.add(mappedId)
    try {
      record = await readWorkspaceJson<BrowserAnalysisRecord>(`analyses/${mappedId}/analysis.json`)
      if (record.source.source_id === firstSourceId) recordId = mappedId
      else record = null
    } catch (error) {
      if (!isNotFoundError(error)) throw error
    }
  }
  if (!record) {
    for (const analysisId of project.analysis_ids) {
      if (attemptedIds.has(analysisId)) continue
      attemptedIds.add(analysisId)
      let candidate: BrowserAnalysisRecord
      try {
        candidate = await readWorkspaceJson<BrowserAnalysisRecord>(`analyses/${analysisId}/analysis.json`)
      } catch (error) {
        if (isNotFoundError(error)) continue
        throw error
      }
      if (candidate.source.source_id === firstSourceId) {
        recordId = analysisId
        record = candidate
        break
      }
    }
  }
  let source = { ...(record?.source ?? manifestSource), ...manifestSource }
  for (const key of ["video_width", "video_height", "video_fps"] as const) {
    if (!Number.isFinite(source[key]) || (source[key] ?? 0) <= 0) {
      const recordValue = record?.source[key]
      if (typeof recordValue === "number" && Number.isFinite(recordValue) && recordValue > 0) source[key] = recordValue
    }
  }
  if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError")
  if (validSourceVideoMetadata(source)) return resolveBrowserVideoOutputSpec(source)
  let media = selected?.media ?? null
  if (!media && record?.media_path) {
    try {
      media = await readWorkspaceFile(record.media_path)
    } catch (error) {
      if (!isNotFoundError(error)) throw error
    }
  }
  const probed = await probeOptionalSourceVideoMetadata(media, { signal }, textOutput)
  if (probed) {
    if (record) {
      backfillAnalysisRecordVideoMetadata(record, probed)
      if (recordId) await writeWorkspaceJson(`analyses/${recordId}/analysis.json`, record)
    }
    source = { ...source, ...mergeProbedVideoMetadata(source, probed) }
  }
  return resolveBrowserVideoOutputSpec(source)
}

const isNotFoundError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "NotFoundError"

const makeMp4 = async (
  composition: CompositionProject,
  sources: Map<string, BrowserCompositionSource>,
  spec: BrowserVideoOutputSpec,
  signal: AbortSignal | undefined,
  onProgress: BrowserProgressCallback | undefined,
): Promise<Blob> => {
  const durationMs = Math.max(0, ...composition.segments.map((segment) => segment.timeline_end_ms))
  if (!composition.segments.length) throw new Error("MP4로 내보낼 구간이 없습니다.")
  if (durationMs > BROWSER_AUDIO_MP4_MAX_DURATION_MS) throw new Error("브라우저 MP4 출력은 10분까지 지원합니다. composition을 나눠 주세요.")
  const clips = videoClips(composition)
  if (!clips.length) throw new Error("MP4로 내보낼 영상 구간이 없습니다.")
  const videos = new Map<string, File>()
  for (const clip of clips) {
    const source = sources.get(clip.sourceId)
    if (!source?.media) throw new Error(`원본 영상을 찾을 수 없습니다: ${source?.source.path ?? clip.sourceId}`)
    videos.set(clip.sourceId, source.media)
  }
  const totalBytes = [...videos.values()].reduce((sum, file) => sum + file.size, 0)
  if (totalBytes > BROWSER_AUDIO_MAX_INPUT_BYTES) throw new Error("브라우저 MP4 내보내기 입력은 합계 1 GB까지 지원합니다.")
  const wav = await renderBrowserComposition(composition.corpus_project_id, composition, signal, (percent, stage) => report(onProgress, percent * 0.45, stage))
  return withBrowserFfmpeg(signal, async (ffmpeg) => {
    const names = [...videos.keys()]
    const inputPaths = names.map((_, index) => `madnolia-mp4-video-${index}.bin`)
    const wavPath = "madnolia-mp4-audio.wav"
    const outputPath = "madnolia-composition.mp4"
    const touched = [...inputPaths, wavPath, outputPath]
    const ffmpegLog: string[] = []
    const progress = ({ progress: fraction }: { progress: number }): void => report(onProgress, 45 + Math.max(0, Math.min(1, fraction)) * 53, "MP4 인코딩")
    const onLog = ({ message }: BrowserVideoProbeLogEvent): void => {
      ffmpegLog.push(message.slice(0, 240))
      if (ffmpegLog.length > 24) ffmpegLog.shift()
    }
    const describeFailure = (reason: string): string => {
      const detail = ffmpegLog.slice(-12).join(" | ")
      return `${reason}${detail ? ` FFmpeg: ${detail}` : " FFmpeg did not provide diagnostic output."}`
    }
    try {
      ffmpeg.on("progress", progress)
      ffmpeg.on("log", onLog)
      for (const [index, sourceId] of names.entries()) {
        const file = videos.get(sourceId) as File
        await ffmpeg.writeFile(inputPaths[index], new Uint8Array(await file.arrayBuffer()), { signal })
      }
      await ffmpeg.writeFile(wavPath, new Uint8Array(await wav.arrayBuffer()), { signal })
      const duration = durationMs / 1000
      const args = browserVideoBaseInputArgs(spec, duration)
      for (const path of inputPaths) args.push("-i", path)
      args.push("-i", wavPath)
      const sourceInput = new Map(names.map((name, index) => [name, index + 1]))
      const clipsBySource = new Map(names.map((name) => [name, clips.filter((clip) => clip.sourceId === name)]))
      const graph: string[] = ["[0:v]format=rgba,setpts=PTS-STARTPTS[base0]"]
      for (const sourceId of names) {
        const related = clipsBySource.get(sourceId) ?? []
        if (related.length > 1) graph.push(`[${sourceInput.get(sourceId)}:v:0]split=${related.length}${related.map((_, index) => `[src${names.indexOf(sourceId)}_${index}]`).join("")}`)
      }
      let previous = "base0"
      for (const [index, clip] of clips.entries()) {
        const sourceIndex = names.indexOf(clip.sourceId)
        const related = clipsBySource.get(clip.sourceId) ?? []
        const relatedIndex = related.indexOf(clip)
        const inputPad = related.length > 1 ? `src${sourceIndex}_${relatedIndex}` : `${sourceInput.get(clip.sourceId)}:v:0`
        const videoPad = `v${index}`
        const next = `mix${index + 1}`
        const start = clip.timelineStartMs / 1000
        const end = (clip.timelineStartMs + clip.durationMs) / 1000
        const rate = Math.max(0.01, clip.durationMs / Math.max(1, clip.sourceEndMs - clip.sourceStartMs))
        const overlap = Math.min(clip.crossfadeMs, clip.durationMs) / 1000
        graph.push(`[${inputPad}]trim=start=${clip.sourceStartMs / 1000}:end=${clip.sourceEndMs / 1000},setpts=(PTS-STARTPTS)*${rate}+${start}/TB,${browserVideoScalePadFilter(spec)},format=rgba${overlap > 0 ? `,fade=t=in:st=${start}:d=${overlap}:alpha=1` : ""}[${videoPad}]`)
        graph.push(`[${previous}][${videoPad}]overlay=0:0:eof_action=pass:shortest=0:enable='gte(t,${start})*lt(t,${end})'[${next}]`)
        previous = next
      }
      const audioInput = names.length + 1
      args.push("-filter_complex", graph.join(";"), "-map", `[${previous}]`, "-map", `${audioInput}:a:0`, "-t", String(duration), ...browserVideoEncoderArgs(spec), "-c:a", "aac", "-ar", String(BROWSER_AUDIO_SAMPLE_RATE), "-movflags", "+faststart", outputPath)
      let code: number
      try {
        code = await ffmpeg.exec(args, BROWSER_FFMPEG_EXEC_TIMEOUT_MS, { signal })
      } catch (error) {
        throw new Error(describeFailure(error instanceof Error ? error.message : String(error)))
      }
      if (code !== 0) throw new Error(describeFailure(`브라우저 FFmpeg가 MP4를 만들지 못했습니다 (exit ${code}).`))
      const result = await ffmpeg.readFile(outputPath, undefined, { signal })
      if (typeof result === "string" || result.length < 12) throw new Error("MP4 출력이 비어 있거나 손상되었습니다.")
      report(onProgress, 100, "MP4 내보내기 완료")
      return new Blob([new Uint8Array(result)], { type: "video/mp4" })
    } finally {
      ffmpeg.off("progress", progress)
      ffmpeg.off("log", onLog)
      await cleanupFfmpegFiles(ffmpeg, touched)
    }
  })
}

const report = (callback: BrowserProgressCallback | undefined, percent: number, stage: string): void => {
  callback?.(Math.max(0, Math.min(100, Math.round(percent))), stage)
}

export async function exportBrowserComposition(
  composition: CompositionProject,
  target: ExportTarget,
  signal?: AbortSignal,
  onProgress?: BrowserProgressCallback,
): Promise<BrowserExportArtifact> {
  if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError")
  let blob: Blob
  if (target === "JSON") {
    blob = new Blob([JSON.stringify(composition, null, 2)], { type: "application/json" })
  } else if (target === "WAV") {
    report(onProgress, 2, "composition WAV 합성")
    blob = await renderBrowserComposition(composition.corpus_project_id, composition, signal, onProgress)
  } else if (target === "EDL" || target === "FCPXML") {
    if (!composition.segments.length) throw new Error(`${target} export requires at least one video segment.`)
    const sourceIds = [...new Set(composition.segments.map((segment) => segment.source_id))]
    const sources = await loadBrowserCompositionSources(composition.corpus_project_id, sourceIds)
    const spec = await resolveOutputSpec(composition.corpus_project_id, sources, signal, true)
    const content = target === "EDL"
      ? edlText(composition, sources, spec)
      : fcpxmlText(composition, sources, spec)
    blob = new Blob([content], { type: target === "EDL" ? "text/plain" : "application/xml" })
  } else {
    if (target !== "MP4") throw new Error(`Unsupported export target: ${String(target)}`)
    const sourceIds = [...new Set(composition.segments.map((segment) => segment.source_id))]
    const sources = await loadBrowserCompositionSources(composition.corpus_project_id, sourceIds)
    const spec = await resolveOutputSpec(composition.corpus_project_id, sources, signal)
    blob = await makeMp4(composition, sources, spec, signal, onProgress)
  }
  report(onProgress, 100, "내보내기 완료")
  return { blob, filename: filenameFor(composition, target) }
}
