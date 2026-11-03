import type {
  AnalysisJob,
  AnalysisOverview,
  AnalysisSettings,
  AnalysisSummary,
  AudioRegion,
  BrowserAnalysisMediaIdentity,
  BrowserGpuNavigator,
  BrowserVideoIndexEntry,
  BrowserProjectRecord,
  PhoneAcousticFeatures,
  PhoneOccurrence,
  TranscriptCandidate,
  TranscriptSentence,
  TranscriptWord,
} from "../types"
import type { BrowserAnalysisRecord } from "../types"
import type { BrowserAcousticUnitCentroids, BrowserAnalysisActiveLease, BrowserAnalysisNicknameRequest, BrowserAnalysisReprocessJob, BrowserAnalysisReprocessRequest, BrowserAnalysisReprocessResult, BrowserAnalysisWorkerComplete, BrowserAnalysisWorkerEvent, BrowserAnalysisWorkerProgress, BrowserAnalysisWorkerRequest, BrowserIndexedPronunciation, BrowserReprocessPublishUpdate, BrowserReprocessedPhones } from "../types/browserAnalysis"
import { BROWSER_ACOUSTIC_UNIT_CENTROIDS_FILENAME, BROWSER_ANALYSIS_ACTIVE_LEASE_KEY, BROWSER_ANALYSIS_ACTIVE_LEASE_RENEW_MS, BROWSER_ANALYSIS_ACTIVE_LEASE_TTL_MS, BROWSER_ANALYSIS_INTERRUPTED_STAGE, BROWSER_ANALYSIS_JOB_PREFIX, BROWSER_ANALYSIS_JOB_PROGRESS_WRITE_INTERVAL_MS, BROWSER_ANALYSIS_PAUSE_STAGE, BROWSER_ANALYSIS_STORAGE_DIRECTORY, BROWSER_ASR_DEFAULT_LANGUAGE, BROWSER_ASR_LANGUAGES, BROWSER_ASR_MODELS, BROWSER_ASR_SAMPLE_RATE, BROWSER_HUBERT_CLUSTER_COUNT, BROWSER_HUBERT_CLUSTER_PASSES, BROWSER_HUBERT_EMBEDDING_DIMENSIONS, BROWSER_HUBERT_MODEL, BROWSER_HUBERT_REVISION, BROWSER_MEDIA_STORAGE_DIRECTORY, BROWSER_VIDEO_INDEX } from "../browserAnalysisConstants"
import { BROWSER_ANALYSIS_RECORD_FILENAME, BROWSER_PROJECT_RECORD_FILENAME } from "../browserConstants"
import { decodeMedia } from "./audio"
import { encodeWav, resampleLinear } from "./audioDsp"
import { analyzePhoneAcousticFeatures } from "./phoneAcousticFeatures"
import { pronounceBrowserWords } from "./phonetics"
import { browserAnalysisLeaseAllowsJob, browserAnalysisLeaseIsLiveForJob, indexStablePhoneOccurrences, mayCommitReprocessing, takeStableOccurrenceId, updateProjectAnalysisSnapshot, withBrowserReprocessingMetadata } from "./analysisReprocessing"
import { buildBrowserSentences } from "./speechAnalysis"
import { detectSileroSpeech } from "./sileroVad"
import { getOrProbeSourceVideoMetadata } from "./videoMetadata"
import { hubertLinspaceSeeds } from "./hubertClustering"
import { deleteCachedModel, listCachedModels } from "./modelCache"
import { analysisModelSelections, analysisReprocessModelSelections, getModelFolderHandle, getModelReadiness } from "./modelStorage"
import { getWorkspaceHandle, listWorkspaceDirectories, readWorkspaceFile, readWorkspaceJson, writeWorkspaceFile, writeWorkspaceJson } from "./workspace"
import { recoverReprocessTransaction, transactionalPublish } from "./reprocessTransactions"
export { recoverReprocessTransaction } from "./reprocessTransactions"

const jobs = new Map<string, AnalysisJob>()
const workers = new Map<string, Worker>()
const preparation = new Map<string, AbortController>()
const jobWrites = new Map<string, Promise<void>>()
const jobWriteTimes = new Map<string, number>()
const reprocessJobs = new Map<string, BrowserAnalysisReprocessJob>()
const reprocessWorkers = new Map<string, Worker>()
const reprocessControllers = new Map<string, AbortController>()
const reprocessJobWrites = new Map<string, Promise<void>>()
const leaseTimers = new Map<string, number>()
const leaseOwnerId = crypto.randomUUID()
let analysisMutationActive = false
const jsonResponse = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })
const errorResponse = (error: unknown, status = 400): Response => jsonResponse({ detail: error instanceof Error ? error.message : String(error) }, status)

function activeLease(): BrowserAnalysisActiveLease | null {
  try {
    const raw = localStorage.getItem(BROWSER_ANALYSIS_ACTIVE_LEASE_KEY)
    if (!raw) return null
    const lease = JSON.parse(raw) as BrowserAnalysisActiveLease
    return typeof lease.job_id === "string" && Number.isFinite(lease.expires_at) && lease.expires_at > Date.now() ? { ...lease, owner_id: typeof lease.owner_id === "string" ? lease.owner_id : "legacy" } : null
  } catch { return null }
}

function acquireActiveLease(jobId: string): boolean {
  try {
    const current = activeLease()
    if (!browserAnalysisLeaseAllowsJob(current, jobId, leaseOwnerId, Date.now())) return false
    const renew = () => {
      const latest = activeLease()
      if (latest && (latest.job_id !== jobId || latest.owner_id !== leaseOwnerId)) return
      localStorage.setItem(BROWSER_ANALYSIS_ACTIVE_LEASE_KEY, JSON.stringify({ job_id: jobId, owner_id: leaseOwnerId, expires_at: Date.now() + BROWSER_ANALYSIS_ACTIVE_LEASE_TTL_MS } satisfies BrowserAnalysisActiveLease))
    }
    renew()
    const claimed = activeLease()
    if (claimed?.job_id !== jobId || claimed.owner_id !== leaseOwnerId) return false
    if (!leaseTimers.has(jobId)) leaseTimers.set(jobId, window.setInterval(renew, BROWSER_ANALYSIS_ACTIVE_LEASE_RENEW_MS))
  } catch { }
  return true
}

function releaseActiveLease(jobId: string): void {
  const timer = leaseTimers.get(jobId)
  if (timer !== undefined) window.clearInterval(timer)
  leaseTimers.delete(jobId)
  try { const lease = activeLease(); if (lease?.job_id === jobId && lease.owner_id === leaseOwnerId) localStorage.removeItem(BROWSER_ANALYSIS_ACTIVE_LEASE_KEY) } catch { }
}

function updateJob(job: AnalysisJob): Promise<void> {
  const prior = jobs.get(job.job_id)
  jobs.set(job.job_id, job)
  const previous = jobWrites.get(job.job_id) ?? Promise.resolve()
  const terminal = ["complete", "failed", "stopped"].includes(job.status)
  const lastWrite = jobWriteTimes.get(job.job_id) ?? 0
  if (!terminal && prior && prior.status === job.status && prior.stage === job.stage
    && Date.now() - lastWrite < BROWSER_ANALYSIS_JOB_PROGRESS_WRITE_INTERVAL_MS) return previous
  jobWriteTimes.set(job.job_id, Date.now())
  const next = previous.catch(() => undefined).then(() => writeWorkspaceJson(`jobs/analysis-${job.job_id}.json`, job))
  jobWrites.set(job.job_id, next)
  void next.catch(() => undefined)
  if (terminal) return next.then(() => { if (["complete", "failed", "stopped"].includes(jobs.get(job.job_id)?.status ?? "")) releaseActiveLease(job.job_id) })
  return next
}

function assignAcousticUnits(features: PhoneAcousticFeatures[], vectors: number[][]): number[][] {
  const validIndices = vectors.flatMap((vector, index) => vector.length && vector.every(Number.isFinite) && vector.some((value) => value !== 0) ? [index] : [])
  if (!features.length || !validIndices.length) return []
  const dimensions = vectors[validIndices[0]].length
  const count = Math.min(BROWSER_HUBERT_CLUSTER_COUNT, validIndices.length)
  const centroids = hubertLinspaceSeeds(validIndices.length, count).map((offset) => [...vectors[validIndices[offset]]])
  const totals = new Array(count).fill(1) as number[]
  const assign = (vector: number[]): number => centroids.reduce((best, centroid, candidate) => {
    let distance = 0
    let bestDistance = 0
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      distance += (vector[dimension] - centroid[dimension]) ** 2
      bestDistance += (vector[dimension] - centroids[best][dimension]) ** 2
    }
    return distance < bestDistance ? candidate : best
  }, 0)
  for (let pass = 0; pass < BROWSER_HUBERT_CLUSTER_PASSES; pass += 1) {
    for (let start = 0; start < validIndices.length; start += 1024) {
      const batch = validIndices.slice(start, start + 1024)
      const groups = new Map<number, number[][]>()
      for (const index of batch) {
        const group = assign(vectors[index])
        groups.set(group, [...(groups.get(group) ?? []), vectors[index]])
      }
      for (const [group, members] of groups) {
        const nextTotal = totals[group] + members.length
        for (let dimension = 0; dimension < dimensions; dimension += 1) {
          centroids[group][dimension] = (centroids[group][dimension] * totals[group] + members.reduce((sum, vector) => sum + vector[dimension], 0)) / nextTotal
        }
        totals[group] = nextTotal
      }
    }
  }
  const valid = new Set(validIndices)
  features.forEach((feature, index) => { feature.acoustic_unit_id = valid.has(index) ? assign(vectors[index]) : null })
  return centroids
}

async function readVideoIndex(): Promise<Record<string, BrowserVideoIndexEntry>> {
  try { return await readWorkspaceJson(BROWSER_VIDEO_INDEX) }
  catch { return {} }
}

function buildReprocessedPhones(record: BrowserAnalysisRecord, result: BrowserAnalysisReprocessResult, audio: Awaited<ReturnType<typeof decodeMedia>>): BrowserReprocessedPhones {
  const pronunciations = result.phones
  const words = record.overview.words
  const sentences = record.overview.sentences
  const sentenceByWord = new Map<number, number>()
  for (const sentence of sentences) for (let index = sentence.word_start_index; index < sentence.word_end_index; index += 1) sentenceByWord.set(index, sentence.sentence_index)
  const priorByIdentity = indexStablePhoneOccurrences(record.phones)
  const byWord = new Map<number, BrowserIndexedPronunciation[]>()
  pronunciations.forEach((phone, phone_index) => byWord.set(phone.word_index, [...(byWord.get(phone.word_index) ?? []), { phone, phone_index }]))
  const phones: PhoneOccurrence[] = []
  const vectors: number[][] = []
  for (const [wordIndex, word] of words.entries()) {
    const wordPhones = byWord.get(wordIndex) ?? []
    const weights = wordPhones.map(({ phone }) => phone.phone_id.includes(".vowel.") ? 1 : 0.65)
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
    let accumulatedWeight = 0
    const estimates = [word.start_ms]
    for (const weight of weights.slice(0, -1)) { accumulatedWeight += weight; estimates.push(word.start_ms + Math.round((word.end_ms - word.start_ms) * accumulatedWeight / Math.max(1e-9, totalWeight))) }
    estimates.push(word.end_ms)
    for (const [offset, { phone, phone_index: phoneIndex }] of wordPhones.entries()) {
      const alignment = result.phone_alignments.find((item) => item.phone_index === phoneIndex)
      const aligned = typeof alignment?.start_ms === "number" && typeof alignment.end_ms === "number"
      const startMs = aligned ? alignment.start_ms! : estimates[offset]
      const endMs = Math.max(startMs + 1, aligned ? alignment.end_ms! : estimates[offset + 1])
      phones.push({ occurrence_id: takeStableOccurrenceId(priorByIdentity, phone) ?? crypto.randomUUID(), source_id: record.source.source_id, sentence_index: sentenceByWord.get(wordIndex) ?? 0, word_index: wordIndex, grapheme: phone.grapheme, pronunciation: phone.ipa, phone_id: phone.phone_id, ipa: phone.ipa, start_ms: startMs, end_ms: endMs, confidence: aligned ? alignment!.confidence : null, alignment_method: "CTC_FORCED", alignment_status: alignment?.status ?? "MISSING" })
      vectors.push(result.hubert_embeddings[phoneIndex] ?? [])
    }
  }
  const acousticFeatures = analyzePhoneAcousticFeatures(audio.samples, audio.sampleRate, phones)
  const centroids = result.inference.acoustic_units.enabled ? assignAcousticUnits(acousticFeatures, vectors) : []
  return { phones, acousticFeatures, centroids }
}

async function publishReprocessed(record: BrowserAnalysisRecord, result: BrowserAnalysisReprocessResult, audio: Awaited<ReturnType<typeof decodeMedia>>): Promise<void> {
  const { phones, acousticFeatures, centroids } = buildReprocessedPhones(record, result, audio)
  const transactionId = crypto.randomUUID()
  const backupArchivePath = (path: string): string => {
    const [collection, id, ...rest] = path.split("/")
    return `${collection}/${id}/reprocess-backups/${transactionId}/${rest.join("/")}`
  }
  const updated: BrowserAnalysisRecord = {
    ...withBrowserReprocessingMetadata(record, result, new Date().toISOString()),
    phones,
    overview: { ...record.overview, phone_count: phones.length },
    acoustic_features: acousticFeatures,
    acoustic_units_path: result.inference.acoustic_units.enabled ? `${BROWSER_ANALYSIS_STORAGE_DIRECTORY}/${record.summary.analysis_id}/${BROWSER_ACOUSTIC_UNIT_CENTROIDS_FILENAME}` : null,
  }
  const recordPath = `analyses/${record.summary.analysis_id}/${BROWSER_ANALYSIS_RECORD_FILENAME}`
  const updates: BrowserReprocessPublishUpdate[] = [{ path: recordPath, backup_archive_path: backupArchivePath(recordPath), data: new Blob([JSON.stringify(updated, null, 2)], { type: "application/json" }) }]
  if (result.inference.acoustic_units.enabled) {
    const centroidRecord: BrowserAcousticUnitCentroids = { model_name: BROWSER_HUBERT_MODEL, model_revision: BROWSER_HUBERT_REVISION, dimensions: BROWSER_HUBERT_EMBEDDING_DIMENSIONS, cluster_count: centroids.length, centroids }
    updates.push({ path: updated.acoustic_units_path!, backup_archive_path: backupArchivePath(updated.acoustic_units_path!), data: new Blob([JSON.stringify(centroidRecord, null, 2)], { type: "application/json" }) })
  } else if (record.acoustic_units_path) updates.push({ path: record.acoustic_units_path, backup_archive_path: backupArchivePath(record.acoustic_units_path), delete_after: true })
  const projects = await listWorkspaceDirectories("projects")
  for (const projectId of projects) {
    try {
      const project = await readWorkspaceJson<BrowserProjectRecord>(`projects/${projectId}/${BROWSER_PROJECT_RECORD_FILENAME}`)
      if (!project.analysis_ids.includes(record.summary.analysis_id)) continue
      const projectPath = `projects/${projectId}/${BROWSER_PROJECT_RECORD_FILENAME}`
      const updatedProject = updateProjectAnalysisSnapshot(project, updated)
      updates.push({ path: projectPath, backup_archive_path: backupArchivePath(projectPath), data: new Blob([JSON.stringify(updatedProject, null, 2)], { type: "application/json" }) })
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError") && !(error instanceof SyntaxError)) throw error
    }
  }
  await transactionalPublish(transactionId, updates)
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
  await recoverReprocessTransaction()
  const ids = await listWorkspaceDirectories(BROWSER_ANALYSIS_STORAGE_DIRECTORY)
  const records = await Promise.all(ids.map((id) => readWorkspaceJson<BrowserAnalysisRecord>(`${BROWSER_ANALYSIS_STORAGE_DIRECTORY}/${id}/${BROWSER_ANALYSIS_RECORD_FILENAME}`)))
  return records.sort((left, right) => right.summary.created_at.localeCompare(left.summary.created_at))
}

async function writeRecord(result: BrowserAnalysisWorkerComplete, audioRegions: AudioRegion[], videoFps: number | null = null): Promise<AnalysisSummary> {
  const filePath = result.media_path
  const analysisId = result.record_id
  try {
    const existing = await readWorkspaceJson<BrowserAnalysisRecord>(`analyses/${analysisId}/${BROWSER_ANALYSIS_RECORD_FILENAME}`)
    if (existing?.summary?.analysis_id === analysisId && existing.source?.source_id === analysisId
      && Array.isArray(existing.overview?.words) && Array.isArray(existing.phones)) return existing.summary
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError") && !(error instanceof SyntaxError)) throw error
  }
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
    video_fps: videoFps,
  }
  const words: TranscriptWord[] = result.words.map((word) => ({ ...word }))
  const transcript = result.transcript.trim()
  const sentences = buildBrowserSentences(words, transcript)
  const sentenceByWord = new Map<number, number>()
  for (const sentence of sentences) for (let index = sentence.word_start_index; index < sentence.word_end_index; index += 1) sentenceByWord.set(index, sentence.sentence_index)
  const phones: PhoneOccurrence[] = []
  const acousticFeatures: PhoneAcousticFeatures[] = []
  const vectors: number[][] = []
  const pronunciations = result.phones.length ? result.phones : transcript ? await pronounceBrowserWords(words.map((word) => word.text), "AUTO") : []
  const phoneByWord = new Map<number, BrowserIndexedPronunciation[]>()
  pronunciations.forEach((phone, phoneIndex) => phoneByWord.set(phone.word_index, [...(phoneByWord.get(phone.word_index) ?? []), { phone, phone_index: phoneIndex }]))
  for (const [wordIndex, word] of words.entries()) {
    const wordPhones = phoneByWord.get(wordIndex) ?? []
    const weights = wordPhones.map(({ phone }) => phone.phone_id.includes(".vowel.") ? 1 : 0.65)
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
    let accumulatedWeight = 0
    const estimates = [word.start_ms]
    for (const weight of weights.slice(0, -1)) {
      accumulatedWeight += weight
      estimates.push(word.start_ms + Math.round((word.end_ms - word.start_ms) * accumulatedWeight / Math.max(1e-9, totalWeight)))
    }
    estimates.push(word.end_ms)
    for (const [phoneOffset, { phone, phone_index: phoneIndex }] of wordPhones.entries()) {
      const alignment = result.phone_alignments.find((item) => item.phone_index === phoneIndex)
      const alignedStart = alignment?.start_ms
      const alignedEnd = alignment?.end_ms
      const aligned = typeof alignedStart === "number" && typeof alignedEnd === "number"
      const startMs = aligned ? alignedStart : estimates[phoneOffset]
      const endMs = Math.max(startMs + 1, aligned ? alignedEnd : estimates[phoneOffset + 1])
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
        confidence: alignment?.confidence ?? null,
        alignment_method: result.phone_alignments.length ? "CTC_FORCED" : "ESTIMATED_WORD",
        alignment_status: alignment?.status ?? (result.phone_alignments.length ? "MISSING" : "LOW_CONFIDENCE"),
      })
      vectors.push(result.hubert_embeddings[phoneIndex] ?? [])
    }
  }
  acousticFeatures.push(...analyzePhoneAcousticFeatures(result.audio.samples, result.audio.sampleRate, phones))
  const centroids = result.acoustic_units ? assignAcousticUnits(acousticFeatures, vectors) : []
  const acousticUnitsPath = result.acoustic_units ? `${BROWSER_ANALYSIS_STORAGE_DIRECTORY}/${analysisId}/${BROWSER_ACOUSTIC_UNIT_CENTROIDS_FILENAME}` : null
  if (acousticUnitsPath) {
    const centroidRecord: BrowserAcousticUnitCentroids = {
      model_name: BROWSER_HUBERT_MODEL,
      model_revision: BROWSER_HUBERT_REVISION,
      dimensions: BROWSER_HUBERT_EMBEDDING_DIMENSIONS,
      cluster_count: centroids.length,
      centroids,
    }
    await writeWorkspaceJson(acousticUnitsPath, centroidRecord)
  }
  const candidates: TranscriptCandidate[] = result.candidates.map((item) => ({
    candidate_id: crypto.randomUUID(),
    model_name: item.model_name,
    model_revision: item.model_revision,
    model_dtype: item.model_dtype,
    inference_device: item.inference_device,
    transcript: item.transcript,
    language_probability: null,
    words: item.words,
    sentences: buildBrowserSentences(item.words, item.transcript),
  }))
  const overview: AnalysisOverview = {
    source_id: sourceId,
    transcript,
    audio_regions: audioRegions,
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
    acoustic_units_path: acousticUnitsPath,
    inference_metadata: result.inference_metadata,
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
    const modelFolder = getModelFolderHandle()
    const videoIndex = await readVideoIndex()
    const entry = videoIndex[settings.filename]
    if (!entry) throw new Error("The selected media file is missing from the workspace.")
    const file = await readWorkspaceFile(entry.path)
    updateJob({ ...job, stage: "Preparing audio", percent: 1 })
    const isVideo = file.type.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi)$/iu.test(file.name)
    const metadata = isVideo ? await getOrProbeSourceVideoMetadata(file, controller.signal) : null
    const fallbackDimensions = metadata ? [metadata.width, metadata.height] as [number | null, number | null] : await readVideoDimensions(file, controller.signal)
    const [video_width, video_height] = fallbackDimensions
    if (controller.signal.aborted) return
    const audio = await decodeMedia(file, controller.signal, (percent, stage) => {
      const current = jobs.get(job.job_id)
      if (current && current.status !== "stopped") updateJob({ ...current, stage, percent: Math.max(1, Math.round(percent * 0.08)) })
    })
    if (controller.signal.aborted || jobs.get(job.job_id)?.status === "stopped") return
    updateJob({ ...job, stage: "Detecting speech", percent: 7 })
    const speechIntervals = await detectSileroSpeech(audio.samples, {}, {
      signal: controller.signal,
      onProgress: ({ completedSamples, totalSamples }) => {
        const current = jobs.get(job.job_id)
        if (!current || current.status === "stopped") return
        const ratio = totalSamples > 0 ? completedSamples / totalSamples : 1
        updateJob({ ...current, stage: "Detecting speech", percent: Math.min(8, 7 + Math.round(ratio)) })
      },
    })
    if (controller.signal.aborted || jobs.get(job.job_id)?.status === "stopped") return
    preparation.delete(job.job_id)
    const audioRegions: AudioRegion[] = speechIntervals.map((interval) => ({
      region_type: interval.type === "speech" ? "SPEECH" : "NON_SPEECH",
      start_ms: interval.start_ms,
      end_ms: interval.end_ms,
    }))
    const worker = new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module" })
    workers.set(job.job_id, worker)
    worker.onmessage = (event: MessageEvent<BrowserAnalysisWorkerEvent>) => {
      if (event.data.kind === "progress" && event.data.progress) {
        const progress = event.data.progress
        const paused = progress.stage === BROWSER_ANALYSIS_PAUSE_STAGE
        const current = jobs.get(job.job_id)!
        updateJob({ ...current, status: paused ? "paused" : current.status === "stopping" ? "stopping" : "running", stage: progress.stage, percent: Math.max(8, progress.percent), download_model: progress.download_model, download_percent: progress.download_percent,
          completed_windows: progress.completed_windows ?? current.completed_windows,
          total_windows: progress.total_windows ?? current.total_windows,
          reused_windows: progress.reused_windows ?? current.reused_windows,
        })
      }
      if (event.data.kind === "complete" && event.data.result) {
        void writeRecord(event.data.result, audioRegions, metadata?.fps ?? null).then(async (summary) => {
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
    const request: BrowserAnalysisWorkerRequest = {
      kind: "start",
      settings: {
        job_id: job.job_id,
        record_id: job.record_id!,
        filename: settings.filename,
        nickname: settings.nickname,
        model_name: settings.model_name,
        asr_diagnostics: new URLSearchParams(location.search).has("asr-diagnostics"),
        asr_language: settings.asr_language ?? BROWSER_ASR_DEFAULT_LANGUAGE,
        candidate_models: settings.candidate_models,
        acoustic_units: settings.acoustic_units,
        alignment_mode: settings.alignment_mode,
        precision: settings.precision,
        device: settings.device as "webgpu" | "wasm",
        audio,
        audio_regions: audioRegions,
        workspace: getWorkspaceHandle(),
        model_directory: getModelFolderHandle(),
        video_width,
        video_height,
      },
    }
    worker.postMessage(request)
  } catch (error) {
    if (jobs.get(job.job_id)?.status !== "stopped") failJob(job.job_id, error)
  } finally {
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
      const lease = activeLease()
      if (browserAnalysisLeaseIsLiveForJob(lease, jobId, Date.now())) return job
      const interrupted = { ...job, status: "failed" as const, interrupted_stage: job.stage, stage: BROWSER_ANALYSIS_INTERRUPTED_STAGE, error: "페이지가 닫히기 전에 분석이 완료되지 않았습니다.", download_model: null, download_percent: null }
      updateJob(interrupted)
      return interrupted
    }
    return job
  }
  catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null
    if (error instanceof SyntaxError) return null
    throw error
  }
}

function validSettings(settings: AnalysisSettings): boolean {
  const validModels = new Set<string>(BROWSER_ASR_MODELS.map((model) => model.id))
  return !!settings.filename && validModels.has(settings.model_name)
    && (settings.asr_language === undefined || BROWSER_ASR_LANGUAGES.includes(settings.asr_language))
    && ["webgpu", "wasm"].includes(settings.device) && ["estimated", "ctc"].includes(settings.alignment_mode)
    && ["baseline", "compact"].includes(settings.precision)
    && (settings.candidate_models ?? []).every((model) => validModels.has(model) && model !== settings.model_name)
}

async function validateResumeResources(job: AnalysisJob): Promise<AnalysisSettings> {
  const settings = job.settings
  if (!settings || !job.record_id || !job.media_identity) throw new Error("This saved job does not contain resumable settings.")
  if (!validSettings(settings)) throw new Error("Saved analysis settings are invalid. Dismiss this job and start a new analysis.")
  const index = await readVideoIndex()
  const media = index[settings.filename]
  if (!media || media.path !== job.media_identity.path || media.size !== job.media_identity.size || media.type !== job.media_identity.type) {
    throw new Error("The saved media file is missing or has changed in the workspace.")
  }
  const file = await readWorkspaceFile(media.path)
  if (file.size !== job.media_identity.size || file.lastModified !== job.media_identity.last_modified || (file.type || media.type) !== job.media_identity.type) throw new Error("The saved media file is missing or has changed in the workspace.")
  const folder = getModelFolderHandle()
  if (!folder) throw new Error("Connect the model folder and prepare the saved models before resuming.")
  const readiness = await Promise.all(analysisModelSelections(settings).map((selection) => getModelReadiness(selection, folder)))
  const unavailable = readiness.findIndex((status) => !status.ready)
  if (unavailable >= 0) throw new Error(`Selected model is not ready. ${readiness[unavailable].message} Prepare the saved models before resuming.`)
  return settings
}

async function hasActiveJob(): Promise<boolean> {
  if (activeLease()) return true
  if (workers.size || preparation.size || reprocessWorkers.size || reprocessControllers.size) return true
  return [...jobs.values()].some((job) => ["running", "pausing", "paused", "stopping"].includes(job.status) && (workers.has(job.job_id) || preparation.has(job.job_id)))
}

async function detectAnalysisDevice(): Promise<"webgpu" | "wasm"> {
  const gpu = (navigator as BrowserGpuNavigator).gpu
  if (!gpu) return "wasm"
  try { return await gpu.requestAdapter() ? "webgpu" : "wasm" }
  catch { return "wasm" }
}

function updateReprocessJob(job: BrowserAnalysisReprocessJob): Promise<void> {
  reprocessJobs.set(job.job_id, job)
  const previous = reprocessJobWrites.get(job.job_id) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(() => writeWorkspaceJson(`jobs/reprocess-${job.job_id}.json`, job))
  reprocessJobWrites.set(job.job_id, next)
  return next.then(() => {
    if (reprocessJobWrites.get(job.job_id) === next) reprocessJobWrites.delete(job.job_id)
    if (job.status !== "running" && reprocessJobs.get(job.job_id)?.status !== "running") releaseActiveLease(job.job_id)
  }, (error) => {
    if (reprocessJobWrites.get(job.job_id) === next) reprocessJobWrites.delete(job.job_id)
    throw error
  })
}

async function startReprocess(body: BrowserAnalysisReprocessRequest): Promise<BrowserAnalysisReprocessJob> {
  if (!body.analysis_id || !["baseline", "compact"].includes(body.precision) || !["webgpu", "wasm"].includes(body.device) || typeof body.acoustic_units !== "boolean") throw new Error("재처리 설정이 올바르지 않습니다.")
  if ([...reprocessJobs.values()].some((job) => job.status === "running")) throw new Error("이미 분석 재처리가 실행 중입니다.")
  if (await hasActiveJob()) throw new Error("기존 분석 작업이 실행 중입니다.")
  const record = await readWorkspaceJson<BrowserAnalysisRecord>(`analyses/${body.analysis_id}/${BROWSER_ANALYSIS_RECORD_FILENAME}`)
  if (record.summary.analysis_id !== body.analysis_id || !Array.isArray(record.overview.words) || !record.audio_path) throw new Error("재처리할 저장 분석이 올바르지 않습니다.")
  const folder = getModelFolderHandle()
  if (!folder) throw new Error("모델 폴더를 연결한 뒤 CTC 및 선택한 HuBERT 모델을 준비하세요.")
  const selections = analysisReprocessModelSelections(body.precision, body.device, body.acoustic_units)
  for (const selection of selections) {
    const readiness = await getModelReadiness(selection, folder)
    if (!readiness.ready) throw new Error(`필요한 모델이 준비되지 않았습니다. ${readiness.message}`)
  }
  const jobId = crypto.randomUUID()
  if (!acquireActiveLease(jobId)) throw new Error("다른 탭에서 분석 작업이 실행 중입니다.")
  const job: BrowserAnalysisReprocessJob = { job_id: jobId, analysis_id: body.analysis_id, status: "running", stage: "저장 오디오 준비", percent: 1, error: null }
  try { await updateReprocessJob(job) }
  catch (error) { reprocessJobs.delete(jobId); releaseActiveLease(jobId); throw error }
  const controller = new AbortController()
  reprocessControllers.set(jobId, controller)
  void (async () => {
    let worker: Worker | null = null
    try {
      const file = await readWorkspaceFile(record.audio_path)
      const decoded = await decodeMedia(file, controller.signal)
      const samples = decoded.sampleRate === BROWSER_ASR_SAMPLE_RATE ? decoded.samples : resampleLinear(decoded.samples, decoded.sampleRate, BROWSER_ASR_SAMPLE_RATE)
      if (controller.signal.aborted) throw new DOMException("재처리가 취소되었습니다.", "AbortError")
      const current = reprocessJobs.get(jobId)
      if (!current || current.status !== "running") return
      await updateReprocessJob({ ...current, stage: "CTC/HuBERT 모델 실행", percent: 5 })
      if (controller.signal.aborted || reprocessJobs.get(jobId)?.status !== "running") return
      worker = new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module" })
      reprocessWorkers.set(jobId, worker)
      worker.onmessage = (event: MessageEvent<BrowserAnalysisWorkerEvent>) => {
        if (event.data.kind === "progress" && event.data.progress) {
          const progress = event.data.progress
          const currentJob = reprocessJobs.get(jobId)
          if (currentJob?.status === "running" && !currentJob.stage.startsWith("원본 저장")) void updateReprocessJob({ ...currentJob, stage: progress.stage, percent: Math.max(5, Math.round(progress.percent)) })
        }
        if (event.data.kind === "reprocessed" && event.data.reprocess_result) {
          const currentJob = reprocessJobs.get(jobId)
          if (!currentJob || !mayCommitReprocessing(currentJob)) return
          const committing = { ...currentJob, stage: "원본 저장 및 프로젝트 갱신", percent: 95 }
          reprocessJobs.set(jobId, committing)
          void updateReprocessJob(committing).then(async () => {
            if (reprocessJobs.get(jobId)?.status !== "running") return
            await publishReprocessed(record, event.data.reprocess_result!, { samples, sampleRate: BROWSER_ASR_SAMPLE_RATE })
          }).then(async () => {
            const currentJob = reprocessJobs.get(jobId)
            if (currentJob?.status === "running") await updateReprocessJob({ ...currentJob, status: "complete", stage: "재처리 완료", percent: 100 })
          }).catch(async (error: unknown) => {
            const currentJob = reprocessJobs.get(jobId)
            if (currentJob) await updateReprocessJob({ ...currentJob, status: "failed", stage: "저장 실패", error: error instanceof Error ? error.message : String(error) })
          }).finally(() => {
            worker?.terminate()
            reprocessWorkers.delete(jobId)
            reprocessControllers.delete(jobId)
          })
        }
        if (event.data.kind === "failure") {
          const currentJob = reprocessJobs.get(jobId)
          if (currentJob?.status === "running" && !currentJob.stage.startsWith("원본 저장")) void updateReprocessJob({ ...currentJob, status: event.data.message?.includes("stopped") || controller.signal.aborted ? "stopped" : "failed", stage: controller.signal.aborted ? "재처리 취소" : "재처리 실패", error: controller.signal.aborted ? null : event.data.message ?? "재처리에 실패했습니다." })
          worker?.terminate()
          reprocessWorkers.delete(jobId)
          reprocessControllers.delete(jobId)
        }
      }
      worker.onerror = (event) => {
        const currentJob = reprocessJobs.get(jobId)
        if (currentJob?.status === "running" && !currentJob.stage.startsWith("원본 저장")) void updateReprocessJob({ ...currentJob, status: "failed", stage: "재처리 실패", error: event.message || "재처리 작업자가 실패했습니다." })
        worker?.terminate()
        reprocessWorkers.delete(jobId)
        reprocessControllers.delete(jobId)
      }
      const request: BrowserAnalysisWorkerRequest = { kind: "reprocess", settings: {
        job_id: jobId, record_id: body.analysis_id, transcript: record.overview.transcript,
        words: record.overview.words, precision: body.precision, device: body.device,
        acoustic_units: body.acoustic_units, audio: { samples, sampleRate: BROWSER_ASR_SAMPLE_RATE },
        workspace: getWorkspaceHandle(), model_directory: folder,
      } }
      worker.postMessage(request)
    } catch (error) {
      const currentJob = reprocessJobs.get(jobId)
      if (currentJob?.status === "running") await updateReprocessJob({ ...currentJob, status: controller.signal.aborted ? "stopped" : "failed", stage: controller.signal.aborted ? "재처리 취소" : "재처리 실패", error: controller.signal.aborted ? null : error instanceof Error ? error.message : String(error) })
      worker?.terminate()
      reprocessWorkers.delete(jobId)
      reprocessControllers.delete(jobId)
    }
  })()
  return job
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
  await recoverReprocessTransaction()
  const url = new URL(path, window.location.origin)
  const pathname = url.pathname
  const method = (init?.method ?? "GET").toUpperCase()
  const parts = pathname.split("/").filter(Boolean)
  const decode = (value: string) => decodeURIComponent(value)
  const mutatingAnalysis = method === "POST" && (pathname === "/api/analyses" || (parts[1] === "analysis-jobs" && parts[3] === "retry") || (parts[1] === "analyses" && parts[3] === "reprocess") || (parts[1] === "analysis-reprocess" && parts[3] === "stop"))
  if (mutatingAnalysis && analysisMutationActive) return jsonResponse({ detail: "An analysis is already starting or resuming." }, 409)
  if (mutatingAnalysis) analysisMutationActive = true
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
    if (method === "POST" && parts[1] === "analyses" && parts[3] === "reprocess") {
      if (typeof init?.body !== "string") throw new Error("재처리 설정이 필요합니다.")
      const body = JSON.parse(init.body) as BrowserAnalysisReprocessRequest
      const job = await startReprocess({ ...body, analysis_id: decode(parts[2]) })
      return jsonResponse(job)
    }
    if (parts[1] === "analysis-reprocess" && parts[2]) {
      const jobId = decode(parts[2])
      const job = reprocessJobs.get(jobId)
      if (!job) return jsonResponse({ detail: "재처리 작업을 찾을 수 없습니다." }, 404)
      if (method === "GET") return jsonResponse(job)
      if (method === "POST" && parts[3] === "stop" && job.status === "running") {
        if (job.stage.startsWith("원본 저장")) return jsonResponse({ detail: "원본 분석을 저장하는 중에는 취소할 수 없습니다." }, 409)
        reprocessControllers.get(jobId)?.abort()
        reprocessWorkers.get(jobId)?.terminate()
        reprocessWorkers.delete(jobId)
        reprocessControllers.delete(jobId)
        const stopped = { ...job, status: "stopped" as const, stage: "재처리 취소", error: null }
        await updateReprocessJob(stopped)
        return jsonResponse(stopped)
      }
    }
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
      if (!validSettings(settings)) {
        throw new Error("Invalid browser analysis settings.")
      }
      const modelFolder = getModelFolderHandle()
      if (!modelFolder) throw new Error("Connect the model folder and prepare the selected models before analysis.")
      const readiness = await Promise.all(analysisModelSelections(settings).map((selection) => getModelReadiness(selection, modelFolder)))
      const unavailable = readiness.findIndex((status) => !status.ready)
      if (unavailable >= 0) throw new Error(`Selected model is not ready. ${readiness[unavailable].message} Prepare the selected models before analysis.`)
      if (await hasActiveJob() || [...reprocessJobs.values()].some((job) => job.status === "running")) return jsonResponse({ detail: "An analysis or reprocessing job is already running." }, 409)
      const jobId = `${BROWSER_ANALYSIS_JOB_PREFIX}${crypto.randomUUID()}`
      const media = (await readVideoIndex())[settings.filename]
      if (!media) throw new Error("The selected media file is missing from the workspace.")
      const mediaFile = await readWorkspaceFile(media.path)
      const media_identity: BrowserAnalysisMediaIdentity = { path: media.path, type: mediaFile.type || media.type, size: mediaFile.size, last_modified: mediaFile.lastModified }
      if (!acquireActiveLease(jobId)) return jsonResponse({ detail: "다른 탭에서 분석 작업이 실행 중입니다." }, 409)
      const job: AnalysisJob = {
        job_id: jobId, status: "running", filename: settings.filename, percent: 0, stage: "Queued", analysis_id: null,
        error: null, download_model: null, download_percent: null, settings: { ...settings, candidate_models: [...settings.candidate_models] },
        record_id: crypto.randomUUID(), media_identity,
      }
      try { await updateJob(job) }
      catch (error) { jobs.delete(jobId); releaseActiveLease(jobId); throw error }
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
        if (action === "retry" && ["failed", "stopped"].includes(job.status)) {
          try {
            const record = await readWorkspaceJson<BrowserAnalysisRecord>(`analyses/${job.record_id}/${BROWSER_ANALYSIS_RECORD_FILENAME}`)
            if (record.summary.analysis_id === job.record_id) {
              const complete = { ...job, status: "complete" as const, stage: "Complete", percent: 100, analysis_id: job.record_id, error: null }
              await updateJob(complete)
              return jsonResponse(complete)
            }
          } catch (error) {
            if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error
          }
          const settings = await validateResumeResources(job)
          if (await hasActiveJob()) return jsonResponse({ detail: "An analysis is already running." }, 409)
          const retry: AnalysisJob = { ...job, status: "running", stage: "Queued for resume", error: null, download_model: null, download_percent: null }
          if (!acquireActiveLease(retry.job_id)) return jsonResponse({ detail: "다른 탭에서 분석 작업이 실행 중입니다." }, 409)
          try { await updateJob(retry) }
          catch (error) { jobs.delete(retry.job_id); releaseActiveLease(retry.job_id); throw error }
          void prepareJob(retry, settings)
          return jsonResponse(retry)
        }
        if (action === "retry" && job.status === "complete") return jsonResponse(job)
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
  } finally {
    if (mutatingAnalysis) analysisMutationActive = false
  }
}
