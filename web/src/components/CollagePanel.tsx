import { useEffect, useMemo, useRef, useState } from "react"

import {
  createComposition,
  exportComposition,
  fetchCompositions,
  previewComposition,
  searchCandidates,
  updateComposition,
} from "../api"
import { MAX_STRETCH_PERCENT, MIN_STRETCH_PERCENT } from "../constants"
import type {
  CandidateSearchResult,
  CollagePanelProps,
  CompositionProject,
  ExportTarget,
  SaveCompositionRequest,
  TimelineSegment,
  UnitCandidate,
} from "../types"
import { formatTime } from "./Timeline"

const EXPORT_TARGETS: ExportTarget[] = ["WAV", "MP4", "JSON", "EDL", "FCPXML"]

export function CollagePanel({ projectId, initialCompositionId, onPreview }: CollagePanelProps) {
  const [targetText, setTargetText] = useState("")
  const [result, setResult] = useState<CandidateSearchResult | null>(null)
  const [selectedPhone, setSelectedPhone] = useState(0)
  const [segments, setSegments] = useState<TimelineSegment[]>([])
  const [compositions, setCompositions] = useState<CompositionProject[]>([])
  const [compositionId, setCompositionId] = useState("")
  const [name, setName] = useState("새 오디오 콜라주")
  const [crossfadeMs, setCrossfadeMs] = useState(8)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [previewUrl, setPreviewUrl] = useState("")
  const previewController = useRef<AbortController | null>(null)

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
    setResult(null)
    setSegments([])
    setCompositionId("")
    setMessage("")
    void reloadCompositions(projectId, setCompositions)
  }, [projectId])

  useEffect(() => {
    const selected = compositions.find((item) => item.composition_id === initialCompositionId)
    if (!selected) return
    setCompositionId(selected.composition_id)
    setName(selected.name)
    setTargetText(selected.target_text)
    setCrossfadeMs(selected.crossfade_ms)
    setSegments(selected.segments)
  }, [initialCompositionId, compositions])

  const visibleCandidates = useMemo(
    () => result?.candidates.filter(
      (candidate) => candidate.target_start_index === selectedPhone,
    ).slice(0, 40) ?? [],
    [result, selectedPhone],
  )

  const runSearch = async () => {
    if (!targetText.trim()) return
    setBusy(true)
    setMessage("")
    try {
      const next = await searchCandidates(projectId, targetText)
      setResult(next)
      setSelectedPhone(0)
      setSegments([])
      setCompositionId("")
      setMessage(`${next.target_phones.length}개 음소 · ${next.candidates.length}개 후보`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const addCandidate = (candidate: UnitCandidate) => {
    const previousEnd = segments.at(-1)?.timeline_end_ms ?? 0
    const start = Math.max(0, previousEnd - (segments.length ? crossfadeMs : 0))
    const duration = candidate.source_end_ms - candidate.source_start_ms
    setSegments([
      ...segments,
      {
        segment_id: `seg_${crypto.randomUUID()}`,
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
      },
    ])
    setSelectedPhone(candidate.target_end_index)
  }

  const changeOrder = (index: number, offset: number) => {
    const destination = index + offset
    if (destination < 0 || destination >= segments.length) return
    const reordered = [...segments]
    ;[reordered[index], reordered[destination]] = [reordered[destination], reordered[index]]
    setSegments(retime(reordered))
  }

  const buildRequest = (): SaveCompositionRequest => {
    const current = compositions.find((item) => item.composition_id === compositionId)
    return {
      name,
      target_text: result?.target_text ?? current?.target_text ?? targetText,
      target_pronunciation: result?.target_pronunciation ?? current?.target_pronunciation ?? "",
      crossfade_ms: crossfadeMs,
      segments,
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
      if (!controller.signal.aborted) setPreviewUrl(URL.createObjectURL(blob))
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      if (previewController.current === controller) {
        previewController.current = null
        setBusy(false)
      }
    }
  }

  const save = async () => {
    if (!result && !compositionId) {
      setMessage("먼저 문장을 검색하세요.")
      return
    }
    setBusy(true)
    try {
      const body = buildRequest()
      const saved = compositionId
        ? await updateComposition(compositionId, body)
        : await createComposition(projectId, body)
      setCompositionId(saved.composition_id)
      await reloadCompositions(projectId, setCompositions)
      setMessage(`저장됨 · ${saved.composition_id}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
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
    setResult(null)
    setMessage(`불러옴 · ${composition.updated_at}`)
  }

  const runExport = async (target: ExportTarget) => {
    if (!compositionId) {
      setMessage("먼저 조립 프로젝트를 저장하세요.")
      return
    }
    setBusy(true)
    try {
      await exportComposition(compositionId, target)
      setMessage(`${target} 익스포트 완료`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="collage panel">
      <div className="collage-heading">
        <div>
          <p className="section-label">AUDIO COLLAGE</p>
          <h2>음소 후보 탐색과 배치</h2>
        </div>
        <label>
          저장된 콜라주
          <select value={compositionId} onChange={(event) => load(event.target.value)}>
            <option value="">새 콜라주</option>
            {compositions.map((item) => (
              <option key={item.composition_id} value={item.composition_id}>{item.name}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="search-row">
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

      {result && (
        <>
          <div className="pronunciation">발음형 <strong>{result.target_pronunciation}</strong></div>
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
                  <span>
                    입력 {candidate.target_start_index + 1}–{candidate.target_end_index} · {candidate.unit_type}
                  </span>
                  <span>
                    소스 {formatTime(candidate.source_start_ms)}–{formatTime(candidate.source_end_ms)} · {(candidate.similarity * 100).toFixed(0)}%
                  </span>
                  {candidate.match_status !== "EXACT" && (
                    <span className="approximation">대체 {candidate.matched_ipa.join(" · ")}</span>
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

      <div className="assembly">
        <div className="assembly-toolbar">
          <input value={name} onChange={(event) => setName(event.target.value)} aria-label="프로젝트 이름" />
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
                }))))
              }}
            />
          </label>
          <button disabled={busy} onClick={() => void save()}>콜라주 저장</button>
          <button disabled={busy || !segments.length} onClick={() => void playPreview()}>전체 미리 듣기</button>
        </div>
        {previewUrl && <audio className="assembly-preview" src={previewUrl} controls autoPlay aria-label="조립한 음성 미리 듣기" />}
        <div className="assembly-track">
          {segments.map((segment, index) => (
            <article key={segment.segment_id} className={segment.match_status.toLowerCase()}>
              {index > 0 && (
                <label className="segment-gap">
                  앞 음소와 간격 (ms)
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
                        ? { ...item, gap_before_ms: value } : item)))
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
                      ? { ...item, stretch_percent: value } : item)))
                  }}
                />
              </label>
              <span>{formatTime(segment.timeline_start_ms)}–{formatTime(segment.timeline_end_ms)}</span>
              <span>{segment.match_status}</span>
              <div>
                <button onClick={() => changeOrder(index, -1)}>←</button>
                <button onClick={() => changeOrder(index, 1)}>→</button>
                <button onClick={() => setSegments(retime(segments.filter((_, item) => item !== index)))}>×</button>
              </div>
            </article>
          ))}
          {!segments.length && <span className="muted">후보의 배치 버튼을 눌러 타임라인을 만드세요.</span>}
        </div>
        <div className="export-row">
          {EXPORT_TARGETS.map((target) => (
            <button key={target} disabled={busy || !compositionId} onClick={() => void runExport(target)}>
              {target}
            </button>
          ))}
          {message && <span>{message}</span>}
        </div>
      </div>
    </section>
  )
}

function retime(segments: TimelineSegment[]): TimelineSegment[] {
  let cursor = 0
  return segments.map((segment, index) => {
    const duration = Math.round(
      (segment.source_end_ms - segment.source_start_ms) * segment.stretch_percent / 100,
    )
    const previousDuration = index
      ? Math.round(
        (segments[index - 1].source_end_ms - segments[index - 1].source_start_ms)
          * segments[index - 1].stretch_percent / 100,
      ) : duration
    const gap = index ? Math.max(-Math.min(duration, previousDuration), segment.gap_before_ms) : 0
    const start = Math.max(0, cursor + gap)
    cursor = start + duration
    return { ...segment, gap_before_ms: index ? gap : 0, timeline_start_ms: start, timeline_end_ms: cursor }
  })
}

async function reloadCompositions(
  projectId: string,
  apply: (items: CompositionProject[]) => void,
): Promise<void> {
  apply(await fetchCompositions(projectId))
}
