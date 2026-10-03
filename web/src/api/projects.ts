import type {
  CompositionProject,
  ProjectIdResponse,
  ProjectDetail,
  ProjectSummary,
  TimelineSlice,
  WaveformData,
} from "../types"
import { request } from "./client"

export const fetchProjects = (): Promise<ProjectSummary[]> => request("/api/projects")

export const createProject = (name: string, analysisIds: string[]): Promise<ProjectIdResponse> =>
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

export const audioUrl = (projectId: string, sourceId: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/audio/${encodeURIComponent(sourceId)}`

export const fetchAudioBlob = async (
  projectId: string,
  sourceId: string,
  signal?: AbortSignal,
): Promise<Blob> => {
  const response = await fetch(audioUrl(projectId, sourceId), { signal })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return response.blob()
}

export const fetchCollages = (): Promise<CompositionProject[]> => request("/api/collages")

export const fetchCollage = (id: string): Promise<CompositionProject> =>
  request(`/api/collages/${encodeURIComponent(id)}`)
