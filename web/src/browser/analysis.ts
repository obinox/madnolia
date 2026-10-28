import type {
  AnalysisJob,
  AnalysisOverview,
  AnalysisSettings,
  AnalysisSummary,
  AudioRegion,
  BrowserGpuNavigator,
  BrowserVideoIndexEntry,
  PhoneAcousticFeatures,
  PhoneOccurrence,
  TranscriptCandidate,
  TranscriptSentence,
  TranscriptWord,
} from "../types"
import type { BrowserAnalysisRecord } from "../types"
import type { BrowserAnalysisNicknameRequest, BrowserAnalysisWorkerComplete, BrowserAnalysisWorkerEvent, BrowserAnalysisWorkerProgress } from "../types/browserAnalysis"
import { BROWSER_ANALYSIS_JOB_PREFIX, BROWSER_ANALYSIS_JOB_PROGRESS_WRITE_INTERVAL_MS, BROWSER_ANALYSIS_PAUSE_STAGE, BROWSER_ANALYSIS_STORAGE_DIRECTORY, BROWSER_ASR_MODELS, BROWSER_MEDIA_STORAGE_DIRECTORY, BROWSER_VIDEO_INDEX } from "../browserAnalysisConstants"
import { BROWSER_ANALYSIS_RECORD_FILENAME } from "../browserConstants"
import { decodeMedia } from "./audio"
import { encodeWav, estimatePitch } from "./audioDsp"
import { pronounceBrowserText } from "./phonetics"
import { buildBrowserSentences, classifyBrowserAudio } from "./speechAnalysis"
import { deleteCachedModel, listCachedModels } from "./modelCache"
import { getWorkspaceHandle, listWorkspaceDirectories, readWorkspaceFile, readWorkspaceJson, writeWorkspaceFile, writeWorkspaceJson } from "./workspace"

const jobs = new Map<string, AnalysisJob>()
const workers = new Map<string, Worker>()
const preparation = new Map<string, AbortController>()
const jobWrites = new Map<string, Promise<void>>()
const jobWriteTimes = new Map<string, number>()
const jsonResponse = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })
const errorResponse = (error: unknown, status = 400): Response => jsonResponse({ detail: error instanceof Error ? error.message : String(error) }, status)

function updateJob(job: AnalysisJob): Promise<void> {
  jobs.set(job.job_id, job)
  const previous = jobWrites.get(job.job_id) ?? Promise.resolve()
  const terminal = ["complete", "failed", "stopped"].includes(job.status)
  const prior = jobs.get(job.job_id)
  const lastWrite = jobWriteTimes.get(job.job_id) ?? 0
  if (!terminal && prior && prior.status === job.status && prior.stage === job.stage
    && Date.now() - lastWrite < BROWSER_ANALYSIS_JOB_PROGRESS_WRITE_INTERVAL_MS) return previous
  jobWriteTimes.set(job.job_id, Date.now())
  const next = previous.catch(() => undefined).then(() => writeWorkspaceJson(`jobs/analysis-${job.job_id}.json`, job))
  jobWrites.set(job.job_id, next)
  void next.catch(() => undefined)
  if (terminal) return next
  return next
}

function phoneBoundaries(samples: Float32Array, sampleRate: number, startMs: number, endMs: number, count: number): number[] {
  const bounds = [startMs]
  const span = Math.max(0, endMs - startMs)
  const frameMs = 10
  const minimumMs = Math.min(frameMs, span / Math.max(1, count))
  for (let boundary = 1; boundary < count; boundary += 1) {
    const expected = startMs + span * boundary / count
    const radius = Math.max(frameMs, Math.min(40, span / count * 0.35))
    const from = Math.max(bounds.at(-1)! + minimumMs, expected - radius)
    const to = Math.min(endMs - minimumMs * (count - boundary), expected + radius)
    let bestMs = expected
    let bestEnergy = Infinity
    for (let candidate = from; candidate <= to; candidate += frameMs) {
      const first = Math.max(0, Math.floor(candidate * sampleRate / 1000))
      const last = Math.min(samples.length, Math.ceil((candidate + frameMs) * sampleRate / 1000))
      let energy = 0
      for (let index = first; index < last; index += 1) energy += (samples[index] ?? 0) ** 2
      energy /= Math.max(1, last - first)
      if (energy < bestEnergy) {
        bestEnergy = energy
        bestMs = candidate
      }
    }
    bounds.push(Math.max(bounds.at(-1)! + minimumMs, Math.min(endMs, bestMs)))
  }
  bounds.push(endMs)
  return bounds
}

function acousticVector(samples: Float32Array, sampleRate: number, startMs: number, endMs: number): number[] {
  const first = Math.max(0, Math.floor(startMs * sampleRate / 1000))
  const last = Math.min(samples.length, Math.ceil(endMs * sampleRate / 1000))
  let energy = 0
  let peak = 0
  let crossings = 0
  let previous = samples[first] ?? 0
  for (let index = first; index < last; index += 1) {
    const value = samples[index] ?? 0
    energy += value * value
    peak = Math.max(peak, Math.abs(value))
    if ((value < 0) !== (previous < 0)) crossings += 1
    previous = value
  }
  const length = Math.max(1, last - first)
  const rms = Math.sqrt(energy / length)
  const bins = 24
  let weightedFrequency = 0
  let totalMagnitude = 0
  const windowLength = Math.min(256, length)
  if (windowLength > 1) {
    for (let bin = 1; bin <= bins; bin += 1) {
      let real = 0
      let imaginary = 0
      for (let index = 0; index < windowLength; index += 1) {
        const value = samples[first + index] ?? 0
        const angle = 2 * Math.PI * bin * index / windowLength
        real += value * Math.cos(angle)
        imaginary -= value * Math.sin(angle)
      }
      const magnitude = Math.hypot(real, imaginary)
      weightedFrequency += bin * sampleRate / windowLength * magnitude
      totalMagnitude += magnitude
    }
  }
  return [20 * Math.log10(Math.max(1e-6, rms)), 20 * Math.log10(Math.max(1e-6, peak)), crossings / length, weightedFrequency / Math.max(1e-9, totalMagnitude)]
}

function assignAcousticUnits(features: PhoneAcousticFeatures[], vectors: number[][]): void {
  if (!features.length) return
  const dimensions = vectors[0].length
  const minima = Array.from({ length: dimensions }, (_, column) => Math.min(...vectors.map((vector) => vector[column])))
  const maxima = Array.from({ length: dimensions }, (_, column) => Math.max(...vectors.map((vector) => vector[column])))
  const normalized = vectors.map((vector) => vector.map((value, column) => (value - minima[column]) / Math.max(1e-9, maxima[column] - minima[column])))
  const count = Math.min(8, features.length)
  const centroids = Array.from({ length: count }, (_, index) => [...normalized[Math.floor(index * normalized.length / count)]])
  const groups = new Array(features.length).fill(0) as number[]
  for (let iteration = 0; iteration < 6; iteration += 1) {
    for (const [index, vector] of normalized.entries()) {
      groups[index] = centroids.reduce((best, centroid, candidate) => {
        const distance = vector.reduce((sum, value, column) => sum + (value - centroid[column]) ** 2, 0)
        const bestDistance = vector.reduce((sum, value, column) => sum + (value - centroids[best][column]) ** 2, 0)
        return distance < bestDistance ? candidate : best
      }, 0)
    }
    for (let cluster = 0; cluster < count; cluster += 1) {
      const members = normalized.filter((_, index) => groups[index] === cluster)
      if (members.length) centroids[cluster] = Array.from({ length: dimensions }, (_, column) => members.reduce((sum, vector) => sum + vector[column], 0) / members.length)
    }
  }
  features.forEach((feature, index) => { feature.acoustic_unit_id = groups[index] })
}

async function readVideoIndex(): Promise<Record<string, BrowserVideoIndexEntry>> {
  try { return await readWorkspaceJson(BROWSER_VIDEO_INDEX) }
  catch { return {} }
}

async function readVideoDimensions(file: File, signal?: AbortSignal): Promise<[number | null, number | null]> {
  if (signal?.aborted) return [null, null]
  if (!file.type.startsWith("video/") && !/\.(mp4|mov|webm|mkv|avi)$/iu.test(file.name)) return [null, null]
  const video = document.createElement("video")
  const url = URL.createObjectURL(file)
  video.preload = "metadata"
  try {
    return await new Promise((resolve) => {
      const timeout = window.setTimeout(() => resolve([null, null]), 10_000)
      const finish = (dimensions: [number | null, number | null]) => {
        window.clearTimeout(timeout)
        signal?.removeEventListener("abort", aborted)
        resolve(dimensions)
      }
      const aborted = () => finish([null, null])
      signal?.addEventListener("abort", aborted, { once: true })
      video.onloadedmetadata = () => finish([video.videoWidth || null, video.videoHeight || null])
      video.onerror = () => finish([null, null])
      video.src = url
    })
  } finally {
    video.removeAttribute("src")
    video.load()
    URL.revokeObjectURL(url)
  }
}

async function listAnalyses(): Promise<BrowserAnalysisRecord[]> {
  const ids = await listWorkspaceDirectories(BROWSER_ANALYSIS_STORAGE_DIRECTORY)
  const records = await Promise.all(ids.map((id) => readWorkspaceJson<BrowserAnalysisRecord>(`${BROWSER_ANALYSIS_STORAGE_DIRECTORY}/${id}/${BROWSER_ANALYSIS_RECORD_FILENAME}`)))
  return records.sort((left, right) => right.summary.created_at.localeCompare(left.summary.created_at))
}

async function writeRecord(result: BrowserAnalysisWorkerComplete): Promise<AnalysisSummary> {
  const filePath = result.media_path
  const analysisId = result.record_id
  const sourceId = analysisId
  const durationMs = result.duration_ms
  const source = {
    source_id: sourceId,
    path: filePath,
    duration_ms: durationMs,
    audio_sample_rate: result.audio.sampleRate,
    audio_channels: 1,
    video_width: result.video_width,
    video_height: result.video_height,
    video_fps: null,
  }
  const words: TranscriptWord[] = result.words.map((word) => ({ ...word }))
  const transcript = result.transcript.trim()
  const sentences = buildBrowserSentences(words, transcript)
  const sentenceByWord = new Map<number, number>()
  for (const sentence of sentences) for (let index = sentence.word_start_index; index < sentence.word_end_index; index += 1) sentenceByWord.set(index, sentence.sentence_index)
  const phones: PhoneOccurrence[] = []
  const acousticFeatures: PhoneAcousticFeatures[] = []
  const vectors: number[][] = []
  const pronunciations = result.phones.length ? result.phones : transcript ? pronounceBrowserText(transcript, "AUTO") : []
  const phoneByWord = new Map<number, typeof pronunciations>()
  for (const phone of pronunciations) phoneByWord.set(phone.word_index, [...(phoneByWord.get(phone.word_index) ?? []), phone])
  for (const [wordIndex, word] of words.entries()) {
    const wordPhones = phoneByWord.get(wordIndex) ?? []
    const boundaries = phoneBoundaries(result.audio.samples, result.audio.sampleRate, word.start_ms, word.end_ms, wordPhones.length)
    for (const [phoneIndex, phone] of wordPhones.entries()) {
      const startMs = Math.max(word.start_ms, Math.round(boundaries[phoneIndex]))
      const endMs = Math.min(word.end_ms, Math.max(startMs + 1, Math.round(boundaries[phoneIndex + 1])))
      const occurrenceId = crypto.randomUUID()
      phones.push({
        occurrence_id: occurrenceId,
        source_id: sourceId,
        sentence_index: sentenceByWord.get(wordIndex) ?? 0,
        word_index: wordIndex,
        grapheme: phone.grapheme,
        pronunciation: phone.ipa,
        phone_id: phone.phone_id,
        ipa: phone.ipa,
        start_ms: startMs,
        end_ms: endMs,
        confidence: null,
        alignment_method: "ESTIMATED_WORD",
        alignment_status: "LOW_CONFIDENCE",
      })
      const first = Math.max(0, Math.floor(startMs * result.audio.sampleRate / 1000))
      const last = Math.min(result.audio.samples.length, Math.max(first + 1, Math.ceil(endMs * result.audio.sampleRate / 1000)))
      const vector = acousticVector(result.audio.samples, result.audio.sampleRate, startMs, endMs)
      vectors.push(vector)
      const pitchFrames = estimatePitch(result.audio.samples.slice(first, last), result.audio.sampleRate).filter((frame) => frame.hz !== null)
      const pitches = pitchFrames.map((frame) => frame.hz as number).sort((left, right) => left - right)
      acousticFeatures.push({ occurrence_id: occurrenceId, rms_db: vector[0], peak_db: vector[1], f0_hz: pitches.length ? pitches[Math.floor(pitches.length / 2)] : null, voiced_probability: pitchFrames.length / Math.max(1, estimatePitch(result.audio.samples.slice(first, last), result.audio.sampleRate).length), acoustic_unit_id: null })
    }
  }
  if (result.acoustic_units) assignAcousticUnits(acousticFeatures, vectors)
  const candidates: TranscriptCandidate[] = result.candidates.map((item) => ({
    candidate_id: crypto.randomUUID(),
    model_name: item.model_name,
    transcript: item.transcript,
    language_probability: null,
    words: item.words,
    sentences: buildBrowserSentences(item.words, item.transcript),
  }))
  const overview: AnalysisOverview = {
    source_id: sourceId,
    transcript,
    audio_regions: classifyBrowserAudio(result.audio.samples, result.audio.sampleRate, durationMs),
    sentences,
    words,
    transcript_candidates: candidates,
    word_count: words.length,
    phone_count: phones.length,
  }
  const summary: AnalysisSummary = {
    analysis_id: analysisId,
    created_at: new Date().toISOString(),
    model_name: result.model_name,
    nickname: result.nickname.trim() || null,
    source,
  }
  const record: BrowserAnalysisRecord = {
    summary,
    source,
    overview,
    phones,
    acoustic_features: acousticFeatures,
    audio_path: `analyses/${analysisId}/audio.wav`,
    media_path: filePath,
  }
  await writeWorkspaceFile(record.audio_path, encodeWav(result.audio))
  await writeWorkspaceJson(`analyses/${analysisId}/${BROWSER_ANALYSIS_RECORD_FILENAME}`, record)
  return summary
}

async function prepareJob(job: AnalysisJob, settings: AnalysisSettings): Promise<void> {
  const controller = new AbortController()
  preparation.set(job.job_id, controller)
  try {
    const videoIndex = await readVideoIndex()
    const entry = videoIndex[settings.filename]
    if (!entry) throw new Error("The selected media file is missing from the workspace.")
    const file = await readWorkspaceFile(entry.path)
    updateJob({ ...job, stage: "Preparing audio", percent: 1 })
    const [video_width, video_height] = await readVideoDimensions(file, controller.signal)
    if (controller.signal.aborted) return
    const audio = await decodeMedia(file, controller.signal, (percent, stage) => {
      const current = jobs.get(job.job_id)
      if (current && current.status !== "stopped") updateJob({ ...current, stage, percent: Math.max(1, Math.round(percent * 0.08)) })
    })
    if (controller.signal.aborted || jobs.get(job.job_id)?.status === "stopped") return
    preparation.delete(job.job_id)
    const worker = new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module" })
    workers.set(job.job_id, worker)
    worker.onmessage = (event: MessageEvent<BrowserAnalysisWorkerEvent>) => {
      if (event.data.kind === "progress" && event.data.progress) {
        const progress = event.data.progress
        const paused = progress.stage === BROWSER_ANALYSIS_PAUSE_STAGE
        const current = jobs.get(job.job_id)!
        updateJob({ ...current, status: paused ? "paused" : current.status === "stopping" ? "stopping" : "running", stage: progress.stage, percent: Math.max(8, progress.percent), download_model: progress.download_model, download_percent: progress.download_percent })
      }
      if (event.data.kind === "complete" && event.data.result) {
        void writeRecord(event.data.result).then(async (summary) => {
          const current = jobs.get(job.job_id)
          if (!current || ["stopped", "failed"].includes(current.status)) return
          await updateJob({ ...current, status: "complete", stage: "Complete", percent: 100, analysis_id: summary.analysis_id, error: null, download_model: null, download_percent: null })
        }).catch((error: unknown) => {
          if (!(["stopped", "failed"].includes(jobs.get(job.job_id)?.status ?? ""))) failJob(job.job_id, error)
        })
        worker.terminate()
        workers.delete(job.job_id)
      }
      if (event.data.kind === "failure") {
        const failed = jobs.get(job.job_id)!
        const stopped = failed.status === "stopping" || event.data.message === "Analysis stopped"
        updateJob({ ...failed, status: stopped ? "stopped" : "failed", stage: stopped ? "Stopped" : "Failed", error: stopped ? null : event.data.message ?? "Analysis failed", download_model: null, download_percent: null })
        worker.terminate()
        workers.delete(job.job_id)
      }
    }
    worker.onerror = (event) => failJob(job.job_id, new Error(event.message || "Analysis worker failed"))
    worker.postMessage({ kind: "start", settings: { job_id: job.job_id, filename: settings.filename, nickname: settings.nickname, model_name: settings.model_name, candidate_models: settings.candidate_models, acoustic_units: settings.acoustic_units, device: settings.device as "webgpu" | "wasm", audio, workspace: getWorkspaceHandle(), video_width, video_height } })
  } catch (error) {
    if (jobs.get(job.job_id)?.status !== "stopped") failJob(job.job_id, error)
    preparation.delete(job.job_id)
  }
}

function failJob(jobId: string, error: unknown): void {
  const job = jobs.get(jobId)
  if (!job) return
  updateJob({ ...job, status: "failed", stage: "Failed", error: error instanceof Error ? error.message : String(error), download_model: null, download_percent: null })
  workers.get(jobId)?.terminate()
  workers.delete(jobId)
}

async function savedJob(jobId: string): Promise<AnalysisJob | null> {
  if (jobs.has(jobId)) return jobs.get(jobId)!
  try {
    const job = await readWorkspaceJson<AnalysisJob>(`jobs/analysis-${jobId}.json`)
    if (["running", "pausing", "paused", "stopping"].includes(job.status)) {
      const interrupted = { ...job, status: "failed" as const, stage: "Interrupted when the page closed", error: "The browser tab closed before analysis completed.", download_model: null, download_percent: null }
      updateJob(interrupted)
      return interrupted
    }
    return job
  }
  catch { return null }
}

async function detectAnalysisDevice(): Promise<"webgpu" | "wasm"> {
  const gpu = (navigator as BrowserGpuNavigator).gpu
  if (!gpu) return "wasm"
  try { return await gpu.requestAdapter() ? "webgpu" : "wasm" }
  catch { return "wasm" }
}

async function handleUpload(init?: RequestInit): Promise<Response> {
  if (!(init?.body instanceof FormData)) throw new Error("A media file is required.")
  const file = init.body.get("file")
  if (!(file instanceof File) || !file.name.trim()) throw new Error("A media file is required.")
  const index = await readVideoIndex()
  const extension = file.name.match(/\.[^.]+$/u)?.[0] ?? ""
  const stem = file.name.slice(0, file.name.length - extension.length).replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^[._]+|[._]+$/gu, "") || "media"
  let filename = file.name
  while (index[filename]) filename = `${stem}-${crypto.randomUUID().slice(0, 8)}${extension}`
  const path = `${BROWSER_MEDIA_STORAGE_DIRECTORY}/${filename}`
  await writeWorkspaceFile(path, file, init?.signal ?? undefined)
  index[filename] = { path, type: file.type || "application/octet-stream", size: file.size }
  await writeWorkspaceJson(BROWSER_VIDEO_INDEX, index)
  return jsonResponse({ filename })
}

export async function handleBrowserAnalysisRequest(path: string, init?: RequestInit): Promise<Response | null> {
  const url = new URL(path, window.location.origin)
  const pathname = url.pathname
  const method = (init?.method ?? "GET").toUpperCase()
  const parts = pathname.split("/").filter(Boolean)
  const decode = (value: string) => decodeURIComponent(value)
  try {
    if (method === "POST" && pathname === "/api/videos") return await handleUpload(init)
    if (method === "GET" && pathname === "/api/videos") return jsonResponse(Object.keys(await readVideoIndex()).sort())
    if (method === "GET" && pathname === "/api/analysis-hardware") return jsonResponse({ backend: "transformers-js", device: await detectAnalysisDevice(), gpu_vendor: null })
    if (method === "GET" && pathname === "/api/browser-models") return jsonResponse(await listCachedModels())
    if (method === "DELETE" && parts[1] === "browser-models" && parts[2]) {
      await deleteCachedModel(decode(parts[2]))
      return jsonResponse({ ok: true })
    }
    if (method === "GET" && pathname === "/api/analyses") return jsonResponse((await listAnalyses()).map((record) => record.summary))
    if (method === "PUT" && parts[1] === "analyses" && parts[3] === "nickname") {
      const id = decode(parts[2])
      const record = await readWorkspaceJson<BrowserAnalysisRecord>(`analyses/${id}/${BROWSER_ANALYSIS_RECORD_FILENAME}`)
      if (typeof init?.body !== "string") throw new Error("A nickname is required.")
      const body = JSON.parse(init.body) as BrowserAnalysisNicknameRequest
      record.summary.nickname = (body.nickname ?? "").trim() || null
      await writeWorkspaceJson(`analyses/${id}/${BROWSER_ANALYSIS_RECORD_FILENAME}`, record)
      return jsonResponse(record.summary)
    }
    if (method === "POST" && pathname === "/api/analyses") {
      if (typeof init?.body !== "string") throw new Error("Analysis settings are required.")
      const settings = JSON.parse(init.body) as AnalysisSettings
    const validModels = new Set<string>(BROWSER_ASR_MODELS.map((model) => model.id))
      if (!settings.filename || !validModels.has(settings.model_name) || !["webgpu", "wasm"].includes(settings.device)
        || (settings.candidate_models ?? []).some((model) => !validModels.has(model) || model === settings.model_name)) {
        throw new Error("Invalid browser analysis settings.")
      }
      const active = [...jobs.values()].some((job) => ["running", "pausing", "paused", "stopping"].includes(job.status))
      if (active) return jsonResponse({ detail: "An analysis is already running." }, 409)
      const jobId = `${BROWSER_ANALYSIS_JOB_PREFIX}${crypto.randomUUID()}`
      const job: AnalysisJob = { job_id: jobId, status: "running", filename: settings.filename, percent: 0, stage: "Queued", analysis_id: null, error: null, download_model: settings.model_name, download_percent: 0 }
      updateJob(job)
      void prepareJob(job, settings)
      return jsonResponse({ job_id: jobId })
    }
    if (parts[1] === "analysis-jobs" && parts[2]) {
      const jobId = decode(parts[2])
      const job = await savedJob(jobId)
      if (!job) return jsonResponse({ detail: "Job not found" }, 404)
      if (method === "GET") return jsonResponse(job)
      if (method === "POST" && parts[3]) {
        const action = parts[3]
        const worker = workers.get(jobId)
        if (!worker && !(action === "stop" && preparation.has(jobId)) || !["running", "pausing", "paused", "stopping"].includes(job.status)) return jsonResponse({ detail: "Job cannot be controlled in this state." }, 409)
        if (action === "pause" && job.status === "running") {
          worker?.postMessage({ kind: "pause" })
          const next = { ...job, status: "pausing" as const, stage: "Pausing at chunk boundary" }
          updateJob(next)
          return jsonResponse(next)
        }
        if (action === "resume" && ["pausing", "paused"].includes(job.status)) {
          worker?.postMessage({ kind: "resume" })
          const next = { ...job, status: "running" as const, stage: "Resuming" }
          updateJob(next)
          return jsonResponse(next)
        }
        if (action === "stop" && ["running", "pausing", "paused"].includes(job.status)) {
          if (worker) worker.postMessage({ kind: "stop" })
          else {
            preparation.get(jobId)?.abort()
            preparation.delete(jobId)
            const stopped = { ...job, status: "stopped" as const, stage: "Stopped", error: null }
            updateJob(stopped)
            return jsonResponse(stopped)
          }
          const next = { ...job, status: "stopping" as const, stage: "Stopping at chunk boundary" }
          updateJob(next)
          return jsonResponse(next)
        }
        return jsonResponse({ detail: "Job cannot be controlled in this state." }, 409)
      }
    }
    if (method === "GET" && pathname === "/api/browser-model-cache") return jsonResponse(await listCachedModels())
    if (method === "DELETE" && parts[1] === "browser-model-cache" && parts[2]) {
      await deleteCachedModel(decode(parts[2]))
      return jsonResponse({ ok: true })
    }
    return null
  } catch (error) {
    return errorResponse(error)
  }
}
