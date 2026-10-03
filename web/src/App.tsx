import { useEffect, useMemo, useRef, useState } from "react"

import { fetchCollage, fetchProject, fetchProjects, fetchTimeline, fetchWaveform, audioUrl, fetchAudioBlob } from "./api/projects"
import {
  PHONE_DETAIL_MAX_MS,
  PLAYBACK_LOOP_EPSILON_MS,
  SOURCE_TIMELINE_FETCH_DEBOUNCE_MS,
  WAVEFORM_BINS,
  WORD_DETAIL_MAX_MS,
} from "./constants"
import { Timeline, formatTime } from "./components/Timeline"
import { CollagePanel } from "./components/CollagePanel"
import { AnalysisPage } from "./components/AnalysisPage"
import { ProjectsPage } from "./components/ProjectsPage"
import { ProfessionalSynthesisPage } from "./components/ProfessionalSynthesisPage"
import type {
  ProjectDetail,
  ProjectSummary,
  PhoneCache,
  TimelineSelection,
  TimelineSlice,
  UnitCandidate,
  WaveformData,
  WorkflowPage,
} from "./types"

export default function App() {
  const audioRefs = useRef<Map<string, HTMLAudioElement>>(new Map())
  const playbackFrameRef = useRef<number | null>(null)
  const waveformRequestRef = useRef(0)
  const loopSelectionRef = useRef(false)
  const selectionRef = useRef<TimelineSelection | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [page, setPage] = useState<WorkflowPage>("analysis")
  const [projectId, setProjectId] = useState("")
  const [requestedCollageId, setRequestedCollageId] = useState("")
  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [sourceId, setSourceId] = useState("")
  const [audioObjectUrls, setAudioObjectUrls] = useState<Record<string, string>>({})
  const [audioCacheCount, setAudioCacheCount] = useState(0)
  const [audioCacheProcessedCount, setAudioCacheProcessedCount] = useState(0)
  const [transcriptCandidateId, setTranscriptCandidateId] = useState("")
  const [viewStartMs, setViewStartMs] = useState(0)
  const [viewEndMs, setViewEndMs] = useState(1)
  const [currentMs, setCurrentMs] = useState(0)
  const [waveform, setWaveform] = useState<WaveformData | null>(null)
  const [waveformLoading, setWaveformLoading] = useState(false)
  const [phoneCache, setPhoneCache] = useState<PhoneCache | null>(null)
  const [selection, setSelection] = useState<TimelineSelection | null>(null)
  const [loopSelection, setLoopSelection] = useState(false)
  const [pendingCandidate, setPendingCandidate] = useState<UnitCandidate | null>(null)
  const [error, setError] = useState("")
  const audioObjectUrlsRef = useRef<string[]>([])

  const activeAudio = () => audioRefs.current.get(sourceId) ?? null

  const prepareSourceAudio = (nextSourceId: string) => {
    const audio = audioRefs.current.get(nextSourceId)
    if (audio && audio.readyState < 2) audio.load()
  }

  const source = project?.manifest.sources.find((item) => item.source_id === sourceId) ?? null
  const analysis = project?.analyses.find((item) => item.source_id === sourceId) ?? null
  const transcriptCandidate = analysis?.transcript_candidates.find(
    (candidate) => candidate.candidate_id === transcriptCandidateId,
  ) ?? null
  const displayedWords = transcriptCandidate?.words ?? analysis?.words ?? []
  const durationMs = source?.duration_ms ?? 1
  const viewSpan = viewEndMs - viewStartMs

  const openProject = (id: string, destination: "collage" | "professional" = "collage") => {
    setRequestedCollageId("")
    setProjectId(id)
    window.location.hash = `#/${destination}/${encodeURIComponent(id)}`
  }

  useEffect(() => {
    let routeRequestId = 0
    const syncPage = () => {
      const currentRequestId = ++routeRequestId
      const hash = window.location.hash
      if (hash.startsWith("#/collages/")) {
        const id = decodeURIComponent(hash.slice("#/collages/".length))
        setRequestedCollageId(id)
        setProjectId("")
        fetchCollage(id).then((collage) => {
          if (currentRequestId === routeRequestId) {
            setProjectId(collage.corpus_project_id)
            setPage(collage.mode === "PROFESSIONAL" ? "professional" : "collage")
          }
        }).catch((caught: Error) => {
          if (currentRequestId === routeRequestId) setError(caught.message)
        })
      } else if (hash.startsWith("#/collage/")) {
        setRequestedCollageId("")
        setProjectId(decodeURIComponent(hash.slice("#/collage/".length)))
        setPage("collage")
      } else if (hash.startsWith("#/professional/")) {
        setRequestedCollageId("")
        setProjectId(decodeURIComponent(hash.slice("#/professional/".length)))
        setPage("professional")
      } else if (hash === "#/projects") {
        setPage("projects")
      } else {
        setPage("analysis")
        if (hash !== "#/analysis") window.location.hash = "#/analysis"
      }
    }
    syncPage()
    window.addEventListener("hashchange", syncPage)
    return () => {
      routeRequestId += 1
      window.removeEventListener("hashchange", syncPage)
    }
  }, [])

  useEffect(() => {
    selectionRef.current = selection
  }, [selection])

  useEffect(() => {
    loopSelectionRef.current = loopSelection
  }, [loopSelection])

  useEffect(() => () => {
    if (playbackFrameRef.current !== null) {
      window.cancelAnimationFrame(playbackFrameRef.current)
    }
  }, [])

  useEffect(() => {
    fetchProjects()
      .then(setProjects)
      .catch((caught: Error) => setError(caught.message))
  }, [])

  useEffect(() => {
    setProject(null)
    setSourceId("")
    setAudioObjectUrls({})
    setAudioCacheCount(0)
    setAudioCacheProcessedCount(0)
    if (!projectId) return
    let active = true
    setError("")
    fetchProject(projectId)
      .then((detail) => {
        if (!active) return
        setProject(detail)
        const firstSource = detail.manifest.sources[0]
        if (firstSource) {
          setSourceId(firstSource.source_id)
          setTranscriptCandidateId(detail.analyses[0]?.transcript_candidates[0]?.candidate_id ?? "")
          setViewStartMs(0)
          setViewEndMs(firstSource.duration_ms)
          setCurrentMs(0)
          setSelection(null)
          setLoopSelection(false)
          selectionRef.current = null
          loopSelectionRef.current = false
          setPhoneCache(null)
        }
      })
      .catch((caught: Error) => { if (active) setError(caught.message) })
    return () => { active = false }
  }, [projectId])

  useEffect(() => {
    if (!projectId || !project) return
    const controller = new AbortController()
    let active = true
    for (const url of audioObjectUrlsRef.current) URL.revokeObjectURL(url)
    audioObjectUrlsRef.current = []
    setAudioObjectUrls({})
    setAudioCacheCount(0)
    setAudioCacheProcessedCount(0)
    void Promise.all(project.manifest.sources.map(async (sourceItem) => {
      try {
        const blob = await fetchAudioBlob(projectId, sourceItem.source_id, controller.signal)
        if (!active) return
        const url = URL.createObjectURL(blob)
        audioObjectUrlsRef.current.push(url)
        setAudioObjectUrls((current) => ({ ...current, [sourceItem.source_id]: url }))
        setAudioCacheCount((current) => current + 1)
      } catch (caught) {
        if (caught instanceof Error && caught.name !== "AbortError" && active) {
          setError(caught.message)
        }
      } finally {
        if (active) setAudioCacheProcessedCount((current) => current + 1)
      }
    }))
    return () => {
      active = false
      controller.abort()
    }
  }, [project, projectId])

  useEffect(() => () => {
    for (const url of audioObjectUrlsRef.current) URL.revokeObjectURL(url)
  }, [])

  useEffect(() => {
    audioRefs.current.forEach((audio, id) => {
      if (id !== sourceId && !audio.paused) audio.pause()
    })
  }, [sourceId])

  useEffect(() => {
    if (!analysis?.transcript_candidates.length) {
      setTranscriptCandidateId("")
      return
    }
    if (!analysis.transcript_candidates.some(
      (candidate) => candidate.candidate_id === transcriptCandidateId,
    )) {
      setTranscriptCandidateId(analysis.transcript_candidates[0].candidate_id)
    }
  }, [analysis, transcriptCandidateId])

  useEffect(() => {
    if (!pendingCandidate || pendingCandidate.source_id !== sourceId) return
    const audio = activeAudio()
    if (!audio) return
    const playCandidate = () => {
      audio.currentTime = pendingCandidate.source_start_ms / 1000
      setCurrentMs(pendingCandidate.source_start_ms)
      void audio.play()
      setPendingCandidate(null)
    }
    if (audio.readyState >= 1) {
      playCandidate()
      return
    }
    audio.addEventListener("loadedmetadata", playCandidate, { once: true })
    return () => audio.removeEventListener("loadedmetadata", playCandidate)
  }, [pendingCandidate, sourceId])

  useEffect(() => {
    const requestId = ++waveformRequestRef.current
    setWaveform(null)
    if (!projectId || !sourceId || viewEndMs <= viewStartMs) {
      setWaveformLoading(false)
      return
    }
    const controller = new AbortController()
    setWaveformLoading(true)
    const timer = window.setTimeout(() => {
      fetchWaveform(projectId, sourceId, viewStartMs, viewEndMs, WAVEFORM_BINS, controller.signal)
        .then((nextWaveform) => {
          if (waveformRequestRef.current === requestId) setWaveform(nextWaveform)
        })
        .catch((caught: Error) => {
          if (caught.name !== "AbortError") setError(caught.message)
        })
        .finally(() => {
          if (waveformRequestRef.current === requestId) setWaveformLoading(false)
        })
    }, SOURCE_TIMELINE_FETCH_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [projectId, sourceId, viewEndMs, viewStartMs])

  useEffect(() => {
    if (!projectId || !sourceId || viewEndMs <= viewStartMs || viewSpan > PHONE_DETAIL_MAX_MS) return
    if (
      phoneCache?.sourceId === sourceId &&
      viewStartMs >= phoneCache.startMs &&
      viewEndMs <= phoneCache.endMs
    ) return
    const controller = new AbortController()
    const padding = Math.max(viewSpan, 30_000)
    const fetchStart = Math.max(0, viewStartMs - padding)
    const fetchEnd = Math.min(durationMs, viewEndMs + padding)
    const timer = window.setTimeout(() => {
      fetchTimeline(projectId, sourceId, fetchStart, fetchEnd, false, true, controller.signal)
        .then((slice) => {
          setPhoneCache({
            sourceId,
            startMs: fetchStart,
            endMs: fetchEnd,
            phones: slice.phones,
            acousticFeatures: slice.acoustic_features,
          })
        })
        .catch((caught: Error) => {
          if (caught.name !== "AbortError") setError(caught.message)
        })
    }, SOURCE_TIMELINE_FETCH_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [durationMs, phoneCache, projectId, sourceId, viewEndMs, viewSpan, viewStartMs])

  const timeline = useMemo<TimelineSlice | null>(() => {
    if (!analysis) return null
    return {
      start_ms: viewStartMs,
      end_ms: viewEndMs,
      audio_regions: analysis.audio_regions.filter(
        (region) => region.start_ms < viewEndMs && region.end_ms > viewStartMs,
      ),
      words: viewSpan <= WORD_DETAIL_MAX_MS
        ? displayedWords.filter((word) => word.start_ms < viewEndMs && word.end_ms > viewStartMs)
        : [],
      phones: viewSpan <= PHONE_DETAIL_MAX_MS && phoneCache?.sourceId === sourceId
        ? phoneCache.phones.filter((phone) => phone.start_ms < viewEndMs && phone.end_ms > viewStartMs)
        : [],
      acoustic_features: viewSpan <= PHONE_DETAIL_MAX_MS && phoneCache?.sourceId === sourceId
        ? phoneCache.acousticFeatures
        : [],
    }
  }, [analysis, displayedWords, phoneCache, sourceId, viewEndMs, viewSpan, viewStartMs])

  const selectedFeatures = selection?.occurrence_id
    ? timeline?.acoustic_features.find(
      (feature) => feature.occurrence_id === selection.occurrence_id,
    ) ?? null
    : null

  const regionStats = useMemo(() => {
    if (!analysis) return { speech: 0, nonSpeech: 0 }
    return analysis.audio_regions.reduce(
      (total, region) => {
        const duration = region.end_ms - region.start_ms
        if (region.region_type === "SPEECH") total.speech += duration
        else total.nonSpeech += duration
        return total
      },
      { speech: 0, nonSpeech: 0 },
    )
  }, [analysis])

  const seek = (timeMs: number) => {
    const audio = activeAudio()
    if (!audio) return
    const exactTimeMs = Math.max(0, Math.min(durationMs, timeMs))
    audio.currentTime = exactTimeMs / 1000
    setCurrentMs(exactTimeMs)
  }

  const zoom = (factor: number) => {
    const center = (viewStartMs + viewEndMs) / 2
    const nextSpan = Math.max(1_000, Math.min(durationMs, viewSpan * factor))
    const start = Math.max(0, Math.min(durationMs - nextSpan, center - nextSpan / 2))
    setViewStartMs(start)
    setViewEndMs(start + nextSpan)
  }

  const stopPlaybackClock = () => {
    if (playbackFrameRef.current === null) return
    window.cancelAnimationFrame(playbackFrameRef.current)
    playbackFrameRef.current = null
  }

  const startPlaybackClock = () => {
    stopPlaybackClock()
    const tick = () => {
      const audio = activeAudio()
      if (!audio || audio.paused || audio.ended) {
        playbackFrameRef.current = null
        return
      }
      const timeMs = audio.currentTime * 1000
      const activeSelection = selectionRef.current
      if (
        loopSelectionRef.current &&
        activeSelection &&
        timeMs >= activeSelection.end_ms - PLAYBACK_LOOP_EPSILON_MS
      ) {
        audio.currentTime = activeSelection.start_ms / 1000
        setCurrentMs(activeSelection.start_ms)
      } else {
        setCurrentMs(timeMs)
      }
      playbackFrameRef.current = window.requestAnimationFrame(tick)
    }
    playbackFrameRef.current = window.requestAnimationFrame(tick)
  }

  const syncPlaybackPosition = () => {
    const audio = activeAudio()
    if (!audio) return
    setCurrentMs(audio.currentTime * 1000)
  }

  const handleSelection = (nextSelection: TimelineSelection | null) => {
    setSelection(nextSelection)
    setLoopSelection(false)
    selectionRef.current = nextSelection
    loopSelectionRef.current = false
  }

  const previewCandidate = (candidate: UnitCandidate) => {
    const candidateSource = project?.manifest.sources.find(
      (item) => item.source_id === candidate.source_id,
    )
    const candidateDuration = candidateSource?.duration_ms ?? durationMs
    const padding = Math.max(500, candidate.source_end_ms - candidate.source_start_ms)
    setWaveform(null)
    setPhoneCache(null)
    prepareSourceAudio(candidate.source_id)
    setSourceId(candidate.source_id)
    setViewStartMs(Math.max(0, candidate.source_start_ms - padding))
    setViewEndMs(Math.min(candidateDuration, candidate.source_end_ms + padding))
    const nextSelection: TimelineSelection = {
      occurrence_id: null,
      kind: "PHONE",
      label: candidate.matched_ipa.join(" · "),
      start_ms: candidate.source_start_ms,
      end_ms: candidate.source_end_ms,
      pronunciation: candidate.target_ipa.join(" · "),
      phone_id: null,
      alignment_method: null,
      alignment_status: null,
    }
    setSelection(nextSelection)
    setLoopSelection(true)
    selectionRef.current = nextSelection
    loopSelectionRef.current = true
    setPendingCandidate(candidate)
  }

  const prepareCandidatePreview = (candidate: UnitCandidate) => {
    prepareSourceAudio(candidate.source_id)
  }

  const selectSource = (nextSourceId: string) => {
    const nextSource = project?.manifest.sources.find((item) => item.source_id === nextSourceId)
    setWaveform(null)
    setPhoneCache(null)
    setSelection(null)
    setCurrentMs(0)
    prepareSourceAudio(nextSourceId)
    setSourceId(nextSourceId)
    setViewStartMs(0)
    setViewEndMs(nextSource?.duration_ms ?? 1)
  }

  return (
    <main className="editor-app">
      <header className="app-header">
        <div className="app-brand">
          <p className="eyebrow">CONCATENATIVE CORPUS LAB</p>
          <h1>Madnolia Viewer</h1>
        </div>
        <nav className="workflow-nav" aria-label="작업 단계">
          <a href="#/analysis" aria-current={page === "analysis" ? "page" : undefined}>1. 영상 분석</a>
          <a href="#/projects" aria-current={page === "projects" ? "page" : undefined}>2. 프로젝트</a>
          <a
            href={projectId ? `#/collage/${encodeURIComponent(projectId)}` : "#/projects"}
            className={projectId ? undefined : "disabled"}
            aria-disabled={projectId ? undefined : true}
            aria-current={page === "collage" ? "page" : undefined}
          >3. 합성</a>
          <a
            href={projectId ? `#/professional/${encodeURIComponent(projectId)}` : "#/projects"}
            className={projectId ? undefined : "disabled"}
            aria-disabled={projectId ? undefined : true}
            aria-current={page === "professional" ? "page" : undefined}
          >4. 전문 편집</a>
        </nav>
        <div className="header-context">
        {page === "collage" || page === "professional" ? <div className="header-controls">
          <label>
            Project
            <select value={projectId} onChange={(event) => openProject(
              event.target.value,
              page === "professional" ? "professional" : "collage",
            )}>
              {projects.map((item) => (
                <option key={item.project_id} value={item.project_id}>{item.name}</option>
              ))}
            </select>
          </label>
          {page === "collage" && project && project.manifest.sources.length > 1 && (
            <label>
              Source
              <select value={sourceId} onChange={(event) => selectSource(event.target.value)}>
                {project.manifest.sources.map((item) => (
                  <option key={item.source_id} value={item.source_id}>{item.path.split(/[\\/]/).pop()}</option>
                ))}
              </select>
            </label>
          )}
          {page === "collage" && analysis && analysis.transcript_candidates.length > 1 && (
            <label>
              Transcript
              <select
                value={transcriptCandidateId}
                onChange={(event) => setTranscriptCandidateId(event.target.value)}
              >
                {analysis.transcript_candidates.map((candidate) => (
                  <option key={candidate.candidate_id} value={candidate.candidate_id}>
                    {candidate.model_name} · {candidate.words.length.toLocaleString()} words
                  </option>
                ))}
              </select>
            </label>
          )}
        </div> : <div className="header-stage">
          <strong>{page === "analysis" ? "STEP 01" : "STEP 02"}</strong>
          <span>{page === "analysis" ? "ANALYZE" : "COLLECT"}</span>
        </div>}
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      {page === "analysis" ? (
        <AnalysisPage onGoToProjects={() => { window.location.hash = "#/projects" }} />
      ) : page === "projects" ? (
        <ProjectsPage projects={projects}
          onOpenProject={openProject}
          onOpenCollage={(id) => { window.location.hash = `#/collages/${encodeURIComponent(id)}` }}
          onProjectCreated={async () => { setProjects(await fetchProjects()) }} />
      ) : page === "professional" && project ? (
        <ProfessionalSynthesisPage
          projectId={projectId}
          initialCompositionId={requestedCollageId}
        />
      ) : project && source && analysis ? (
        <>
          <div className="editor-shell">
          <section className="workspace-grid">
            <div className="source-audio-card panel">
              <div className="quadrant-heading">
                <strong>SOURCE AUDIO</strong>
                <span>{source.path.split(/[\\/]/).pop()} · CACHE {audioCacheProcessedCount}/{project.manifest.sources.length} · RAM {audioCacheCount}</span>
              </div>
              <div className="source-audio-pool">
                {project.manifest.sources.map((bufferedSource) => {
                  const bufferedSourceId = bufferedSource.source_id
                  const cachedAudioUrl = audioObjectUrls[bufferedSourceId]
                  const attachedAudioUrl = cachedAudioUrl ?? (
                    bufferedSourceId === sourceId ? audioUrl(projectId, bufferedSourceId) : undefined
                  )
                  return (
                  <audio
                    key={`${projectId}:${bufferedSourceId}`}
                    ref={(element) => {
                      if (element) audioRefs.current.set(bufferedSourceId, element)
                      else audioRefs.current.delete(bufferedSourceId)
                    }}
                    className={bufferedSourceId === sourceId ? "active" : ""}
                    src={attachedAudioUrl}
                    controls={bufferedSourceId === sourceId}
                    preload="auto"
                    onPlay={bufferedSourceId === sourceId ? startPlaybackClock : undefined}
                    onPause={bufferedSourceId === sourceId ? () => {
                      stopPlaybackClock()
                      syncPlaybackPosition()
                    } : undefined}
                    onEnded={bufferedSourceId === sourceId ? () => {
                      stopPlaybackClock()
                      syncPlaybackPosition()
                    } : undefined}
                    onSeeked={bufferedSourceId === sourceId ? syncPlaybackPosition : undefined}
                  />
                  )
                })}
              </div>
              <div className="transport-readout">
                <span>{formatTime(currentMs)}</span>
                <span>{formatTime(durationMs)}</span>
              </div>
              <div className="source-summary">
                <strong>{source.path.split(/[\\/]/).pop()}</strong>
                <span>{project.manifest.model_name} · {analysis.phone_count.toLocaleString()} phonemes · {formatTime(durationMs)}</span>
              </div>
            </div>

            <aside className="inspector panel">
              <p className="section-label">ANALYSIS</p>
              <dl className="stats">
                <div><dt>Model</dt><dd>{project.manifest.model_name}</dd></div>
                <div><dt>Backend</dt><dd>{project.manifest.inference_backend} · {project.manifest.inference_device}</dd></div>
                <div><dt>Words</dt><dd>{displayedWords.length.toLocaleString()}</dd></div>
                <div><dt>Phones</dt><dd>{analysis.phone_count.toLocaleString()}</dd></div>
                <div><dt>Speech</dt><dd>{formatTime(regionStats.speech)}</dd></div>
                <div><dt>Non-speech</dt><dd>{formatTime(regionStats.nonSpeech)}</dd></div>
              </dl>

              <div className="selection-card">
                <p className="section-label">SELECTION</p>
                {selection ? (
                  <>
                    <strong className="selection-label">{selection.label}</strong>
                    <span>{selection.kind} · {formatTime(selection.start_ms)} – {formatTime(selection.end_ms)}</span>
                    {selection.pronunciation && <span>발음형 {selection.pronunciation}</span>}
                    {selection.phone_id && <code>{selection.phone_id}</code>}
                    {selection.alignment_method && <span className="badge">{selection.alignment_method}</span>}
                    {selection.alignment_status && <span className="badge">{selection.alignment_status}</span>}
                    {selectedFeatures && (
                      <>
                        <span>RMS {selectedFeatures.rms_db.toFixed(1)} dB</span>
                        <span>Peak {selectedFeatures.peak_db.toFixed(1)} dB</span>
                        <span>
                          F0 {selectedFeatures.f0_hz === null
                            ? "UNVOICED"
                            : `${selectedFeatures.f0_hz.toFixed(1)} Hz`}
                        </span>
                        <span>Voiced {(selectedFeatures.voiced_probability * 100).toFixed(0)}%</span>
                        {selectedFeatures.acoustic_unit_id !== null && (
                          <span>Unit {selectedFeatures.acoustic_unit_id}</span>
                        )}
                      </>
                    )}
                    <button
                      className={loopSelection ? "active" : ""}
                      onClick={() => {
                        const nextLoopState = !loopSelectionRef.current
                        setLoopSelection(nextLoopState)
                        loopSelectionRef.current = nextLoopState
                        if (nextLoopState) {
                          seek(selection.start_ms)
                          void activeAudio()?.play()
                        }
                      }}
                    >
                      {loopSelection ? "반복 중지" : "구간 반복"}
                    </button>
                  </>
                ) : (
                  <span className="muted">단어나 phone을 선택하세요.</span>
                )}
              </div>
            </aside>
          </section>

          <section className="timeline-panel panel">
            <div className="timeline-toolbar">
              <strong className="panel-kicker">SOURCE TIMELINE</strong>
              <span className={`waveform-status${waveformLoading ? " loading" : ""}`}>
                {waveformLoading ? "파형 업데이트 중" : "파형 최신"}
              </span>
              <div className="legend">
                <span><i className="speech" />Speech</span>
                <span><i className="non-speech" />Non-speech</span>
                <span><i className="word" />Word</span>
                <span><i className="phone" />IPA phone</span>
              </div>
              <div className="zoom-controls">
                <button onClick={() => zoom(0.5)}>＋</button>
                <button onClick={() => zoom(2)}>−</button>
                <button onClick={() => { setViewStartMs(0); setViewEndMs(durationMs) }}>전체</button>
                <button onClick={() => {
                  const span = Math.min(60_000, durationMs)
                  const start = Math.max(0, Math.min(durationMs - span, currentMs - span / 2))
                  setViewStartMs(start)
                  setViewEndMs(start + span)
                }}>재생 위치</button>
              </div>
            </div>
            <Timeline
              durationMs={durationMs}
              viewStartMs={viewStartMs}
              viewEndMs={viewEndMs}
              currentMs={currentMs}
              waveform={waveform}
              timeline={timeline}
              selection={selection}
              onSeek={seek}
              onViewChange={(start, end) => { setViewStartMs(start); setViewEndMs(end) }}
              onSelect={handleSelection}
            />
            <div className="timeline-hint">
              <span>{formatTime(viewStartMs)}</span>
              <span>휠: 확대 · 드래그: 이동 · 클릭: 탐색</span>
              <span>{formatTime(viewEndMs)}</span>
            </div>
          </section>

          <CollagePanel
            projectId={projectId}
            initialCompositionId={requestedCollageId}
            onPreview={previewCandidate}
            onPreparePreview={prepareCandidatePreview}
          />

          <section className="transcript panel">
            <p className="section-label">TRANSCRIPT</p>
            <p>{transcriptCandidate?.transcript ?? analysis.transcript}</p>
          </section>
          </div>
        </>
      ) : (
        <div className="empty panel">프로젝트를 불러오는 중입니다.</div>
      )}
    </main>
  )
}
