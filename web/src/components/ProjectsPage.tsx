import { useEffect, useState } from "react"

import { createProject, fetchAnalyses, fetchCollages, renameAnalysis } from "../api"
import { ANALYSIS_NICKNAME_MAX_LENGTH } from "../constants"
import type { AnalysisSummary, CompositionProject, ProjectsPageProps } from "../types"

export function ProjectsPage({ projects, onOpenProject, onOpenCollage, onProjectCreated }: ProjectsPageProps) {
  const [analyses, setAnalyses] = useState<AnalysisSummary[]>([])
  const [collages, setCollages] = useState<CompositionProject[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [name, setName] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState("")
  const [draftNickname, setDraftNickname] = useState("")

  useEffect(() => {
    fetchAnalyses().then(setAnalyses).catch((error: Error) => setMessage(error.message))
    fetchCollages().then(setCollages).catch((error: Error) => setMessage(error.message))
  }, [])

  const makeProject = async () => {
    setBusy(true)
    setMessage("")
    try {
      const created = await createProject(name, selected)
      await onProjectCreated()
      onOpenProject(created.project_id)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally { setBusy(false) }
  }

  const saveNickname = async () => {
    setBusy(true)
    setMessage("")
    try {
      const updated = await renameAnalysis(editingId, draftNickname)
      setAnalyses((current) => current.map((item) => item.analysis_id === editingId ? updated : item))
      setEditingId("")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally { setBusy(false) }
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
          {analyses.map((analysis) => (
            <div key={analysis.analysis_id} className="analysis-item">
              <label className="analysis-select">
                <input type="checkbox" checked={selected.includes(analysis.analysis_id)}
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
          {!analyses.length && <p>완료된 분석이 없습니다. 영상 분석부터 시작하세요.</p>}
        </div>
        <label htmlFor="project-name">프로젝트 이름</label>
        <input id="project-name" placeholder="새 프로젝트" value={name}
          onChange={(event) => setName(event.target.value)} />
        <button disabled={!selected.length || !name.trim() || busy} onClick={() => void makeProject()}>
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
        <h3>저장된 콜라주</h3>
        <div className="project-list">
          {collages.map((collage) => (
            <button key={collage.composition_id} onClick={() => onOpenCollage(collage.composition_id)}>
              <strong>{collage.name}</strong><span>연결 프로젝트: {projects.find((item) => item.project_id === collage.corpus_project_id)?.name ?? collage.corpus_project_id} →</span>
            </button>
          ))}
          {!collages.length && <p>저장된 콜라주가 없습니다.</p>}
        </div>
      </div>
      {message && <p className="error" role="alert">{message}</p>}
    </section>
  )
}
