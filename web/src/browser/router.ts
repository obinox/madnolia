import type {
  CompositionProject,
  ExportJob,
  ExportTarget,
  JobIdResponse,
  ProjectIdResponse,
  ProjectDetail,
  ProjectManifest,
  ProjectSummary,
  ProfessionalAutotuneRequest,
  SaveCompositionRequest,
  SearchJob,
  TimelineSlice,
  WaveformData,
} from "../types"
import type { BrowserProgressCallback } from "../types/browserAudio"
import type {
  BrowserAnalysisRecord,
  BrowserCompositionCreateBody,
  BrowserExportArtifact,
  BrowserProjectCreateRequest,
  BrowserProjectCreateResponse,
  BrowserProjectRecord,
  BrowserSearchRequest,
} from "../types"
import {
  BROWSER_ANALYSIS_RECORD_FILENAME,
  BROWSER_COMPOSITION_RECORD_FILENAME,
  BROWSER_PROJECT_RECORD_FILENAME,
  BROWSER_WAVEFORM_BINS_MAX,
} from "../browserConstants"
import {
  listWorkspaceDirectories,
  readWorkspaceFile,
  readWorkspaceJson,
  writeWorkspaceFile,
  writeWorkspaceJson,
} from "./workspace"
import { startBrowserSearch } from "./search"

const jsonResponse = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json" },
})

const errorResponse = (error: unknown, status = 400): Response => jsonResponse({
  detail: error instanceof Error ? error.message : String(error),
}, status)

function exportTarget(value: string): ExportTarget {
  if (["JSON", "WAV", "MP4", "EDL", "FCPXML"].includes(value)) return value as ExportTarget
  throw new Error(`Unsupported export target: ${value}`)
}

const pathId = (value: string): string => decodeURIComponent(value)

const activeSearches = new Map<string, AbortController>()
const activeExports = new Map<string, AbortController>()

async function persistSearch(job: SearchJob): Promise<void> {
  await writeWorkspaceJson(`jobs/${job.job_id}.json`, job)
}

async function startSearchJob(projectId: string, request: BrowserSearchRequest): Promise<JobIdResponse> {
  const job: SearchJob = {
    job_id: crypto.randomUUID(),
    project_id: projectId,
    status: "running",
    percent: 0,
    stage: "starting",
    result: null,
    error: null,
  }
  const controller = new AbortController()
  activeSearches.set(job.job_id, controller)
  try { await persistSearch(job) }
  catch (error) { activeSearches.delete(job.job_id); throw error }
  let progressWrite = Promise.resolve()
  let lastProgressKey = ""
  window.setTimeout(() => {
    void startBrowserSearch(projectId, request, async (progress) => {
      const key = `${progress.stage}:${Math.floor(progress.percent)}`
      if (key === lastProgressKey) return
      lastProgressKey = key
      job.stage = progress.stage
      job.percent = progress.percent
      progressWrite = progressWrite.then(() => persistSearch(job)).catch(() => undefined)
    }, controller.signal).then(async (result) => {
      await progressWrite
      job.result = result
      job.status = "complete"
      job.percent = 100
      job.stage = "complete"
      await persistSearch(job)
    }).catch(async (error: unknown) => {
      await progressWrite
      job.status = controller.signal.aborted ? "cancelled" : "failed"
      job.stage = job.status
      job.error = error instanceof Error ? error.message : String(error)
      await persistSearch(job)
    }).finally(() => activeSearches.delete(job.job_id)).catch(() => undefined)
  }, 0)
  return { job_id: job.job_id }
}

async function startExportJob(compositionId: string, target: ExportTarget): Promise<JobIdResponse> {
  const job: ExportJob = {
    job_id: crypto.randomUUID(),
    target,
    status: "running",
    percent: 0,
    stage: "starting",
    filename: "",
    error: null,
  }
  const controller = new AbortController()
  activeExports.set(job.job_id, controller)
  try { await writeWorkspaceJson(`jobs/${job.job_id}.json`, job) }
  catch (error) { activeExports.delete(job.job_id); throw error }
  let progressWrite = Promise.resolve()
  let lastProgressKey = ""
  window.setTimeout(() => {
    void readComposition(compositionId).then((composition) => makeExport(composition, target, controller.signal, (percent, stage) => {
      const key = `${stage}:${percent}`
      if (key === lastProgressKey) return
      lastProgressKey = key
      job.percent = percent
      job.stage = stage
      progressWrite = progressWrite.then(() => writeWorkspaceJson(`jobs/${job.job_id}.json`, job)).catch(() => undefined)
    }))
      .then(async (artifact) => {
        await progressWrite
        await writeWorkspaceFile(`jobs/${job.job_id}.blob`, artifact.blob)
        job.filename = artifact.filename
        job.percent = 100
        job.stage = "complete"
        job.status = "complete"
      }).catch(async (error: unknown) => {
        await progressWrite
        job.status = "failed"
        job.stage = "failed"
        job.error = error instanceof Error ? error.message : String(error)
      }).then(() => writeWorkspaceJson(`jobs/${job.job_id}.json`, job))
      .finally(() => activeExports.delete(job.job_id))
      .catch(() => undefined)
  }, 0)
  return { job_id: job.job_id }
}

async function readSearchJob(jobId: string): Promise<SearchJob> {
  const job = await readWorkspaceJson<SearchJob>(`jobs/${jobId}.json`)
  if (!activeSearches.has(jobId) && (job.status === "running" || job.status === "cancelling")) {
    job.status = "failed"
    job.stage = "interrupted"
    job.error = "검색 중 페이지가 닫혀 작업을 복구할 수 없습니다."
    await persistSearch(job)
  }
  return job
}

async function readExportJob(jobId: string): Promise<ExportJob> {
  const job = await readWorkspaceJson<ExportJob>(`jobs/${jobId}.json`)
  if (!activeExports.has(jobId) && job.status === "running") {
    job.status = "failed"
    job.stage = "interrupted"
    job.error = "내보내기 중 페이지가 닫혀 작업을 복구할 수 없습니다."
    await writeWorkspaceJson(`jobs/${jobId}.json`, job)
  }
  return job
}

async function bodyJson<T>(init?: RequestInit): Promise<T> {
  if (typeof init?.body !== "string") throw new Error("요청 데이터가 없습니다.")
  return JSON.parse(init.body) as T
}

async function listAnalyses(): Promise<BrowserAnalysisRecord[]> {
  const ids = await listWorkspaceDirectories("analyses")
  const records = await Promise.all(ids.map((id) => readWorkspaceJson<BrowserAnalysisRecord>(`analyses/${id}/${BROWSER_ANALYSIS_RECORD_FILENAME}`)))
  return records
}

async function readProject(projectId: string): Promise<BrowserProjectRecord> {
  return readWorkspaceJson<BrowserProjectRecord>(`projects/${projectId}/${BROWSER_PROJECT_RECORD_FILENAME}`)
}

async function readComposition(compositionId: string): Promise<CompositionProject> {
  return readWorkspaceJson<CompositionProject>(`collages/${compositionId}/${BROWSER_COMPOSITION_RECORD_FILENAME}`)
}

async function projectSummary(record: BrowserProjectRecord): Promise<ProjectSummary> {
  const { manifest } = record.detail
  return {
    project_id: manifest.project_id,
    name: manifest.name,
    created_at: manifest.created_at,
    model_name: manifest.model_name,
    inference_backend: manifest.inference_backend,
    inference_device: manifest.inference_device,
    alignment_mode: "estimated",
    source_count: manifest.sources.length,
    total_duration_ms: manifest.sources.reduce((total, source) => total + source.duration_ms, 0),
  }
}

async function listProjects(): Promise<ProjectSummary[]> {
  const ids = await listWorkspaceDirectories("projects")
  const records = await Promise.all(ids.map(readProject))
  return Promise.all(records.map(projectSummary))
}

async function createProject(body: BrowserProjectCreateRequest): Promise<BrowserProjectCreateResponse> {
  if (!body.name.trim() || !body.analysis_ids.length) throw new Error("프로젝트 이름과 분석을 선택하세요.")
  const allRecords = await listAnalyses()
  const records = body.analysis_ids.map((id) => {
    const record = allRecords.find((item) => item.summary.analysis_id === id)
    if (!record) throw new Error(`분석을 찾을 수 없습니다: ${id}`)
    return record
  })
  const projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  const sources = records.map((record) => record.source)
  const sourceAnalyses = Object.fromEntries(records.map((record) => [record.source.source_id, record.summary.analysis_id]))
  const manifest: ProjectManifest = {
    project_id: projectId,
    name: body.name.trim(),
    analysis_ids: records.map((record) => record.summary.analysis_id),
    source_analyses: sourceAnalyses,
    created_at: now,
    model_name: records[0].summary.model_name,
    inference_backend: "transformers-js",
    inference_device: "browser",
    sources,
  }
  const detail: ProjectDetail = {
    manifest,
    analyses: records.map((record) => record.overview),
  }
  await writeWorkspaceJson(`projects/${projectId}/${BROWSER_PROJECT_RECORD_FILENAME}`, {
    detail,
    analysis_ids: manifest.analysis_ids,
  } satisfies BrowserProjectRecord)
  return { project_id: projectId } satisfies ProjectIdResponse
}

async function listCompositions(): Promise<CompositionProject[]> {
  const ids = await listWorkspaceDirectories("collages")
  return Promise.all(ids.map(readComposition))
}

async function saveComposition(projectId: string, body: SaveCompositionRequest, compositionId?: string): Promise<CompositionProject> {
  await readProject(projectId)
  const previous = compositionId ? await readComposition(compositionId) : null
  const now = new Date().toISOString()
  const id = compositionId ?? crypto.randomUUID()
  const composition: CompositionProject = {
    composition_id: id,
    corpus_project_id: projectId,
    name: body.name,
    target_text: body.target_text,
    target_pronunciation: body.target_pronunciation,
    created_at: previous?.created_at ?? now,
    updated_at: now,
    crossfade_ms: body.crossfade_ms,
    tempo_bpm: body.tempo_bpm,
    beats_per_bar: body.beats_per_bar,
    beat_division: body.beat_division,
    grid_offset_units: body.grid_offset_units,
    pitch_notes: body.pitch_notes,
    segments: body.segments,
    mode: body.mode,
    schema_version: body.schema_version,
    parent_composition_id: body.parent_composition_id,
    parent_composition_updated_at: body.parent_composition_updated_at,
  }
  await writeWorkspaceJson(`collages/${id}/${BROWSER_COMPOSITION_RECORD_FILENAME}`, composition)
  return composition
}

async function sourceRecords(project: BrowserProjectRecord): Promise<BrowserAnalysisRecord[]> {
  const allRecords = await listAnalyses()
  return project.analysis_ids.map((id) => {
    const record = allRecords.find((item) => item.summary.analysis_id === id)
    if (!record) throw new Error(`분석 파일을 찾을 수 없습니다: ${id}`)
    return record
  })
}

async function getTimeline(projectId: string, query: URLSearchParams): Promise<TimelineSlice> {
  const sourceId = query.get("source_id") ?? ""
  const startMs = Number(query.get("start_ms"))
  const endMs = Number(query.get("end_ms"))
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error("시간 범위가 올바르지 않습니다.")
  const project = await readProject(projectId)
  const record = (await sourceRecords(project)).find((item) => item.source.source_id === sourceId)
  if (!record) throw new Error("프로젝트 원본을 찾을 수 없습니다.")
  const includeWords = query.get("include_words") !== "false"
  const includePhones = query.get("include_phones") !== "false"
  const phones = includePhones ? record.phones.filter((item) => item.start_ms < endMs && item.end_ms > startMs) : []
  const phoneIds = new Set(phones.map((item) => item.occurrence_id))
  return {
    start_ms: startMs,
    end_ms: endMs,
    audio_regions: record.overview.audio_regions.filter((item) => item.start_ms < endMs && item.end_ms > startMs),
    words: includeWords ? record.overview.words.filter((item) => item.start_ms < endMs && item.end_ms > startMs) : [],
    phones,
    acoustic_features: record.acoustic_features.filter((item) => phoneIds.has(item.occurrence_id)),
  }
}

async function getWaveform(projectId: string, query: URLSearchParams, signal?: AbortSignal): Promise<WaveformData> {
  const sourceId = query.get("source_id") ?? ""
  const startMs = Number(query.get("start_ms"))
  const endMs = Number(query.get("end_ms"))
  const bins = Math.max(1, Math.min(BROWSER_WAVEFORM_BINS_MAX, Number(query.get("bins") ?? 1200)))
  const project = await readProject(projectId)
  const record = (await sourceRecords(project)).find((item) => item.source.source_id === sourceId)
  if (!record) throw new Error("프로젝트 원본을 찾을 수 없습니다.")
  const file = await readWorkspaceFile(record.audio_path)
  const { decodeMedia } = await import("./audio")
  const decoded = await decodeMedia(file, signal)
  const from = Math.max(0, Math.floor(startMs * decoded.sampleRate / 1000))
  const to = Math.min(decoded.samples.length, Math.ceil(endMs * decoded.sampleRate / 1000))
  const peaks = Array.from({ length: bins }, (_, index) => {
    const first = from + Math.floor((to - from) * index / bins)
    const last = Math.min(to, Math.max(first + 1, from + Math.floor((to - from) * (index + 1) / bins)))
    let peak = 0
    for (let sample = first; sample < last; sample += 1) peak = Math.max(peak, Math.abs(decoded.samples[sample] ?? 0))
    return peak
  })
  return { start_ms: startMs, end_ms: endMs, peaks }
}

async function validateCompositionBody(body: SaveCompositionRequest): Promise<SaveCompositionRequest> {
  if (body.parent_composition_id) {
    const parent = await readComposition(body.parent_composition_id)
    if (body.parent_composition_updated_at !== parent.updated_at) throw new Error("부모 합성이 변경되어 저장할 수 없습니다. 새 복사본을 만드세요.")
  }
  return body
}

async function makeExport(composition: CompositionProject, target: ExportTarget, signal?: AbortSignal, onProgress?: BrowserProgressCallback): Promise<BrowserExportArtifact> {
  const { exportBrowserComposition } = await import("./exports")
  return exportBrowserComposition(composition, target, signal, onProgress)
}

export async function handleBrowserRequest(path: string, init?: RequestInit): Promise<Response | null> {
  const url = new URL(path, window.location.origin)
  const pathname = url.pathname
  const method = (init?.method ?? "GET").toUpperCase()
  const parts = pathname.split("/").filter(Boolean)
  const signal = init?.signal ?? undefined
  try {
    const { handleBrowserAnalysisRequest } = await import("./analysis")
    const analysis = await handleBrowserAnalysisRequest(`${pathname}${url.search}`, init)
    if (analysis) return analysis

    if (method === "GET" && pathname === "/api/projects") return jsonResponse(await listProjects())
    if (method === "POST" && pathname === "/api/projects") return jsonResponse(await createProject(await bodyJson(init)))
    if (method === "GET" && parts[1] === "projects" && parts.length === 3) {
      return jsonResponse((await readProject(pathId(parts[2]))).detail)
    }
    if (method === "GET" && parts[1] === "projects" && parts[3] === "timeline") {
      return jsonResponse(await getTimeline(pathId(parts[2]), url.searchParams))
    }
    if (method === "GET" && parts[1] === "projects" && parts[3] === "waveform") {
      return jsonResponse(await getWaveform(pathId(parts[2]), url.searchParams, signal))
    }
    if (method === "GET" && parts[1] === "projects" && parts[3] === "audio") {
      const project = await readProject(pathId(parts[2]))
      const record = (await sourceRecords(project)).find((item) => item.source.source_id === pathId(parts[4]))
      if (!record) throw new Error("프로젝트 원본을 찾을 수 없습니다.")
      return new Response(await readWorkspaceFile(record.audio_path), { headers: { "Content-Type": "audio/wav" } })
    }
    if (method === "GET" && parts[1] === "projects" && parts[3] === "media") {
      const project = await readProject(pathId(parts[2]))
      const record = (await sourceRecords(project)).find((item) => item.source.source_id === pathId(parts[4]))
      if (!record) throw new Error("프로젝트 원본을 찾을 수 없습니다.")
      const file = await readWorkspaceFile(record.media_path)
      return new Response(file, { headers: { "Content-Type": file.type || "application/octet-stream" } })
    }
    if (method === "GET" && pathname === "/api/collages") return jsonResponse(await listCompositions())
    if (method === "GET" && parts[1] === "collages" && parts.length === 3) return jsonResponse(await readComposition(pathId(parts[2])))
    if (method === "POST" && pathname === "/api/collages") {
      const body = await bodyJson<BrowserCompositionCreateBody>(init)
      return jsonResponse(await saveComposition(body.project_id, await validateCompositionBody(body.composition)))
    }
    if (method === "PUT" && parts[1] === "collages" && parts.length === 3) {
      const previous = await readComposition(pathId(parts[2]))
      return jsonResponse(await saveComposition(previous.corpus_project_id, await validateCompositionBody(await bodyJson(init)), previous.composition_id))
    }
    if (method === "GET" && parts[1] === "projects" && parts[3] === "compositions" && parts.length === 4) {
      return jsonResponse((await listCompositions()).filter((item) => item.corpus_project_id === pathId(parts[2])))
    }
    if (method === "GET" && parts[1] === "projects" && parts[3] === "compositions" && parts.length === 5) {
      return jsonResponse(await readComposition(pathId(parts[4])))
    }
    if (method === "POST" && parts[1] === "projects" && parts[3] === "compositions" && parts[4] === "preview") {
      const body = await validateCompositionBody(await bodyJson(init))
      const { renderBrowserComposition } = await import("./audio")
      const blob = await renderBrowserComposition(pathId(parts[2]), body, signal)
      return new Response(blob, { headers: { "Content-Type": "audio/wav" } })
    }
    if (method === "POST" && parts[1] === "projects" && parts[3] === "compositions" && parts[4] === "autotune") {
      const body = await bodyJson<ProfessionalAutotuneRequest>(init)
      const { autotuneBrowserComposition } = await import("./audio")
      return jsonResponse(await autotuneBrowserComposition(pathId(parts[2]), body, signal))
    }
    if (method === "POST" && parts[1] === "projects" && parts[3] === "compositions" && parts[4] === "pitch-analysis") {
      const body = await validateCompositionBody(await bodyJson(init))
      const { analyzeBrowserPitch } = await import("./audio")
      return jsonResponse(await analyzeBrowserPitch(pathId(parts[2]), body, signal))
    }
    if (method === "POST" && parts[1] === "projects" && parts[3] === "compositions" && parts.length === 4) {
      return jsonResponse(await saveComposition(pathId(parts[2]), await validateCompositionBody(await bodyJson(init))))
    }
    if (method === "PUT" && parts[1] === "projects" && parts[3] === "compositions" && parts.length === 5) {
      return jsonResponse(await saveComposition(pathId(parts[2]), await validateCompositionBody(await bodyJson(init)), pathId(parts[4])))
    }
    if (method === "POST" && parts[1] === "projects" && parts[3] === "search-jobs") {
      const body = await bodyJson<BrowserSearchRequest>(init)
      return jsonResponse(await startSearchJob(pathId(parts[2]), body))
    }
    if (parts[1] === "search-jobs" && parts.length === 3 && method === "GET") {
      return jsonResponse(await readSearchJob(pathId(parts[2])))
    }
    if (parts[1] === "search-jobs" && parts.length === 3 && method === "DELETE") {
      const jobId = pathId(parts[2])
      const job = await readSearchJob(jobId)
      const controller = activeSearches.get(jobId)
      if (controller && job.status === "running") {
        job.status = "cancelling"
        await persistSearch(job)
        controller.abort()
      }
      return jsonResponse(job)
    }
    if (method === "POST" && parts[1] === "collages" && parts[3] === "export-jobs") {
      return jsonResponse(await startExportJob(pathId(parts[2]), exportTarget(pathId(parts[4]))))
    }
    if (method === "GET" && parts[1] === "export-jobs" && parts.length === 3) {
      return jsonResponse(await readExportJob(pathId(parts[2])))
    }
    if (method === "GET" && parts[1] === "export-jobs" && parts[3] === "download") {
      const jobId = pathId(parts[2])
      const job = await readExportJob(jobId)
      return new Response(await readWorkspaceFile(`jobs/${jobId}.blob`), {
        headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${job.filename}"` },
      })
    }
    if (method === "POST" && parts[1] === "collages" && parts[3] === "export") {
      const artifact = await makeExport(await readComposition(pathId(parts[2])), exportTarget(pathId(parts[4])), signal)
      return new Response(artifact.blob, { headers: { "Content-Type": artifact.blob.type || "application/octet-stream", "Content-Disposition": `attachment; filename="${artifact.filename}"` } })
    }
    if (pathname.startsWith("/api/")) return jsonResponse({ detail: `Browser route not implemented: ${method} ${pathname}` }, 501)
    return null
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error
    const status = error instanceof DOMException
      ? error.name === "NotFoundError" ? 404 : ["NotAllowedError", "SecurityError"].includes(error.name) ? 403 : 400
      : 400
    return errorResponse(error, status)
  }
}
