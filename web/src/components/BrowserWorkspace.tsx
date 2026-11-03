import { useCallback, useEffect, useState } from "react"

import { BROWSER_WORKSPACE_BROWSER_SUPPORT } from "../browserConstants"
import {
  connectWorkspace,
  getSavedWorkspaceHandle,
  reconnectWorkspace,
  restoreWorkspaceHandle,
} from "../browser/workspace"
import { deleteCachedModel, listCachedModels } from "../browser/modelCache"
import { connectModelFolder, getModelReadiness, getSavedModelFolder, modelSelection, prepareModel, requestModelFolderPermission, resetModelFolder, restoreModelFolder } from "../browser/modelStorage"
import { BROWSER_ASR_DEFAULT_MODEL, BROWSER_ASR_MODELS } from "../browserAnalysisConstants"
import { useGlobalTask } from "../globalTask"
import type { BrowserModelCacheItem } from "../types/browserAnalysis"
import type { BrowserModelDevice, BrowserModelPrecision, BrowserModelPreparationProgress, BrowserModelReadyState, BrowserModelSelection, BrowserModelTaskKind } from "../types/browserModelStorage"
import type { BrowserPermissionDirectoryHandle } from "../types/browser"
import type { BrowserDirectoryPickerWindow, BrowserLegacyImportProgress, BrowserLegacyImportSummary, BrowserWorkspaceProps } from "../types"
import { BROWSER_LEGACY_IMPORT_PICKER_ID } from "../browserConstants"
import { importLegacyPythonData } from "../browser/legacyImport"
import "../styles/browser-workspace.css"

export function BrowserWorkspace({ children }: BrowserWorkspaceProps) {
  const { task, beginTask, updateTask, finishTask } = useGlobalTask()
  const taskActive = task !== null
  const [handle, setHandle] = useState<FileSystemDirectoryHandle | null>(null)
  const [savedHandle, setSavedHandle] = useState<FileSystemDirectoryHandle | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [models, setModels] = useState<BrowserModelCacheItem[]>([])
  const [modelsOpen, setModelsOpen] = useState(false)
  const [legacyImporting, setLegacyImporting] = useState(false)
  const [legacyImportProgress, setLegacyImportProgress] = useState<BrowserLegacyImportProgress | null>(null)
  const [legacyImportSummary, setLegacyImportSummary] = useState<BrowserLegacyImportSummary | null>(null)
  const [modelFolder, setModelFolder] = useState<BrowserPermissionDirectoryHandle | null>(null)
  const [savedModelFolder, setSavedModelFolder] = useState<BrowserPermissionDirectoryHandle | null>(null)
  const [modelKind, setModelKind] = useState<BrowserModelTaskKind>("asr")
  const [modelId, setModelId] = useState(BROWSER_ASR_DEFAULT_MODEL)
  const [modelPrecision, setModelPrecision] = useState<BrowserModelPrecision>("baseline")
  const [modelDevice, setModelDevice] = useState<BrowserModelDevice>("wasm")
  const [modelReady, setModelReady] = useState<BrowserModelReadyState | null>(null)
  const [modelProgress, setModelProgress] = useState<BrowserModelPreparationProgress | null>(null)
  const [modelFolderError, setModelFolderError] = useState("")

  const selectedModel: BrowserModelSelection = modelSelection(modelKind, modelId, modelPrecision, modelDevice)

  const refreshModelReadiness = useCallback(async (folder = modelFolder) => {
    const status = await getModelReadiness(selectedModel, folder)
    setModelReady(status)
  }, [modelFolder, modelKind, modelId, modelPrecision, modelDevice])

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
    let active = true
    void getSavedModelFolder().then(async (saved) => {
      if (!active || !saved) return
      setSavedModelFolder(saved)
      const restored = await restoreModelFolder(saved)
      if (active && restored) setModelFolder(restored)
    }).catch((caught: Error) => { if (active) setModelFolderError(caught.message) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (modelFolder) void refreshModelReadiness()
  }, [modelFolder, refreshModelReadiness])

  const chooseModelFolder = async () => {
    if (taskActive) return
    try {
      setModelFolderError("")
      const folder = await connectModelFolder()
      setModelFolder(folder)
      setSavedModelFolder(folder)
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) setModelFolderError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const reconnectModelFolder = async () => {
    if (taskActive) return
    try {
      setModelFolderError("")
      const folder = await requestModelFolderPermission()
      if (folder) {
        setModelFolder(folder)
        setSavedModelFolder(folder)
      }
    } catch (caught) { setModelFolderError(caught instanceof Error ? caught.message : String(caught)) }
  }

  const prepareSelectedModel = async () => {
    if (taskActive) return
    try {
      setModelFolderError("")
      const permitted = await requestModelFolderPermission()
      if (!permitted) throw new Error("모델 폴더를 먼저 연결하세요.")
      setModelFolder(permitted)
      const controller = new AbortController()
      const taskId = beginTask({
        label: "모델 파일 준비",
        stage: selectedModel.model_id + " 파일 확인 중",
        percent: null,
        cancelLabel: "취소",
        cancel: () => controller.abort(),
      })
      if (!taskId) return
      setModelProgress(null)
      try {
        const status = await prepareModel(selectedModel, controller.signal, (progress) => {
          setModelProgress(progress)
          updateTask(taskId, {
            stage: progress.current_file + " (" + progress.completed_files + "/" + progress.total_files + ")",
            percent: progress.expected_bytes ? Math.min(99, Math.round(progress.received_bytes * 100 / progress.expected_bytes)) : null,
          })
        }, permitted)
        setModelReady(status)
      } finally {
        finishTask(taskId)
      }
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) setModelFolderError(caught instanceof Error ? caught.message : String(caught))
      await refreshModelReadiness()
    }
  }

  const resetConnectedModelFolder = async () => {
    if (taskActive) return
    await resetModelFolder()
    setModelFolder(null)
    setSavedModelFolder(null)
    setModelReady(null)
    setModelProgress(null)
  }

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

  const openExistingFolder = async () => {
    if (taskActive && handle) return
    setError("")
    setLoading(true)
    try {
      const connected = await connectWorkspace(true)
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

  const importPythonData = async () => {
    if (!handle || taskActive || legacyImporting) return
    const taskId = beginTask({ label: "Python 데이터 가져오기", stage: "Python data 폴더 선택 중", percent: null })
    if (!taskId) return
    const picker = window as unknown as BrowserDirectoryPickerWindow
    if (typeof picker.showDirectoryPicker !== "function") {
      setError("Python 데이터 가져오기는 최신 Chrome 또는 Edge에서 사용할 수 있습니다.")
      finishTask(taskId)
      return
    }
    setError("")
    setLegacyImportSummary(null)
    setLegacyImportProgress(null)
    setLegacyImporting(true)
    try {
      const source = await picker.showDirectoryPicker({ id: BROWSER_LEGACY_IMPORT_PICKER_ID, mode: "read" })
      if (await source.isSameEntry(handle)) throw new Error("현재 브라우저 작업공간 폴더와 다른 Python data 폴더를 선택하세요.")
      const summary = await importLegacyPythonData(source, (progress) => {
        setLegacyImportProgress(progress)
        updateTask(taskId, {
          stage: `가져오는 중: ${progress.name} (${progress.completed}/${progress.total})`,
          percent: progress.total ? Math.round(progress.completed * 100 / progress.total) : null,
        })
      })
      setLegacyImportSummary(summary)
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLegacyImporting(false)
      finishTask(taskId)
    }
  }

  if (!handle) {
    return (
      <main className="browser-workspace-gate">
        <section className="browser-workspace-card">
          <p className="section-label">MADNOLIA / LOCAL WORKSPACE</p>
          <h1>브라우저 작업공간 연결</h1>
          <p>프로젝트, 모델, 영상과 작업 결과를 보관할 폴더를 선택하세요. 기존 Madnolia 브라우저 작업공간도 다시 사용할 수 있습니다.</p>
          <p className="browser-workspace-support">{BROWSER_WORKSPACE_BROWSER_SUPPORT}</p>
          {savedHandle && <p className="browser-workspace-folder">저장된 폴더: <strong>{savedHandle.name}</strong></p>}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="browser-workspace-actions">
            {savedHandle && <button type="button" data-testid="reconnect-workspace" disabled={loading} onClick={() => void reconnect()}>
              {loading ? "권한 확인 중…" : "저장된 폴더 다시 연결"}
            </button>}
            <button type="button" disabled={loading} onClick={() => void openExistingFolder()}>
              {loading ? "폴더 확인 중…" : "기존 작업공간 열기"}
            </button>
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
          <button type="button" disabled={taskActive || legacyImporting} onClick={() => void importPythonData()}>
            {legacyImporting ? "Python 데이터 가져오는 중…" : "Python 데이터 가져오기"}
          </button>
          <button type="button" disabled={taskActive} onClick={() => void chooseFolder()}>폴더 변경</button>
        </div>
      </header>
      {legacyImporting && legacyImportProgress && <p className="browser-workspace-inline-error" role="status">Python 가져오기: {legacyImportProgress.completed}/{legacyImportProgress.total} · {legacyImportProgress.name}</p>}
      {legacyImportSummary && <p className="browser-workspace-inline-error" role="status">가져옴: 프로젝트 {legacyImportSummary.projects_imported}개, 분석 {legacyImportSummary.analyses_imported}개, 콜라주 {legacyImportSummary.collages_imported}개 (부모 연결 누락 {legacyImportSummary.composition_parent_links_missing}개), 오디오 {legacyImportSummary.audio_files_imported}개, 미디어 {legacyImportSummary.media_files_imported}개 (누락 {legacyImportSummary.media_files_missing}개), SQLite {legacyImportSummary.database_files_preserved}개, 버전 파일 {legacyImportSummary.version_files_preserved}개, 내보내기 파일 {legacyImportSummary.export_files_preserved}개, centroid {legacyImportSummary.centroid_files_imported}개</p>}
      {modelsOpen && (
        <section className="browser-models-panel" aria-label="로컬 모델 폴더">
          <div className="browser-models-heading"><strong>로컬 모델</strong><button type="button" disabled={taskActive} onClick={() => void loadModels()}>새로고침</button></div>
          <div className="browser-model-folder">
            <strong>재사용 모델 폴더</strong>
            <p>{modelFolder ? "연결된 폴더: " + modelFolder.name : "분석 데이터 작업공간과 별도로 모델 폴더를 연결하세요."}</p>
            <div className="browser-workspace-actions">
              <button type="button" disabled={taskActive} onClick={() => void chooseModelFolder()}>{modelFolder ? "모델 폴더 변경" : "모델 폴더 연결"}</button>
              {!modelFolder && savedModelFolder && <button type="button" disabled={taskActive} onClick={() => void reconnectModelFolder()}>저장된 폴더 다시 연결</button>}
              {modelFolder && <button type="button" disabled={taskActive} onClick={() => void resetConnectedModelFolder()}>연결 초기화</button>}
            </div>
            <div className="browser-model-folder-options">
              <label>모델 종류
                <select value={modelKind} disabled={taskActive} onChange={(event) => setModelKind(event.target.value as BrowserModelTaskKind)}>
                  <option value="asr">음성 인식 (ASR)</option><option value="ctc">음소 정렬 (CTC)</option><option value="hubert">HuBERT 특징</option>
                </select>
              </label>
              {modelKind === "asr" && <label>ASR 모델
                <select value={modelId} disabled={taskActive} onChange={(event) => setModelId(event.target.value)}>
                  {BROWSER_ASR_MODELS.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
                </select>
              </label>}
              <label>모델 정밀도
                <select value={modelPrecision} disabled={taskActive} onChange={(event) => setModelPrecision(event.target.value as BrowserModelPrecision)}>
                  <option value="baseline">Baseline</option><option value="compact">Compact</option>
                </select>
              </label>
              <label>실행 장치
                <select value={modelDevice} disabled={taskActive} onChange={(event) => setModelDevice(event.target.value as BrowserModelDevice)}>
                  <option value="webgpu">WebGPU</option><option value="wasm">WebAssembly CPU</option>
                </select>
              </label>
            </div>
            <p role="status">{modelReady?.message ?? "선택한 모델 파일의 준비 상태를 확인합니다."}</p>
            {modelProgress && <p role="status">{modelProgress.current_file}: {modelProgress.received_bytes.toLocaleString()} bytes</p>}
            {modelFolderError && <p className="error" role="alert">{modelFolderError}</p>}
            <button type="button" disabled={taskActive || !modelFolder || modelReady?.ready === true} onClick={() => void prepareSelectedModel()}>
              {modelReady?.ready ? "모델 준비 완료" : "선택 모델 파일 준비 / 다운로드"}
            </button>
            <p>브라우저 ONNX 파일과 필요한 설정·토크나이저를 준비합니다. PyTorch 및 .safetensors 전용 폴더는 지원하지 않습니다.</p>
          </div>
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
