import type {
  SearchJob,
  InputLanguage,
  CompositionProject,
  ExportTarget,
  ProjectDetail,
  ProjectSummary,
  SaveCompositionRequest,
  TimelineSlice,
  WaveformData,
  AnalysisSummary,
  AnalysisJob,
  AnalysisAction,
  AnalysisSettings,
  DetectedAnalysisHardware,
  ApiErrorResponse,
  VideoUploadResult,
} from "./types"

const responseError = async (response: Response): Promise<string> => {
  try {
    const body = await response.json() as ApiErrorResponse
    if (typeof body.detail === "string") return body.detail
  } catch { }
  return `${response.status} ${response.statusText}`
}

const request = async <T>(
  path: string,
  signal?: AbortSignal,
  init?: RequestInit,
): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    signal,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  })
  if (!response.ok) {
    throw new Error(await responseError(response))
  }
  return response.json() as Promise<T>
}

export const fetchProjects = (): Promise<ProjectSummary[]> => request("/api/projects")
export const fetchCollages = (): Promise<CompositionProject[]> => request("/api/collages")
export const fetchCollage = (id: string): Promise<CompositionProject> =>
  request(`/api/collages/${encodeURIComponent(id)}`)

export const fetchVideos = (): Promise<string[]> => request("/api/videos")
export const uploadVideo = (
  file: File,
  onProgress: (percent: number) => void,
): Promise<VideoUploadResult> => new Promise((resolve, reject) => {
  const form = new FormData()
  form.append("file", file)
  const xhr = new XMLHttpRequest()
  xhr.open("POST", "/api/videos")
  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100))
  }
  xhr.onerror = () => reject(new Error("업로드 중 연결이 끊겼습니다. 다시 시도해 주세요."))
  xhr.onabort = () => reject(new Error("업로드가 취소되었습니다."))
  xhr.onload = () => {
    let body: VideoUploadResult | ApiErrorResponse
    try { body = JSON.parse(xhr.responseText) as VideoUploadResult | ApiErrorResponse }
    catch { reject(new Error(`${xhr.status} ${xhr.statusText}`)); return }
    if (xhr.status < 200 || xhr.status >= 300) {
      reject(new Error("detail" in body && typeof body.detail === "string"
        ? body.detail : `${xhr.status} ${xhr.statusText}`))
      return
    }
    resolve(body as VideoUploadResult)
  }
  xhr.send(form)
})
export const fetchAnalysisHardware = (): Promise<DetectedAnalysisHardware> =>
  request("/api/analysis-hardware")

export const fetchAnalyses = (): Promise<AnalysisSummary[]> => request("/api/analyses")

export const renameAnalysis = (analysisId: string, nickname: string): Promise<AnalysisSummary> =>
  request(`/api/analyses/${encodeURIComponent(analysisId)}/nickname`, undefined, {
    method: "PUT", body: JSON.stringify({ nickname }),
  })

export const startAnalysis = (settings: AnalysisSettings): Promise<{ job_id: string }> =>
  request("/api/analyses", undefined, { method: "POST", body: JSON.stringify(settings) })

export const fetchAnalysisJob = (jobId: string): Promise<AnalysisJob> =>
  request(`/api/analysis-jobs/${encodeURIComponent(jobId)}`)

export const controlAnalysisJob = (jobId: string, action: AnalysisAction): Promise<AnalysisJob> =>
  request(`/api/analysis-jobs/${encodeURIComponent(jobId)}/${action}`, undefined, { method: "POST" })

export const createProject = (name: string, analysisIds: string[]): Promise<{ project_id: string }> =>
  request("/api/projects", undefined, {
    method: "POST",
    body: JSON.stringify({ name, analysis_ids: analysisIds }),
  })

export const fetchProject = (projectId: string): Promise<ProjectDetail> =>
  request(`/api/projects/${encodeURIComponent(projectId)}`)

export const fetchTimeline = (
  projectId: string,
  sourceId: string,
  startMs: number,
  endMs: number,
  includeWords: boolean,
  includePhones: boolean,
  signal: AbortSignal,
): Promise<TimelineSlice> => {
  const params = new URLSearchParams({
    source_id: sourceId,
    start_ms: String(Math.round(startMs)),
    end_ms: String(Math.round(endMs)),
    include_words: String(includeWords),
    include_phones: String(includePhones),
  })
  return request(`/api/projects/${encodeURIComponent(projectId)}/timeline?${params}`, signal)
}

export const fetchWaveform = (
  projectId: string,
  sourceId: string,
  startMs: number,
  endMs: number,
  bins: number,
  signal: AbortSignal,
): Promise<WaveformData> => {
  const params = new URLSearchParams({
    source_id: sourceId,
    start_ms: String(Math.round(startMs)),
    end_ms: String(Math.round(endMs)),
    bins: String(bins),
  })
  return request(`/api/projects/${encodeURIComponent(projectId)}/waveform?${params}`, signal)
}

export const mediaUrl = (projectId: string, sourceId: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(sourceId)}`

export const startSearch = (
  projectId: string,
  text: string,
  inputLanguage: InputLanguage,
  signal?: AbortSignal,
): Promise<{ job_id: string }> => request(
  `/api/projects/${encodeURIComponent(projectId)}/search-jobs`,
  signal,
  { method: "POST", body: JSON.stringify({
    text, max_candidates_per_start: 8, input_language: inputLanguage,
  }) },
)

export const getSearchJob = (jobId: string, signal?: AbortSignal): Promise<SearchJob> =>
  request(`/api/search-jobs/${encodeURIComponent(jobId)}`, signal)

export const cancelSearch = (jobId: string): Promise<SearchJob> => request(
  `/api/search-jobs/${encodeURIComponent(jobId)}`,
  undefined,
  { method: "DELETE" },
)

export const fetchCompositions = (projectId: string): Promise<CompositionProject[]> =>
  request(`/api/projects/${encodeURIComponent(projectId)}/compositions`)

export const createComposition = (
  projectId: string,
  body: SaveCompositionRequest,
): Promise<CompositionProject> => request(
  "/api/collages",
  undefined,
  { method: "POST", body: JSON.stringify({ project_id: projectId, composition: body }) },
)

export const updateComposition = (
  compositionId: string,
  body: SaveCompositionRequest,
): Promise<CompositionProject> => request(
  `/api/collages/${encodeURIComponent(compositionId)}`,
  undefined,
  { method: "PUT", body: JSON.stringify(body) },
)

export const previewComposition = async (
  projectId: string,
  body: SaveCompositionRequest,
  signal: AbortSignal,
): Promise<Blob> => {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/compositions/preview`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    },
  )
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return response.blob()
}

export const exportComposition = async (
  compositionId: string,
  target: ExportTarget,
): Promise<void> => {
  const response = await fetch(
    `/api/collages/${encodeURIComponent(compositionId)}/export/${target}`,
    { method: "POST" },
  )
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  const blob = await response.blob()
  const disposition = response.headers.get("content-disposition") ?? ""
  const filename = disposition.match(/filename="?([^";]+)"?/)?.[1] ?? `export.${target.toLowerCase()}`
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
