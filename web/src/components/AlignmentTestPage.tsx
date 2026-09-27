import { useEffect, useMemo, useRef, useState } from "react"

import { fetchAlignmentTest, fetchAlignmentTestWaveform } from "../api"
import {
  ALIGNMENT_TEST_COLORS, ALIGNMENT_TEST_INITIAL_SPAN_MS,
  ALIGNMENT_TEST_LABELS, ALIGNMENT_TEST_METHODS,
} from "../constants"
import type { AlignmentTestData, AlignmentTestMethod, WaveformData } from "../types"
import { formatTime } from "./Timeline"

export function AlignmentTestPage() {
  const audioRef = useRef<HTMLAudioElement>(null)
  const dragRef = useRef<{ x: number; start: number } | null>(null)
  const dragMovedRef = useRef(false)
  const [data, setData] = useState<AlignmentTestData | null>(null)
  const [waveform, setWaveform] = useState<WaveformData | null>(null)
  const [error, setError] = useState("")
  const [viewStart, setViewStart] = useState(0)
  const [span, setSpan] = useState(ALIGNMENT_TEST_INITIAL_SPAN_MS)
  const [currentMs, setCurrentMs] = useState(0)
  const [selected, setSelected] = useState<number | null>(null)

  useEffect(() => {
    fetchAlignmentTest().then(setData).catch((caught: Error) => setError(caught.message))
  }, [])

  useEffect(() => {
    if (!data) return
    const controller = new AbortController()
    fetchAlignmentTestWaveform(viewStart, viewStart + span, controller.signal)
      .then(setWaveform)
      .catch((caught: Error) => { if (caught.name !== "AbortError") setError(caught.message) })
    return () => controller.abort()
  }, [data, span, viewStart])

  useEffect(() => {
    let frame = 0
    const tick = () => {
      const audio = audioRef.current
      if (audio && !audio.paused) {
        setCurrentMs(audio.currentTime * 1000)
        frame = requestAnimationFrame(tick)
      }
    }
    const audio = audioRef.current
    audio?.addEventListener("play", tick)
    return () => { audio?.removeEventListener("play", tick); cancelAnimationFrame(frame) }
  }, [data])

  const moveView = (start: number, nextSpan = span) => {
    if (!data) return
    const boundedSpan = Math.max(500, Math.min(data.duration_ms, nextSpan))
    setSpan(boundedSpan)
    setViewStart(Math.round(Math.max(0, Math.min(data.duration_ms - boundedSpan, start))))
  }

  const zoom = (factor: number, anchor = viewStart + span / 2) => {
    const nextSpan = Math.max(500, Math.min(data?.duration_ms ?? span, span * factor))
    moveView(anchor - (anchor - viewStart) * nextSpan / span, nextSpan)
  }

  const seek = (ms: number) => {
    if (audioRef.current) audioRef.current.currentTime = ms / 1000
    setCurrentMs(ms)
  }

  const playFrom = (ms: number) => {
    seek(ms)
    void audioRef.current?.play()
  }

  const visiblePhones = useMemo(() => {
    if (!data) return []
    return ALIGNMENT_TEST_METHODS.map((method) => data.results[method].phones
      .map((phone, index) => ({ ...phone, index }))
      .filter((phone) => phone.start_ms < viewStart + span && phone.end_ms > viewStart))
  }, [data, viewStart, span])

  const selectedPhone = selected === null ? null : data?.phones[selected]
  const selectedWord = selectedPhone ? data?.words[selectedPhone.word_index] : null
  const x = (ms: number) => 110 + (ms - viewStart) / span * 1070

  return (
    <section className="alignment-test">
      <div className="page-intro">
        <p className="eyebrow">IPA ALIGNMENT EXPERIMENT</p>
        <h2>음소 경계 비교</h2>
        <p>2026년 9월 10일 Maple Now · 30:00~40:00 · Qwen 0.6B 전사 기반 7,536개 음소</p>
      </div>
      {error && <div className="error">{error}</div>}
      {!data ? <div className="panel empty">실험 자료를 불러오는 중…</div> : <>
        <div className="alignment-overview">
          <div className="panel alignment-audio">
            <p className="section-label">원본 구간 · 현재 위치 {formatTime(currentMs)} / {formatTime(data.duration_ms)}</p>
            <audio ref={audioRef} src="/api/alignment-test/audio" controls preload="metadata"
              onSeeked={(event) => setCurrentMs(event.currentTarget.currentTime * 1000)} />
            <p className="muted">이 페이지의 시각은 잘라낸 10분 오디오 기준이야. 원본 영상 시각은 30분을 더하면 돼.</p>
          </div>
          <div className="panel alignment-inspector">
            <p className="section-label">선택한 음소</p>
            {selectedPhone && selected !== null ? <>
              <strong className="selection-label">/{selectedPhone.ipa}/</strong>
              <span>#{selected + 1} · {selectedWord?.text ?? ""}</span>
              {ALIGNMENT_TEST_METHODS.map((method) => {
                const phone = data.results[method].phones[selected]
                const base = data.results.ctc.phones[selected]
                return <div className="alignment-detail" key={method}>
                  <span style={{ color: ALIGNMENT_TEST_COLORS[method] }}>{ALIGNMENT_TEST_LABELS[method]}</span>
                  <span>{phone ? `/${phone.ipa}/ ${formatTime(phone.start_ms)} → ${formatTime(phone.end_ms)}${phone.unknown ? " · 미확인" : ""}` : "자료 없음"}</span>
                  <small>{phone && method !== "ctc" ? `CTC 대비 시작 ${phone.start_ms - base.start_ms >= 0 ? "+" : ""}${phone.start_ms - base.start_ms}ms · 끝 ${phone.end_ms - base.end_ms >= 0 ? "+" : ""}${phone.end_ms - base.end_ms}ms` : ""}</small>
                </div>
              })}
              <button onClick={() => { const phone = data.results.ctc.phones[selected]; seek(Math.max(0, phone.start_ms - 200)); void audioRef.current?.play() }}>선택 위치 듣기</button>
            </> : <p className="muted">아래 음소를 눌러 경계를 비교해 봐.</p>}
          </div>
        </div>
        <div className="panel alignment-chart">
          <div className="timeline-toolbar">
            <div className="legend">{ALIGNMENT_TEST_METHODS.map((method) =>
              <span key={method}><i style={{ background: ALIGNMENT_TEST_COLORS[method] }} />{ALIGNMENT_TEST_LABELS[method]} · {data.results[method].total_seconds.toFixed(2)}초</span>)}</div>
            <div className="zoom-controls">
              <button onClick={() => moveView(viewStart - span * .75)}>←</button>
              <button onClick={() => zoom(.5)}>확대 +</button>
              <button onClick={() => zoom(2)}>축소 −</button>
              <button onClick={() => moveView(currentMs - span / 2)}>재생 위치</button>
              <button onClick={() => moveView(viewStart + span * .75)}>→</button>
            </div>
          </div>
          <input className="alignment-scrub" type="range" min={0} max={Math.max(0, data.duration_ms - span)}
            step={100} value={viewStart} aria-label="표시 구간 이동"
            onChange={(event) => moveView(Number(event.target.value))} />
          <div className="timeline-shell">
            <svg className="alignment-svg" viewBox="0 0 1200 265" preserveAspectRatio="none"
              onWheel={(event) => { event.preventDefault(); zoom(event.deltaY < 0 ? .7 : 1.4, viewStart + Math.max(0, Math.min(1, (event.clientX - event.currentTarget.getBoundingClientRect().left) / event.currentTarget.getBoundingClientRect().width)) * span) }}
              onPointerDown={(event) => { dragRef.current = { x: event.clientX, start: viewStart }; dragMovedRef.current = false }}
              onPointerMove={(event) => {
                if (!dragRef.current) return
                if (Math.abs(event.clientX - dragRef.current.x) > 4) dragMovedRef.current = true
                if (dragMovedRef.current) moveView(dragRef.current.start - (event.clientX - dragRef.current.x) / event.currentTarget.getBoundingClientRect().width * span)
              }}
              onPointerUp={() => { dragRef.current = null }}
              onPointerLeave={() => { dragRef.current = null }}>
              {[0, 1, 2, 3, 4, 5].map((tick) => {
                const ms = viewStart + span * tick / 5
                return <g key={tick}><line x1={x(ms)} x2={x(ms)} y1={18} y2={258} stroke="#26303a" />
                  <text x={x(ms) + 3} y={13} fill="#8091a3" fontSize={11}>{formatTime(ms)}</text></g>
              })}
              <text x={8} y={54} fill="#8091a3" fontSize={12}>파형</text>
              {waveform?.start_ms === viewStart && waveform.end_ms === viewStart + span && waveform.peaks.map((peak, index) =>
                <line key={index} x1={110 + index * 1070 / waveform.peaks.length} x2={110 + index * 1070 / waveform.peaks.length}
                  y1={57 - peak * 25} y2={57 + peak * 25} stroke="#65a9ff" opacity={.6} />)}
              {ALIGNMENT_TEST_METHODS.map((method: AlignmentTestMethod, row) => <g key={method}>
                <text x={8} y={108 + row * 38} fill={ALIGNMENT_TEST_COLORS[method]} fontSize={12}>{ALIGNMENT_TEST_LABELS[method]}</text>
                <line x1={110} x2={1180} y1={115 + row * 38} y2={115 + row * 38} stroke="#202b35" />
                {visiblePhones[row].map((phone) => <g key={phone.index}>
                  <rect x={Math.max(110, x(phone.start_ms))} y={94 + row * 38}
                    width={Math.max(1.5, Math.min(1180, x(phone.end_ms)) - Math.max(110, x(phone.start_ms)))} height={25}
                    rx={2} fill={ALIGNMENT_TEST_COLORS[method]} opacity={phone.unknown ? .25 : selected === phone.index ? 1 : .68}
                    stroke={selected === phone.index ? "white" : "none"} strokeWidth={2}
                    onClick={() => {
                      if (dragMovedRef.current) { dragMovedRef.current = false; return }
                      setSelected(phone.index)
                      playFrom(phone.start_ms)
                    }} />
                  {(phone.end_ms - phone.start_ms) / span * 1070 > 17 && <text x={x(phone.start_ms) + 3} y={111 + row * 38}
                    fill="#0d1117" fontSize={10} pointerEvents="none">{phone.ipa}</text>}
                </g>)}
              </g>)}
              {currentMs >= viewStart && currentMs <= viewStart + span && <line x1={x(currentMs)} x2={x(currentMs)} y1={20} y2={260} stroke="#ff5470" strokeWidth={2} pointerEvents="none" />}
            </svg>
          </div>
          <div className="timeline-hint"><span>{formatTime(viewStart)} ~ {formatTime(viewStart + span)} · 휠 확대 · 드래그 이동 · 음소 클릭 재생</span><span>모델 간 경계 차이는 정확도가 아니야. 검증된 정답 경계는 없어.</span></div>
        </div>
        <div className="panel alignment-words">
          <p className="section-label">전체 전사 · {data.words.length.toLocaleString()}개 단어 · 단어를 누르면 해당 위치로 이동</p>
          <div>{data.words.map((word, index) => <button key={index}
            className={selectedPhone?.word_index === index ? "selected" : undefined}
            onClick={() => { moveView(word.start_ms - span / 3); seek(word.start_ms); setSelected(data.phones.findIndex((phone) => phone.word_index === index)) }}
            title={formatTime(word.start_ms)}>{word.text}</button>)}</div>
        </div>
      </>}
    </section>
  )
}
