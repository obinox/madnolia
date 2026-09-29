import { useEffect, useMemo, useRef, useState } from "react"

import {
  createComposition,
  cancelSearch,
  exportComposition,
  fetchCompositions,
  getSearchJob,
  previewComposition,
  startSearch,
  updateComposition,
} from "../api"
import {
  COLLAGE_EXPORT_TARGETS,
  MAX_STRETCH_PERCENT,
  MIN_STRETCH_PERCENT,
  PITCH_TRANSITION_DEFAULT_MS,
  PITCH_TRANSITION_DEFAULT_STRENGTH,
} from "../constants"
import type {
  CandidateSearchResult,
  CollagePanelProps,
  CompositionProject,
  CompositionMode,
  ExportTarget,
  InputLanguage,
  PhoneUnit,
  SaveCompositionRequest,
  SearchJob,
  TimelineSegment,
  UnitCandidate,
} from "../types"
import { formatTime } from "./Timeline"
import { ProfessionalEditor, reorderSegments } from "./ProfessionalEditor"

export function CollagePanel({ projectId, initialCompositionId, onPreview }: CollagePanelProps) {
  const [targetText, setTargetText] = useState("")
  const [inputLanguage, setInputLanguage] = useState<InputLanguage>("AUTO")
  const [result, setResult] = useState<CandidateSearchResult | null>(null)
  const [selectedPhone, setSelectedPhone] = useState(0)
  const [segments, setSegments] = useState<TimelineSegment[]>([])
  const [compositions, setCompositions] = useState<CompositionProject[]>([])
  const [compositionId, setCompositionId] = useState("")
  const [name, setName] = useState("새 오디오 합성")
  const [crossfadeMs, setCrossfadeMs] = useState(8)
  const [mode, setMode] = useState<CompositionMode>("SIMPLE")
  const [selectedSegmentId, setSelectedSegmentId] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [previewUrl, setPreviewUrl] = useState("")
  const [previewCurrentMs, setPreviewCurrentMs] = useState(0)
  const [searchProgress, setSearchProgress] = useState<SearchJob | null>(null)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  const previewController = useRef<AbortController | null>(null)
  const searchController = useRef<AbortController | null>(null)
  const searchJobId = useRef("")
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
    setPreviewCurrentMs(0)
  }, [projectId, segments, crossfadeMs, mode])

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  useEffect(() => {
    searchController.current?.abort()
    if (searchJobId.current) void cancelSearch(searchJobId.current).catch(() => undefined)
    searchController.current = null
    searchJobId.current = ""
    setSearchProgress(null)
    compositionsRequestId.current += 1
    setResult(null)
    setSegments([])
    setCompositionId("")
    setMode("SIMPLE")
    setSelectedSegmentId("")
    setMessage("")
    setBusy(false)
    setCompositions([])
    void reloadProjectCompositions(projectId).catch((error: Error) => {
      if (projectIdRef.current === projectId) setMessage(error.message)
    })
    return () => {
      compositionsRequestId.current += 1
      searchController.current?.abort()
      if (searchJobId.current) void cancelSearch(searchJobId.current).catch(() => undefined)
      searchJobId.current = ""
    }
  }, [projectId])

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
    setCrossfadeMs(selected.crossfade_ms)
    setSegments(selected.segments)
    setMode(selected.mode)
    setSelectedSegmentId(selected.segments[0]?.segment_id ?? "")
  }, [initialCompositionId, compositions, projectId])

  const visibleCandidates = useMemo(
    () => result?.candidates.filter(
      (candidate) => candidate.target_start_index === selectedPhone,
    ).slice(0, 40) ?? [],
    [result, selectedPhone],
  )

  const runSearch = async () => {
    if (!targetText.trim()) return
    searchController.current?.abort()
    const controller = new AbortController()
    searchController.current = controller
    setBusy(true)
    setSearchProgress(null)
    setMessage("")
    try {
      const { job_id } = await startSearch(projectId, targetText, inputLanguage, controller.signal)
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
      if (job.status === "failed" || !job.result) throw new Error(job.error ?? "Search failed")
      const next = job.result
      setResult(next)
      setSelectedPhone(0)
      setSegments([])
      setCompositionId("")
      setSelectedSegmentId("")
      setMessage(`${next.target_phones.length}개 음소 · ${next.candidates.length}개 후보`)
    } catch (error) {
      if (!controller.signal.aborted && projectIdRef.current === projectId) {
        setMessage(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (searchController.current === controller) {
        searchController.current = null
        searchJobId.current = ""
        if (projectIdRef.current === projectId) setBusy(false)
      }
    }
  }

  const stopSearch = async () => {
    const jobId = searchJobId.current
    searchController.current?.abort()
    if (jobId) await cancelSearch(jobId).catch(() => undefined)
    searchJobId.current = ""
    setBusy(false)
    setSearchProgress((current) => current ? { ...current, status: "cancelled", stage: "cancelled" } : current)
    setMessage("검색이 취소됐어요")
  }

  const addCandidate = (candidate: UnitCandidate) => {
    const previousEnd = segments.at(-1)?.timeline_end_ms ?? 0
    const start = Math.max(0, previousEnd - (segments.length ? crossfadeMs : 0))
    const phoneUnits = mode === "PROFESSIONAL" ? candidateToPhoneUnits(candidate) : []
    const duration = mode === "PROFESSIONAL"
      ? phoneUnits.reduce((total, unit) => total + unit.output_duration_ms, 0)
      : candidate.source_end_ms - candidate.source_start_ms
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
      },
    ]
    setSegments(retime(next, mode))
    setSelectedSegmentId(segmentId)
    setSelectedPhone(candidate.target_end_index)
  }

  const changeOrder = (index: number, offset: number) => {
    const destination = index + offset
    if (destination < 0 || destination >= segments.length) return
    const reordered = [...segments]
    ;[reordered[index], reordered[destination]] = [reordered[destination], reordered[index]]
    setSegments(retime(reordered, mode))
  }

  const convertToProfessional = () => {
    const converted = segments.map((segment, index) => ({
      ...segment,
      lane: index % 2,
      phone_units: segment.phone_units.length ? segment.phone_units : [legacyPhoneUnit(segment)],
    }))
    setMode("PROFESSIONAL")
    setCompositionId("")
    setName(`${name} (전문)`)
    setSegments(retime(converted, "PROFESSIONAL"))
    setSelectedSegmentId(converted[0]?.segment_id ?? "")
    setMessage("기존 합성을 전문 합성 복사본으로 변환했습니다.")
  }

  const updatePhoneUnit = (
    segmentId: string,
    phoneUnitId: string,
    updates: Partial<PhoneUnit>,
  ) => {
    setSegments(retime(segments.map((segment) => segment.segment_id === segmentId
      ? {
          ...segment,
          phone_units: segment.phone_units.map((unit) => unit.phone_unit_id === phoneUnitId
            ? { ...unit, ...updates } : unit),
        }
      : segment), mode))
  }

  const buildRequest = (): SaveCompositionRequest => {
    const current = compositions.find((item) => item.composition_id === compositionId)
    return {
      name,
      target_text: result?.target_text ?? current?.target_text ?? targetText,
      target_pronunciation: result?.target_pronunciation ?? current?.target_pronunciation ?? "",
      crossfade_ms: crossfadeMs,
      segments,
      mode,
      schema_version: 1,
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
        setPreviewCurrentMs(0)
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
    if (!result && !compositionId) {
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
    setCrossfadeMs(composition.crossfade_ms)
    setSegments(composition.segments)
    setMode(composition.mode)
    setSelectedSegmentId(composition.segments[0]?.segment_id ?? "")
    setResult(null)
    setMessage(`불러옴 · ${composition.updated_at}`)
  }

  const runExport = async (target: ExportTarget) => {
    if (!result && !compositionId) {
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
            {compositions.map((item) => (
              <option key={item.composition_id} value={item.composition_id}>{item.name}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="synthesis-search">
      <div className="search-row">
        <select
          aria-label="검색 입력 언어"
          value={inputLanguage}
          onChange={(event) => setInputLanguage(event.target.value as InputLanguage)}
        >
          <option value="AUTO">자동 감지</option>
          <option value="KO">한국어</option>
          <option value="EN">English</option>
          <option value="JA">日本語</option>
        </select>
        <textarea
          value={targetText}
          onChange={(event) => setTargetText(event.target.value)}
          placeholder="만들 문장을 입력하세요"
          rows={2}
        />
        <button disabled={busy || !targetText.trim()} onClick={() => void runSearch()}>
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

      {result && (
        <>
          <div className="pronunciation">
            {({ KO: "한국어", EN: "English", JA: "日本語", AUTO: "자동" })[result.input_language]} 발음형
            <strong>{result.target_pronunciation}</strong>
          </div>
          <div className="phone-strip">
            {result.target_phones.map((phone) => (
              <button
                key={phone.target_index}
                className={`${selectedPhone === phone.target_index ? "selected" : ""} ${phone.exact_available ? "" : "missing"}`}
                onClick={() => setSelectedPhone(phone.target_index)}
                title={phone.exact_available ? phone.phone_id : `${phone.phone_id} · 정확 후보 없음`}
              >
                <span>{phone.grapheme}</span>
                <strong>{phone.ipa}</strong>
                {!phone.exact_available && <small>유사</small>}
              </button>
            ))}
          </div>

          <div className="candidate-list">
            {visibleCandidates.length ? visibleCandidates.map((candidate) => (
              <article key={candidate.candidate_id} className={`candidate ${candidate.match_status.toLowerCase()}`}>
                <div>
                  <strong>{candidate.target_ipa.join(" · ")}</strong>
                  <span className="candidate-source">{result.source_labels[candidate.source_id] ?? candidate.source_id}</span>
                  <span>
                    입력 {candidate.target_start_index + 1}–{candidate.target_end_index} · {candidate.unit_type}
                  </span>
                  <span>
                    소스 {formatTime(candidate.source_start_ms)}–{formatTime(candidate.source_end_ms)} · {(candidate.similarity * 100).toFixed(0)}%
                  </span>
                  {candidate.match_status !== "EXACT" && (
                    <span className="approximation">
                      {candidate.alignments.map((alignment) => (
                        `${alignment.operation} ${alignment.target_ipa ?? "∅"}→${alignment.source_ipa ?? "∅"}`
                      )).join(" · ")}
                    </span>
                  )}
                </div>
                <div className="candidate-actions">
                  <button onClick={() => onPreview(candidate)}>듣기</button>
                  <button onClick={() => addCandidate(candidate)}>배치</button>
                </div>
              </article>
            )) : <p className="muted">이 위치를 시작점으로 하는 후보가 없습니다.</p>}
          </div>
        </>
      )}

      </div>

      <div className="assembly">
        <div className="assembly-toolbar">
          <input value={name} onChange={(event) => setName(event.target.value)} aria-label="프로젝트 이름" />
          <label>
            불러오기
            <select value={compositionId} onChange={(event) => load(event.target.value)}>
              <option value="">새 합성</option>
              {compositions.map((item) => (
                <option key={item.composition_id} value={item.composition_id}>{item.name}</option>
              ))}
            </select>
          </label>
          <label>
            편집 모드
            <select
              value={mode}
              disabled={segments.length > 0}
              onChange={(event) => setMode(event.target.value as CompositionMode)}
            >
              <option value="SIMPLE">단순 합성</option>
              <option value="PROFESSIONAL">전문 합성</option>
            </select>
          </label>
          {mode === "SIMPLE" && segments.length > 0 && (
            <button onClick={convertToProfessional}>전문 합성으로 복사</button>
          )}
          <label>
            Crossfade ms
            <input
              type="number"
              min={0}
              max={100}
              value={crossfadeMs}
              onChange={(event) => {
                const value = Math.max(0, Math.min(100, Number(event.target.value)))
                setCrossfadeMs(value)
                setSegments(retime(segments.map((segment, index) => ({
                  ...segment,
                  gap_before_ms: index && segment.gap_before_ms === -crossfadeMs
                    ? -value : segment.gap_before_ms,
                })), mode))
              }}
            />
          </label>
          <button disabled={busy} onClick={() => void save()}>합성 저장</button>
          <button disabled={busy || !segments.length} onClick={() => void playPreview()}>전체 미리 듣기</button>
        </div>
        {previewUrl && <audio
          ref={previewAudioRef}
          className="assembly-preview"
          src={previewUrl}
          controls
          autoPlay
          aria-label="조립한 음성 미리 듣기"
          onTimeUpdate={(event) => setPreviewCurrentMs(event.currentTarget.currentTime * 1000)}
          onSeeked={(event) => setPreviewCurrentMs(event.currentTarget.currentTime * 1000)}
        />}
        {mode === "PROFESSIONAL" && segments.length > 0 && (
          <ProfessionalEditor
            segments={segments}
            selectedSegmentId={selectedSegmentId}
            playheadMs={previewCurrentMs}
            onSelectSegment={setSelectedSegmentId}
            onPlayheadChange={(timeMs) => {
              setPreviewCurrentMs(timeMs)
              if (previewAudioRef.current && Number.isFinite(previewAudioRef.current.duration)) {
                previewAudioRef.current.currentTime = Math.max(0, Math.min(
                  previewAudioRef.current.duration,
                  timeMs / 1000,
                ))
              }
            }}
            onUpdatePhone={updatePhoneUnit}
            onUpdateSegment={(segmentId, updates) => setSegments(retime(segments.map((segment) => {
              if (segment.segment_id !== segmentId) return segment
              const phoneUnits = [...segment.phone_units]
              if (updates.source_start_ms !== undefined && phoneUnits[0] && phoneUnits[0].source_start_ms !== null) {
                phoneUnits[0] = { ...phoneUnits[0], source_start_ms: updates.source_start_ms }
              }
              if (updates.source_end_ms !== undefined && phoneUnits.length) {
                const last = phoneUnits.length - 1
                if (phoneUnits[last].source_end_ms !== null) {
                  phoneUnits[last] = { ...phoneUnits[last], source_end_ms: updates.source_end_ms }
                }
              }
              return { ...segment, ...updates, phone_units: phoneUnits }
            }), mode))}
            onReorderSegment={(sourceId, destinationId) => setSegments(retime(reorderSegments(segments, sourceId, destinationId), mode))}
            onChangeOrder={(segmentId, offset) => changeOrder(segments.findIndex((segment) => segment.segment_id === segmentId), offset)}
            onDeleteSegment={(segmentId) => {
              const next = retime(segments.filter((segment) => segment.segment_id !== segmentId), mode)
              setSegments(next)
              setSelectedSegmentId(next[0]?.segment_id ?? "")
            }}
          />
        )}
        {mode === "SIMPLE" && <div className="assembly-track">
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
                      setSegments(retime(segments.map((item, itemIndex) => itemIndex === index
                        ? { ...item, gap_before_ms: value } : item), mode))
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
                    setSegments(retime(segments.map((item, itemIndex) => itemIndex === index
                      ? { ...item, stretch_percent: value } : item), mode))
                  }}
                />
              </label>
              <span>{formatTime(segment.timeline_start_ms)}–{formatTime(segment.timeline_end_ms)}</span>
              <span>{segment.match_status}</span>
              <div>
                <button onClick={() => changeOrder(index, -1)}>←</button>
                <button onClick={() => changeOrder(index, 1)}>→</button>
                <button onClick={() => {
                  const next = retime(segments.filter((_, item) => item !== index), mode)
                  setSegments(next)
                  setSelectedSegmentId(next[Math.min(index, next.length - 1)]?.segment_id ?? "")
                }}>×</button>
              </div>
            </article>
          ))}
          {!segments.length && <span className="muted">후보의 배치 버튼을 눌러 타임라인을 만드세요.</span>}
        </div>}
        <div className="export-row">
          {COLLAGE_EXPORT_TARGETS.map((target) => (
            <button
              key={target}
              disabled={busy || (!result && !compositionId)}
              onClick={() => void runExport(target)}
            >
              {target}
            </button>
          ))}
          {message && <span>{message}</span>}
        </div>
      </div>
    </section>
  )
}

function retime(segments: TimelineSegment[], mode: CompositionMode): TimelineSegment[] {
  let cursor = 0
  const timelineEnds: number[] = []
  return segments.map((segment, index) => {
    const duration = segmentDuration(segment, mode)
    const previousDuration = index
      ? segmentDuration(segments[index - 1], mode) : duration
    const gap = index ? Math.max(-Math.min(duration, previousDuration), segment.gap_before_ms) : 0
    const previousEnd = cursor
    const earliestStart = mode === "PROFESSIONAL" && index > 1
      ? timelineEnds[index - 2] : 0
    const start = Math.max(earliestStart, cursor + gap)
    cursor = start + duration
    timelineEnds.push(cursor)
    return {
      ...segment,
      lane: index % 2,
      gap_before_ms: index ? start - previousEnd : 0,
      timeline_start_ms: start,
      timeline_end_ms: cursor,
    }
  })
}

function segmentDuration(segment: TimelineSegment, mode: CompositionMode): number {
  return mode === "PROFESSIONAL"
    ? segment.phone_units.reduce((total, unit) => total + unit.output_duration_ms, 0)
    : Math.round((segment.source_end_ms - segment.source_start_ms) * segment.stretch_percent / 100)
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
    output_duration_ms: alignment.source_start_ms !== null && alignment.source_end_ms !== null
      ? alignment.source_end_ms - alignment.source_start_ms : 0,
    source_f0_hz: alignment.source_f0_hz,
    voiced_probability: alignment.voiced_probability,
    target_pitch_midi: alignment.source_f0_hz === null ? null : hzToMidi(alignment.source_f0_hz),
    formant_shift_semitones: 0,
    transition_to_next_ms: PITCH_TRANSITION_DEFAULT_MS,
    transition_strength_percent: PITCH_TRANSITION_DEFAULT_STRENGTH,
    transition_center_ms: 0,
  }))
}

function legacyPhoneUnit(segment: TimelineSegment): PhoneUnit {
  return {
    phone_unit_id: `phone_${crypto.randomUUID()}`,
    operation: segment.match_status === "EXACT" ? "MATCH" : "SUBSTITUTE",
    target_index: segment.target_start_index,
    target_phone_id: null,
    target_ipa: segment.target_ipa.join(" "),
    source_occurrence_id: null,
    source_phone_id: null,
    source_ipa: segment.matched_ipa.join(" "),
    source_start_ms: segment.source_start_ms,
    source_end_ms: segment.source_end_ms,
    output_duration_ms: segment.timeline_end_ms - segment.timeline_start_ms,
    source_f0_hz: null,
    voiced_probability: 0,
    target_pitch_midi: null,
    formant_shift_semitones: 0,
    transition_to_next_ms: PITCH_TRANSITION_DEFAULT_MS,
    transition_strength_percent: PITCH_TRANSITION_DEFAULT_STRENGTH,
    transition_center_ms: 0,
  }
}

function hzToMidi(frequencyHz: number): number {
  return 69 + 12 * Math.log2(frequencyHz / 440)
}
