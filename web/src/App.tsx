import { useEffect, useMemo, useRef, useState } from "react"

import { fetchCollage, fetchProject, fetchProjects, fetchTimeline, fetchWaveform, mediaUrl } from "./api"
import {
  PHONE_DETAIL_MAX_MS,
  PLAYBACK_LOOP_EPSILON_MS,
  WAVEFORM_BINS,
  WORD_DETAIL_MAX_MS,
} from "./constants"
import { Timeline, formatTime } from "./components/Timeline"
import { CollagePanel } from "./components/CollagePanel"
import { AnalysisPage } from "./components/AnalysisPage"
import { ProjectsPage } from "./components/ProjectsPage"
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
  const videoRef = useRef<HTMLVideoElement>(null)
  const playbackFrameRef = useRef<number | null>(null)
  const loopSelectionRef = useRef(false)
  const selectionRef = useRef<TimelineSelection | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [page, setPage] = useState<WorkflowPage>("analysis")
  const [projectId, setProjectId] = useState("")
  const [requestedCollageId, setRequestedCollageId] = useState("")
  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [sourceId, setSourceId] = useState("")
  const [transcriptCandidateId, setTranscriptCandidateId] = useState("")
  const [viewStartMs, setViewStartMs] = useState(0)
  const [viewEndMs, setViewEndMs] = useState(1)
  const [currentMs, setCurrentMs] = useState(0)
  const [waveform, setWaveform] = useState<WaveformData | null>(null)
  const [phoneCache, setPhoneCache] = useState<PhoneCache | null>(null)
  const [selection, setSelection] = useState<TimelineSelection | null>(null)
  const [loopSelection, setLoopSelection] = useState(false)
  const [pendingCandidate, setPendingCandidate] = useState<UnitCandidate | null>(null)
  const [error, setError] = useState("")

  const source = project?.manifest.sources.find((item) => item.source_id === sourceId) ?? null
  const analysis = project?.analyses.find((item) => item.source_id === sourceId) ?? null
  const transcriptCandidate = analysis?.transcript_candidates.find(
    (candidate) => candidate.candidate_id === transcriptCandidateId,
  ) ?? null
  const displayedWords = transcriptCandidate?.words ?? analysis?.words ?? []
  const durationMs = source?.duration_ms ?? 1
  const viewSpan = viewEndMs - viewStartMs

  const openProject = (id: string) => {
    setRequestedCollageId("")
    setProjectId(id)
    window.location.hash = `#/collage/${encodeURIComponent(id)}`
  }

  useEffect(() => {
    const syncPage = () => {
      const hash = window.location.hash
      if (hash.startsWith("#/collages/")) {
        const id = decodeURIComponent(hash.slice("#/collages/".length))
        setRequestedCollageId(id)
        setProjectId("")
        setPage("collage")
        fetchCollage(id).then((collage) => setProjectId(collage.corpus_project_id))
          .catch((caught: Error) => setError(caught.message))
      } else if (hash.startsWith("#/collage/")) {
        setRequestedCollageId("")
        setProjectId(decodeURIComponent(hash.slice("#/collage/".length)))
        setPage("collage")
      } else if (hash === "#/projects") {
        setPage("projects")
      } else {
        setPage("analysis")
        if (hash !== "#/analysis") window.location.hash = "#/analysis"
      }
    }
    syncPage()
    window.addEventListener("hashchange", syncPage)
    return () => window.removeEventListener("hashchange", syncPage)
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
    if (!projectId) return
    let active = true
    setError("")
    setProject(null)
    setSourceId("")
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
    const video = videoRef.current
    if (!video) return
    const playCandidate = () => {
      video.currentTime = pendingCandidate.source_start_ms / 1000
      setCurrentMs(pendingCandidate.source_start_ms)
      void video.play()
      setPendingCandidate(null)
    }
    if (video.readyState >= 1) {
      playCandidate()
      return
    }
    video.addEventListener("loadedmetadata", playCandidate, { once: true })
    return () => video.removeEventListener("loadedmetadata", playCandidate)
  }, [pendingCandidate, sourceId])

  useEffect(() => {
    if (!projectId || !sourceId || viewEndMs <= viewStartMs) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      fetchWaveform(projectId, sourceId, viewStartMs, viewEndMs, WAVEFORM_BINS, controller.signal)
        .then(setWaveform)
        .catch((caught: Error) => {
          if (caught.name !== "AbortError") setError(caught.message)
        })
    }, 180)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [projectId, sourceId, viewEndMs, viewSpan, viewStartMs])

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
    return () => controller.abort()
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
    if (!videoRef.current) return
    const exactTimeMs = Math.max(0, Math.min(durationMs, timeMs))
    videoRef.current.currentTime = exactTimeMs / 1000
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
      const video = videoRef.current
      if (!video || video.paused || video.ended) {
        playbackFrameRef.current = null
        return
      }
      const timeMs = video.currentTime * 1000
      const activeSelection = selectionRef.current
      if (
        loopSelectionRef.current &&
        activeSelection &&
        timeMs >= activeSelection.end_ms - PLAYBACK_LOOP_EPSILON_MS
      ) {
        video.currentTime = activeSelection.start_ms / 1000
        setCurrentMs(activeSelection.start_ms)
      } else {
        setCurrentMs(timeMs)
      }
      playbackFrameRef.current = window.requestAnimationFrame(tick)
    }
    playbackFrameRef.current = window.requestAnimationFrame(tick)
  }

  const syncPlaybackPosition = () => {
    const video = videoRef.current
    if (!video) return
    setCurrentMs(video.currentTime * 1000)
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

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">CONCATENATIVE CORPUS LAB</p>
          <h1>Madnolia Viewer</h1>
        </div>
        <nav className="workflow-nav" aria-label="작업 단계">
          <a href="#/analysis" aria-current={page === "analysis" ? "page" : undefined}>1. 영상 분석</a>
          <a href="#/projects" aria-current={page === "projects" ? "page" : undefined}>2. 프로젝트</a>
          {projectId && <a href={`#/collage/${encodeURIComponent(projectId)}`}
            aria-current={page === "collage" ? "page" : undefined}>3. 콜라주</a>}
        </nav>
        {page === "collage" && (
        <div className="header-controls">
          <label>
            Project
            <select value={projectId} onChange={(event) => openProject(event.target.value)}>
              {projects.map((item) => (
                <option key={item.project_id} value={item.project_id}>{item.name}</option>
              ))}
            </select>
          </label>
          {project && project.manifest.sources.length > 1 && (
            <label>
              Source
              <select value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
                {project.manifest.sources.map((item) => (
                  <option key={item.source_id} value={item.source_id}>{item.path.split(/[\\/]/).pop()}</option>
                ))}
              </select>
            </label>
          )}
          {analysis && analysis.transcript_candidates.length > 1 && (
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
        </div>
        )}
      </header>

      {error && <div className="error">{error}</div>}

      {page === "analysis" ? (
        <AnalysisPage onGoToProjects={() => { window.location.hash = "#/projects" }} />
      ) : page === "projects" ? (
        <ProjectsPage projects={projects}
          onOpenProject={openProject}
          onOpenCollage={(id) => { window.location.hash = `#/collages/${encodeURIComponent(id)}` }}
          onProjectCreated={async () => { setProjects(await fetchProjects()) }} />
      ) : project && source && analysis ? (
        <>
          <section className="workspace-grid">
            <div className="video-card panel">
              <video
                ref={videoRef}
                src={mediaUrl(projectId, sourceId)}
                controls
                preload="metadata"
                onPlay={startPlaybackClock}
                onPause={() => {
                  stopPlaybackClock()
                  syncPlaybackPosition()
                }}
                onEnded={() => {
                  stopPlaybackClock()
                  syncPlaybackPosition()
                }}
                onSeeked={syncPlaybackPosition}
              />
              <div className="transport-readout">
                <span>{formatTime(currentMs)}</span>
                <span>{formatTime(durationMs)}</span>
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
                          void videoRef.current?.play()
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

          <CollagePanel projectId={projectId} initialCompositionId={requestedCollageId} onPreview={previewCandidate} />

          <section className="transcript panel">
            <p className="section-label">TRANSCRIPT</p>
            <p>{transcriptCandidate?.transcript ?? analysis.transcript}</p>
          </section>
        </>
      ) : (
        <div className="empty panel">프로젝트를 불러오는 중입니다.</div>
      )}
    </main>
  )
}
