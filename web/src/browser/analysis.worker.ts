import { AutoModelForSpeechSeq2Seq, AutoProcessor, AutoTokenizer, env } from "@huggingface/transformers"
import wasmMjsUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url"
import wasmUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url"
import wasmJsepMjsUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url"
import wasmJsepUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url"
import type { BrowserAnalysisWorkerRequest, BrowserAnalysisWorkerSettings, BrowserAnalysisReprocessSettings, BrowserAnalysisWorkerProgress, BrowserAnalysisWord, BrowserAsrProgressEvent, BrowserAnalysisModelTranscript, BrowserInferenceDType, BrowserInferenceModelMetadata } from "../types/browserAnalysis"
import type { BrowserGpuNavigator, BrowserPronunciation } from "../types"
import type { BrowserSpeechInterval } from "../types/browserSpeech"
import type { BrowserWhisperModel, BrowserWhisperProcessor, BrowserWhisperTokenizer } from "../types/browserWhisperDecoding"
import { BROWSER_ASR_CHECKPOINT_POLICY_VERSION, BROWSER_ASR_DEFAULT_LANGUAGE, BROWSER_ASR_MODELS, BROWSER_ASR_SAMPLE_RATE, BROWSER_ASR_TASK, BROWSER_CTC_MODEL, BROWSER_CTC_REVISION, BROWSER_HUBERT_MODEL, BROWSER_HUBERT_REVISION } from "../browserAnalysisConstants"
import { createWorkspaceModelCache } from "./modelCache"
import { pronounceBrowserWords } from "./phonetics"
import { alignBrowserPhones } from "./ctcAlignment"
import { buildBrowserSentences } from "./speechAnalysis"
import { extractBrowserHubertEmbeddings } from "./hubertUnits"
import { assertAsrMemoryPreflight } from "./asrMemory"
import { transcribeAsrWindows } from "./asrWindowTranscription"
import { createWhisperWindowDecoder } from "./whisperDecoding"
import { readAsrWindowCheckpoint, writeAsrWindowCheckpoint } from "./asrCheckpoints"
import { asrSpeechWindows } from "./asrDecoding"

let stopRequested = false
let pauseRequested = false
let resumeWait: (() => void) | null = null
let diagnosticsEnabled = false
let activeAsrAbortController: AbortController | null = null
let activePcmDigest: Promise<string> | null = null

const sendProgress = (stage: string, percent: number, downloadModel: string | null = null, downloadPercent: number | null = null, completedWindows?: number, totalWindows?: number, reusedWindows?: number): void => {
  const progress: BrowserAnalysisWorkerProgress = { kind: "progress", stage, percent, download_model: downloadModel, download_percent: downloadPercent,
    ...(completedWindows === undefined ? {} : { completed_windows: completedWindows }),
    ...(totalWindows === undefined ? {} : { total_windows: totalWindows }),
    ...(reusedWindows === undefined ? {} : { reused_windows: reusedWindows }),
  }
  self.postMessage({ kind: "progress", progress })
}

async function audioDigest(samples: Float32Array): Promise<string> {
  const bytes = samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength) as ArrayBuffer
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")
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
  const modelConfig = BROWSER_ASR_MODELS.find((model) => model.id === modelName)
  if (!modelConfig) throw new Error(`Unsupported ASR model: ${modelName}`)
  const artifact = modelConfig.artifacts[settings.precision]
  const base = ordinal * 88 / count + 8
  const span = 88 / count
  const dtype: BrowserInferenceDType = artifact.dtype[settings.device]
  const regions: BrowserSpeechInterval[] = settings.audio_regions.map((region) => ({
    type: region.region_type === "SPEECH" ? "speech" : "non_speech",
    start_ms: region.start_ms,
    end_ms: region.end_ms,
  }))
  if (!regions.some((region) => region.type === "speech")) {
    return { model_name: artifact.model_id, model_revision: artifact.revision, model_dtype: dtype, inference_device: settings.device, transcript: "", words: [] }
  }
  const windows = asrSpeechWindows(regions)
  const pcmDigest = await (activePcmDigest ??= audioDigest(settings.audio.samples))
  const checkpointIdentity = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({
    pcmDigest, model: artifact.model_id, revision: artifact.revision, dtype, device: settings.device,
    language: settings.asr_language ?? BROWSER_ASR_DEFAULT_LANGUAGE, task: BROWSER_ASR_TASK,
    policy: BROWSER_ASR_CHECKPOINT_POLICY_VERSION, windows: windows.map((window) => [window.start_ms, window.end_ms]),
    regions: regions.map((region) => [region.type, region.start_ms, region.end_ms]),
  })))
  const identity = [...new Uint8Array(checkpointIdentity)].map((value) => value.toString(16).padStart(2, "0")).join("")
  const checkpointPath = `asr-checkpoints/${identity}`
  let model: Awaited<ReturnType<typeof AutoModelForSpeechSeq2Seq.from_pretrained>> | null = null
  let loadingComplete = false
  let decoderPromise: Promise<ReturnType<typeof createWhisperWindowDecoder>> | null = null
  try {
    const getDecoder = () => decoderPromise ??= (async () => {
      sendProgress(`Loading ${artifact.model_id}`, base, artifact.model_id, 0)
      const sharedOptions = {
        revision: artifact.revision ?? undefined,
        progress_callback: (event: BrowserAsrProgressEvent) => {
          if (stopRequested) throw new DOMException("Analysis stopped", "AbortError")
          if (event.status === "progress") sendProgress(`Loading ${artifact.model_id}`, base, event.file ?? artifact.model_id, event.progress ?? null)
          if (event.status === "done") sendProgress(`Loading ${artifact.model_id}`, base + span * 0.03, event.file ?? artifact.model_id, 100)
        },
      }
      assertAsrMemoryPreflight(artifact, dtype, settings.device)
      model = await AutoModelForSpeechSeq2Seq.from_pretrained(artifact.model_id, {
        ...sharedOptions,
        device: settings.device,
        dtype,
        subfolder: artifact.subfolder,
        use_external_data_format: dtype === "fp32" ? artifact.external_data_format : undefined,
      })
      const tokenizer = await AutoTokenizer.from_pretrained(artifact.model_id, sharedOptions)
      const processor = await AutoProcessor.from_pretrained(artifact.model_id, sharedOptions)
      loadingComplete = true
      return createWhisperWindowDecoder({
        model: model as unknown as BrowserWhisperModel,
        tokenizer: tokenizer as unknown as BrowserWhisperTokenizer,
        processor: processor as unknown as BrowserWhisperProcessor,
        language: settings.asr_language ?? BROWSER_ASR_DEFAULT_LANGUAGE,
        onDiagnostic: diagnosticsEnabled ? (diagnostic) => console.info("MADNOLIA_ASR_DIAGNOSTIC", JSON.stringify({
          model: artifact.model_id,
          revision: artifact.revision,
          dtype,
          device: settings.device,
          ...diagnostic,
        })) : undefined,
      })
    })()
    const decode = async (samples: Float32Array, options: Parameters<ReturnType<typeof createWhisperWindowDecoder>>[1]) => (await getDecoder())(samples, options)
    const words = await transcribeAsrWindows(settings.audio.samples, regions, decode, {
      signal: activeAsrAbortController?.signal,
      loadCheckpoint: (index, window, contextHash) => readAsrWindowCheckpoint(settings.workspace, checkpointPath, index, identity, window, contextHash),
      saveCheckpoint: (index, window, rawWords, contextHash) => writeAsrWindowCheckpoint(settings.workspace, checkpointPath, index, identity, window, rawWords, contextHash),
      onBoundary: async ({ index, total }) => {
        await boundary()
        sendProgress(`Transcribing ${artifact.model_id}`, base + span * (0.08 + index / total * 0.91), null, null)
      },
      onProgress: ({ index, total, reused }) => {
        if (stopRequested) throw new DOMException("Analysis stopped", "AbortError")
        sendProgress(`Transcribing ${artifact.model_id}: ${reused} checkpoint windows reused; ${index - reused} completed this run`, base + span * (0.08 + index / total * 0.91), null, null, index, total, reused)
      },
    })
    return {
      model_name: artifact.model_id,
      model_revision: artifact.revision,
      model_dtype: dtype,
      inference_device: settings.device,
      transcript: words.map((word) => word.text).join(" ").trim(),
      words: words.map((word): BrowserAnalysisWord => ({ ...word, confidence: null })),
    }
  } catch (cause) {
    if (loadingComplete) throw cause
    const detail = cause instanceof Error ? cause.message : String(cause)
    if (dtype === "fp32" && settings.device === "wasm" && /memory|allocation|arraybuffer|out of memory|oom/iu.test(detail)) {
      throw new Error(`Failed to load ${artifact.model_id}@${artifact.revision ?? "main"} in FP32 on WASM because the browser could not reserve enough memory. No precision fallback was selected. You can explicitly select compact precision to use its configured dtype (${modelConfig.artifacts.compact.dtype[settings.device]}). Original error: ${detail}`, { cause })
    }
    throw new Error(`Failed to load ASR artifact ${artifact.model_id}@${artifact.revision ?? "main"} (${dtype}) for ${settings.precision} ${settings.device}: ${detail}`, { cause })
  } finally {
    try { await (model as Awaited<ReturnType<typeof AutoModelForSpeechSeq2Seq.from_pretrained>> | null)?.dispose() } catch { }
  }
}

async function run(settings: BrowserAnalysisWorkerSettings): Promise<void> {
  stopRequested = false
  pauseRequested = false
  activeAsrAbortController = new AbortController()
  diagnosticsEnabled = settings.asr_diagnostics === true
  activePcmDigest = null
  const supportsGpu = typeof navigator !== "undefined" && !!await (navigator as BrowserGpuNavigator).gpu?.requestAdapter()
  if (settings.device === "webgpu" && !supportsGpu) throw new Error("WebGPU is unavailable in this browser or device.")
  const device = settings.device === "webgpu" ? "webgpu" : "wasm"
  env.useCustomCache = true
  env.customCache = createWorkspaceModelCache(settings.workspace, settings.model_directory)
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
  const phones: BrowserPronunciation[] = transcript ? await pronounceBrowserWords(primary.words.map((word) => word.text), "AUTO") : []
  sendProgress("Aligning phonemes with CTC", 97, "qnighy/wav2vec2-xlsr-53-espeak-cv-ft-ONNX", 0)
  const sentences = buildBrowserSentences(primary.words, transcript)
  const phone_alignments = settings.alignment_mode === "ctc"
    ? await alignBrowserPhones(settings.audio.samples, primary.words, phones, sentences, settings.device, settings.precision, settings.workspace, settings.model_directory, boundary, (percent) => sendProgress("Aligning phonemes with CTC", 97 + percent * 0.02, "qnighy/wav2vec2-xlsr-53-espeak-cv-ft-ONNX", percent))
    : []
  const hubert_embeddings = settings.acoustic_units
    ? await extractBrowserHubertEmbeddings(settings.audio.samples, primary.words, phones, phone_alignments, settings.device, settings.precision, boundary, (percent) => sendProgress("Extracting HuBERT phone features", 99 + percent * 0.01, "Xenova/hubert-base-ls960", percent))
    : []
  const inferenceMetadata = {
    precision: settings.precision,
    asr_language: settings.asr_language ?? BROWSER_ASR_DEFAULT_LANGUAGE,
    asr_task: BROWSER_ASR_TASK,
    asr_models: candidates.map((candidate) => ({ model_name: candidate.model_name, model_revision: candidate.model_revision, dtype: candidate.model_dtype, device: candidate.inference_device, enabled: true } satisfies BrowserInferenceModelMetadata)),
    alignment: { model_name: BROWSER_CTC_MODEL, model_revision: BROWSER_CTC_REVISION, dtype: settings.precision === "baseline" ? "fp32" : device === "webgpu" ? "fp16" : "q4", device, enabled: settings.alignment_mode === "ctc" } satisfies BrowserInferenceModelMetadata,
    acoustic_units: { model_name: BROWSER_HUBERT_MODEL, model_revision: BROWSER_HUBERT_REVISION, dtype: settings.precision === "baseline" ? "fp32" : device === "webgpu" ? "fp16" : "q8", device, enabled: settings.acoustic_units } satisfies BrowserInferenceModelMetadata,
  }
  const record_id = settings.record_id
  const file_name = settings.filename
  const duration_ms = Math.round(settings.audio.samples.length * 1000 / BROWSER_ASR_SAMPLE_RATE)
  self.postMessage({
    kind: "complete",
    result: { record_id, file_name, nickname: settings.nickname, model_name: settings.model_name, duration_ms, transcript, words: primary.words, candidates, acoustic_units: settings.acoustic_units, phones, phone_alignments, hubert_embeddings, audio: settings.audio, media_path: `media/${file_name}`, video_width: settings.video_width, video_height: settings.video_height, inference_metadata: inferenceMetadata },
  })
}

async function runReprocess(settings: BrowserAnalysisReprocessSettings): Promise<void> {
  stopRequested = false
  pauseRequested = false
  const supportsGpu = typeof navigator !== "undefined" && !!await (navigator as BrowserGpuNavigator).gpu?.requestAdapter()
  if (settings.device === "webgpu" && !supportsGpu) throw new Error("WebGPU is unavailable in this browser or device.")
  env.useCustomCache = true
  env.customCache = createWorkspaceModelCache(settings.workspace, settings.model_directory)
  env.useBrowserCache = false
  env.useFSCache = false
  env.allowLocalModels = false
  const wasm = env.backends.onnx.wasm
  if (wasm) {
    wasm.numThreads = 1
    wasm.proxy = false
    wasm.wasmPaths = settings.device === "webgpu" ? { mjs: wasmJsepMjsUrl, wasm: wasmJsepUrl } : { mjs: wasmMjsUrl, wasm: wasmUrl }
  }
  const device = settings.device
  const dtype = (kind: "ctc" | "hubert"): BrowserInferenceDType => settings.precision === "baseline" ? "fp32" : device === "webgpu" ? "fp16" : kind === "ctc" ? "q4" : "q8"
  const words: BrowserAnalysisWord[] = settings.words.map((word) => ({ ...word }))
  const phones = settings.transcript.trim() ? await pronounceBrowserWords(words.map((word) => word.text), "AUTO") : []
  const sentences = buildBrowserSentences(words, settings.transcript)
  const phone_alignments = await alignBrowserPhones(settings.audio.samples, words, phones, sentences, device, settings.precision, settings.workspace, settings.model_directory, boundary, (percent) => sendProgress("CTC 발음 정렬", percent * (settings.acoustic_units ? 0.72 : 0.95), BROWSER_CTC_MODEL, percent))
  const hubert_embeddings = settings.acoustic_units
    ? await extractBrowserHubertEmbeddings(settings.audio.samples, words, phones, phone_alignments, device, settings.precision, boundary, (percent) => sendProgress("HuBERT 음향 특징 추출", 72 + percent * 0.28, BROWSER_HUBERT_MODEL, percent))
    : []
  const modelMetadata = (kind: "ctc" | "hubert"): BrowserInferenceModelMetadata => ({
    model_name: kind === "ctc" ? BROWSER_CTC_MODEL : BROWSER_HUBERT_MODEL,
    model_revision: kind === "ctc" ? BROWSER_CTC_REVISION : BROWSER_HUBERT_REVISION,
    dtype: dtype(kind), device, enabled: kind === "ctc" || settings.acoustic_units,
  })
  self.postMessage({ kind: "reprocessed", reprocess_result: {
    record_id: settings.record_id, phones, phone_alignments, hubert_embeddings,
    inference: { precision: settings.precision, alignment: modelMetadata("ctc"), acoustic_units: modelMetadata("hubert") },
  } })
}

self.onmessage = (event: MessageEvent<BrowserAnalysisWorkerRequest>) => {
  const message = event.data
  if (message.kind === "pause") { pauseRequested = true; return }
  if (message.kind === "resume") { pauseRequested = false; resumeWait?.(); return }
  if (message.kind === "stop") { stopRequested = true; activeAsrAbortController?.abort(); resumeWait?.(); return }
  void (message.kind === "reprocess" ? runReprocess(message.settings) : run(message.settings)).catch((error: unknown) => {
    const causes: string[] = []
    let current: unknown = error
    while (current instanceof Error && !causes.includes(current.message)) {
      causes.push(current.message)
      current = current.cause
    }
    if (current !== undefined && !(current instanceof Error)) causes.push(String(current))
    const messageText = causes.join("; caused by: ") || String(error)
    self.postMessage({ kind: "failure", message: messageText })
  })
}
