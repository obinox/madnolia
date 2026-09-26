import { useEffect, useRef, useState } from "react"

import { controlAnalysisJob, fetchAnalysisJob, fetchVideos, startAnalysis } from "../api"
import {
  ANALYSIS_MODEL_OPTIONS,
  ANALYSIS_NICKNAME_MAX_LENGTH,
  ANALYSIS_JOB_STORAGE_KEY,
  ANALYSIS_PROGRESS_ANIMATION_MAX_MS,
  ANALYSIS_PROGRESS_ANIMATION_MIN_MS,
  ANALYSIS_PROGRESS_ANIMATION_PER_PERCENT_MS,
  ANALYSIS_PROGRESS_POLL_MS,
  DEFAULT_ANALYSIS_ACOUSTIC_UNITS,
  DEFAULT_ANALYSIS_ALIGNMENT,
  DEFAULT_ANALYSIS_BACKEND,
  DEFAULT_ANALYSIS_DEVICE,
  DEFAULT_ANALYSIS_MODEL,
} from "../constants"
import type { AnalysisAction, AnalysisJob, AnalysisPageProps, AnalysisSettings } from "../types"

export function AnalysisPage({ onGoToProjects }: AnalysisPageProps) {
  const [videos, setVideos] = useState<string[]>([])
  const [filename, setFilename] = useState("")
  const [settings, setSettings] = useState<AnalysisSettings>({
    filename: "", nickname: "", model_name: DEFAULT_ANALYSIS_MODEL, backend: DEFAULT_ANALYSIS_BACKEND,
    device: DEFAULT_ANALYSIS_DEVICE, alignment_mode: DEFAULT_ANALYSIS_ALIGNMENT,
    candidate_models: [], acoustic_units: DEFAULT_ANALYSIS_ACOUSTIC_UNITS,
  })
  const [jobId, setJobId] = useState(() => window.localStorage.getItem(ANALYSIS_JOB_STORAGE_KEY) ?? "")
  const [job, setJob] = useState<AnalysisJob | null>(null)
  const [displayPercent, setDisplayPercent] = useState(0)
  const displayedPercentRef = useRef(0)
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetchVideos()
      .then((available) => {
        setVideos(available)
        setFilename((current) => current || available[0] || "")
      })
      .catch((error: Error) => setMessage(error.message))
  }, [])

  useEffect(() => {
    if (!jobId) return
    let active = true
    let pending = false
    const poll = async () => {
      if (pending) return
      pending = true
      try {
        const current = await fetchAnalysisJob(jobId)
        if (!active) return
        setJob(current)
        if (["running", "pausing", "paused", "stopping"].includes(current.status)) return
        window.localStorage.removeItem(ANALYSIS_JOB_STORAGE_KEY)
        setJobId("")
      } catch (error) {
        if (!active) return
        window.localStorage.removeItem(ANALYSIS_JOB_STORAGE_KEY)
        setJobId("")
        setMessage(error instanceof Error ? error.message : String(error))
      } finally {
        pending = false
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), ANALYSIS_PROGRESS_POLL_MS)
    return () => { active = false; window.clearInterval(timer) }
  }, [jobId])

  useEffect(() => {
    if (!job) return
    const from = displayedPercentRef.current
    const to = Math.max(from, job.percent)
    if (from === to) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      displayedPercentRef.current = to
      setDisplayPercent(to)
      return
    }
    const duration = Math.min(ANALYSIS_PROGRESS_ANIMATION_MAX_MS, Math.max(
      ANALYSIS_PROGRESS_ANIMATION_MIN_MS,
      (to - from) * ANALYSIS_PROGRESS_ANIMATION_PER_PERCENT_MS,
    ))
    let frame = 0
    let start = 0
    const animate = (now: number) => {
      if (!start) start = now
      const value = from + (to - from) * Math.min(1, (now - start) / duration)
      displayedPercentRef.current = value
      setDisplayPercent(value)
      if (value < to) frame = window.requestAnimationFrame(animate)
    }
    frame = window.requestAnimationFrame(animate)
    return () => window.cancelAnimationFrame(frame)
  }, [job?.percent, job?.job_id])

  const analyze = async () => {
    setBusy(true)
    setMessage("")
    try {
      const started = await startAnalysis({ ...settings, filename })
      window.localStorage.setItem(ANALYSIS_JOB_STORAGE_KEY, started.job_id)
      displayedPercentRef.current = 0
      setDisplayPercent(0)
      setJob({
        job_id: started.job_id, filename, status: "running", percent: 0,
        stage: "대기 중", analysis_id: null, error: null,
        download_model: null, download_percent: null,
      })
      setJobId(started.job_id)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally { setBusy(false) }
  }

  const control = async (action: AnalysisAction) => {
    setBusy(true)
    setMessage("")
    try {
      setJob(await controlAnalysisJob(job!.job_id, action))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally { setBusy(false) }
  }

  return (
    <section className="workflow-page">
      <div className="page-intro">
        <p className="section-label">STEP 01 / ANALYZE</p>
        <h2>영상 분석</h2>
        <p>서버의 data/input/videos 폴더에 있는 영상으로 분석 결과를 만듭니다.</p>
      </div>
      <div className="panel workflow-card">
        <label htmlFor="analysis-video">분석할 영상</label>
        <select id="analysis-video" value={filename} onChange={(event) => setFilename(event.target.value)}>
          {videos.map((video) => <option key={video} value={video}>{video}</option>)}
        </select>
        <label htmlFor="analysis-nickname">분석 별명 (선택)</label>
        <input id="analysis-nickname" value={settings.nickname} maxLength={ANALYSIS_NICKNAME_MAX_LENGTH}
          disabled={!!jobId} placeholder="예: 2026 여름 쇼케이스"
          onChange={(event) => setSettings({ ...settings, nickname: event.target.value })} />
        {!videos.length && <p>영상이 없습니다. data/input/videos 폴더에 영상을 넣고 새로고침하세요.</p>}
        <div className="analysis-settings">
          <label>전사 모델
            <select value={settings.model_name} disabled={!!jobId} onChange={(event) => setSettings({
              ...settings, model_name: event.target.value,
              candidate_models: settings.candidate_models.filter((item) => item !== event.target.value),
            })}>
              {ANALYSIS_MODEL_OPTIONS.map((model) => <option key={model} value={model}>{model}</option>)}
            </select>
          </label>
          <label>실행 방식
            <select value={settings.backend} disabled={!!jobId} onChange={(event) => setSettings({
              ...settings, backend: event.target.value as AnalysisSettings["backend"],
              device: event.target.value === "faster-whisper" ? "CPU" : settings.device,
            })}>
              <option value="openvino">OpenVINO</option>
              <option value="faster-whisper">faster-whisper</option>
            </select>
          </label>
          <label>실행 장치
            <select value={settings.device} disabled={!!jobId || settings.backend === "faster-whisper"}
              onChange={(event) => setSettings({ ...settings, device: event.target.value as AnalysisSettings["device"] })}>
              <option value="GPU">GPU</option><option value="CPU">CPU</option>
            </select>
          </label>
          <label>발음 정렬
            <select value={settings.alignment_mode} disabled={!!jobId} onChange={(event) => setSettings({
              ...settings, alignment_mode: event.target.value as AnalysisSettings["alignment_mode"],
            })}>
              <option value="ctc">CTC 정밀 정렬</option><option value="estimated">단어 시간으로 추정</option>
            </select>
          </label>
          <label>추가 전사 모델
            <select value={settings.candidate_models[0] ?? ""} disabled={!!jobId} onChange={(event) => setSettings({
              ...settings, candidate_models: event.target.value ? [event.target.value] : [],
            })}>
              <option value="">사용 안 함</option>
              {ANALYSIS_MODEL_OPTIONS.filter((model) => model !== settings.model_name).map((model) => (
                <option key={model} value={model}>{model}</option>
              ))}
            </select>
          </label>
          <label className="analysis-checkbox">
            <input type="checkbox" checked={settings.acoustic_units} disabled={!!jobId}
              onChange={(event) => setSettings({ ...settings, acoustic_units: event.target.checked })} />
            음향 단위 분석 (HuBERT)
          </label>
        </div>
        <p>기본값은 전사·발음 경계·음향 특징의 정확도를 우선합니다. GPU와 CTC·HuBERT 모델이 필요합니다.</p>
        <button disabled={!filename || !!jobId || busy} onClick={() => void analyze()}>
          {jobId ? "분석 진행 중" : "분석 시작"}
        </button>
      </div>
      {job && (
        <div className="panel progress-card" role="status" aria-live="polite">
          {job.download_model && job.download_percent !== null && (
            <div className="download-progress">
              <div className="progress-heading">
                <div><strong>모델 준비 · {job.download_model}</strong><span>{job.stage === "모델 변환" ? "변환 완료 상태" : "모델 파일 전송량"}</span></div>
                <strong className="progress-value">{job.download_percent.toFixed(1)}%</strong>
              </div>
              <div className="progress-track" role="progressbar" aria-label="모델 다운로드 진행률"
                aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.download_percent}>
                <span className="progress-fill" style={{ width: `${job.download_percent}%` }} />
              </div>
            </div>
          )}
          <div className="progress-heading">
            <div><strong>{job.stage}</strong><span>{job.filename}</span></div>
            <strong className="progress-value">{displayPercent.toFixed(1)}%</strong>
          </div>
          <div className="progress-track" role="progressbar" aria-label="영상 분석 진행률"
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.percent}>
            <span className={job.status === "running" ? "progress-fill active" : "progress-fill"}
              style={{ width: `${displayPercent}%` }} />
          </div>
          <p>전사 진행률은 처리한 영상 구간을 기준으로 표시합니다. 남은 시간의 비율은 아닙니다.</p>
          {job.status === "failed" && <p className="error">{job.error}</p>}
          {job.status === "stopped" && <p>분석을 중단했습니다. 미완료 결과는 정리됩니다.</p>}
          {job.status === "pausing" && <p>현재 처리 구간이 끝나면 일시정지합니다.</p>}
          {job.status === "paused" && <p>일시정지 중입니다. 계속하기를 누르면 이어서 처리합니다.</p>}
          {job.status === "stopping" && <p>현재 처리 구간이 끝나면 분석을 중단합니다.</p>}
          {["running", "pausing", "paused"].includes(job.status) && (
            <div className="analysis-controls">
              {job.status === "running" ? (
                <button disabled={busy} onClick={() => void control("pause")}>일시정지</button>
              ) : (
                <button disabled={busy} onClick={() => void control("resume")}>계속하기</button>
              )}
              <button disabled={busy} onClick={() => void control("stop")}>분석 중단</button>
            </div>
          )}
          {job.status === "complete" && (
            <button onClick={onGoToProjects}>완료된 분석으로 프로젝트 만들기 →</button>
          )}
        </div>
      )}
      {message && <p className="error" role="alert">{message}</p>}
    </section>
  )
}
