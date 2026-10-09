import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import type { PropsWithChildren } from "react"

import { GlobalTaskOverlay } from "./components/GlobalTaskOverlay"
import type { ApiError, GlobalTask, GlobalTaskContextValue, GlobalTaskInput, RestoredGlobalTaskState } from "./types"
import type { RemoteTaskDescriptor, RemoteSearchResult } from "./types"
import { REMOTE_SEARCH_RESULT_STORAGE_PREFIX } from "./constants"
import { cancelSearch } from "./api/search"
import { downloadExportArtifact } from "./api/compositions"
import { clearRemoteTask, pollExportJob, pollSearchJob, readRemoteTask, remoteTaskStage, updateRemoteTask } from "./api/remoteTasks"

const restoreTask = (): RestoredGlobalTaskState => {
  const descriptor = readRemoteTask()
  return {
    descriptor,
    task: descriptor ? {
      id: `remote-task-${descriptor.job_id}`,
      label: descriptor.label,
      stage: descriptor.stage ?? "원격 작업 상태 확인 중",
      percent: descriptor.percent ?? null,
      cancel: descriptor.kind === "search" ? async () => { await cancelSearch(descriptor.job_id) } : undefined,
      cancelLabel: "검색 중단",
    } : null,
  }
}

const GlobalTaskContext = createContext<GlobalTaskContextValue | null>(null)

export function GlobalTaskProvider({ children }: PropsWithChildren) {
  const [restored] = useState(restoreTask)
  const [task, setTask] = useState<GlobalTask | null>(restored.task)
  const restoredDescriptor = restored.descriptor
  const taskRef = useRef<GlobalTask | null>(restored.task)
  const recoveryStarted = useRef(false)
  const monitorRef = useRef<Promise<unknown> | null>(null)
  const nextIdRef = useRef(0)

  const beginTask = useCallback((input: GlobalTaskInput) => {
    if (taskRef.current) return null
    const id = `global-task-${++nextIdRef.current}`
    const nextTask = { ...input, id }
    taskRef.current = nextTask
    setTask(nextTask)
    return id
  }, [])

  const updateTask = useCallback((id: string, patch: Partial<GlobalTaskInput>) => {
    if (taskRef.current?.id !== id) return
    const nextTask = { ...taskRef.current, ...patch, id }
    taskRef.current = nextTask
    setTask(nextTask)
  }, [])

  const finishTask = useCallback((id: string) => {
    if (taskRef.current?.id !== id) return
    taskRef.current = null
    setTask(null)
  }, [])

  const isTaskActive = useCallback(() => taskRef.current !== null, [])

  const updateRecoveredTask = useCallback((id: string, patch: Partial<GlobalTaskInput>) => {
    if (taskRef.current?.id !== id) return
    const next = { ...taskRef.current, ...patch, id }
    taskRef.current = next
    setTask(next)
    if (restoredDescriptor) updateRemoteTask(restoredDescriptor.job_id, { stage: next.stage, percent: next.percent })
  }, [restoredDescriptor])

  useEffect(() => {
    const descriptor = restored.descriptor
    if (!descriptor || recoveryStarted.current) return
    recoveryStarted.current = true
    const id = `remote-task-${descriptor.job_id}`
    const finish = () => finishTask(id)
    if (descriptor.kind === "search") {
      const monitor = pollSearchJob(descriptor.job_id, (job) => updateRecoveredTask(id, job
        ? { stage: remoteTaskStage(job.stage), percent: job.percent }
        : { stage: "상태 확인을 재시도하는 중" })).then((job) => {
          if (job.status === "complete" && job.result && descriptor.search) {
            const result = job.result
            const deliverResult = () => {
              const restoredResult: RemoteSearchResult = { descriptor, result }
              window.localStorage.setItem(`${REMOTE_SEARCH_RESULT_STORAGE_PREFIX}${descriptor.project_id}`, JSON.stringify(restoredResult))
            }
            try { deliverResult() } catch {
              updateRecoveredTask(id, { stage: "검색 결과를 브라우저에 저장하지 못했습니다. 다시 시도해 주세요.", percent: null, cancel: undefined, actions: [{ id: "retry-result", label: "결과 저장 다시 시도", onAction: () => { deliverResult(); clearRemoteTask(descriptor.job_id); finish() } }] })
              return
            }
            clearRemoteTask(descriptor.job_id)
            finish()
            return
          }
          clearRemoteTask(descriptor.job_id)
          updateRecoveredTask(id, {
            stage: job.status === "cancelled" ? "검색을 중단했습니다." : job.status === "failed" ? `검색 실패: ${job.error ?? "원인을 확인할 수 없습니다."}` : "검색은 완료됐지만 결과를 받지 못했습니다.",
            percent: null,
            cancel: undefined,
            actions: [{ id: "dismiss", label: "확인", onAction: finish }],
          })
        }).catch((error: ApiError) => {
          if (error.status === 404) {
            clearRemoteTask(descriptor.job_id)
            updateRecoveredTask(id, { stage: "서버에서 작업을 찾을 수 없습니다.", percent: null, cancel: undefined, actions: [{ id: "dismiss", label: "닫기", onAction: finish }] })
          } else updateRecoveredTask(id, { stage: `작업 상태 확인 실패: ${error.message}`, percent: null, cancel: async () => { await cancelSearch(descriptor.job_id) } })
        })
      monitorRef.current = monitor
      updateRecoveredTask(id, { cancel: async () => {
        await cancelSearch(descriptor.job_id)
        await monitorRef.current
      } })
    } else if (descriptor.target) {
      let completedFilename = ""
      const monitor = pollExportJob(descriptor.job_id, (job) => updateRecoveredTask(id, job
        ? { stage: remoteTaskStage(job.stage), percent: job.percent }
        : { stage: "상태 확인을 재시도하는 중" })).then(async (job) => {
        if (job.status === "failed") {
          clearRemoteTask(descriptor.job_id)
          updateRecoveredTask(id, { stage: `내보내기 실패: ${job.error ?? "원인을 확인할 수 없습니다."}`, percent: null, actions: [{ id: "dismiss", label: "확인", onAction: finish }] })
          return
        }
        completedFilename = job.filename
        updateRecoveredTask(id, { stage: "파일 받는 중", percent: null })
        await downloadExportArtifact(descriptor.job_id, descriptor.target!, job.filename)
        clearRemoteTask(descriptor.job_id)
        finish()
      }).catch((error: ApiError) => {
        if (error.status === 404) {
          clearRemoteTask(descriptor.job_id)
          updateRecoveredTask(id, { stage: "서버에서 내보내기 작업을 찾을 수 없습니다.", percent: null, actions: [{ id: "dismiss", label: "닫기", onAction: finish }] })
        } else {
          const retryDownload = async () => {
            updateRecoveredTask(id, { stage: "파일 받는 중", percent: null })
            try {
              await downloadExportArtifact(descriptor.job_id, descriptor.target!, completedFilename || "export")
              clearRemoteTask(descriptor.job_id)
              finish()
            } catch (retryError) {
              updateRecoveredTask(id, {
                stage: `파일을 받지 못했습니다: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
                percent: null,
                actions: [{ id: "retry", label: "다시 받기", onAction: retryDownload }],
              })
              throw retryError
            }
          }
          updateRecoveredTask(id, { stage: `파일을 받지 못했습니다: ${error.message}`, percent: null, actions: [{ id: "retry", label: "다시 받기", onAction: retryDownload }] })
        }
      })
      monitorRef.current = monitor
    }
  }, [finishTask, restored.descriptor, updateRecoveredTask])
  const value = useMemo(() => ({ task, beginTask, updateTask, finishTask, isTaskActive }), [
    beginTask,
    finishTask,
    isTaskActive,
    task,
    updateTask,
  ])

  return (
    <GlobalTaskContext.Provider value={value}>
      <div className="global-task-app" inert={task ? true : undefined} aria-hidden={task ? true : undefined}>
        {children}
      </div>
      <GlobalTaskOverlay task={task} />
    </GlobalTaskContext.Provider>
  )
}

export function useGlobalTask() {
  const context = useContext(GlobalTaskContext)
  if (!context) throw new Error("useGlobalTask must be used within GlobalTaskProvider")
  return context
}
