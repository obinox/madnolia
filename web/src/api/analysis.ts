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

export const fetchVideos = (): Promise<string[]> => request("/api/videos")

export const uploadVideo = (
  file: File,
  onProgress: (percent: number) => void,
  onUploadComplete?: () => void,
  signal?: AbortSignal,
): Promise<VideoUploadResult> => new Promise((resolve, reject) => {
  const form = new FormData()
  form.append("file", file)
  const xhr = new XMLHttpRequest()
  xhr.open("POST", "/api/videos")
  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100))
  }
  xhr.upload.onload = () => onUploadComplete?.()
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
  if (signal?.aborted) {
    reject(new Error("업로드가 취소되었습니다."))
    return
  }
  const abort = () => xhr.abort()
  signal?.addEventListener("abort", abort, { once: true })
  xhr.onloadend = () => signal?.removeEventListener("abort", abort)
  xhr.send(form)
})

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
  const response = await fetch(`/api/analysis-jobs/${encodeURIComponent(jobId)}`)
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
