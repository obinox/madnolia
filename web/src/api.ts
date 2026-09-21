import type { ProjectDetail, ProjectSummary, TimelineSlice, WaveformData } from "./types"

const request = async <T>(path: string, signal?: AbortSignal): Promise<T> => {
  const response = await fetch(path, { signal })
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
