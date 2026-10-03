import { useEffect, useMemo, useRef, useState } from "react"

import { cancelSearch, getSearchJob, startSearch } from "../api/search"
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
} from "../constants"
import type {
  CandidateSearchResult,
  CandidateSearchTab,
  CollagePanelProps,
  CompositionDraft,
  CompositionProject,
  ExportTarget,
  InputLanguage,
  PhoneUnit,
  SaveCompositionRequest,
  SearchJob,
  SynthesisWorkspace,
  TimelineSegment,
  UnitCandidate,
} from "../types"
import { retimeCompositionSegments } from "../composition"
import { formatTime } from "./Timeline"

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
  const [searchError, setSearchError] = useState("")
  const [previewUrl, setPreviewUrl] = useState("")
  const [searchProgress, setSearchProgress] = useState<SearchJob | null>(null)
  const [draftProjectId, setDraftProjectId] = useState("")
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  const previewController = useRef<AbortController | null>(null)
  const searchController = useRef<AbortController | null>(null)
  const searchJobId = useRef("")
  const searchBusyRef = useRef(false)
  const projectIdRef = useRef(projectId)
  const compositionsRequestId = useRef(0)
  const appliedInitialCompositionKey = useRef("")
  projectIdRef.current = projectId

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
    setDraftProjectId("")
    searchController.current?.abort()
    if (searchJobId.current) void cancelSearch(searchJobId.current).catch(() => undefined)
    searchController.current = null
    searchJobId.current = ""
    searchBusyRef.current = false
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
          && Array.isArray(draft.segments)
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
      window.localStorage.removeItem(`${COMPOSITION_DRAFT_STORAGE_PREFIX}${projectId}`)
    }
    setDraftProjectId(projectId)
    void reloadProjectCompositions(projectId).catch((error: Error) => {
      if (projectIdRef.current === projectId) setMessage(error.message)
    })
    return () => {
      compositionsRequestId.current += 1
      searchController.current?.abort()
      if (searchJobId.current) void cancelSearch(searchJobId.current).catch(() => undefined)
      searchJobId.current = ""
      searchBusyRef.current = false
    }
  }, [projectId])

  useEffect(() => {
    if (draftProjectId !== projectId) return
    const storageKey = `${COMPOSITION_DRAFT_STORAGE_PREFIX}${projectId}`
    const timer = window.setTimeout(() => {
      if (!targetText.trim() && !segments.length && !compositionId) {
        window.localStorage.removeItem(storageKey)
        return
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
  const selectedTarget = result?.target_phones[selectedPhone] ?? null
  const selectedExactCount = visibleCandidates.filter(
    (candidate) => candidate.match_status === "EXACT",
  ).length
  const selectedApproximateCount = visibleCandidates.length - selectedExactCount
  const selectedFallbackCount = visibleCandidates.filter((candidate) => candidate.fallback).length
  const missingCandidateCount = result?.target_phones.filter((phone) => !result.candidates.some(
    (candidate) => candidate.target_start_index === phone.target_index,
  )).length ?? 0

  const runSearch = async (searchTab: CandidateSearchTab = "EXACT") => {
    if (!targetText.trim() || searchBusyRef.current) return
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
      const { job_id } = await startSearch(
        projectId,
        targetText,
        inputLanguage,
        searchTab === "EXACT"
          ? EXACT_SEARCH_CANDIDATES_PER_PHONE
          : APPROXIMATE_SEARCH_CANDIDATES_PER_PHONE,
        searchTab === "EXACT",
        searchTab === "APPROXIMATE",
        controller.signal,
      )
      searchJobId.current = job_id
      if (controller.signal.aborted) {
        await cancelSearch(job_id).catch(() => undefined)
        return
      }
      let job: SearchJob
      do {
        job = await getSearchJob(job_id, controller.signal)
        if (projectIdRef.current !== projectId || controller.signal.aborted) return
        setSearchProgress(job)
        if (job.status === "running") await new Promise((resolve) => window.setTimeout(resolve, 250))
      } while (job.status === "running")
      if (projectIdRef.current !== projectId) return
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
        setSegments([])
        setCompositionId("")
        setMessage(`${next.target_phones.length}개 음소 · 정확 후보 ${next.candidates.length}개`)
      } else {
        setApproximateResult(next)
        setMessage(`유사 후보 ${next.candidates.length}개`)
      }
    } catch (error) {
      if (!controller.signal.aborted && projectIdRef.current === projectId) {
        const detail = error instanceof Error ? error.message : String(error)
        setSearchError(detail)
        setMessage(detail)
      }
    } finally {
      if (searchController.current === controller) {
        searchController.current = null
        searchJobId.current = ""
        searchBusyRef.current = false
        if (projectIdRef.current === projectId) setBusy(false)
      }
    }
  }

  const stopSearch = async () => {
    const jobId = searchJobId.current
    searchController.current?.abort()
    if (jobId) await cancelSearch(jobId).catch(() => undefined)
    searchJobId.current = ""
    searchBusyRef.current = false
    setBusy(false)
    setSearchProgress((current) => current ? { ...current, status: "cancelled", stage: "cancelled" } : current)
    setMessage("검색이 취소됐어요")
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
    }
  }

  const persistComposition = async (): Promise<CompositionProject> => {
    const body = buildRequest()
    const saved = compositionId
      ? await updateComposition(compositionId, body)
      : await createComposition(projectId, body)
    if (projectIdRef.current === projectId) setCompositionId(saved.composition_id)
    await reloadProjectCompositions(projectId)
    return saved
  }

  const save = async () => {
    if (!targetText.trim() && !compositionId) {
      setMessage("먼저 문장을 검색하세요.")
      return
    }
    setBusy(true)
    setMessage("")
    try {
      const saved = await persistComposition()
      if (projectIdRef.current === projectId) setMessage(`저장됨 · ${saved.composition_id}`)
    } catch (error) {
      if (projectIdRef.current === projectId) {
        setMessage(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (projectIdRef.current === projectId) setBusy(false)
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
    setBusy(true)
    setMessage("")
    try {
      const saved = await persistComposition()
      await exportComposition(saved.composition_id, target)
      if (projectIdRef.current === projectId) setMessage(`${target} 익스포트 완료`)
    } catch (error) {
      if (projectIdRef.current === projectId) {
        setMessage(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (projectIdRef.current === projectId) setBusy(false)
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
            corpus: "영상 음소 불러오기",
            phonetic: "발음 음소 변환",
            exact: "정확 일치 검색",
            approximate: "유사 발음 검색",
            sorting: "검색 결과 정렬",
          } as Record<string, string>)[searchProgress.stage] ?? searchProgress.stage}</span>
          <strong>{Math.floor(searchProgress.percent)}%</strong>
        </div>
        <progress max={100} value={searchProgress.percent} aria-label="Search progress" />
        <button onClick={() => void stopSearch()}>취소</button>
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
        </div>
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
    formant_shift_semitones: 0,
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
