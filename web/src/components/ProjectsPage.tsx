import { useEffect, useRef, useState } from "react"

import { fetchAnalyses, fetchAnalysisReprocessJob, renameAnalysis, startAnalysisReprocess, stopAnalysisReprocess } from "../api/analysis"
import { createProject, fetchCollages } from "../api/projects"
import { ANALYSIS_NICKNAME_MAX_LENGTH } from "../constants"
import type { AnalysisSummary, CompositionProject, ListLoadState, ProjectsPageProps } from "../types"
import { useGlobalTask } from "../globalTask"
import { analysisReprocessModelSelections, getModelFolderHandle, getModelReadiness, prepareModel } from "../browser/modelStorage"
import type { BrowserModelSelection } from "../types/browserModelStorage"
import type { AnalysisPrecision } from "../types"

export function ProjectsPage({ projects, onOpenProject, onOpenCollage, onProjectCreated }: ProjectsPageProps) {
  const { beginTask, updateTask, finishTask, isTaskActive } = useGlobalTask()
  const [analyses, setAnalyses] = useState<AnalysisSummary[]>([])
  const [collages, setCollages] = useState<CompositionProject[]>([])
  const [analysisListState, setAnalysisListState] = useState<ListLoadState>("loading")
  const [analysisListError, setAnalysisListError] = useState("")
  const [collageListState, setCollageListState] = useState<ListLoadState>("loading")
  const [collageListError, setCollageListError] = useState("")
  const [selected, setSelected] = useState<string[]>([])
  const [name, setName] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState("")
  const [draftNickname, setDraftNickname] = useState("")
  const [createdProjectId, setCreatedProjectId] = useState("")
  const [creationRecoveryPending, setCreationRecoveryPending] = useState(false)
  const [reprocessAnalysisId, setReprocessAnalysisId] = useState("")
  const [reprocessPrecision, setReprocessPrecision] = useState<AnalysisPrecision>("baseline")
  const [reprocessDevice, setReprocessDevice] = useState<"webgpu" | "wasm">("wasm")
  const [reprocessHubert, setReprocessHubert] = useState(false)
  const [reprocessMessage, setReprocessMessage] = useState("")
  const [modelReady, setModelReady] = useState<Record<string, string>>({})
  const reprocessJobId = useRef("")

  const loadAnalyses = async () => {
    setAnalysisListState("loading")
    setAnalysisListError("")
    try {
      setAnalyses(await fetchAnalyses())
      setAnalysisListState("loaded")
    } catch (error) {
      setAnalysisListError(error instanceof Error ? error.message : String(error))
      setAnalysisListState("error")
    }
  }

  const loadCollages = async () => {
    setCollageListState("loading")
    setCollageListError("")
    try {
      setCollages(await fetchCollages())
      setCollageListState("loaded")
    } catch (error) {
      setCollageListError(error instanceof Error ? error.message : String(error))
      setCollageListState("error")
    }
  }

  useEffect(() => {
    void loadAnalyses()
    void loadCollages()
  }, [])

  useEffect(() => {
    let active = true
    setModelReady({})
    const folder = getModelFolderHandle()
    if (folder) void Promise.all(reprocessSelections().map(async (selection) => [selection.kind, (await getModelReadiness(selection, folder)).ready ? "준비됨" : "미준비"] as const))
      .then((entries) => { if (active) setModelReady(Object.fromEntries(entries)) })
    return () => { active = false }
  }, [reprocessPrecision, reprocessDevice, reprocessHubert])

  const reprocessSelections = (): BrowserModelSelection[] => analysisReprocessModelSelections(reprocessPrecision, reprocessDevice, reprocessHubert)

  const prepareReprocessModels = async () => {
    if (isTaskActive()) return
    const folder = getModelFolderHandle()
    if (!folder) { setReprocessMessage("모델 폴더를 연결하세요."); return }
    const controller = new AbortController()
    const selections = reprocessSelections()
    const taskId = beginTask({ label: "재처리 모델 준비", stage: "준비 중", percent: 0, cancel: () => controller.abort(), cancelLabel: "모델 준비 취소" })
    if (!taskId) return
    setReprocessMessage("")
    try {
      for (const [index, selection] of selections.entries()) {
        await prepareModel(selection, controller.signal, (progress) => {
          const fraction = progress.expected_bytes ? progress.received_bytes / progress.expected_bytes : 0
          updateTask(taskId, { stage: `${selection.kind === "ctc" ? "CTC" : "HuBERT"} · ${progress.current_file}`, percent: Math.round((index + fraction) * 100 / selections.length) })
        }, folder)
        if (controller.signal.aborted) throw new DOMException("모델 준비가 취소되었습니다.", "AbortError")
      }
      setModelReady(Object.fromEntries(await Promise.all(selections.map(async (selection) => [selection.kind, (await getModelReadiness(selection, folder)).ready ? "준비됨" : "미준비"] as const))))
      updateTask(taskId, { stage: "선택 모델 준비 완료", percent: 100 })
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) setReprocessMessage(error instanceof Error ? error.message : String(error))
    } finally { finishTask(taskId) }
  }

  const reprocessSelected = async () => {
    if (!reprocessAnalysisId || isTaskActive()) return
    const taskId = beginTask({ label: "기존 분석 재처리", stage: "작업 시작", percent: 0, cancel: async () => {
      if (reprocessJobId.current) await stopAnalysisReprocess(reprocessJobId.current)
    }, cancelLabel: "재처리 취소" })
    if (!taskId) return
    setReprocessMessage("")
    reprocessJobId.current = ""
    try {
      const job = await startAnalysisReprocess({ analysis_id: reprocessAnalysisId, precision: reprocessPrecision, device: reprocessDevice, acoustic_units: reprocessHubert })
      reprocessJobId.current = job.job_id
      let current = job
      while (current.status === "running") {
        updateTask(taskId, { stage: current.stage, percent: current.percent })
        await new Promise((resolve) => window.setTimeout(resolve, 600))
        current = await fetchAnalysisReprocessJob(job.job_id)
      }
      if (current.status !== "complete") throw new Error(current.error || "재처리에 실패했습니다.")
      updateTask(taskId, { stage: "저장과 프로젝트 갱신 완료", percent: 100 })
      await loadAnalyses()
      setReprocessMessage("재처리가 완료되었습니다. 전사와 단어 시간은 유지했습니다.")
    } catch (error) {
      setReprocessMessage(error instanceof Error ? error.message : String(error))
    } finally {
      reprocessJobId.current = ""
      finishTask(taskId)
    }
  }

  const makeProject = async () => {
    if (isTaskActive()) return
    const taskId = beginTask({ label: "프로젝트 생성", stage: "저장 중", percent: null })
    if (!taskId) return
    setBusy(true)
    setMessage("")
    try {
      const created = await createProject(name, selected)
      setCreatedProjectId(created.project_id)
      setName("")
      setSelected([])
      try {
        await onProjectCreated(created.project_id)
        setCreationRecoveryPending(false)
        finishTask(taskId)
        onOpenProject(created.project_id)
      } catch (error) {
        setCreationRecoveryPending(true)
        setMessage(`프로젝트 ${created.project_id} 생성 성공, 목록 새로고침 실패: ${error instanceof Error ? error.message : String(error)}`)
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      finishTask(taskId)
      setBusy(false)
    }
  }

  const retryCreatedProjectList = async () => {
    if (!createdProjectId || busy || isTaskActive()) return
    const taskId = beginTask({ label: "프로젝트 목록 새로고침", stage: "목록 불러오는 중" })
    if (!taskId) return
    setBusy(true)
    try {
      await onProjectCreated(createdProjectId)
      setCreationRecoveryPending(false)
      setMessage("")
      finishTask(taskId)
      onOpenProject(createdProjectId)
    } catch (error) {
      setMessage(`프로젝트 ${createdProjectId} 생성 성공, 목록 새로고침 실패: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      finishTask(taskId)
      setBusy(false)
    }
  }

  const saveNickname = async () => {
    if (isTaskActive()) return
    const taskId = beginTask({ label: "분석 별명 저장", stage: "저장 중", percent: null })
    if (!taskId) return
    setBusy(true)
    setMessage("")
    try {
      const updated = await renameAnalysis(editingId, draftNickname)
      setAnalyses((current) => current.map((item) => item.analysis_id === editingId ? updated : item))
      setEditingId("")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      finishTask(taskId)
      setBusy(false)
    }
  }

  return (
    <section className="workflow-page">
      <div className="page-intro">
        <p className="section-label">STEP 02 / COLLECT</p>
        <h2>프로젝트 만들기</h2>
        <p>사용할 영상 분석을 선택하세요. 하나의 프로젝트에서 여러 영상의 발음을 검색할 수 있습니다.</p>
      </div>
      <div className="panel workflow-card">
        <h3>분석 선택 <span className="selected-count">{selected.length}개 선택</span></h3>
        <div className="analysis-list">
          {analysisListState === "loading" && <p>분석 목록을 불러오는 중입니다.</p>}
          {analysisListState === "error" && <div role="alert"><p>{analysisListError}</p><button disabled={busy} onClick={() => void loadAnalyses()}>분석 목록 다시 불러오기</button></div>}
          {analyses.map((analysis) => (
            <div key={analysis.analysis_id} className="analysis-item">
              <label className="analysis-select">
                <input type="checkbox" disabled={creationRecoveryPending} checked={selected.includes(analysis.analysis_id)}
                  onChange={(event) => setSelected(event.target.checked
                    ? [...selected, analysis.analysis_id]
                    : selected.filter((id) => id !== analysis.analysis_id))} />
                <span><strong>{analysis.nickname || analysis.source.path.split(/[\\/]/).pop()}</strong>
                  <small>{analysis.nickname ? `${analysis.source.path.split(/[\\/]/).pop()} / ` : ""}
                    {analysis.model_name} / {analysis.analysis_id}</small></span>
              </label>
              {editingId === analysis.analysis_id ? (
                <div className="analysis-nickname-edit">
                  <input aria-label="분석 별명" value={draftNickname}
                    maxLength={ANALYSIS_NICKNAME_MAX_LENGTH}
                    onChange={(event) => setDraftNickname(event.target.value)} />
                  <button disabled={busy} onClick={() => void saveNickname()}>저장</button>
                  <button disabled={busy} onClick={() => setEditingId("")}>취소</button>
                </div>
              ) : (
                <div className="analysis-nickname-edit">
                  <button disabled={busy || isTaskActive()} onClick={() => {
                    setEditingId(analysis.analysis_id)
                    setDraftNickname(analysis.nickname ?? "")
                  }}>별명 편집</button>
                  <button disabled={busy || isTaskActive()} onClick={() => { setReprocessAnalysisId(analysis.analysis_id); setReprocessMessage("") }}>재처리 선택</button>
                </div>
              )}
            </div>
          ))}
          {analysisListState === "loaded" && !analyses.length && <p>완료된 분석이 없습니다. 영상 분석부터 시작하세요.</p>}
        </div>
        <label htmlFor="project-name">프로젝트 이름</label>
        <input id="project-name" disabled={creationRecoveryPending} placeholder="새 프로젝트" value={name}
          onChange={(event) => setName(event.target.value)} />
        <button disabled={!selected.length || !name.trim() || busy || creationRecoveryPending} onClick={() => void makeProject()}>
          선택한 분석으로 프로젝트 생성
        </button>
      </div>
      <div className="panel workflow-card">
        <h3>저장된 분석 재처리</h3>
        <p>전사와 단어 시간은 그대로 두고 발음·CTC 정렬과 음향 특징을 다시 계산합니다.</p>
        <label htmlFor="reprocess-precision">정밀도</label>
        <select id="reprocess-precision" value={reprocessPrecision} disabled={isTaskActive()} onChange={(event) => setReprocessPrecision(event.target.value as AnalysisPrecision)}>
          <option value="baseline">기준 정밀도</option><option value="compact">경량 정밀도</option>
        </select>
        <label htmlFor="reprocess-device">장치</label>
        <select id="reprocess-device" value={reprocessDevice} disabled={isTaskActive()} onChange={(event) => setReprocessDevice(event.target.value as "webgpu" | "wasm")}>
          <option value="wasm">CPU (WASM)</option><option value="webgpu">GPU (WebGPU)</option>
        </select>
        <label><input type="checkbox" checked={reprocessHubert} disabled={isTaskActive()} onChange={(event) => setReprocessHubert(event.target.checked)} /> HuBERT 음향 특징 포함</label>
        <p>필요 모델: CTC {modelReady.ctc ? `· ${modelReady.ctc}` : "· 준비 여부 확인 전"}{reprocessHubert ? ` / HuBERT ${modelReady.hubert ? `· ${modelReady.hubert}` : "· 준비 여부 확인 전"}` : ""}</p>
        <div className="project-created-recovery">
          <button disabled={isTaskActive()} onClick={() => void prepareReprocessModels()}>선택한 CTC/HuBERT 모델 준비</button>
          <button disabled={!reprocessAnalysisId || isTaskActive()} onClick={() => void reprocessSelected()}>{reprocessAnalysisId ? "선택한 분석 재처리" : "분석 목록에서 재처리를 선택하세요"}</button>
        </div>
        {reprocessMessage && <p role="status">{reprocessMessage}</p>}
      </div>
      <div className="panel workflow-card">
        <h3>기존 프로젝트</h3>
        <div className="project-list">
          {projects.map((project) => (
            <button key={project.project_id} onClick={() => onOpenProject(project.project_id)}>
              <strong>{project.name}</strong><span>영상 {project.source_count}개 →</span>
            </button>
          ))}
          {!projects.length && <p>아직 프로젝트가 없습니다.</p>}
        </div>
      </div>
      <div className="panel workflow-card">
        <h3>저장된 합성</h3>
        <div className="project-list">
          {collageListState === "loading" && <p>합성 목록을 불러오는 중입니다.</p>}
          {collageListState === "error" && <div role="alert"><p>{collageListError}</p><button disabled={busy} onClick={() => void loadCollages()}>합성 목록 다시 불러오기</button></div>}
          {collages.map((collage) => (
            <button key={collage.composition_id} onClick={() => onOpenCollage(collage.composition_id)}>
              <strong>{collage.name}</strong><span>연결 프로젝트: {projects.find((item) => item.project_id === collage.corpus_project_id)?.name ?? collage.corpus_project_id} →</span>
            </button>
          ))}
          {collageListState === "loaded" && !collages.length && <p>저장된 합성이 없습니다.</p>}
        </div>
      </div>
      {message && <p className="error" role="alert">{message}</p>}
      {createdProjectId && message.includes("목록 새로고침 실패") && <div className="project-created-recovery">
        <button disabled={busy} onClick={() => onOpenProject(createdProjectId)}>생성한 프로젝트 열기</button>
        <button disabled={busy} onClick={() => void retryCreatedProjectList()}>목록만 다시 불러오기</button>
      </div>}
    </section>
  )
}
