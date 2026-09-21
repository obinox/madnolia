import { useEffect, useMemo, useRef, useState } from "react"

import { fetchProject, fetchProjects, fetchTimeline, fetchWaveform, mediaUrl } from "./api"
import { PHONE_DETAIL_MAX_MS, WAVEFORM_BINS, WORD_DETAIL_MAX_MS } from "./constants"
import { Timeline, formatTime } from "./components/Timeline"
import type {
  ProjectDetail,
  ProjectSummary,
  TimelineSelection,
  TimelineSlice,
  WaveformData,
} from "./types"

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [projectId, setProjectId] = useState("")
  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [sourceId, setSourceId] = useState("")
  const [viewStartMs, setViewStartMs] = useState(0)
  const [viewEndMs, setViewEndMs] = useState(1)
  const [currentMs, setCurrentMs] = useState(0)
  const [waveform, setWaveform] = useState<WaveformData | null>(null)
  const [timeline, setTimeline] = useState<TimelineSlice | null>(null)
  const [selection, setSelection] = useState<TimelineSelection | null>(null)
  const [loopSelection, setLoopSelection] = useState(false)
  const [error, setError] = useState("")

  const source = project?.manifest.sources.find((item) => item.source_id === sourceId) ?? null
  const analysis = project?.analyses.find((item) => item.source_id === sourceId) ?? null
  const durationMs = source?.duration_ms ?? 1
  const viewSpan = viewEndMs - viewStartMs

  useEffect(() => {
    fetchProjects()
      .then((items) => {
        setProjects(items)
        if (items[0]) setProjectId(items[0].project_id)
      })
      .catch((caught: Error) => setError(caught.message))
  }, [])

  useEffect(() => {
    if (!projectId) return
    setError("")
    fetchProject(projectId)
      .then((detail) => {
        setProject(detail)
        const firstSource = detail.manifest.sources[0]
        if (firstSource) {
          setSourceId(firstSource.source_id)
          setViewStartMs(0)
          setViewEndMs(firstSource.duration_ms)
          setCurrentMs(0)
          setSelection(null)
        }
      })
      .catch((caught: Error) => setError(caught.message))
  }, [projectId])

  useEffect(() => {
    if (!projectId || !sourceId || viewEndMs <= viewStartMs) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const includeWords = viewSpan <= WORD_DETAIL_MAX_MS
      const includePhones = viewSpan <= PHONE_DETAIL_MAX_MS
      Promise.all([
        fetchTimeline(projectId, sourceId, viewStartMs, viewEndMs, includeWords, includePhones, controller.signal),
        fetchWaveform(projectId, sourceId, viewStartMs, viewEndMs, WAVEFORM_BINS, controller.signal),
      ])
        .then(([nextTimeline, nextWaveform]) => {
          setTimeline(nextTimeline)
          setWaveform(nextWaveform)
        })
        .catch((caught: Error) => {
          if (caught.name !== "AbortError") setError(caught.message)
        })
    }, 180)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [projectId, sourceId, viewEndMs, viewSpan, viewStartMs])

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
    videoRef.current.currentTime = timeMs / 1000
    setCurrentMs(timeMs)
  }

  const zoom = (factor: number) => {
    const center = (viewStartMs + viewEndMs) / 2
    const nextSpan = Math.max(1_000, Math.min(durationMs, viewSpan * factor))
    const start = Math.max(0, Math.min(durationMs - nextSpan, center - nextSpan / 2))
    setViewStartMs(start)
    setViewEndMs(start + nextSpan)
  }

  const handleTimeUpdate = () => {
    const video = videoRef.current
    if (!video) return
    const timeMs = video.currentTime * 1000
    if (loopSelection && selection && timeMs >= selection.end_ms) {
      video.currentTime = selection.start_ms / 1000
      void video.play()
      return
    }
    setCurrentMs(timeMs)
  }

  const handleSelection = (nextSelection: TimelineSelection | null) => {
    setSelection(nextSelection)
    setLoopSelection(false)
  }

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">CONCATENATIVE CORPUS LAB</p>
          <h1>Madnolia Viewer</h1>
        </div>
        <div className="header-controls">
          <label>
            Project
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              {projects.map((item) => (
                <option key={item.project_id} value={item.project_id}>{item.project_id}</option>
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
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      {project && source && analysis ? (
        <>
          <section className="workspace-grid">
            <div className="video-card panel">
              <video
                ref={videoRef}
                src={mediaUrl(projectId, sourceId)}
                controls
                preload="metadata"
                onTimeUpdate={handleTimeUpdate}
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
                <div><dt>Words</dt><dd>{analysis.word_count.toLocaleString()}</dd></div>
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
                    <button
                      className={loopSelection ? "active" : ""}
                      onClick={() => {
                        seek(selection.start_ms)
                        setLoopSelection((value) => !value)
                        void videoRef.current?.play()
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

          <section className="transcript panel">
            <p className="section-label">TRANSCRIPT</p>
            <p>{analysis.transcript}</p>
          </section>
        </>
      ) : (
        <div className="empty panel">프로젝트를 불러오는 중입니다.</div>
      )}
    </main>
  )
}
