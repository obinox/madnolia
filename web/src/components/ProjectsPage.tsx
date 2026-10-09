import { useEffect, useState } from "react"

import { fetchAnalyses, renameAnalysis } from "../api/analysis"
import { createProject, fetchCollages } from "../api/projects"
import { ANALYSIS_NICKNAME_MAX_LENGTH } from "../constants"
import type { AnalysisSummary, CompositionProject, ListLoadState, ProjectsPageProps } from "../types"
import { useGlobalTask } from "../globalTask"

export function ProjectsPage({ projects, onOpenProject, onOpenCollage, onProjectCreated }: ProjectsPageProps) {
  const { beginTask, finishTask, isTaskActive } = useGlobalTask()
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
                <button disabled={busy} onClick={() => {
                  setEditingId(analysis.analysis_id)
                  setDraftNickname(analysis.nickname ?? "")
                }}>별명 편집</button>
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
