import { useEffect, useRef, useState } from "react"

import { controlAnalysisJob, fetchAnalysisHardware, fetchAnalysisJob, fetchVideos, retryAnalysisJob, startAnalysis, uploadVideo } from "../api/analysis"
import {
  VIDEO_UPLOAD_ACCEPT,
  ANALYSIS_MODEL_DOWNLOAD_STAGE,
  ANALYSIS_NICKNAME_MAX_LENGTH,
  ANALYSIS_JOB_STORAGE_KEY,
  ANALYSIS_PROGRESS_ANIMATION_MAX_MS,
  ANALYSIS_PROGRESS_ANIMATION_MIN_MS,
  ANALYSIS_PROGRESS_ANIMATION_PER_PERCENT_MS,
  ANALYSIS_PROGRESS_POLL_MS,
  DEFAULT_ANALYSIS_ACOUSTIC_UNITS,
} from "../constants"
import { BROWSER_ASR_DEFAULT_MODEL, BROWSER_ASR_MODELS } from "../browserAnalysisConstants"
import { analysisModelSelections, getModelFolderHandle, getModelReadiness, prepareModel } from "../browser/modelStorage"
import type { AnalysisAction, AnalysisJob, AnalysisPageProps, AnalysisSettings, DetectedAnalysisHardware, GlobalTaskAction } from "../types"
import { useGlobalTask } from "../globalTask"

export function AnalysisPage({ onGoToProjects }: AnalysisPageProps) {
  const { task, beginTask, updateTask, finishTask, isTaskActive } = useGlobalTask()
  const taskIdRef = useRef<string | null>(null)
  const jobRef = useRef<AnalysisJob | null>(null)
  const actionPendingRef = useRef(false)
  const actionGenerationRef = useRef(0)
  const actionTaskIdRef = useRef<string | null>(null)
  const busyOwnerRef = useRef(0)
  const cancelWaitersRef = useRef<Array<() => void>>([])
  const [videos, setVideos] = useState<string[]>([])
  const [filename, setFilename] = useState("")
  const [settings, setSettings] = useState<AnalysisSettings>({
    filename: "", nickname: "", model_name: BROWSER_ASR_DEFAULT_MODEL, backend: "transformers-js",
    device: "wasm", alignment_mode: "ctc", precision: "baseline",
    candidate_models: [], acoustic_units: DEFAULT_ANALYSIS_ACOUSTIC_UNITS,
  })
  const [jobId, setJobId] = useState(() => {
    try { return window.localStorage.getItem(ANALYSIS_JOB_STORAGE_KEY) ?? "" } catch { return "" }
  })
  const jobIdRef = useRef(jobId)
  const [job, setJob] = useState<AnalysisJob | null>(null)
  const [pollGeneration, setPollGeneration] = useState(0)
  const [displayPercent, setDisplayPercent] = useState(0)
  const displayedPercentRef = useRef(0)
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadPercent, setUploadPercent] = useState(0)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [hardware, setHardware] = useState<DetectedAnalysisHardware | null>(null)
  const deviceChangedRef = useRef(false)
  const modelOptions = BROWSER_ASR_MODELS
  const selectedModel = modelOptions.find((model) => model.id === settings.model_name)
  const clearStoredJob = () => { try { window.localStorage.removeItem(ANALYSIS_JOB_STORAGE_KEY) } catch { } }

  const ensureAnalysisTask = (label: string, stage: string, percent: number | null = null) => {
    if (jobRef.current && !["running", "pausing", "paused", "stopping"].includes(jobRef.current.status)) return null
    if (taskIdRef.current) return taskIdRef.current
    const id = beginTask({ label, stage, percent, cancel: cancelAnalysis, cancelLabel: "분석 중단" })
    taskIdRef.current = id
    return id
  }

  const modalActions = (current: AnalysisJob): GlobalTaskAction[] => {
    const actions: GlobalTaskAction[] = []
    if (current.status === "running" || current.status === "paused" || current.status === "pausing") {
      const action: AnalysisAction = current.status === "paused" ? "resume" : "pause"
      actions.push({ id: action, label: current.status === "pausing" ? "일시정지 대기 중" : action === "pause" ? "일시정지" : "계속하기", disabled: actionPendingRef.current || current.status === "pausing", pending: current.status === "pausing", onAction: () => control(action, true) })
    }
    return actions
  }

  useEffect(() => {
    if (jobId && !taskIdRef.current) ensureAnalysisTask("분석 작업", "진행 상태 확인 중", null)
  }, [jobId, task?.id])

  useEffect(() => {
    fetchAnalysisHardware()
      .then((detected) => {
        setHardware(detected)
        let storedJob = ""
        try { storedJob = window.localStorage.getItem(ANALYSIS_JOB_STORAGE_KEY) ?? "" } catch { }
        if (!deviceChangedRef.current && !storedJob) {
          setSettings((current) => ({ ...current, backend: "transformers-js", device: detected.device }))
        }
      })
      .catch(() => {
        setHardware({ backend: "transformers-js", device: "wasm", gpu_vendor: null })
        if (!deviceChangedRef.current) {
          setSettings((current) => ({ ...current, backend: "transformers-js", device: "wasm" }))
        }
      })
  }, [])

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
    let settled = false
    const poll = async () => {
      if (pending || settled) return
      pending = true
      try {
        const current = await fetchAnalysisJob(jobId)
        if (!active) return
        setJob(current)
        jobRef.current = current
        if (current.settings) {
          setSettings(current.settings)
          setFilename(current.settings.filename)
        }
        if (["running", "pausing", "paused", "stopping"].includes(current.status)) {
          const id = ensureAnalysisTask(
            current.download_model && current.stage === ANALYSIS_MODEL_DOWNLOAD_STAGE ? `모델 준비: ${current.download_model}` : `분석: ${current.filename}`,
            current.stage,
            current.download_model && current.stage === ANALYSIS_MODEL_DOWNLOAD_STAGE && current.download_percent !== null ? current.download_percent : current.percent,
          )
          if (id) updateTask(id, {
            label: current.download_model && current.stage === ANALYSIS_MODEL_DOWNLOAD_STAGE ? `모델 준비: ${current.download_model}` : `분석: ${current.filename}`,
            stage: current.stage,
            percent: current.download_model && current.stage === ANALYSIS_MODEL_DOWNLOAD_STAGE && current.download_percent !== null ? current.download_percent : current.percent,
            actions: modalActions(current),
            cancel: current.status === "stopping" ? undefined : cancelAnalysis,
            cancelLabel: current.status === "stopping" ? "중단 요청 중" : "분석 중단",
          })
          return
        }
        settled = true
        const finishedTaskId = taskIdRef.current
        if (actionTaskIdRef.current === finishedTaskId) {
          actionGenerationRef.current += 1
          actionTaskIdRef.current = null
          actionPendingRef.current = false
          if (busyOwnerRef.current === actionGenerationRef.current - 1) {
            busyOwnerRef.current = 0
            setBusy(false)
          }
        }
        if (finishedTaskId) finishTask(finishedTaskId)
        taskIdRef.current = null
      } catch (error) {
        if (!active) return
        if (error instanceof Error && error.name === "AnalysisJobNotFoundError") {
          settled = true
          clearStoredJob()
          jobIdRef.current = ""
          setJobId("")
          const finishedTaskId = taskIdRef.current
          if (actionTaskIdRef.current === finishedTaskId) {
            actionGenerationRef.current += 1
            actionTaskIdRef.current = null
            actionPendingRef.current = false
            if (busyOwnerRef.current === actionGenerationRef.current - 1) {
              busyOwnerRef.current = 0
              setBusy(false)
            }
          }
          if (finishedTaskId) finishTask(finishedTaskId)
          taskIdRef.current = null
          setMessage(error.message)
          return
        }
        if (taskIdRef.current) updateTask(taskIdRef.current, { stage: "분석 상태 연결을 재시도하는 중", percent: null })
        setMessage(error instanceof Error ? error.message : String(error))
      } finally {
        pending = false
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), ANALYSIS_PROGRESS_POLL_MS)
    return () => { active = false; window.clearInterval(timer) }
  }, [jobId, pollGeneration])

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
    if (isTaskActive()) return
    const selections = analysisModelSelections(settings)
    const readiness = await Promise.all(selections.map((selection) => getModelReadiness(selection)))
    const unavailable = readiness.findIndex((status) => !status.ready)
    if (unavailable >= 0) {
      setMessage(`선택한 모델이 준비되지 않았습니다. ${readiness[unavailable].message} 아래의 '선택 모델 일괄 준비'를 실행한 뒤 분석을 시작하세요.`)
      return
    }
    const taskId = ensureAnalysisTask(`분석: ${filename}`, "분석 요청 중", null)
    if (!taskId) return
    const busyOwner = ++actionGenerationRef.current
    busyOwnerRef.current = busyOwner
    setBusy(true)
    setMessage("")
    try {
      const started = await startAnalysis({ ...settings, filename })
      updateTask(taskId, { label: `분석: ${filename}`, stage: "분석 시작 중", percent: 0 })
      jobIdRef.current = started.job_id
      setJobId(started.job_id)
      try {
        window.localStorage.setItem(ANALYSIS_JOB_STORAGE_KEY, started.job_id)
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error))
      }
      cancelWaitersRef.current.splice(0).forEach((resolve) => resolve())
      displayedPercentRef.current = 0
      setDisplayPercent(0)
      setJob({
        job_id: started.job_id, filename, status: "running", percent: 0,
        stage: "대기 중", analysis_id: null, error: null,
        download_model: null, download_percent: null,
      })
      jobRef.current = { job_id: started.job_id, filename, status: "running", percent: 0, stage: "대기 중", analysis_id: null, error: null, download_model: null, download_percent: null }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
      finishTask(taskId)
      taskIdRef.current = null
      cancelWaitersRef.current.splice(0).forEach((resolve) => resolve())
    } finally {
      if (busyOwnerRef.current === busyOwner) {
        busyOwnerRef.current = 0
        setBusy(false)
      }
    }
  }

  const prepareSelectedModels = async () => {
    if (isTaskActive() || !getModelFolderHandle()) {
      setMessage("상단의 로컬 모델 메뉴에서 모델 폴더를 연결하세요.")
      return
    }
    const selections = analysisModelSelections(settings)
    const controller = new AbortController()
    const taskId = beginTask({ label: "선택 모델 일괄 준비", stage: "모델 준비 시작", percent: 0, cancel: () => controller.abort(), cancelLabel: "모델 준비 취소" })
    if (!taskId) return
    setMessage("")
    try {
      const folder = getModelFolderHandle()
      if (!folder) throw new Error("모델 폴더 연결이 끊어졌습니다. 다시 연결하세요.")
      for (const [index, selection] of selections.entries()) {
        await prepareModel(selection, controller.signal, (progress) => {
          const fraction = progress.expected_bytes ? progress.received_bytes / progress.expected_bytes : 0
          updateTask(taskId, { label: "선택 모델 일괄 준비", stage: `${selection.model_id}: ${progress.current_file}`, percent: Math.min(99, ((index + fraction) / selections.length) * 100) })
        }, folder)
        if (controller.signal.aborted) throw new DOMException("모델 준비가 취소되었습니다.", "AbortError")
        updateTask(taskId, { stage: `모델 ${index + 1}/${selections.length} 준비 완료`, percent: ((index + 1) / selections.length) * 100 })
      }
      updateTask(taskId, { stage: "선택한 모델을 모두 준비했습니다.", percent: 100 })
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) setMessage(error instanceof Error ? error.message : String(error))
    } finally { finishTask(taskId) }
  }

  const cancelAnalysis = async () => {
    const taskId = taskIdRef.current
    if (!taskId) return
    if (!jobIdRef.current) await new Promise<void>((resolve) => cancelWaitersRef.current.push(resolve))
    if (taskIdRef.current === taskId && jobIdRef.current) await control("stop", true)
  }

  const control = async (action: AnalysisAction, propagateError = false) => {
    const taskId = taskIdRef.current
    const currentJobId = jobIdRef.current
    if (!currentJobId || !taskId || actionPendingRef.current) return
    const actionGeneration = ++actionGenerationRef.current
    actionTaskIdRef.current = taskId
    busyOwnerRef.current = actionGeneration
    actionPendingRef.current = true
    setBusy(true)
    setMessage("")
    try {
      updateTask(taskId, { stage: action === "pause" ? "일시정지 요청 중" : action === "resume" ? "다시 시작 요청 중" : "중단 요청 중", actions: (jobRef.current ? modalActions(jobRef.current) : []).map((item) => ({ ...item, disabled: true, pending: true })), cancelLabel: action === "stop" ? "중단 요청 중" : "분석 중단" })
      const current = jobRef.current ?? await fetchAnalysisJob(currentJobId)
      const updated = await controlAnalysisJob(current.job_id, action)
      if (actionGenerationRef.current !== actionGeneration || taskIdRef.current !== taskId || jobIdRef.current !== currentJobId) return
      setJob(updated)
      jobRef.current = updated
      updateTask(taskId, { stage: updated.stage || (action === "stop" ? "중단 요청 중" : "상태 변경 중"), percent: updated.percent, actions: modalActions(updated), cancel: updated.status === "stopping" ? undefined : cancelAnalysis, cancelLabel: updated.status === "stopping" ? "중단 요청 중" : "분석 중단" })
    } catch (error) {
      if (actionGenerationRef.current === actionGeneration && taskIdRef.current === taskId && jobIdRef.current === currentJobId) {
        setMessage(error instanceof Error ? error.message : String(error))
        if (jobRef.current) updateTask(taskId, { actions: modalActions(jobRef.current), cancelLabel: action === "stop" ? "중단 실패 · 다시 시도" : "분석 중단" })
      }
      if (propagateError) throw error
    } finally {
      if (actionGenerationRef.current === actionGeneration) {
        actionTaskIdRef.current = null
        actionPendingRef.current = false
      }
      if (actionGenerationRef.current === actionGeneration && taskIdRef.current === taskId && jobIdRef.current === currentJobId) {
        if (busyOwnerRef.current === actionGeneration) busyOwnerRef.current = 0
        setBusy(false)
        if (jobRef.current) updateTask(taskId, { actions: modalActions(jobRef.current) })
      }
    }
  }

  const resumeSavedJob = async () => {
    const currentJob = jobRef.current
    if (!currentJob || !jobIdRef.current || isTaskActive() || !["failed", "stopped"].includes(currentJob.status)) return
    const taskId = beginTask({ label: `저장 분석 재개: ${currentJob.filename}`, stage: "저장 작업공간과 모델 확인 중", percent: null, cancel: cancelAnalysis, cancelLabel: "분석 중단" })
    if (!taskId) return
    taskIdRef.current = taskId
    setBusy(true)
    setMessage("")
    try {
      const resumed = await retryAnalysisJob(currentJob.job_id)
      if (taskIdRef.current !== taskId || jobIdRef.current !== currentJob.job_id) return
      jobRef.current = resumed
      setJob(resumed)
      setPollGeneration((generation) => generation + 1)
      updateTask(taskId, { label: `분석: ${resumed.filename}`, stage: resumed.stage, percent: resumed.percent, actions: modalActions(resumed), cancel: cancelAnalysis, cancelLabel: "분석 중단" })
    } catch (error) {
      if (taskIdRef.current === taskId) {
        setMessage(error instanceof Error ? error.message : String(error))
        finishTask(taskId)
        setBusy(false)
        taskIdRef.current = null
        setPollGeneration((generation) => generation + 1)
      }
    } finally {
      if (taskIdRef.current === taskId) setBusy(false)
    }
  }

  const dismissSavedJob = () => {
    if (jobRef.current && ["running", "pausing", "paused", "stopping"].includes(jobRef.current.status)) return
    clearStoredJob()
    jobIdRef.current = ""
    setJobId("")
    setJob(null)
    jobRef.current = null
  }

  const importVideo = async (file?: File) => {
    if (!file || uploading || jobId || isTaskActive()) return
    const controller = new AbortController()
    const taskId = beginTask({
      label: `영상 업로드: ${file.name}`, stage: "전송 중", percent: 0,
      cancel: () => controller.abort(), cancelLabel: "업로드 취소",
    })
    if (!taskId) return
    setMessage("")
    setUploadPercent(0)
    setUploading(true)
    try {
      const uploaded = await uploadVideo(file, (percent) => {
        setUploadPercent(percent)
        updateTask(taskId, { percent })
      }, () => updateTask(taskId, {
        stage: "서버에서 업로드 처리 중",
        percent: null,
        cancel: undefined,
        cancelLabel: undefined,
      }), controller.signal)
      setFilename(uploaded.filename)
      setVideos((current) => current.includes(uploaded.filename)
        ? current : [...current, uploaded.filename].sort())
      const available = await fetchVideos()
      setVideos(available)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      finishTask(taskId)
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  return (
    <section className="workflow-page analysis-page">
      <div className="page-intro">
        <p className="section-label">STEP 01 / ANALYZE</p>
        <h2>영상 분석</h2>
        <p>분석할 영상을 선택하거나 아래 영역에 끌어다 놓으세요.</p>
      </div>
      <div className="panel workflow-card">
        <div className={`video-drop-zone${dragging ? " dragging" : ""}`}
          onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
          }}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            void importVideo(event.dataTransfer.files[0])
          }}>
          <strong>영상 파일을 여기에 끌어다 놓으세요</strong>
          <span>또는 파일을 직접 선택할 수 있습니다. 큰 영상은 업로드가 끝날 때까지 잠시 기다려 주세요.</span>
          <input ref={fileInputRef} id="analysis-video-file" type="file" accept={VIDEO_UPLOAD_ACCEPT}
            className="visually-hidden" disabled={uploading || !!jobId}
            onChange={(event) => void importVideo(event.currentTarget.files?.[0])} />
          <button type="button" disabled={uploading || !!jobId}
            onClick={() => fileInputRef.current?.click()}>영상 파일 선택</button>
          {uploading && <div className="upload-progress" role="status" aria-live="polite">
            <span>영상 복사 중 {uploadPercent}%</span>
            <progress aria-label="영상 복사 진행률" max={100} value={uploadPercent} />
          </div>}
        </div>
        <label htmlFor="analysis-video">분석할 영상</label>
        <select id="analysis-video" value={filename} onChange={(event) => setFilename(event.target.value)}>
          {videos.map((video) => <option key={video} value={video}>{video}</option>)}
        </select>
        <label htmlFor="analysis-nickname">분석 별명 (선택)</label>
        <input id="analysis-nickname" value={settings.nickname} maxLength={ANALYSIS_NICKNAME_MAX_LENGTH}
          disabled={!!jobId} placeholder="예: 2026 여름 쇼케이스"
          onChange={(event) => setSettings({ ...settings, nickname: event.target.value })} />
        {!videos.length && <p>아직 추가한 영상이 없습니다. 위에서 영상 파일을 선택해 주세요.</p>}
        <div className="analysis-settings">
          <label>전사 모델
            <select value={settings.model_name} disabled={!!jobId} onChange={(event) => setSettings({
              ...settings, model_name: event.target.value,
              candidate_models: settings.candidate_models.filter((item) => item !== event.target.value),
            })}>
              {modelOptions.map((model) => <option key={model.id} value={model.id}>{model.label} ({model.size_label})</option>)}
            </select>
          </label>
          <label>실행 장치
            <select value={settings.device} disabled={!!jobId} onChange={(event) => {
              deviceChangedRef.current = true
              setSettings({ ...settings, device: event.target.value as AnalysisSettings["device"] })
            }}>
              <option value="webgpu">WebGPU</option><option value="wasm">WebAssembly CPU</option>
            </select>
            {selectedModel && <span>선택 정밀도: {selectedModel.artifacts[settings.precision].dtype[settings.device]}</span>}
          </label>
          <label>모델 정밀도
            <select value={settings.precision} disabled={!!jobId} onChange={(event) => setSettings({
              ...settings, precision: event.target.value as AnalysisSettings["precision"],
            })}>
              <option value="baseline">FP32 기준 정밀도</option><option value="compact">장치별 양자화</option>
            </select>
            <span>양자화는 용량과 메모리를 줄이며, 기준 정밀도와의 품질 차이는 기기별로 확인해야 합니다.</span>
          </label>
          <label>음소 정렬
            <select value={settings.alignment_mode} disabled={!!jobId} onChange={(event) => setSettings({
              ...settings, alignment_mode: event.target.value as AnalysisSettings["alignment_mode"],
            })}>
              <option value="ctc">wav2vec2 CTC 강제 정렬</option><option value="estimated">단어 시간 기반 추정</option>
            </select>
            {settings.alignment_mode === "ctc" && <span>CTC 정밀도: {settings.precision === "baseline" ? "fp32" : settings.device === "webgpu" ? "fp16" : "q4"}</span>}
          </label>
          <label>추가 전사 모델
            <select value={settings.candidate_models[0] ?? ""} disabled={!!jobId} onChange={(event) => setSettings({
              ...settings, candidate_models: event.target.value ? [event.target.value] : [],
            })}>
              <option value="">사용 안 함</option>
              {modelOptions.filter((model) => model.id !== settings.model_name).map((model) => (
                <option key={model.id} value={model.id}>{model.label} ({model.size_label})</option>
              ))}
            </select>
          </label>
          <label className="analysis-checkbox">
            <input type="checkbox" checked={settings.acoustic_units} disabled={!!jobId}
              onChange={(event) => setSettings({ ...settings, acoustic_units: event.target.checked })} />
            HuBERT 음향 단위 분석 (768차원 음성 임베딩 군집화)
          </label>
        </div>
        <button disabled={busy || isTaskActive() || !!jobId} onClick={() => void prepareSelectedModels()}>선택 모델 일괄 준비</button>
        {hardware && <p>감지된 실행 장치: {hardware.device === "webgpu" ? "WebGPU" : "WebAssembly CPU"}{hardware.gpu_vendor ? ` · ${hardware.gpu_vendor}` : ""}. {settings.alignment_mode === "ctc" ? "음소 경계는 wav2vec2 CTC logits로 정렬합니다." : "음소 경계는 단어 구간 안에서 추정합니다."} {settings.acoustic_units ? "음향 단위는 HuBERT 음성 임베딩으로 군집화합니다." : "음향 단위 분석은 꺼져 있습니다."}</p>}
        <button type="button" data-testid="start-analysis" disabled={!filename || !hardware || !!jobId || busy || isTaskActive()} onClick={() => void analyze()}>
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
          {job.interrupted_stage && ["failed", "stopped"].includes(job.status) && <p data-testid="analysis-resume-progress">Interrupted during {job.interrupted_stage}{job.total_windows ? `; ${job.completed_windows ?? 0}/${job.total_windows} windows completed (${job.reused_windows ?? 0} reused)` : ""}</p>}
          {job.status === "failed" && <p className="error">{job.error}</p>}
          {job.status === "stopped" && <p>분석을 중단했습니다. 미완료 결과는 정리됩니다.</p>}
          {job.status === "pausing" && <p>현재 처리 구간이 끝나면 일시정지합니다.</p>}
          {job.status === "paused" && <p>일시정지 중입니다. 계속하기를 누르면 이어서 처리합니다.</p>}
          {job.status === "stopping" && <p>현재 처리 구간이 끝나면 분석을 중단합니다.</p>}
          {["running", "pausing", "paused", "stopping"].includes(job.status) && (
            <div className="analysis-controls">
              {job.status === "running" || job.status === "pausing" ? (
                <button disabled={busy || job.status === "pausing"} onClick={() => void control("pause")}>{job.status === "pausing" ? "일시정지 대기 중" : "일시정지"}</button>
              ) : job.status === "paused" ? (
                <button disabled={busy} onClick={() => void control("resume")}>계속하기</button>
              ) : (
                <button disabled>중단 대기 중</button>
              )}
              <button disabled={busy} onClick={() => void control("stop")}>분석 중단</button>
            </div>
          )}
          {job.status === "complete" && (
            <button onClick={onGoToProjects}>완료된 분석으로 프로젝트 만들기 →</button>
          )}
          {["failed", "stopped"].includes(job.status) && (
            <div className="analysis-controls">
              <button type="button" data-testid="resume-analysis-job" disabled={busy || isTaskActive() || !job.settings}
                onClick={() => void resumeSavedJob()}>저장 분석 이어하기</button>
              <button type="button" data-testid="dismiss-analysis-job" disabled={busy} onClick={dismissSavedJob}>저장 작업 닫기</button>
            </div>
          )}
          {job.status === "complete" && <button type="button" data-testid="dismiss-analysis-job" onClick={dismissSavedJob}>저장 작업 닫기</button>}
        </div>
      )}
      {message && <p className="error" role="alert">{message}</p>}
    </section>
  )
}
