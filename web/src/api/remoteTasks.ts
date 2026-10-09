import { COLLAGE_EXPORT_TARGETS, EXPORT_PROGRESS_POLL_MS, REMOTE_TASK_RETRY_MS, REMOTE_TASK_SCHEMA_VERSION, REMOTE_TASK_STORAGE_KEY, SEARCH_STAGE_LABELS } from "../constants"
import type { ExportJob, RemoteJobShape, RemoteTaskDescriptor, SearchJob } from "../types"
import { request } from "./client"

export function remoteTaskStage(stage: string): string {
  return ({
    queued: "대기 중",
    running: "작업 중",
    cancelling: "중단 요청 중",
    cancelled: "작업 중단됨",
    complete: "작업 완료",
    failed: "작업 실패",
    finalizing: "작업 마무리 중",
    ...SEARCH_STAGE_LABELS,
  } as Record<string, string>)[stage.toLowerCase()] ?? stage
}

export function readRemoteTask(): RemoteTaskDescriptor | null {
  try {
    const raw = window.localStorage.getItem(REMOTE_TASK_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as RemoteTaskDescriptor
    const validExport = value?.kind !== "export" || (
      typeof value.composition_id === "string" && !!value.composition_id
      && typeof value.target === "string" && COLLAGE_EXPORT_TARGETS.some((target) => target === value.target)
    )
    const validSearch = value?.kind !== "search" || (
      !!value.search
      && typeof value.search.text === "string"
      && ["EXACT", "APPROXIMATE"].includes(value.search.tab)
      && ["AUTO", "KO", "EN", "JA"].includes(value.search.input_language)
      && typeof value.search.pronunciation === "string"
      && (value.search.exact_result === undefined || (
        !!value.search.exact_result
        && Array.isArray(value.search.exact_result.candidates)
        && Array.isArray(value.search.exact_result.target_phones)
      ))
    )
    if (!value || typeof value !== "object" || value.version !== REMOTE_TASK_SCHEMA_VERSION || typeof value.job_id !== "string" || !value.job_id
      || typeof value.project_id !== "string" || !value.project_id || typeof value.label !== "string"
      || (value.percent !== undefined && value.percent !== null && (typeof value.percent !== "number" || !Number.isFinite(value.percent)))
      || !["search", "export"].includes(value.kind)
      || (value.stage !== undefined && typeof value.stage !== "string")
      || !validExport || !validSearch) {
      window.localStorage.removeItem(REMOTE_TASK_STORAGE_KEY)
      return null
    }
    return value
  } catch {
    try { window.localStorage.removeItem(REMOTE_TASK_STORAGE_KEY) } catch { }
    return null
  }
}

export function saveRemoteTask(descriptor: RemoteTaskDescriptor): void {
  try { window.localStorage.setItem(REMOTE_TASK_STORAGE_KEY, JSON.stringify(descriptor)) } catch { }
}

export function clearRemoteTask(jobId: string): void {
  try {
    if (readRemoteTask()?.job_id === jobId) window.localStorage.removeItem(REMOTE_TASK_STORAGE_KEY)
  } catch { }
}

export function updateRemoteTask(jobId: string, patch: Pick<RemoteTaskDescriptor, "stage" | "percent">): void {
  const current = readRemoteTask()
  if (current?.job_id === jobId) saveRemoteTask({ ...current, ...patch })
}

const wait = (delayMs: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"))
  const timer = window.setTimeout(done, delayMs)
  function done() {
    signal?.removeEventListener("abort", abort)
    resolve()
  }
  function abort() {
    window.clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
    reject(new DOMException("Aborted", "AbortError"))
  }
  signal?.addEventListener("abort", abort, { once: true })
})

async function poll<T extends RemoteJobShape>(
  url: string,
  terminal: readonly string[],
  active: readonly string[],
  onStatus: (job: T | null) => void,
  signal?: AbortSignal,
): Promise<T> {
  while (!signal?.aborted) {
    let job: T
    try {
      job = await request<T>(url, signal)
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error
      const status = error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : null
      if (status === 404) throw error
      if (status === null && !(error instanceof TypeError) && !(error instanceof SyntaxError)) throw error
      onStatus(null)
      await wait(REMOTE_TASK_RETRY_MS, signal)
      continue
    }

    const validShape = Boolean(job && typeof job === "object" && typeof job.job_id === "string"
      && typeof job.stage === "string" && typeof job.percent === "number" && Number.isFinite(job.percent)
      && (!("error" in job) || job.error === null || typeof job.error === "string"))
    const validStatus = validShape && [...terminal, ...active].includes(job.status)
    const validCompletion = validStatus && job.status === "complete" && (
      ("filename" in job && typeof job.filename !== "string")
      || ("result" in job && (!job.result || typeof job.result !== "object"
        || !("candidates" in job.result) || !Array.isArray(job.result.candidates)
        || !("target_phones" in job.result) || !Array.isArray(job.result.target_phones)))
    )
    if (!validStatus || validCompletion || job.job_id !== decodeURIComponent(url.split("/").at(-1) ?? "")) {
      onStatus(null)
      await wait(REMOTE_TASK_RETRY_MS, signal)
      continue
    }
    onStatus(job)
    if (terminal.includes(job.status)) return job
    await wait(EXPORT_PROGRESS_POLL_MS, signal)
  }
  throw new DOMException("Aborted", "AbortError")
}

export const pollSearchJob = (jobId: string, onStatus: (job: SearchJob | null) => void, signal?: AbortSignal) =>
  poll<SearchJob>(`/api/search-jobs/${encodeURIComponent(jobId)}`, ["complete", "cancelled", "failed"], ["running", "cancelling"], onStatus, signal)

export const pollExportJob = (jobId: string, onStatus: (job: ExportJob | null) => void, signal?: AbortSignal) =>
  poll<ExportJob>(`/api/export-jobs/${encodeURIComponent(jobId)}`, ["complete", "failed"], ["running"], onStatus, signal)
