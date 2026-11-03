import type { BrowserSileroVadCallbacks, BrowserSileroVadOptions, BrowserSileroVadResponse, BrowserSpeechInterval, BrowserSpeechSampleInterval, BrowserSpeechTimedInterval, BrowserSpeechWindow } from "../types/browserSpeech"
import {
  BROWSER_SILERO_CHUNK_MS,
  BROWSER_SILERO_MAX_SPEECH_SECONDS,
  BROWSER_SILERO_MERGE_GAP_MS,
  BROWSER_SILERO_MIN_SILENCE_MS,
  BROWSER_SILERO_MIN_SPEECH_MS,
  BROWSER_SILERO_MIN_SILENCE_AT_MAX_MS,
  BROWSER_SILERO_NEG_THRESHOLD_DIFFERENCE,
  BROWSER_SILERO_NEG_THRESHOLD,
  BROWSER_SILERO_SAMPLE_RATE,
  BROWSER_SILERO_SPEECH_PAD_MS,
  BROWSER_SILERO_THRESHOLD,
  BROWSER_SILERO_WINDOW_SAMPLES,
  BROWSER_SILERO_CONTEXT_SAMPLES,
  BROWSER_SPEECH_WINDOW_MS,
  BROWSER_SPEECH_WINDOW_OVERLAP_MS,
} from "../browserSpeechConstants"

export function speechTimestampsFromProbabilities(
  probabilities: ArrayLike<number>,
  audioLengthSamples: number,
  options: BrowserSileroVadOptions = {},
): BrowserSpeechSampleInterval[] {
  const threshold = options.threshold ?? BROWSER_SILERO_THRESHOLD
  const negThreshold = options.negThreshold ?? Math.max(threshold - BROWSER_SILERO_NEG_THRESHOLD_DIFFERENCE, 0.01)
  const minSpeechSamples = BROWSER_SILERO_SAMPLE_RATE * (options.minSpeechMs ?? BROWSER_SILERO_MIN_SPEECH_MS) / 1000
  const padSamples = BROWSER_SILERO_SAMPLE_RATE * (options.speechPadMs ?? BROWSER_SILERO_SPEECH_PAD_MS) / 1000
  const maxSpeechSamples = BROWSER_SILERO_SAMPLE_RATE * (options.maxSpeechSeconds ?? BROWSER_SILERO_MAX_SPEECH_SECONDS) - BROWSER_SILERO_WINDOW_SAMPLES - 2 * padSamples
  const minSilenceSamples = BROWSER_SILERO_SAMPLE_RATE * (options.minSilenceMs ?? BROWSER_SILERO_MIN_SILENCE_MS) / 1000
  const minSilenceAtMaxSamples = BROWSER_SILERO_SAMPLE_RATE * BROWSER_SILERO_MIN_SILENCE_AT_MAX_MS / 1000
  let triggered = false
  let currentStart = -1
  let tempEnd = 0
  let prevEnd = 0
  let nextStart = 0
  const speeches: BrowserSpeechSampleInterval[] = []

  for (let i = 0; i < probabilities.length; i += 1) {
    const start = BROWSER_SILERO_WINDOW_SAMPLES * i
    const probability = probabilities[i]
    if (probability >= threshold && tempEnd) {
      tempEnd = 0
      if (nextStart < prevEnd) nextStart = start
    }
    if (probability >= threshold && !triggered) {
      triggered = true
      currentStart = start
      continue
    }
    if (triggered && start - currentStart > maxSpeechSamples) {
      if (prevEnd) {
        speeches.push({ start: currentStart, end: prevEnd })
        currentStart = -1
        if (nextStart < prevEnd) triggered = false
        else currentStart = nextStart
        prevEnd = 0
        nextStart = 0
        tempEnd = 0
      } else {
        speeches.push({ start: currentStart, end: start })
        currentStart = -1
        prevEnd = 0
        nextStart = 0
        tempEnd = 0
        triggered = false
        continue
      }
    }
    if (probability < negThreshold && triggered) {
      if (!tempEnd) tempEnd = start
      if (start - tempEnd > minSilenceAtMaxSamples) prevEnd = tempEnd
      if (start - tempEnd < minSilenceSamples) continue
      if (tempEnd - currentStart > minSpeechSamples) speeches.push({ start: currentStart, end: tempEnd })
      currentStart = -1
      prevEnd = 0
      nextStart = 0
      tempEnd = 0
      triggered = false
    }
  }
  if (currentStart >= 0 && audioLengthSamples - currentStart > minSpeechSamples) {
    speeches.push({ start: currentStart, end: audioLengthSamples })
  }
  for (let i = 0; i < speeches.length; i += 1) {
    const speech = speeches[i]
    if (i === 0) speech.start = Math.max(0, speech.start - padSamples)
    if (i < speeches.length - 1) {
      const silence = speeches[i + 1].start - speech.end
      if (silence < 2 * padSamples) {
        speech.end += Math.floor(silence / 2)
        speeches[i + 1].start = Math.max(0, speeches[i + 1].start - Math.floor(silence / 2))
      } else {
        speech.end = Math.min(audioLengthSamples, speech.end + padSamples)
        speeches[i + 1].start = Math.max(0, speeches[i + 1].start - padSamples)
      }
    } else {
      speech.end = Math.min(audioLengthSamples, speech.end + padSamples)
    }
  }
  return speeches
}

export function completeSpeechIntervals(
  durationMs: number,
  speechIntervals: BrowserSpeechTimedInterval[],
  mergeGapMs = BROWSER_SILERO_MERGE_GAP_MS,
): BrowserSpeechInterval[] {
  const merged: BrowserSpeechTimedInterval[] = []
  for (const interval of [...speechIntervals].sort((left, right) => left.start_ms - right.start_ms)) {
    const previous = merged.at(-1)
    if (previous && interval.start_ms - previous.end_ms <= mergeGapMs) previous.end_ms = Math.max(previous.end_ms, interval.end_ms)
    else merged.push({ ...interval })
  }
  const output: BrowserSpeechInterval[] = []
  let cursor = 0
  for (const interval of merged) {
    if (interval.start_ms > cursor) output.push({ type: "non_speech", start_ms: cursor, end_ms: interval.start_ms })
    output.push({ type: "speech", ...interval })
    cursor = interval.end_ms
  }
  if (cursor < durationMs) output.push({ type: "non_speech", start_ms: cursor, end_ms: durationMs })
  return output
}

export function speechWindows(intervals: BrowserSpeechInterval[]): BrowserSpeechWindow[] {
  const output: BrowserSpeechWindow[] = []
  const stride = BROWSER_SPEECH_WINDOW_MS - BROWSER_SPEECH_WINDOW_OVERLAP_MS
  const halfOverlap = BROWSER_SPEECH_WINDOW_OVERLAP_MS / 2
  for (const interval of intervals) {
    if (interval.type !== "speech") continue
    let offset = interval.start_ms
    let first = true
    while (offset < interval.end_ms) {
      const end = Math.min(interval.end_ms, offset + BROWSER_SPEECH_WINDOW_MS)
      const final = end >= interval.end_ms
      output.push({
        start_ms: offset,
        end_ms: end,
        keep_start_ms: first ? offset : offset + halfOverlap,
        keep_end_ms: final ? end : end - halfOverlap,
      })
      if (final) break
      offset += stride
      first = false
    }
  }
  return output
}

function pythonRound(value: number): number {
  const floor = Math.floor(value)
  const fraction = value - floor
  return fraction === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(value)
}

export function intervalsFromSileroProbabilities(
  probabilities: ArrayLike<number>,
  audioLengthSamples: number,
  options: BrowserSileroVadOptions = {},
): BrowserSpeechInterval[] {
  const speech = speechTimestampsFromProbabilities(probabilities, audioLengthSamples, options).map(({ start, end }) => ({
    start_ms: pythonRound(start * 1000 / BROWSER_SILERO_SAMPLE_RATE),
    end_ms: pythonRound(end * 1000 / BROWSER_SILERO_SAMPLE_RATE),
  }))
  return completeSpeechIntervals(pythonRound(audioLengthSamples * 1000 / BROWSER_SILERO_SAMPLE_RATE), speech, options.mergeGapMs)
}

export function intervalsFromChunkProbabilities(
  probabilities: Float32Array,
  chunkFrameCounts: number[],
  audioLengthSamples: number,
  options: BrowserSileroVadOptions = {},
): BrowserSpeechInterval[] {
  const chunkSamples = BROWSER_SILERO_SAMPLE_RATE * BROWSER_SILERO_CHUNK_MS / 1000
  const speechIntervals: BrowserSpeechTimedInterval[] = []
  let probabilityOffset = 0
  for (let chunkIndex = 0; chunkIndex < chunkFrameCounts.length; chunkIndex += 1) {
    const frameCount = chunkFrameCounts[chunkIndex]
    const sampleOffset = chunkIndex * chunkSamples
    const chunkLength = Math.min(chunkSamples, audioLengthSamples - sampleOffset)
    const local = speechTimestampsFromProbabilities(
      probabilities.subarray(probabilityOffset, probabilityOffset + frameCount),
      chunkLength,
      options,
    )
    speechIntervals.push(...local.map(({ start, end }) => ({
      start_ms: pythonRound((sampleOffset + start) * 1000 / BROWSER_SILERO_SAMPLE_RATE),
      end_ms: pythonRound((sampleOffset + end) * 1000 / BROWSER_SILERO_SAMPLE_RATE),
    })))
    probabilityOffset += frameCount
  }
  return completeSpeechIntervals(
    pythonRound(audioLengthSamples * 1000 / BROWSER_SILERO_SAMPLE_RATE),
    speechIntervals,
    options.mergeGapMs,
  )
}

function modelAssetUrl(): string {
  return new URL("./assets/silero-vad/silero_vad_v6.onnx", import.meta.url).href
}

export async function detectSileroSpeech(
  samples: Float32Array,
  options: BrowserSileroVadOptions = {},
  callbacks: BrowserSileroVadCallbacks = {},
): Promise<BrowserSpeechInterval[]> {
  if (!(samples instanceof Float32Array)) throw new TypeError("Silero VAD requires Float32Array PCM samples.")
  if (callbacks.signal?.aborted) throw new DOMException("Silero VAD was cancelled.", "AbortError")
  const worker = new Worker(new URL("./sileroVad.worker.ts", import.meta.url), { type: "module" })
  const pcm = new Float32Array(samples)
  let abortHandler: (() => void) | undefined
  let callbackError: unknown
  let callbackFailed = false
  try {
    const response = await new Promise<BrowserSileroVadResponse>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<BrowserSileroVadResponse>) => {
        if (event.data.kind === "progress") {
          try {
            callbacks.onProgress?.({
              completedSamples: event.data.completedSamples ?? 0,
              totalSamples: event.data.totalSamples ?? samples.length,
            })
          } catch (cause) {
            callbackFailed = true
            callbackError = cause
            worker.postMessage({ kind: "cancel" })
          }
          return
        }
        resolve(event.data)
      }
      worker.onerror = (event) => reject(new Error(event.message || "Silero VAD worker failed."))
      abortHandler = () => worker.postMessage({ kind: "cancel" })
      callbacks.signal?.addEventListener("abort", abortHandler, { once: true })
      worker.postMessage({ kind: "detect", samples: pcm, modelUrl: modelAssetUrl() }, [pcm.buffer])
    })
    if (callbackFailed) throw callbackError
    if (response.kind === "cancelled") throw new DOMException("Silero VAD was cancelled.", "AbortError")
    if (response.kind === "failure") throw new Error(response.message ?? "Silero VAD inference failed.")
    if (!response.probabilities || !response.chunkFrameCounts) throw new Error("Silero VAD worker returned incomplete probabilities.")
    return intervalsFromChunkProbabilities(response.probabilities, response.chunkFrameCounts, samples.length, options)
  } finally {
    if (abortHandler) callbacks.signal?.removeEventListener("abort", abortHandler)
    worker.terminate()
  }
}

