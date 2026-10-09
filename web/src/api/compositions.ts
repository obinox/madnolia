import type { ApiError, CompositionProject, ExportJob, ExportTarget, JobIdResponse, PitchAnalysisResponse, ProfessionalAutotuneRequest, ProfessionalAutotuneResponse, RemoteTaskDescriptor, SaveCompositionRequest } from "../types"
import { request } from "./client"
import { clearRemoteTask, pollExportJob, remoteTaskStage, saveRemoteTask, updateRemoteTask } from "./remoteTasks"
import { REMOTE_TASK_SCHEMA_VERSION } from "../constants"

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

export const autotuneComposition = (
  projectId: string,
  body: ProfessionalAutotuneRequest,
  signal: AbortSignal,
): Promise<ProfessionalAutotuneResponse> => request(
  `/api/projects/${encodeURIComponent(projectId)}/compositions/autotune`,
  signal,
  { method: "POST", body: JSON.stringify(body) },
)

export const analyzeCompositionPitch = (
  projectId: string,
  body: SaveCompositionRequest,
  signal: AbortSignal,
): Promise<PitchAnalysisResponse> => request(
  `/api/projects/${encodeURIComponent(projectId)}/compositions/pitch-analysis`,
  signal,
  { method: "POST", body: JSON.stringify(body) },
)

export const exportComposition = async (
  compositionId: string,
  target: ExportTarget,
  onProgress?: (job: ExportJob) => void,
  signal?: AbortSignal,
  descriptor?: Omit<RemoteTaskDescriptor, "version" | "job_id">,
  onStage?: (stage: string, percent?: number | null) => void,
): Promise<void> => {
  const started = await request<JobIdResponse>(
    `/api/collages/${encodeURIComponent(compositionId)}/export-jobs/${target}`,
    signal,
    { method: "POST" },
  )
  if (descriptor) saveRemoteTask({ ...descriptor, version: REMOTE_TASK_SCHEMA_VERSION, job_id: started.job_id })
  let job: ExportJob
  try {
    job = await pollExportJob(started.job_id, (status) => {
      if (status) onProgress?.({ ...status, stage: remoteTaskStage(status.stage) })
      if (status) updateRemoteTask(started.job_id, { stage: remoteTaskStage(status.stage), percent: status.percent })
      else {
        updateRemoteTask(started.job_id, { stage: "상태 확인을 재시도하는 중" })
        onStage?.("상태 확인을 재시도하는 중")
      }
    }, signal)
  } catch (error) {
    if ((error as ApiError)?.status === 404) clearRemoteTask(started.job_id)
    throw error
  }
  if (job.status === "failed") {
    clearRemoteTask(started.job_id)
    throw new Error(job.error ?? "내보내기에 실패했습니다.")
  }
  updateRemoteTask(started.job_id, { stage: "파일 받는 중", percent: null })
  onStage?.("파일 받는 중", null)
  try { await downloadExportArtifact(started.job_id, target, job.filename, signal) }
  catch (error) {
    if ((error as ApiError)?.status === 404) clearRemoteTask(started.job_id)
    throw error
  }
  clearRemoteTask(started.job_id)
}

export async function downloadExportArtifact(jobId: string, target: ExportTarget, fallbackFilename?: string, signal?: AbortSignal): Promise<void> {
  let response: Response
  try {
    response = await fetch(`/api/export-jobs/${encodeURIComponent(jobId)}/download`, { signal })
    if (!response.ok) {
      const error = new Error(`${response.status} ${response.statusText}`) as ApiError
      error.status = response.status
      throw error
    }
  } catch (error) {
    const failure = new Error(`Download failed: ${error instanceof Error ? error.message : String(error)}`) as ApiError
    failure.status = (error as ApiError)?.status ?? 0
    throw failure
  }
  let blob: Blob
  try { blob = await response.blob() }
  catch (error) { throw new Error(`Download failed: ${error instanceof Error ? error.message : String(error)}`) }
  const disposition = response.headers.get("content-disposition") ?? ""
  const filename = disposition.match(/filename="?([^";]+)"?/)?.[1] ?? fallbackFilename ?? `export.${target.toLowerCase()}`
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
