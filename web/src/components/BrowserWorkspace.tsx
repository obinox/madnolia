import { useCallback, useEffect, useState } from "react"

import { BROWSER_WORKSPACE_BROWSER_SUPPORT } from "../browserConstants"
import {
  connectWorkspace,
  getSavedWorkspaceHandle,
  reconnectWorkspace,
  restoreWorkspaceHandle,
} from "../browser/workspace"
import { deleteCachedModel, listCachedModels } from "../browser/modelCache"
import { useGlobalTask } from "../globalTask"
import type { BrowserModelCacheItem } from "../types/browserAnalysis"
import type { BrowserWorkspaceProps } from "../types"
import "../styles/browser-workspace.css"

export function BrowserWorkspace({ children }: BrowserWorkspaceProps) {
  const { task } = useGlobalTask()
  const taskActive = task !== null
  const [handle, setHandle] = useState<FileSystemDirectoryHandle | null>(null)
  const [savedHandle, setSavedHandle] = useState<FileSystemDirectoryHandle | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [models, setModels] = useState<BrowserModelCacheItem[]>([])
  const [modelsOpen, setModelsOpen] = useState(false)

  const loadModels = useCallback(async () => {
    try {
      setModels(await listCachedModels())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  useEffect(() => {
    let active = true
    void getSavedWorkspaceHandle().then(async (saved) => {
      if (!active) return
      setSavedHandle(saved)
      const restored = await restoreWorkspaceHandle(saved)
      if (active && restored) setHandle(restored)
    }).catch((caught: Error) => {
      if (active) setError(caught.message)
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (handle) void loadModels()
  }, [handle, loadModels])

  const chooseFolder = async () => {
    if (taskActive && handle) return
    setError("")
    setLoading(true)
    try {
      const connected = await connectWorkspace()
      if (handle && !(await handle.isSameEntry(connected))) {
        window.location.reload()
        return
      }
      setSavedHandle(connected)
      setHandle(connected)
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    } finally {
      setLoading(false)
    }
  }

  const reconnect = async () => {
    if (taskActive && handle) return
    setError("")
    setLoading(true)
    try {
      const connected = await reconnectWorkspace()
      if (handle && !(await handle.isSameEntry(connected))) {
        window.location.reload()
        return
      }
      setSavedHandle(connected)
      setHandle(connected)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }

  const removeModel = async (modelId: string) => {
    if (taskActive || !window.confirm(`캐시된 모델 “${modelId}”을 작업공간에서 삭제할까요?`)) return
    try {
      await deleteCachedModel(modelId)
      await loadModels()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  if (!handle) {
    return (
      <main className="browser-workspace-gate">
        <section className="browser-workspace-card">
          <p className="section-label">MADNOLIA / LOCAL WORKSPACE</p>
          <h1>브라우저 작업공간 연결</h1>
          <p>프로젝트, 모델, 영상과 작업 결과를 보관할 폴더를 선택하세요.</p>
          <p className="browser-workspace-support">{BROWSER_WORKSPACE_BROWSER_SUPPORT}</p>
          {savedHandle && <p className="browser-workspace-folder">저장된 폴더: <strong>{savedHandle.name}</strong></p>}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="browser-workspace-actions">
            {savedHandle && <button type="button" disabled={loading} onClick={() => void reconnect()}>
              {loading ? "권한 확인 중…" : "저장된 폴더 다시 연결"}
            </button>}
            <button type="button" disabled={loading} onClick={() => void chooseFolder()}>
              {loading ? "폴더 확인 중…" : "작업공간 폴더 선택"}
            </button>
          </div>
        </section>
      </main>
    )
  }

  return (
    <div className="browser-workspace-shell">
      <header className="browser-workspace-bar">
        <div><span>로컬 작업공간</span><strong>{handle.name}</strong></div>
        <div className="browser-workspace-controls">
          <button type="button" disabled={taskActive} onClick={() => setModelsOpen((open) => !open)}>
            모델 {models.length}개
          </button>
          <button type="button" disabled={taskActive} onClick={() => void chooseFolder()}>폴더 변경</button>
        </div>
      </header>
      {modelsOpen && (
        <section className="browser-models-panel" aria-label="로컬 모델 폴더">
          <div className="browser-models-heading"><strong>로컬 모델</strong><button type="button" disabled={taskActive} onClick={() => void loadModels()}>새로고침</button></div>
          {models.length ? models.map((model) => (
            <div className="browser-model-row" key={model.model_id}>
              <strong>{model.label}</strong><span>{model.file_count} files · {model.size_label}</span>
              <button type="button" disabled={taskActive} onClick={() => void removeModel(model.model_id)}>캐시 삭제</button>
            </div>
          )) : <p>models 폴더에 저장된 모델이 없습니다.</p>}
        </section>
      )}
      {error && <p className="browser-workspace-inline-error" role="alert">{error}</p>}
      {children}
    </div>
  )
}
