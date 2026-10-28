import type {
  AnalysisAction,
  AnalysisJob,
  AnalysisSettings,
  AnalysisSummary,
  DetectedAnalysisHardware,
  VideoUploadResult,
  ApiErrorResponse,
  JobIdResponse,
} from "../types"
import { request } from "./client"
import { runtimeFetch } from "./transport"

export const fetchVideos = (): Promise<string[]> => request("/api/videos")

export const uploadVideo = async (
  file: File,
  onProgress: (percent: number) => void,
  onUploadComplete?: () => void,
  signal?: AbortSignal,
): Promise<VideoUploadResult> => {
  if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError")
  const form = new FormData()
  form.append("file", file)
  onProgress(0)
  const response = await runtimeFetch("/api/videos", { method: "POST", body: form, signal })
  let body: VideoUploadResult | ApiErrorResponse
  try { body = await response.json() as VideoUploadResult | ApiErrorResponse }
  catch { throw new Error(`${response.status} ${response.statusText}`) }
  if (!response.ok) throw new Error("detail" in body && typeof body.detail === "string" ? body.detail : `${response.status} ${response.statusText}`)
  onProgress(100)
  onUploadComplete?.()
  return body as VideoUploadResult
}

export const fetchAnalysisHardware = (): Promise<DetectedAnalysisHardware> =>
  request("/api/analysis-hardware")

export const fetchAnalyses = (): Promise<AnalysisSummary[]> => request("/api/analyses")

export const renameAnalysis = (analysisId: string, nickname: string): Promise<AnalysisSummary> =>
  request(`/api/analyses/${encodeURIComponent(analysisId)}/nickname`, undefined, {
    method: "PUT", body: JSON.stringify({ nickname }),
  })

export const startAnalysis = (settings: AnalysisSettings): Promise<JobIdResponse> =>
  request("/api/analyses", undefined, { method: "POST", body: JSON.stringify(settings) })

export const fetchAnalysisJob = async (jobId: string): Promise<AnalysisJob> => {
  const response = await runtimeFetch(`/api/analysis-jobs/${encodeURIComponent(jobId)}`)
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const body = await response.json() as ApiErrorResponse
      if (typeof body.detail === "string") message = body.detail
    } catch { }
    const error = new Error(message)
    if (response.status === 404) error.name = "AnalysisJobNotFoundError"
    throw error
  }
  return response.json() as Promise<AnalysisJob>
}

export const controlAnalysisJob = (jobId: string, action: AnalysisAction): Promise<AnalysisJob> =>
  request(`/api/analysis-jobs/${encodeURIComponent(jobId)}/${action}`, undefined, { method: "POST" })
