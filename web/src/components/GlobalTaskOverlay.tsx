import { useEffect, useRef, useState } from "react"

import {
  GLOBAL_TASK_CANCEL_PENDING_STAGE,
  GLOBAL_TASK_DEFAULT_STAGE,
  GLOBAL_TASK_PERCENT_MAX,
  GLOBAL_TASK_PERCENT_MIN,
} from "../constants"
import type { GlobalTaskOverlayProps } from "../types"

export function GlobalTaskOverlay({ task }: GlobalTaskOverlayProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const actionRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const [cancelPending, setCancelPending] = useState(false)
  const [cancelError, setCancelError] = useState("")
  const [actionPending, setActionPending] = useState("")
  const [playing, setPlaying] = useState(false)
  const pendingFocusRef = useRef(false)
  const currentTaskIdRef = useRef(task?.id)
  currentTaskIdRef.current = task?.id

  useEffect(() => {
    if (!task) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    if (actionRef.current) actionRef.current.focus()
    else dialogRef.current?.focus()
    setCancelPending(false)
    setCancelError("")
    setActionPending("")
    return () => {
      const previous = previousFocusRef.current
      if (previous?.isConnected) previous.focus()
      previousFocusRef.current = null
    }
  }, [task?.id])

  useEffect(() => {
    if (!task) return
    if (actionPending || cancelPending) {
      pendingFocusRef.current = true
      return
    }
    if (!pendingFocusRef.current) return
    pendingFocusRef.current = false
    const enabled = dialogRef.current?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]")
    ;(enabled ?? dialogRef.current)?.focus()
  }, [actionPending, cancelPending, task?.id])

  useEffect(() => {
    if (!task) return
    const blockEditingGestures = (event: Event) => {
      if (dialogRef.current?.contains(event.target as Node)) return
      event.preventDefault()
      event.stopPropagation()
    }
    document.addEventListener("pointermove", blockEditingGestures, true)
    document.addEventListener("pointerdown", blockEditingGestures, true)
    document.addEventListener("wheel", blockEditingGestures, { capture: true, passive: false })
    return () => {
      document.removeEventListener("pointermove", blockEditingGestures, true)
      document.removeEventListener("pointerdown", blockEditingGestures, true)
      document.removeEventListener("wheel", blockEditingGestures, true)
    }
  }, [task?.id])

  useEffect(() => {
    if (!task) return
    const refresh = () => setPlaying(Array.from(document.querySelectorAll<HTMLMediaElement>("audio, video")).some((media) => !media.paused && !media.ended))
    refresh()
    document.addEventListener("play", refresh, true)
    document.addEventListener("pause", refresh, true)
    document.addEventListener("ended", refresh, true)
    return () => {
      document.removeEventListener("play", refresh, true)
      document.removeEventListener("pause", refresh, true)
      document.removeEventListener("ended", refresh, true)
    }
  }, [task?.id])

  useEffect(() => {
    if (!task) return
    const keepFocusInside = (event: KeyboardEvent) => {
      if (event.key === "Escape") event.preventDefault()
      event.stopPropagation()
      const editingShortcut = (event.ctrlKey || event.metaKey) && ["z", "y", "x", "v", "a", "s"].includes(event.key.toLowerCase())
      if (editingShortcut) event.preventDefault()
      if (event.key !== "Tab") return
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])") ?? [])
        .filter((element) => element.offsetParent !== null)
      if (!controls.length) {
        event.preventDefault()
        return
      }
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (!controls.includes(document.activeElement as HTMLElement)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener("keydown", keepFocusInside, true)
    return () => document.removeEventListener("keydown", keepFocusInside, true)
  }, [task?.id])

  if (!task) return null
  const percent = task.percent === undefined || task.percent === null || !Number.isFinite(task.percent)
    ? null
    : Math.max(GLOBAL_TASK_PERCENT_MIN, Math.min(GLOBAL_TASK_PERCENT_MAX, task.percent))
  const stage = cancelPending ? GLOBAL_TASK_CANCEL_PENDING_STAGE : task.stage || GLOBAL_TASK_DEFAULT_STAGE

  const requestCancel = async () => {
    if (!task.cancel || cancelPending) return
    const taskId = task.id
    const cancel = task.cancel
    setCancelPending(true)
    setCancelError("")
    try {
      await cancel()
    } catch (caught) {
      if (currentTaskIdRef.current === taskId) setCancelError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (currentTaskIdRef.current === taskId) {
        setCancelPending(false)
      }
    }
  }

  const runAction = async (id: string, action: () => void | Promise<void>) => {
    if (actionPending) return
    const taskId = task.id
    setActionPending(id)
    setCancelError("")
    try { await action() } catch (caught) {
      if (currentTaskIdRef.current === taskId) setCancelError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (currentTaskIdRef.current === taskId) {
        setActionPending("")
      }
    }
  }

  return (
    <div className="global-task-backdrop">
      <section
        ref={dialogRef}
        className="global-task-dialog"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="global-task-title"
        aria-describedby="global-task-stage"
      >
        <p className="eyebrow">MADNOLIA · 작업 진행</p>
        <h2 id="global-task-title">{task.label}</h2>
        <p id="global-task-stage" className="global-task-stage" aria-live="polite">{stage}</p>
        {percent === null ? (
          <div className="global-task-indeterminate" role="progressbar" aria-label={stage} />
        ) : (
          <div
            className="global-task-progress"
            role="progressbar"
            aria-label={stage}
            aria-valuemin={GLOBAL_TASK_PERCENT_MIN}
            aria-valuemax={GLOBAL_TASK_PERCENT_MAX}
            aria-valuenow={percent}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
        )}
        <div className="global-task-footer">
          <span>{percent === null ? "처리 중" : `${Math.round(percent)}%`}</span>
          {playing && <button type="button" onFocus={(event) => event.currentTarget.scrollIntoView({ block: "nearest" })} onClick={() => {
            document.querySelectorAll<HTMLMediaElement>("audio, video").forEach((media) => { if (!media.paused) media.pause() })
            setPlaying(false)
          }}>재생 중지</button>}
          {task.actions?.map((action, index) => <button
            ref={index === 0 ? actionRef : undefined}
            key={action.id}
            type="button"
            disabled={!!actionPending || cancelPending || action.disabled}
            onClick={() => void runAction(action.id, action.onAction)}
            onFocus={(event) => event.currentTarget.scrollIntoView({ block: "nearest" })}
          >{actionPending === action.id ? "처리 중…" : action.label}</button>)}
          {task.cancel && (
            <button ref={!task.actions?.length ? actionRef : undefined} type="button" disabled={cancelPending || !!actionPending} onFocus={(event) => event.currentTarget.scrollIntoView({ block: "nearest" })} onClick={() => void requestCancel()}>
              {cancelPending ? "중단 요청 중…" : task.cancelLabel || "작업 중단"}
            </button>
          )}
        </div>
        {cancelError && <p className="global-task-error" role="alert">작업 요청 실패: {cancelError}</p>}
      </section>
    </div>
  )
}
