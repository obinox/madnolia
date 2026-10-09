import { useEffect, useMemo, useRef, useState } from "react"

import { cancelSearch, startSearch } from "../api/search"
import { clearRemoteTask, pollSearchJob, remoteTaskStage, saveRemoteTask, updateRemoteTask } from "../api/remoteTasks"
import { createComposition, exportComposition, fetchCompositions, previewComposition, updateComposition } from "../api/compositions"
import {
  APPROXIMATE_SEARCH_CANDIDATES_PER_PHONE,
  COLLAGE_EXPORT_TARGETS,
  COMPOSITION_DRAFT_SCHEMA_VERSION,
  COMPOSITION_DRAFT_STORAGE_PREFIX,
  EXACT_SEARCH_CANDIDATES_PER_PHONE,
  MAX_STRETCH_PERCENT,
  MIN_STRETCH_PERCENT,
  PROFESSIONAL_DEFAULT_MISSING_DURATION_MS,
  PROFESSIONAL_TEMPO_DEFAULT_BPM,
  PROFESSIONAL_BEATS_PER_BAR_DEFAULT,
  PROFESSIONAL_BEAT_DIVISION_DEFAULT,
  PITCH_TRANSITION_DEFAULT_MS,
  PITCH_TRANSITION_DEFAULT_STRENGTH,
  PITCH_TARGET_STRENGTH_DEFAULT_PERCENT,
  PITCH_VIBRATO_DEPTH_DEFAULT_CENTS,
  PITCH_VIBRATO_RATE_DEFAULT_HZ,
  PITCH_VIBRATO_START_DEFAULT_MS,
  REMOTE_SEARCH_RESULT_STORAGE_PREFIX,
  REMOTE_TASK_SCHEMA_VERSION,
} from "../constants"
import type {
  CandidateSearchResult,
  ApiError,
  CandidateSearchTab,
  CollagePanelProps,
  CompositionDraft,
  CompositionProject,
  ExportJob,
  ExportTarget,
  InputLanguage,
  PhoneUnit,
  SaveCompositionRequest,
  SearchJob,
  RemoteSearchResult,
  SynthesisWorkspace,
  TimelineSegment,
  UnitCandidate,
} from "../types"
import { retimeCompositionSegments } from "../composition"
import { formatTime } from "./Timeline"
import { ExportProgress } from "./ExportProgress"
import { useGlobalTask } from "../globalTask"

export function CollagePanel({
  projectId,
  initialCompositionId,
  onPreview,
  onPreparePreview,
}: CollagePanelProps) {
  const [targetText, setTargetText] = useState("")
  const [targetPronunciation, setTargetPronunciation] = useState("")
  const [inputLanguage, setInputLanguage] = useState<InputLanguage>("AUTO")
  const [result, setResult] = useState<CandidateSearchResult | null>(null)
  const [approximateResult, setApproximateResult] = useState<CandidateSearchResult | null>(null)
  const [candidateTab, setCandidateTab] = useState<CandidateSearchTab>("EXACT")
  const [workspace, setWorkspace] = useState<SynthesisWorkspace>("SEARCH")
  const [selectedPhone, setSelectedPhone] = useState(0)
  const [activeCandidateId, setActiveCandidateId] = useState("")
  const [segments, setSegments] = useState<TimelineSegment[]>([])
  const [compositions, setCompositions] = useState<CompositionProject[]>([])
  const [compositionId, setCompositionId] = useState("")
  const [name, setName] = useState("새 오디오 합성")
  const [crossfadeMs, setCrossfadeMs] = useState(8)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [listRefreshFailed, setListRefreshFailed] = useState(false)
  const listRefreshFailedRef = useRef(false)
  const [searchError, setSearchError] = useState("")
  const [previewUrl, setPreviewUrl] = useState("")
  const [searchProgress, setSearchProgress] = useState<SearchJob | null>(null)
  const [exportProgress, setExportProgress] = useState<ExportJob | null>(null)
  const [draftProjectId, setDraftProjectId] = useState("")
  const draftProjectIdRef = useRef(draftProjectId)
  draftProjectIdRef.current = draftProjectId
  const latestDraftRef = useRef<CompositionDraft | null>(null)
  const { beginTask, updateTask, finishTask } = useGlobalTask()
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  const previewController = useRef<AbortController | null>(null)
  const searchController = useRef<AbortController | null>(null)
  const exportController = useRef<AbortController | null>(null)
  const searchJobId = useRef("")
  const searchStartRequest = useRef<ReturnType<typeof startSearch> | null>(null)
  const searchCancelRequest = useRef<Promise<void> | null>(null)
  const searchMonitorPromise = useRef<Promise<SearchJob> | null>(null)
  const searchBusyRef = useRef(false)
  const projectIdRef = useRef(projectId)
  const compositionsRequestId = useRef(0)
  const searchTaskId = useRef<string | null>(null)
  const appliedInitialCompositionKey = useRef("")
  const restoredSearchProject = useRef("")
  projectIdRef.current = projectId
  if (draftProjectId === projectId) {
    latestDraftRef.current = !targetText.trim() && !segments.length && !compositionId ? null : {
      schema_version: COMPOSITION_DRAFT_SCHEMA_VERSION,
      project_id: projectId,
      composition_id: compositionId,
      saved_at: new Date().toISOString(),
      target_text: targetText,
      target_pronunciation: targetPronunciation,
      input_language: inputLanguage,
      name,
      crossfade_ms: crossfadeMs,
      segments,
    }
  }

  const reloadProjectCompositions = async (targetProjectId: string): Promise<void> => {
    if (projectIdRef.current !== targetProjectId) return
    const requestId = ++compositionsRequestId.current
    const items = await fetchCompositions(targetProjectId)
    if (requestId === compositionsRequestId.current && projectIdRef.current === targetProjectId) {
      setCompositions(items)
    }
  }

  useEffect(() => {
    if (previewController.current) {
      previewController.current.abort()
      previewController.current = null
      setBusy(false)
    }
    setPreviewUrl("")
  }, [projectId, segments, crossfadeMs])

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  useEffect(() => {
    listRefreshFailedRef.current = false
    setListRefreshFailed(false)
    setExportProgress(null)
    setDraftProjectId("")
    searchController.current = null
    setSearchProgress(null)
    compositionsRequestId.current += 1
    setResult(null)
    setTargetPronunciation("")
    setApproximateResult(null)
    setCandidateTab("EXACT")
    setWorkspace("SEARCH")
    setActiveCandidateId("")
    setSegments([])
    setCompositionId("")
    setMessage("")
    setSearchError("")
    setBusy(false)
    setCompositions([])
    try {
      const rawDraft = window.localStorage.getItem(`${COMPOSITION_DRAFT_STORAGE_PREFIX}${projectId}`)
      if (rawDraft) {
        const draft = JSON.parse(rawDraft) as CompositionDraft
        if (
          draft.schema_version === COMPOSITION_DRAFT_SCHEMA_VERSION
          && draft.project_id === projectId
          && typeof draft.composition_id === "string" && typeof draft.target_text === "string"
          && typeof draft.target_pronunciation === "string" && typeof draft.name === "string"
          && ["AUTO", "KO", "EN", "JA"].includes(draft.input_language)
          && Number.isFinite(draft.crossfade_ms)
          && Array.isArray(draft.segments)
          && draft.segments.every((segment) => segment && typeof segment.segment_id === "string"
            && Array.isArray(segment.phone_units) && Array.isArray(segment.edit_regions) && Array.isArray(segment.volume_envelope))
        ) {
          setCompositionId(draft.composition_id)
          setTargetText(draft.target_text)
          setTargetPronunciation(draft.target_pronunciation)
          setInputLanguage(draft.input_language)
          setName(draft.name)
          setCrossfadeMs(draft.crossfade_ms)
          setSegments(draft.segments)
          if (draft.segments.length) setWorkspace("ASSEMBLY")
        }
      }
    } catch {
      try { window.localStorage.removeItem(`${COMPOSITION_DRAFT_STORAGE_PREFIX}${projectId}`) } catch { }
    }
    setDraftProjectId(projectId)
    void reloadProjectCompositions(projectId).catch((error: Error) => {
      if (projectIdRef.current === projectId) setMessage(error.message)
    })
    return () => {
      compositionsRequestId.current += 1
      const latest = latestDraftRef.current
      if (latest?.project_id === projectId) {
        try { window.localStorage.setItem(`${COMPOSITION_DRAFT_STORAGE_PREFIX}${projectId}`, JSON.stringify(latest)) } catch { }
      } else if (!latest && draftProjectIdRef.current === projectId) {
        try { window.localStorage.removeItem(`${COMPOSITION_DRAFT_STORAGE_PREFIX}${projectId}`) } catch { }
      }
    }
  }, [projectId])

  useEffect(() => {
    const flushDraft = () => {
      const targetProjectId = projectIdRef.current
      if (draftProjectIdRef.current !== targetProjectId) return
      const latest = latestDraftRef.current
      try {
        if (latest?.project_id === targetProjectId) {
          window.localStorage.setItem(`${COMPOSITION_DRAFT_STORAGE_PREFIX}${targetProjectId}`, JSON.stringify(latest))
        } else {
          window.localStorage.removeItem(`${COMPOSITION_DRAFT_STORAGE_PREFIX}${targetProjectId}`)
        }
      } catch { }
    }
    window.addEventListener("pagehide", flushDraft)
    window.addEventListener("beforeunload", flushDraft)
    return () => {
      window.removeEventListener("pagehide", flushDraft)
      window.removeEventListener("beforeunload", flushDraft)
    }
  }, [])

  useEffect(() => {
    const key = `${REMOTE_SEARCH_RESULT_STORAGE_PREFIX}${projectId}`
    try {
      const raw = window.localStorage.getItem(key)
      if (!raw) return
      const restored = JSON.parse(raw) as RemoteSearchResult
      if (restored.descriptor.version !== REMOTE_TASK_SCHEMA_VERSION
        || restored.descriptor.project_id !== projectId || restored.descriptor.kind !== "search"
        || !restored.descriptor.search || !restored.result
        || !Array.isArray(restored.result.candidates) || !Array.isArray(restored.result.target_phones)) {
        try { window.localStorage.removeItem(key) } catch { }
        return
      }
      restoredSearchProject.current = projectId
      setTargetText(restored.descriptor.search.text)
      setInputLanguage(restored.descriptor.search.input_language)
      setTargetPronunciation(restored.result.target_pronunciation)
      if (restored.descriptor.search.tab === "EXACT") {
        setResult(restored.result)
        setCandidateTab("EXACT")
      } else {
        if (restored.descriptor.search.exact_result) setResult(restored.descriptor.search.exact_result)
        setApproximateResult(restored.result)
        setCandidateTab("APPROXIMATE")
      }
      setWorkspace("SEARCH")
      setMessage(restored.descriptor.search.tab === "EXACT"
        ? `정확 후보 ${restored.result.candidates.length}개를 복원했습니다.`
        : `유사 후보 ${restored.result.candidates.length}개를 복원했습니다.`)
      try { window.localStorage.removeItem(key) } catch { }
    } catch {
      try { window.localStorage.removeItem(key) } catch { }
    }
  }, [projectId])

  useEffect(() => {
    if (draftProjectId !== projectId) return
    const storageKey = `${COMPOSITION_DRAFT_STORAGE_PREFIX}${projectId}`
    if (!targetText.trim() && !segments.length && !compositionId) {
      latestDraftRef.current = null
      const timer = window.setTimeout(() => {
        try { window.localStorage.removeItem(storageKey) } catch { }
      }, 300)
      return () => window.clearTimeout(timer)
    }
    const draft: CompositionDraft = {
      schema_version: COMPOSITION_DRAFT_SCHEMA_VERSION,
      project_id: projectId,
      composition_id: compositionId,
      saved_at: new Date().toISOString(),
      target_text: targetText,
      target_pronunciation: targetPronunciation,
      input_language: inputLanguage,
      name,
      crossfade_ms: crossfadeMs,
      segments,
    }
    latestDraftRef.current = draft
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(draft))
      } catch {
        setMessage("브라우저 임시 저장 공간이 부족합니다. 서버 저장을 진행해 주세요.")
      }
    }, 300)
    return () => window.clearTimeout(timer)
  }, [
    compositionId,
    crossfadeMs,
    draftProjectId,
    inputLanguage,
    name,
    projectId,
    segments,
    targetPronunciation,
    targetText,
  ])

  useEffect(() => {
    if (restoredSearchProject.current === projectId) return
    if (!initialCompositionId) {
      appliedInitialCompositionKey.current = ""
      return
    }
    const key = `${projectId}:${initialCompositionId}`
    if (appliedInitialCompositionKey.current === key) return
    const selected = compositions.find((item) =>
      item.composition_id === initialCompositionId && item.corpus_project_id === projectId,
    )
    if (!selected) return
    appliedInitialCompositionKey.current = key
    setCompositionId(selected.composition_id)
    setName(selected.name)
    setTargetText(selected.target_text)
    setTargetPronunciation(selected.target_pronunciation)
    setCrossfadeMs(selected.crossfade_ms)
    setSegments(selected.segments)
    setWorkspace("ASSEMBLY")
  }, [initialCompositionId, compositions, projectId])

  const activeResult = candidateTab === "EXACT" ? result : approximateResult
  const visibleCandidates = useMemo(
    () => activeResult?.candidates.filter(
      (candidate) => candidate.target_start_index === selectedPhone,
    ).slice(0, 40) ?? [],
    [activeResult, selectedPhone],
  )
  const candidateCountsByStart = useMemo(() => {
    const counts = new Map<number, number>()
    for (const candidate of activeResult?.candidates ?? []) {
      counts.set(candidate.target_start_index, (counts.get(candidate.target_start_index) ?? 0) + 1)
    }
    return counts
  }, [activeResult])
  const selectedTarget = activeResult?.target_phones[selectedPhone] ?? null
  const selectedExactCount = visibleCandidates.filter(
    (candidate) => candidate.match_status === "EXACT",
  ).length
  const selectedApproximateCount = visibleCandidates.length - selectedExactCount
  const selectedFallbackCount = visibleCandidates.filter((candidate) => candidate.fallback).length
  const missingCandidateCount = activeResult?.target_phones.filter((phone) => !activeResult.candidates.some(
    (candidate) => candidate.target_start_index === phone.target_index,
  )).length ?? 0

  const runSearch = async (searchTab: CandidateSearchTab = "EXACT") => {
    if (!targetText.trim() || searchBusyRef.current) return
    const taskId = beginTask({
      label: searchTab === "EXACT" ? "정확 후보 검색" : "유사 후보 검색",
      stage: "검색 준비 중",
      percent: null,
      cancel: () => stopSearch(),
      cancelLabel: "검색 취소",
    })
    if (!taskId) return
    searchTaskId.current = taskId
    searchCancelRequest.current = null
    searchBusyRef.current = true
    searchController.current?.abort()
    const controller = new AbortController()
    searchController.current = controller
    setBusy(true)
    setSearchProgress(null)
    if (searchTab === "EXACT") {
      setWorkspace("SEARCH")
      setTargetPronunciation("")
      setResult(null)
      setApproximateResult(null)
      setCandidateTab("EXACT")
      setSelectedPhone(0)
      setActiveCandidateId("")
    } else {
      setApproximateResult(null)
      setCandidateTab("APPROXIMATE")
    }
    setSearchError("")
    setMessage("")
    try {
      const startRequest = startSearch(
        projectId,
        targetText,
        inputLanguage,
        searchTab === "EXACT"
          ? EXACT_SEARCH_CANDIDATES_PER_PHONE
          : APPROXIMATE_SEARCH_CANDIDATES_PER_PHONE,
        searchTab === "EXACT",
        searchTab === "APPROXIMATE",
      )
      searchStartRequest.current = startRequest
      const { job_id } = await startRequest
      if (searchStartRequest.current === startRequest) searchStartRequest.current = null
      searchJobId.current = job_id
      saveRemoteTask({
        version: REMOTE_TASK_SCHEMA_VERSION,
        job_id,
        kind: "search",
        project_id: projectId,
        label: `${searchTab === "EXACT" ? "정확" : "유사"} 후보 검색: ${targetText}`,
        stage: "검색 대기 중",
        percent: 0,
        search: { text: targetText, input_language: inputLanguage, tab: searchTab, pronunciation: targetPronunciation, exact_result: searchTab === "APPROXIMATE" ? result ?? undefined : undefined },
      })
      const monitor = pollSearchJob(job_id, (status) => {
        if (!status) {
          if (searchTaskId.current === taskId) updateTask(taskId, { stage: "상태 확인을 재시도하는 중" })
          updateRemoteTask(job_id, { stage: "상태 확인을 재시도하는 중" })
          return
        }
        if (projectIdRef.current !== projectId || controller.signal.aborted) return
        setSearchProgress(status)
        const stage = remoteTaskStage(status.stage)
        if (searchTaskId.current === taskId) updateTask(taskId, { stage, percent: status.percent })
        updateRemoteTask(job_id, { stage, percent: status.percent })
      }, controller.signal)
      searchMonitorPromise.current = monitor
      const job = await monitor
      if (projectIdRef.current !== projectId) return
      clearRemoteTask(job_id)
      if (job.status === "cancelled") {
        setMessage("검색이 취소됐어요")
        return
      }
      if (job.status === "failed" || !job.result) {
        throw new Error(job.error ?? "검색 결과가 반환되지 않았습니다.")
      }
      const next = job.result
      if (searchTab === "EXACT") {
        setResult(next)
        setTargetPronunciation(next.target_pronunciation)
        setSelectedPhone(0)
        setMessage(`${next.target_phones.length}개 음소 · 정확 후보 ${next.candidates.length}개`)
      } else {
        setApproximateResult(next)
        setMessage(`유사 후보 ${next.candidates.length}개`)
      }
    } catch (error) {
      if (!controller.signal.aborted && projectIdRef.current === projectId) {
        const detail = error instanceof Error ? error.message : String(error)
        if ((error as ApiError)?.status === 404 && searchJobId.current) clearRemoteTask(searchJobId.current)
        setSearchError(detail)
        setMessage(detail)
      }
    } finally {
      if (searchController.current === controller) {
        searchController.current = null
        searchJobId.current = ""
        searchStartRequest.current = null
        searchCancelRequest.current = null
        searchMonitorPromise.current = null
        searchBusyRef.current = false
        if (projectIdRef.current === projectId) setBusy(false)
      }
      if (searchTaskId.current === taskId) {
        searchTaskId.current = null
        finishTask(taskId)
      }
    }
  }

  const stopSearch = async () => {
    if (!searchCancelRequest.current) {
      const taskId = searchTaskId.current
      searchCancelRequest.current = (async () => {
        let jobId = searchJobId.current
        if (!jobId && searchStartRequest.current) {
          try {
            jobId = (await searchStartRequest.current).job_id
          } catch {
            if (taskId && searchTaskId.current === taskId) {
              searchTaskId.current = null
              searchBusyRef.current = false
              finishTask(taskId)
              if (projectIdRef.current === projectId) setBusy(false)
            }
            return
          }
        }
        if (!jobId) return
        searchJobId.current = jobId
        let job: SearchJob
        try {
          job = await cancelSearch(jobId)
          if (job.status === "cancelling" || job.status === "running") {
            const monitor = searchMonitorPromise.current
            if (monitor) job = await monitor
          }
        } catch (error) {
          if ((error as ApiError)?.status === 404) clearRemoteTask(jobId)
          if (taskId && searchTaskId.current !== taskId) return
          throw error
        }
        if (!taskId || searchTaskId.current !== taskId) return
        setSearchProgress(job)
      })()
    }
    const cancellation = searchCancelRequest.current
    try { await cancellation }
    finally {
      if (searchCancelRequest.current === cancellation) searchCancelRequest.current = null
    }
  }

  const selectCandidateTab = (nextTab: CandidateSearchTab) => {
    setActiveCandidateId("")
    if (nextTab === "EXACT") {
      setCandidateTab("EXACT")
      return
    }
    if (approximateResult) {
      setCandidateTab("APPROXIMATE")
      return
    }
    void runSearch("APPROXIMATE")
  }

  const addCandidate = (candidate: UnitCandidate) => {
    setActiveCandidateId("")
    const previousEnd = segments.at(-1)?.timeline_end_ms ?? 0
    const start = Math.max(0, previousEnd - (segments.length ? crossfadeMs : 0))
    const phoneUnits = candidateToPhoneUnits(candidate)
    const duration = candidate.source_end_ms - candidate.source_start_ms
    const segmentId = `seg_${crypto.randomUUID()}`
    const next = [
      ...segments,
      {
        segment_id: segmentId,
        candidate_id: candidate.candidate_id,
        target_start_index: candidate.target_start_index,
        target_end_index: candidate.target_end_index,
        source_id: candidate.source_id,
        source_start_ms: candidate.source_start_ms,
        source_end_ms: candidate.source_end_ms,
        timeline_start_ms: start,
        timeline_end_ms: start + duration,
        match_status: candidate.match_status,
        target_ipa: candidate.target_ipa,
        matched_ipa: candidate.matched_ipa,
        gap_before_ms: segments.length ? -crossfadeMs : 0,
        stretch_percent: MIN_STRETCH_PERCENT,
        lane: segments.length % 2,
        phone_units: phoneUnits,
        edit_regions: [],
        volume_envelope: [],
      },
    ]
    setSegments(retimeCompositionSegments(next, "SIMPLE"))
    setSelectedPhone(candidate.target_end_index)
  }

  const changeOrder = (index: number, offset: number) => {
    const destination = index + offset
    if (destination < 0 || destination >= segments.length) return
    const reordered = [...segments]
    ;[reordered[index], reordered[destination]] = [reordered[destination], reordered[index]]
    setSegments(retimeCompositionSegments(reordered, "SIMPLE"))
  }

  const buildRequest = (): SaveCompositionRequest => {
    const current = compositions.find((item) => item.composition_id === compositionId)
    return {
      name,
      target_text: result?.target_text ?? current?.target_text ?? targetText,
      target_pronunciation: result?.target_pronunciation
        ?? current?.target_pronunciation
        ?? targetPronunciation,
      crossfade_ms: crossfadeMs,
      tempo_bpm: PROFESSIONAL_TEMPO_DEFAULT_BPM,
      beats_per_bar: PROFESSIONAL_BEATS_PER_BAR_DEFAULT,
      beat_division: PROFESSIONAL_BEAT_DIVISION_DEFAULT,
      segments,
      mode: "SIMPLE",
      schema_version: 1,
      parent_composition_id: null,
      parent_composition_updated_at: null,
    }
  }

  const playPreview = async () => {
    const taskId = beginTask({ label: "전체 미리보기 생성", stage: "미리보기 생성 중" })
    if (!taskId) return
    previewController.current?.abort()
    const controller = new AbortController()
    previewController.current = controller
    setBusy(true)
    setMessage("")
    try {
      const blob = await previewComposition(projectId, buildRequest(), controller.signal)
      if (!controller.signal.aborted) {
        setPreviewUrl(URL.createObjectURL(blob))
      }
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      if (previewController.current === controller) {
        previewController.current = null
        setBusy(false)
      }
      finishTask(taskId)
    }
  }

  const persistComposition = async (): Promise<CompositionProject> => {
    const body = buildRequest()
    const saved = compositionId
      ? await updateComposition(compositionId, body)
      : await createComposition(projectId, body)
    if (projectIdRef.current === projectId) {
      setCompositionId(saved.composition_id)
      if (latestDraftRef.current?.project_id === projectId) latestDraftRef.current = { ...latestDraftRef.current, composition_id: saved.composition_id }
    }
    if (projectIdRef.current === projectId) setCompositions((current) => [saved, ...current.filter((item) => item.composition_id !== saved.composition_id)])
    return saved
  }

  const refreshCompositionList = async () => {
    await reloadProjectCompositions(projectId)
    listRefreshFailedRef.current = false
    setListRefreshFailed(false)
  }

  const save = async () => {
    if (!targetText.trim() && !compositionId) {
      setMessage("먼저 문장을 검색하세요.")
      return
    }
    const taskId = beginTask({ label: "합성 저장", stage: "저장 중" })
    if (!taskId) return
    setBusy(true)
    setMessage("")
    try {
      const saved = await persistComposition()
      try {
        await refreshCompositionList()
        if (projectIdRef.current === projectId) setMessage(`저장됨 · ${saved.composition_id}`)
      } catch (error) {
        listRefreshFailedRef.current = true
        setListRefreshFailed(true)
        if (projectIdRef.current === projectId) setMessage(`저장 성공 · ${saved.composition_id}. 목록 새로고침 실패: ${error instanceof Error ? error.message : String(error)}`)
      }
    } catch (error) {
      if (projectIdRef.current === projectId) {
        setMessage(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (projectIdRef.current === projectId) setBusy(false)
      finishTask(taskId)
    }
  }

  const load = (id: string) => {
    setCompositionId(id)
    const composition = compositions.find((item) => item.composition_id === id)
    if (!composition) return
    setName(composition.name)
    setTargetText(composition.target_text)
    setTargetPronunciation(composition.target_pronunciation)
    setCrossfadeMs(composition.crossfade_ms)
    setSegments(composition.segments)
    setWorkspace("ASSEMBLY")
    setResult(null)
    setApproximateResult(null)
    setCandidateTab("EXACT")
    setMessage(`불러옴 · ${composition.updated_at}`)
  }

  const runExport = async (target: ExportTarget) => {
    if (!targetText.trim() && !compositionId) {
      setMessage("먼저 문장을 검색하세요.")
      return
    }
    const taskId = beginTask({ label: `${target} 내보내기`, stage: "합성 저장 중" })
    if (!taskId) return
    const controller = new AbortController()
    exportController.current?.abort()
    exportController.current = controller
    setBusy(true)
    setMessage("")
    setExportProgress(null)
    try {
      const saved = await persistComposition()
      if (controller.signal.aborted || projectIdRef.current !== projectId) return
      try { await refreshCompositionList() } catch {
        listRefreshFailedRef.current = true
        setListRefreshFailed(true)
        setMessage(`저장 성공 · ${saved.composition_id}. 목록 새로고침에 실패했지만 내보내기를 계속합니다.`)
      }
      updateTask(taskId, { stage: `${target} 내보내기`, percent: null })
      await exportComposition(saved.composition_id, target, (job) => {
        if (exportController.current === controller && projectIdRef.current === projectId) {
          setExportProgress(job)
          updateTask(taskId, { stage: remoteTaskStage(job.stage), percent: job.percent })
        }
      }, controller.signal, {
        kind: "export",
        project_id: projectId,
        composition_id: saved.composition_id,
        target,
        label: `${target} 내보내기`,
      }, (stage, percent) => updateTask(taskId, percent === undefined ? { stage } : { stage, percent }))
      if (projectIdRef.current === projectId && !listRefreshFailedRef.current) setMessage(`${target} 익스포트 완료`)
      else if (projectIdRef.current === projectId) setMessage(`저장 및 ${target} 내보내기 완료 · 목록 새로고침에 실패했습니다.`)
    } catch (error) {
      if (!controller.signal.aborted && projectIdRef.current === projectId) {
        setExportProgress(null)
        setMessage(error instanceof Error ? error.message : String(error))
      }
    } finally {
      const isCurrentExport = exportController.current === controller && projectIdRef.current === projectId
      if (exportController.current === controller) exportController.current = null
      if (isCurrentExport) setBusy(false)
      finishTask(taskId)
    }
  }

  return (
    <section className="collage panel">
      <div className="collage-heading">
        <div>
          <p className="section-label">VOICE SYNTHESIS</p>
          <h2>음소 기반 영상·음성 합성</h2>
        </div>
        <label>
          저장된 합성
          <select value={compositionId} onChange={(event) => load(event.target.value)}>
            <option value="">새 합성</option>
            {compositions.filter((item) => item.mode === "SIMPLE").map((item) => (
              <option key={item.composition_id} value={item.composition_id}>{item.name}</option>
            ))}
          </select>
        </label>
      </div>

      <div className={`synthesis-search ${workspace === "SEARCH" ? "active-workspace" : "hidden-workspace"}`}>
      <div className="quadrant-heading">
        <strong>PHONEME SEARCH</strong>
        <div className="synthesis-mode-tabs" role="tablist" aria-label="합성 작업 전환">
          <button type="button" role="tab" aria-selected="true">후보 찾기</button>
          <button type="button" role="tab" aria-selected="false" onClick={() => setWorkspace("ASSEMBLY")}>
            배치 편집 <span>{segments.length}</span>
          </button>
        </div>
      </div>
      <div className="search-row">
        <label className="control-field">
          <span>입력 언어</span>
          <select
            value={inputLanguage}
            onChange={(event) => setInputLanguage(event.target.value as InputLanguage)}
          >
            <option value="AUTO">자동 감지</option>
            <option value="KO">한국어</option>
            <option value="EN">English</option>
            <option value="JA">日本語</option>
          </select>
        </label>
        <label className="control-field search-text-field">
          <span>합성할 문장</span>
          <textarea
            value={targetText}
            onChange={(event) => setTargetText(event.target.value)}
            placeholder="만들 문장을 입력하세요"
            rows={1}
          />
        </label>
        <button className="primary-action" disabled={busy || !targetText.trim()} onClick={() => void runSearch("EXACT")}>
          {busy ? "처리 중" : "후보 찾기"}
        </button>
      </div>

      {searchProgress?.status === "running" && <div className="search-progress">
        <div>
          <span>{({
            queued: "대기 중",
            cancelling: "중단 요청 중",
            corpus: "영상 음소 불러오기",
            phonetic: "발음 음소 변환",
            exact: "정확 일치 검색",
            approximate: "유사 발음 검색",
            sorting: "검색 결과 정렬",
          } as Record<string, string>)[searchProgress.stage] ?? searchProgress.stage}</span>
          <strong>{Math.floor(searchProgress.percent)}%</strong>
        </div>
        <progress max={100} value={searchProgress.percent} aria-label="Search progress" />
        <button onClick={() => { void stopSearch().catch((error: Error) => setSearchError(error.message)) }}>취소</button>
      </div>}

      {searchError && <div className="search-diagnostics search-error" role="alert">
        <div><strong>SEARCH ERROR</strong><span>{inputLanguage === "JA" ? "日本語" : inputLanguage}</span></div>
        <p>{searchError}</p>
        <p>입력 문장: <code>{targetText}</code></p>
      </div>}

      {result && (
        <>
          <div className="search-result-summary">
          <div className="pronunciation">
            {({ KO: "한국어", EN: "English", JA: "日本語", AUTO: "자동" })[result.input_language]} 발음형
            <strong>{result.target_pronunciation}</strong>
          </div>
          <div className="phone-picker" role="listbox" aria-label="검색할 음소 선택">
            {result.target_phones.map((phone) => {
              const count = candidateCountsByStart.get(phone.target_index) ?? 0
              return <button
                key={phone.target_index}
                type="button"
                role="option"
                aria-selected={selectedPhone === phone.target_index}
                className={`${selectedPhone === phone.target_index ? "selected" : ""} ${phone.exact_available ? "" : "missing"}`}
                title={`${phone.target_index + 1}. ${phone.grapheme} / ${phone.ipa} · 후보 ${count}`}
                onClick={() => { setSelectedPhone(phone.target_index); setActiveCandidateId("") }}
              >
                <span>{phone.grapheme}</span>
                <strong>{phone.ipa}</strong>
                <small>{count}</small>
              </button>
            })}
          </div>

          <div className="candidate-tabs" role="tablist" aria-label="후보 검색 방식">
            <button
              type="button"
              role="tab"
              aria-selected={candidateTab === "EXACT"}
              className={candidateTab === "EXACT" ? "selected" : ""}
              onClick={() => selectCandidateTab("EXACT")}
            >정확 후보 <span>{result.candidates.length}</span></button>
            <button
              type="button"
              role="tab"
              aria-selected={candidateTab === "APPROXIMATE"}
              className={candidateTab === "APPROXIMATE" ? "selected" : ""}
              disabled={busy}
              onClick={() => selectCandidateTab("APPROXIMATE")}
            >{busy && candidateTab === "APPROXIMATE" ? "유사 후보 검색 중" : "유사 후보"} <span>{approximateResult?.candidates.length ?? "필요할 때 검색"}</span></button>
          </div>

          <div className="search-diagnostics" role="status" aria-live="polite">
            <div><strong>INFO</strong><span>{result.target_phones.length}개 음소 · {candidateTab === "EXACT" ? "정확" : "유사"} 후보 {activeResult?.candidates.length ?? 0}개</span></div>
            {selectedTarget && <dl>
              <div><dt>선택 음소</dt><dd>{selectedPhone + 1}. {selectedTarget.grapheme} / {selectedTarget.ipa}</dd></div>
              <div><dt>내부 발음 ID</dt><dd><code>{selectedTarget.phone_id}</code></dd></div>
              <div><dt>후보</dt><dd>정확 {selectedExactCount} · 유사 {selectedApproximateCount - selectedFallbackCount} · 대체 {selectedFallbackCount}</dd></div>
            </dl>}
            {selectedTarget && !visibleCandidates.length && (
              <p>이 음소와 발음 특성이 충분히 가까운 구간이 현재 프로젝트의 분석 결과에 없습니다.</p>
            )}
            {selectedTarget && !selectedTarget.exact_available && visibleCandidates.length > 0 && (
              <p>동일한 음소는 없지만 비슷하게 들리는 한국어 음소 후보를 표시하고 있습니다.</p>
            )}
            {selectedFallbackCount > 0 && (
              <p className="diagnostic-warning">자연스러운 대응 후보가 없어 한국어 대체 발음을 표시합니다.</p>
            )}
            {missingCandidateCount > 0 && (
              <p className="diagnostic-warning">전체 음소 중 {missingCandidateCount}개는 배치 가능한 후보가 없습니다. 빨간 음소를 선택해 확인하세요.</p>
            )}
          </div>
          </div>

          <div className="candidate-list">
            {visibleCandidates.length ? visibleCandidates.map((candidate) => (
              <article
                key={candidate.candidate_id}
                className={`candidate ${candidate.match_status.toLowerCase()} ${candidate.fallback ? "fallback" : ""} ${activeCandidateId === candidate.candidate_id ? "playing" : ""}`}
                aria-current={activeCandidateId === candidate.candidate_id ? "true" : undefined}
                onPointerEnter={() => onPreparePreview(candidate)}
                onFocus={() => onPreparePreview(candidate)}
              >
                <i className="candidate-playing-mark" aria-hidden="true">▶</i>
                <div>
                  <div className="candidate-primary">
                    <strong>{candidate.target_ipa.join(" · ")}</strong>
                    <span>{(candidate.similarity * 100).toFixed(0)}%</span>
                    <span>{candidate.unit_type}</span>
                  </div>
                  <span className="candidate-source">{activeResult?.source_labels[candidate.source_id] ?? candidate.source_id}</span>
                  <span>입력 {candidate.target_start_index + 1}–{candidate.target_end_index} · 소스 {formatTime(candidate.source_start_ms)}–{formatTime(candidate.source_end_ms)}</span>
                  {candidate.match_status !== "EXACT" && (
                    <span className="approximation">
                      {candidate.fallback && <b className="fallback-label">대체 발음</b>}
                      {candidate.alignments.map((alignment) => (
                        `${alignment.operation} ${alignment.target_ipa ?? "∅"}→${alignment.source_ipa ?? "∅"}`
                      )).join(" · ")}
                    </span>
                  )}
                </div>
                <div className="candidate-actions">
                  <button onClick={() => {
                    setActiveCandidateId(candidate.candidate_id)
                    setSelectedPhone(candidate.target_start_index)
                    onPreview(candidate)
                  }}>{activeCandidateId === candidate.candidate_id ? "듣는 중" : "듣기"}</button>
                  <button onClick={() => addCandidate(candidate)}>배치</button>
                </div>
              </article>
            )) : <p className="muted">이 위치를 시작점으로 하는 후보가 없습니다.</p>}
          </div>
        </>
      )}

      </div>

      <div className={`assembly ${workspace === "ASSEMBLY" ? "active-workspace" : "hidden-workspace"}`}>
        <div className="quadrant-heading">
          <strong>COMPOSITION</strong>
          <div className="synthesis-mode-tabs" role="tablist" aria-label="합성 작업 전환">
            <button type="button" role="tab" aria-selected="false" onClick={() => setWorkspace("SEARCH")}>
              후보 찾기
            </button>
            <button type="button" role="tab" aria-selected="true">
              배치 편집 <span>{segments.length}</span>
            </button>
          </div>
        </div>
        <div className="assembly-toolbar">
          <div className="assembly-controls">
          <label className="control-field composition-name-field">
            <span>합성 이름</span>
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="control-field">
            <span>불러오기</span>
            <select value={compositionId} onChange={(event) => load(event.target.value)}>
              <option value="">새 합성</option>
              {compositions.filter((item) => item.mode === "SIMPLE").map((item) => (
                <option key={item.composition_id} value={item.composition_id}>{item.name}</option>
              ))}
            </select>
          </label>
          <label className="control-field compact-field">
            <span>크로스페이드 (ms)</span>
            <input
              type="number"
              min={0}
              max={100}
              value={crossfadeMs}
              onChange={(event) => {
                const value = Math.max(0, Math.min(100, Number(event.target.value)))
                setCrossfadeMs(value)
                setSegments(retimeCompositionSegments(segments.map((segment, index) => ({
                  ...segment,
                  gap_before_ms: index && segment.gap_before_ms === -crossfadeMs
                    ? -value : segment.gap_before_ms,
                })), "SIMPLE"))
              }}
            />
          </label>
          </div>
          <div className="assembly-actions">
            <button className="primary-action" disabled={busy} onClick={() => void save()}>합성 저장</button>
            <button disabled={busy || !segments.length} onClick={() => void playPreview()}>전체 미리 듣기</button>
          </div>
        </div>
        {previewUrl && <audio
          ref={previewAudioRef}
          className="assembly-preview"
          src={previewUrl}
          controls
          autoPlay
          aria-label="조립한 음성 미리 듣기"
        />}
        <div className="assembly-track">
          {segments.map((segment, index) => (
            <article
              key={segment.segment_id}
              className={segment.match_status.toLowerCase()}
            >
              {index > 0 && (
                <label className="segment-gap">
                  앞 Part와 간격 (ms)
                  <input
                    type="number"
                    min={-Math.min(
                      segment.timeline_end_ms - segment.timeline_start_ms,
                      segments[index - 1].timeline_end_ms - segments[index - 1].timeline_start_ms,
                    )}
                    value={segment.gap_before_ms}
                    onChange={(event) => {
                      const previous = segments[index - 1]
                      const maximumOverlap = Math.min(
                        segment.timeline_end_ms - segment.timeline_start_ms,
                        previous.timeline_end_ms - previous.timeline_start_ms,
                      )
                      const value = Math.max(-maximumOverlap, Math.round(Number(event.target.value)))
                      setSegments(retimeCompositionSegments(segments.map((item, itemIndex) => itemIndex === index
                        ? { ...item, gap_before_ms: value } : item), "SIMPLE"))
                    }}
                  />
                  <small>음수: 겹침 · 양수: 쉼</small>
                </label>
              )}
              <strong>{segment.target_ipa.join(" · ")}</strong>
              <label className="segment-stretch">
                음소 길이 (%)
                <input
                  type="number"
                  min={MIN_STRETCH_PERCENT}
                  max={MAX_STRETCH_PERCENT}
                  value={segment.stretch_percent}
                  onChange={(event) => {
                    const value = Math.max(MIN_STRETCH_PERCENT, Math.min(
                      MAX_STRETCH_PERCENT, Math.round(Number(event.target.value)),
                    ))
                    setSegments(retimeCompositionSegments(segments.map((item, itemIndex) => itemIndex === index
                      ? { ...item, stretch_percent: value } : item), "SIMPLE"))
                  }}
                />
              </label>
              <span>{formatTime(segment.timeline_start_ms)}–{formatTime(segment.timeline_end_ms)}</span>
              <span>{segment.match_status}</span>
              <div>
                <button onClick={() => changeOrder(index, -1)}>←</button>
                <button onClick={() => changeOrder(index, 1)}>→</button>
                <button onClick={() => {
                  const next = retimeCompositionSegments(segments.filter((_, item) => item !== index), "SIMPLE")
                  setSegments(next)
                }}>×</button>
              </div>
            </article>
          ))}
          {!segments.length && <span className="muted">후보의 배치 버튼을 눌러 타임라인을 만드세요.</span>}
        </div>
        <div className="export-row">
          {COLLAGE_EXPORT_TARGETS.map((target) => (
            <button
              key={target}
              disabled={busy || (!targetText.trim() && !compositionId)}
              onClick={() => void runExport(target)}
            >
              {target}
            </button>
          ))}
          {message && <span className="assembly-message"><strong>INFO</strong>{message}</span>}
          {listRefreshFailed && <button type="button" disabled={busy} onClick={() => void refreshCompositionList().then(() => setMessage("저장된 합성 목록을 새로고침했습니다.")).catch((error: Error) => setMessage(`목록 새로고침 실패: ${error.message}`))}>목록만 다시 불러오기</button>}
        </div>
        {exportProgress && <ExportProgress job={exportProgress} />}
      </div>
    </section>
  )
}

function candidateToPhoneUnits(candidate: UnitCandidate): PhoneUnit[] {
  return candidate.alignments.map((alignment) => ({
    phone_unit_id: `phone_${crypto.randomUUID()}`,
    operation: alignment.operation,
    target_index: alignment.target_index,
    target_phone_id: alignment.target_phone_id,
    target_ipa: alignment.target_ipa,
    source_occurrence_id: alignment.source_occurrence_id,
    source_phone_id: alignment.source_phone_id,
    source_ipa: alignment.source_ipa,
    source_start_ms: alignment.source_start_ms,
    source_end_ms: alignment.source_end_ms,
    output_duration_ms: defaultPhoneDuration(
      alignment.source_start_ms,
      alignment.source_end_ms,
    ),
    source_f0_hz: alignment.source_f0_hz,
    voiced_probability: alignment.voiced_probability,
    target_pitch_midi: alignment.source_f0_hz === null ? null : hzToMidi(alignment.source_f0_hz),
    target_pitch_strength_percent: PITCH_TARGET_STRENGTH_DEFAULT_PERCENT,
    formant_shift_semitones: 0,
    vibrato_depth_cents: PITCH_VIBRATO_DEPTH_DEFAULT_CENTS,
    vibrato_rate_hz: PITCH_VIBRATO_RATE_DEFAULT_HZ,
    vibrato_start_ms: PITCH_VIBRATO_START_DEFAULT_MS,
    transition_to_next_ms: PITCH_TRANSITION_DEFAULT_MS,
    transition_strength_percent: PITCH_TRANSITION_DEFAULT_STRENGTH,
    transition_center_ms: 0,
  }))
}

function defaultPhoneDuration(
  sourceStartMs: number | null,
  sourceEndMs: number | null,
): number {
  if (sourceStartMs === null || sourceEndMs === null) {
    return PROFESSIONAL_DEFAULT_MISSING_DURATION_MS
  }
  const sourceDuration = Math.max(1, sourceEndMs - sourceStartMs)
  return sourceDuration
}

function hzToMidi(frequencyHz: number): number {
  return 69 + 12 * Math.log2(frequencyHz / 440)
}
