import { env, pipeline } from "@huggingface/transformers"
import wasmMjsUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url"
import wasmUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url"
import wasmJsepMjsUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url"
import wasmJsepUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url"
import type { BrowserAnalysisWorkerRequest, BrowserAnalysisWorkerSettings, BrowserAnalysisWorkerProgress, BrowserAnalysisWord, BrowserAsrOutput, BrowserAsrPipeline, BrowserAsrProgressEvent, BrowserTimedAnalysisChunk, BrowserAnalysisModelTranscript } from "../types/browserAnalysis"
import type { BrowserGpuNavigator, BrowserPronunciation } from "../types"
import { BROWSER_ASR_CHUNK_SECONDS, BROWSER_ASR_OVERLAP_SECONDS, BROWSER_ASR_SAMPLE_RATE, BROWSER_ASR_WASM_THREADS } from "../browserAnalysisConstants"
import { createWorkspaceModelCache } from "./modelCache"
import { pronounceBrowserText } from "./phonetics"

let stopRequested = false
let pauseRequested = false
let resumeWait: (() => void) | null = null

const sendProgress = (stage: string, percent: number, downloadModel: string | null = null, downloadPercent: number | null = null): void => {
  const progress: BrowserAnalysisWorkerProgress = { kind: "progress", stage, percent, download_model: downloadModel, download_percent: downloadPercent }
  self.postMessage({ kind: "progress", progress })
}

async function boundary(): Promise<void> {
  if (stopRequested) throw new DOMException("Analysis stopped", "AbortError")
  if (!pauseRequested) return
  sendProgress("Paused at a chunk boundary", 10)
  await new Promise<void>((resolve) => { resumeWait = resolve })
  resumeWait = null
  if (stopRequested) throw new DOMException("Analysis stopped", "AbortError")
}

async function transcribeModel(settings: BrowserAnalysisWorkerSettings, modelName: string, ordinal: number, count: number): Promise<BrowserAnalysisModelTranscript> {
  const base = ordinal * 88 / count + 8
  const span = 88 / count
  sendProgress(`Loading ${modelName}`, base, modelName, 0)
  const asr = await pipeline("automatic-speech-recognition", modelName, {
    device: settings.device,
    dtype: settings.device === "webgpu" ? "fp32" : "q8",
    progress_callback: (event: BrowserAsrProgressEvent) => {
      if (stopRequested) throw new DOMException("Analysis stopped", "AbortError")
      if (event.status === "progress") sendProgress(`Downloading ${modelName}`, base, event.file ?? modelName, event.progress ?? null)
      if (event.status === "done") sendProgress(`Loading ${modelName}`, base + span * 0.03, event.file ?? modelName, 100)
    },
  }) as unknown as BrowserAsrPipeline
  const samples = settings.audio.samples
  const windowSize = BROWSER_ASR_CHUNK_SECONDS * BROWSER_ASR_SAMPLE_RATE
  const hopSize = Math.max(1, (BROWSER_ASR_CHUNK_SECONDS - BROWSER_ASR_OVERLAP_SECONDS) * BROWSER_ASR_SAMPLE_RATE)
  const words: BrowserAnalysisWord[] = []
  let offset = 0
  while (offset < samples.length) {
    await boundary()
    const end = Math.min(samples.length, offset + windowSize)
    const fraction = offset / Math.max(1, samples.length)
    sendProgress(`Transcribing ${modelName}`, base + span * (0.08 + fraction * 0.91), null, null)
    const output = await asr(samples.subarray(offset, end), { return_timestamps: "word", chunk_length_s: BROWSER_ASR_CHUNK_SECONDS, stride_length_s: BROWSER_ASR_OVERLAP_SECONDS })
    if (stopRequested) throw new DOMException("Analysis stopped", "AbortError")
    const lastEnd = words.at(-1)?.end_ms ?? 0
    const newChunks = cleanChunks(output, offset / BROWSER_ASR_SAMPLE_RATE, (end - offset) / BROWSER_ASR_SAMPLE_RATE, lastEnd / 1000)
    for (const chunk of newChunks) {
      const pieces = chunk.text.match(/[^\s]+/gu) ?? []
      const [start, finish] = chunk.timestamp
      for (const [pieceIndex, text] of pieces.entries()) {
        const wordStart = start + (finish - start) * pieceIndex / pieces.length
        const wordEnd = start + (finish - start) * (pieceIndex + 1) / pieces.length
        if (wordEnd * 1000 <= (words.at(-1)?.end_ms ?? -1)) continue
        words.push({ text, start_ms: Math.max(0, Math.round(wordStart * 1000)), end_ms: Math.max(1, Math.round(wordEnd * 1000)), confidence: null })
      }
    }
    if (end === samples.length) break
    offset += hopSize
  }
  await asr.dispose?.()
  return { model_name: modelName, transcript: words.map((word) => word.text).join(" ").trim(), words }
}

function cleanChunks(output: BrowserAsrOutput, offset: number, duration: number, previousEnd: number): BrowserTimedAnalysisChunk[] {
  const chunks = output.chunks ?? []
  if (!chunks.length) {
    const text = output.text?.trim() ?? ""
    if (!text) return []
    const words = text.match(/[^\s]+/gu) ?? []
    const start = Math.max(offset, previousEnd)
    const span = Math.max(0, duration - (start - offset))
    return words.map((word, index) => ({ text: word, timestamp: [start + span * index / words.length, start + span * (index + 1) / words.length] }))
  }
  return chunks.flatMap((chunk) => {
    const [start, end] = chunk.timestamp
    if (start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end) || !chunk.text.trim()) return []
    const absoluteStart = offset + (start as number)
    const absoluteEnd = offset + (end as number)
    if (absoluteEnd <= previousEnd || absoluteStart >= offset + duration) return []
    return [{ text: chunk.text.trim(), timestamp: [Math.max(absoluteStart, offset), Math.min(absoluteEnd, offset + duration)] as [number, number] }]
  })
}

async function run(settings: BrowserAnalysisWorkerSettings): Promise<void> {
  stopRequested = false
  pauseRequested = false
  const supportsGpu = typeof navigator !== "undefined" && !!await (navigator as BrowserGpuNavigator).gpu?.requestAdapter()
  if (settings.device === "webgpu" && !supportsGpu) throw new Error("WebGPU is unavailable in this browser or device.")
  const device = settings.device === "webgpu" ? "webgpu" : "wasm"
  env.useCustomCache = true
  env.customCache = createWorkspaceModelCache(settings.workspace)
  env.useBrowserCache = false
  env.useFSCache = false
  env.allowLocalModels = false
  const wasm = env.backends.onnx.wasm
  if (wasm) {
    wasm.numThreads = 1
    wasm.proxy = false
    wasm.wasmPaths = device === "webgpu" ? { mjs: wasmJsepMjsUrl, wasm: wasmJsepUrl } : { mjs: wasmMjsUrl, wasm: wasmUrl }
  }

  const modelNames = [...new Set([settings.model_name, ...settings.candidate_models])]
  const candidates: BrowserAnalysisModelTranscript[] = []
  for (let index = 0; index < modelNames.length; index += 1) candidates.push(await transcribeModel({ ...settings, device }, modelNames[index], index, modelNames.length))
  const primary = candidates[0]
  const transcript = primary.transcript
  const phones: BrowserPronunciation[] = transcript ? pronounceBrowserText(transcript, "AUTO") : []
  const record_id = crypto.randomUUID()
  const file_name = settings.filename
  const duration_ms = Math.round(settings.audio.samples.length * 1000 / BROWSER_ASR_SAMPLE_RATE)
  self.postMessage({
    kind: "complete",
    result: { record_id, file_name, nickname: settings.nickname, model_name: settings.model_name, duration_ms, transcript, words: primary.words, candidates, acoustic_units: settings.acoustic_units, phones, audio: settings.audio, media_path: `media/${file_name}`, video_width: settings.video_width, video_height: settings.video_height },
  })
}

self.onmessage = (event: MessageEvent<BrowserAnalysisWorkerRequest>) => {
  const message = event.data
  if (message.kind === "pause") { pauseRequested = true; return }
  if (message.kind === "resume") { pauseRequested = false; resumeWait?.(); return }
  if (message.kind === "stop") { stopRequested = true; resumeWait?.(); return }
  void run(message.settings).catch((error: unknown) => {
    const messageText = error instanceof Error ? error.message : String(error)
    self.postMessage({ kind: "failure", message: messageText })
  })
}
