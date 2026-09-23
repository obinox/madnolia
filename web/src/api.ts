import type {
  CandidateSearchResult,
  CompositionProject,
  ExportTarget,
  ProjectDetail,
  ProjectSummary,
  SaveCompositionRequest,
  TimelineSlice,
  WaveformData,
} from "./types"

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
    throw new Error(`${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<T>
}

export const fetchProjects = (): Promise<ProjectSummary[]> => request("/api/projects")

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

export const searchCandidates = (
  projectId: string,
  text: string,
): Promise<CandidateSearchResult> => request(
  `/api/projects/${encodeURIComponent(projectId)}/search`,
  undefined,
  { method: "POST", body: JSON.stringify({ text, max_candidates_per_start: 8 }) },
)

export const fetchCompositions = (projectId: string): Promise<CompositionProject[]> =>
  request(`/api/projects/${encodeURIComponent(projectId)}/compositions`)

export const createComposition = (
  projectId: string,
  body: SaveCompositionRequest,
): Promise<CompositionProject> => request(
  `/api/projects/${encodeURIComponent(projectId)}/compositions`,
  undefined,
  { method: "POST", body: JSON.stringify(body) },
)

export const updateComposition = (
  projectId: string,
  compositionId: string,
  body: SaveCompositionRequest,
): Promise<CompositionProject> => request(
  `/api/projects/${encodeURIComponent(projectId)}/compositions/${encodeURIComponent(compositionId)}`,
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
  projectId: string,
  compositionId: string,
  target: ExportTarget,
): Promise<void> => {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/compositions/${encodeURIComponent(compositionId)}/export/${target}`,
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
