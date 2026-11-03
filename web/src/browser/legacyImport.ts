import type { CompositionProject, MediaSource, ProjectManifest, TranscriptCandidate, TranscriptSentence, TranscriptWord } from "../types"
import type { BrowserAnalysisRecord, BrowserLegacyImportProgress, BrowserLegacyImportSummary, BrowserProjectRecord } from "../types"
import type { BrowserLegacyImportComposition, BrowserLegacyImportedAnalysis, BrowserLegacyJson } from "../types/browserImport"
import { BROWSER_ANALYSIS_RECORD_FILENAME, BROWSER_LEGACY_IMPORT_DIRECTORY, BROWSER_PROJECT_RECORD_FILENAME } from "../browserConstants"
import type { BrowserVideoIndexEntry } from "../types/browser"
import { BROWSER_VIDEO_INDEX } from "../browserAnalysisConstants"
import { readWorkspaceJson, removeWorkspaceEntry, writeWorkspaceFile, writeWorkspaceJson } from "./workspace"
import { getOrProbeSourceVideoMetadata } from "./videoMetadata"
import { MAX_CROSSFADE_MS, MIN_STRETCH_PERCENT, PROFESSIONAL_BEATS_PER_BAR_DEFAULT, PROFESSIONAL_BEAT_DIVISION_DEFAULT, PROFESSIONAL_GRID_OFFSET_UNITS_DEFAULT, PROFESSIONAL_TEMPO_DEFAULT_BPM } from "../constants"

const objectValue = (value: unknown, label: string): BrowserLegacyJson => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Python project data: ${label} must be an object.`)
  return value as BrowserLegacyJson
}

const stringValue = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid Python project data: ${label} is missing.`)
  return value
}

const arrayValue = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`Invalid Python project data: ${label} must be an array.`)
  return value
}

const normalizedParts = (base: string[], relative: string): string[] => {
  if (!relative || /^[\\/]|^[A-Za-z]:/u.test(relative)) throw new Error("Python project contains an absolute file path; import requires paths inside the selected data folder.")
  const result = [...base]
  for (const part of relative.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (!result.length) throw new Error("Python project file path escapes the selected data folder.")
      result.pop()
    } else result.push(part)
  }
  return result
}

async function directoryAt(root: FileSystemDirectoryHandle, parts: string[]): Promise<FileSystemDirectoryHandle> {
  let current = root
  for (const part of parts) current = await current.getDirectoryHandle(part)
  return current
}

async function fileAt(root: FileSystemDirectoryHandle, parts: string[]): Promise<File> {
  const parent = await directoryAt(root, parts.slice(0, -1))
  return (await parent.getFileHandle(parts.at(-1)!)).getFile()
}

async function optionalFileAt(root: FileSystemDirectoryHandle, base: string[], relative: string): Promise<File | null> {
  try { return await fileAt(root, normalizedParts(base, relative)) }
  catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null
    throw error
  }
}

async function readJson(file: File, label: string): Promise<BrowserLegacyJson> {
  try { return objectValue(JSON.parse(await file.text()), label) }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid Python project data:")) throw error
    throw new Error(`Unable to read ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function optionalDirectory(directory: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle | null> {
  try { return await directory.getDirectoryHandle(name) }
  catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null
    throw error
  }
}

async function optionalDirectoryAt(root: FileSystemDirectoryHandle, parts: string[]): Promise<FileSystemDirectoryHandle | null> {
  try { return await directoryAt(root, parts) }
  catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null
    throw error
  }
}

async function parseCentroids(file: File): Promise<number[][]> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length < 10 || bytes[0] !== 0x93 || new TextDecoder().decode(bytes.slice(1, 6)) !== "NUMPY") throw new Error("Python centroid file is not a supported NPY array.")
  const major = bytes[6]
  const headerLengthSize = major === 1 ? 2 : major === 2 || major === 3 ? 4 : 0
  if (!headerLengthSize || bytes.length < 8 + headerLengthSize) throw new Error("Python centroid NPY version is unsupported.")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const headerLength = headerLengthSize === 2 ? view.getUint16(8, true) : view.getUint32(8, true)
  const dataOffset = 8 + headerLengthSize + headerLength
  const header = new TextDecoder("ascii").decode(bytes.slice(8 + headerLengthSize, dataOffset))
  const descriptor = /['"]descr['"]\s*:\s*['"]([<>=|])([fiu])(4|8)['"]/u.exec(header)
  const dimensions = /['"]shape['"]\s*:\s*\((\d+)\s*,\s*(\d+)\s*,?\s*\)/u.exec(header)
  if (!descriptor || !dimensions || /['"]fortran_order['"]\s*:\s*True/u.test(header)) throw new Error("Python centroid array must be a C-order two-dimensional float32/float64 NPY.")
  if (descriptor[2] !== "f") throw new Error("Python centroid array must contain floating-point values.")
  if (descriptor[1] === "|") throw new Error("Python centroid array has unsupported byte order.")
  const itemBytes = Number(descriptor[3])
  const rows = Number(dimensions[1])
  const columns = Number(dimensions[2])
  if (columns !== 768 || rows < 0 || dataOffset + rows * columns * itemBytes > bytes.length) throw new Error("Python centroid NPY shape does not match its data.")
  if (!rows) return []
  const littleEndian = descriptor[1] === "<" || descriptor[1] === "=" && new Uint8Array(new Uint16Array([1]).buffer)[0] === 1
  const centroids = Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => {
    const offset = dataOffset + (row * columns + column) * itemBytes
    return itemBytes === 4 ? view.getFloat32(offset, littleEndian) : view.getFloat64(offset, littleEndian)
  }))
  if (centroids.some((row) => row.some((value) => !Number.isFinite(value)))) throw new Error("Python centroid array contains invalid numeric values.")
  return centroids
}

function convertedRecord(
  sourceData: BrowserLegacyJson,
  analysisData: BrowserLegacyJson,
  manifest: BrowserLegacyJson,
  analysisId: string,
  sourceId: string,
  audioPath: string,
  mediaPath: string,
): BrowserAnalysisRecord {
  const originalSource = objectValue(sourceData, "analysis source")
  const source = { ...originalSource, source_id: sourceId } as unknown as MediaSource
  const words = arrayValue(analysisData.words, "analysis words") as TranscriptWord[]
  const sentences = arrayValue(analysisData.sentences, "analysis sentences") as TranscriptSentence[]
  const phoneItems = arrayValue(analysisData.phones, "analysis phones").map((value) => {
    const phone = objectValue(value, "phone")
    return { ...phone, source_id: sourceId, sentence_index: typeof phone.sentence_index === "number" ? phone.sentence_index : -1, alignment_status: phone.alignment_status ?? "ESTIMATED" }
  })
  const candidateItems = arrayValue(analysisData.transcript_candidates ?? [], "transcript candidates") as TranscriptCandidate[]
  const acousticFeatures = arrayValue(analysisData.acoustic_features ?? [], "acoustic features") as BrowserAnalysisRecord["acoustic_features"]
  const transcript = typeof analysisData.transcript === "string" ? analysisData.transcript : stringValue(analysisData.transcript, "analysis transcript")
  const modelName = typeof manifest.model_name === "string" ? manifest.model_name : "legacy-python"
  const createdAt = typeof manifest.created_at === "string" ? manifest.created_at : new Date().toISOString()
  const regions = arrayValue(analysisData.audio_regions ?? [], "audio regions") as BrowserAnalysisRecord["overview"]["audio_regions"]
  return {
    summary: { analysis_id: analysisId, created_at: createdAt, model_name: modelName, nickname: typeof manifest.nickname === "string" ? manifest.nickname : null, source },
    source,
    overview: {
      source_id: sourceId,
      transcript,
      audio_regions: regions,
      sentences,
      words,
      transcript_candidates: candidateItems,
      word_count: words.length,
      phone_count: phoneItems.length,
    },
    phones: phoneItems as unknown as BrowserAnalysisRecord["phones"],
    acoustic_features: acousticFeatures,
    audio_path: audioPath,
    media_path: mediaPath,
  }
}

async function collectPythonAnalysis(
  dataRoot: FileSystemDirectoryHandle,
  directoryParts: string[],
  projectId: string,
  manifest: BrowserLegacyJson,
): Promise<BrowserLegacyImportedAnalysis[]> {
  const sourceById = new Map(arrayValue(manifest.sources, "project sources").map((value) => {
    const source = objectValue(value, "project source")
    return [stringValue(source.source_id, "source id"), source] as const
  }))
  let analysisPaths = Array.isArray(manifest.analysis_files) ? manifest.analysis_files.map((path) => stringValue(path, "analysis file path")) : []
  if (!analysisPaths.length) {
    const analysisDirectory = await optionalDirectory(await directoryAt(dataRoot, directoryParts), "analysis")
    if (analysisDirectory) {
      analysisPaths = []
      for await (const [name, entry] of analysisDirectory.entries()) if (entry.kind === "file" && name.toLowerCase().endsWith(".json")) analysisPaths.push(`analysis/${name}`)
    }
  }
  if (!analysisPaths.length) throw new Error(`Python project ${projectId} has no JSON analysis files.`)
  const imported: BrowserLegacyImportedAnalysis[] = []
  for (const relativeAnalysisPath of analysisPaths) {
    const analysisFile = await fileAt(dataRoot, normalizedParts(directoryParts, relativeAnalysisPath))
    const analysisData = await readJson(analysisFile, relativeAnalysisPath)
    const originalSource = objectValue(analysisData.source, "analysis source")
    const oldSourceId = stringValue(originalSource.source_id, "analysis source id")
    const sourceData = sourceById.get(oldSourceId) ?? originalSource
    const newSourceId = crypto.randomUUID()
    const newAnalysisId = crypto.randomUUID()
    const audioMap = objectValue(manifest.audio_files ?? {}, "project audio files")
    const audioRelativePath = typeof audioMap[oldSourceId] === "string" ? audioMap[oldSourceId] as string : `audio/${oldSourceId}.wav`
    const audio = await optionalFileAt(dataRoot, directoryParts, audioRelativePath)
    if (!audio) throw new Error(`Missing Python audio for ${oldSourceId}. Choose the full data folder that includes cache/audio, or relink the audio before importing.`)
    const sourcePath = typeof sourceData.path === "string" ? sourceData.path : `${oldSourceId}.wav`
    const normalizedSourcePath = sourcePath.replaceAll("\\", "/")
    const mediaFilename = (normalizedSourcePath.split("/").at(-1) || `${oldSourceId}.wav`).replace(/[\u0000-\u001f<>:"|?*]/gu, "_").slice(0, 180)
    const relativeSourcePath = /^[A-Za-z]:|^\//u.test(normalizedSourcePath) ? null : normalizedSourcePath.replace(/^data\//u, "")
    let video: File | null = null
    if (relativeSourcePath) {
      try { video = await optionalFileAt(dataRoot, [], relativeSourcePath) }
      catch (error) { if (!(error instanceof Error && error.message.includes("escapes the selected data folder"))) throw error }
    }
    if (!video) video = await optionalFileAt(dataRoot, ["input", "videos"], mediaFilename)
    const mediaPath = video ? `media/${newAnalysisId}-${mediaFilename}` : ""
    const record = convertedRecord(sourceData, analysisData, manifest, newAnalysisId, newSourceId, `analyses/${newAnalysisId}/audio.wav`, mediaPath)
    if (video && (video.type.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi)$/iu.test(video.name))) {
      const metadata = await getOrProbeSourceVideoMetadata(video)
      if (metadata) {
        record.source.video_width = metadata.width
        record.source.video_height = metadata.height
        record.source.video_fps = metadata.fps
        record.summary.source = record.source
      }
    }
    imported.push({
      old_project_id: projectId,
      new_project_id: crypto.randomUUID(),
      old_source_id: oldSourceId,
      new_source_id: newSourceId,
      old_analysis_id: projectId,
      new_analysis_id: newAnalysisId,
      record,
      audio,
      media: video,
      media_name: mediaFilename,
    })
  }
  return imported
}

async function preserveLegacyFile(dataRoot: FileSystemDirectoryHandle, directoryParts: string[], relativePath: string | null, destinationPath: string): Promise<boolean> {
  if (!relativePath) return false
  const file = await optionalFileAt(dataRoot, directoryParts, relativePath)
  if (!file) return false
  await writeWorkspaceFile(destinationPath, file)
  return true
}

async function preserveDirectoryTree(directory: FileSystemDirectoryHandle, destinationPath: string, relativeParts: string[] = []): Promise<number> {
  let copied = 0
  for await (const [name, entry] of directory.entries()) {
    const next = [...relativeParts, name]
    if (entry.kind === "directory") copied += await preserveDirectoryTree(entry as FileSystemDirectoryHandle, destinationPath, next)
    else {
      const file = await (entry as FileSystemFileHandle).getFile()
      await writeWorkspaceFile(`${destinationPath}/${next.join("/")}`, file)
      copied += 1
    }
  }
  return copied
}

async function preserveVersionHistory(dataRoot: FileSystemDirectoryHandle, directoryParts: string[], newProjectId: string): Promise<number> {
  const versions = await optionalDirectory(await directoryAt(dataRoot, directoryParts), "versions")
  if (!versions) return 0
  return preserveDirectoryTree(versions, `${BROWSER_LEGACY_IMPORT_DIRECTORY}/${newProjectId}/analysis-versions`)
}

async function rollbackImport(paths: string[]): Promise<void> {
  for (const path of paths.reverse()) {
    try { await removeWorkspaceEntry(path) } catch { }
  }
}

async function collectLegacyCompositions(
  dataRoot: FileSystemDirectoryHandle,
  roots: Array<[string, string[]]>,
): Promise<BrowserLegacyImportComposition[]> {
  const compositions: BrowserLegacyImportComposition[] = []
  for (const [projectId, parts] of roots) {
    if (!(await optionalFileAt(dataRoot, parts, "project.json"))) continue
    const root = await directoryAt(dataRoot, parts)
    const compositionDirectory = await optionalDirectory(root, "compositions")
    if (!compositionDirectory) continue
    for await (const [name, entry] of compositionDirectory.entries()) {
      if (entry.kind !== "file" || !name.toLowerCase().endsWith(".json")) continue
      const handle = entry as FileSystemFileHandle
      const composition = await readJson(await handle.getFile(), `${projectId}/compositions/${name}`)
      const compositionId = stringValue(composition.composition_id, "composition id")
      compositions.push({ old_project_id: projectId, export_parts: [...parts, "exports", compositionId], old_composition_id: compositionId, composition })
    }
  }
  const legacyCollages = await optionalDirectory(dataRoot, "collages")
  if (legacyCollages) for await (const [directoryName, entry] of legacyCollages.entries()) {
    if (entry.kind !== "directory") continue
    const collageFile = await optionalFileAt(dataRoot, ["collages", directoryName], "collage.json")
    if (!collageFile) continue
    const composition = await readJson(collageFile, `collages/${directoryName}/collage.json`)
    const compositionId = stringValue(composition.composition_id, "composition id")
    if (compositionId !== directoryName) throw new Error(`Python collage folder does not match its composition id: ${directoryName}`)
    compositions.push({
      old_project_id: stringValue(composition.corpus_project_id, "composition project id"),
      export_parts: ["collages", directoryName, "exports"],
      old_composition_id: compositionId,
      composition,
    })
  }
  return compositions
}

async function saveImportedProject(
  projectId: string,
  name: string,
  createdAt: string,
  modelName: string,
  backend: string,
  device: string,
  imported: BrowserLegacyImportedAnalysis[],
  centroidsPath: string | null,
): Promise<void> {
  const sources = imported.map((item) => item.record.source)
  const analysisIds = imported.map((item) => item.new_analysis_id)
  const manifest: ProjectManifest = {
    project_id: projectId,
    name,
    analysis_ids: analysisIds,
    source_analyses: Object.fromEntries(imported.map((item) => [item.new_source_id, item.new_analysis_id])),
    created_at: createdAt,
    model_name: modelName,
    inference_backend: backend,
    inference_device: device,
    sources,
  }
  const project: BrowserProjectRecord = { analysis_ids: analysisIds, detail: { manifest, analyses: imported.map((item) => item.record.overview) }, legacy_centroids_path: centroidsPath }
  await writeWorkspaceJson(`projects/${projectId}/${BROWSER_PROJECT_RECORD_FILENAME}`, project)
}

function convertLegacyComposition(
  entry: BrowserLegacyImportComposition,
  newProjectId: string,
  newSourceIds: Map<string, string>,
  compositionIds: Map<string, string>,
): CompositionProject {
  const value = entry.composition
  if (stringValue(value.corpus_project_id, "composition project id") !== entry.old_project_id) throw new Error(`Python composition ${entry.old_composition_id} refers to a different project.`)
  const segments = arrayValue(value.segments, "composition segments").map((item, index, all) => {
    const segment = objectValue(item, "composition segment")
    const oldSourceId = stringValue(segment.source_id, "composition source id")
    const sourceId = newSourceIds.get(oldSourceId)
    if (!sourceId) throw new Error(`Python composition ${entry.old_composition_id} references a source that was not imported: ${oldSourceId}`)
    const previous = index ? objectValue(all[index - 1], "previous composition segment") : null
    const gapBeforeMs = typeof segment.gap_before_ms === "number" ? segment.gap_before_ms : (segment.timeline_start_ms as number) - (previous ? previous.timeline_end_ms as number : 0)
    const crossfadeMs = typeof segment.crossfade_ms === "number" ? segment.crossfade_ms : Math.max(0, Math.min(MAX_CROSSFADE_MS, -((typeof segment.gap_before_ms === "number" ? segment.gap_before_ms : 0))))
    const phoneUnits = arrayValue(segment.phone_units ?? [], "composition phone units").map((item) => {
      const unit = objectValue(item, "composition phone unit")
      return { ...unit, pitch_points: arrayValue(unit.pitch_points ?? [], "phone pitch points"), pitch_owner_ref: unit.pitch_owner_ref ?? null }
    })
    const editRegions = arrayValue(segment.edit_regions ?? [], "composition edit regions").map((item) => {
      const region = objectValue(item, "composition edit region")
      return { ...region, pitch_points: arrayValue(region.pitch_points ?? [], "region pitch points") }
    })
    return {
      ...segment,
      source_id: sourceId,
      gap_before_ms: gapBeforeMs,
      crossfade_ms: crossfadeMs,
      stretch_percent: typeof segment.stretch_percent === "number" ? segment.stretch_percent : MIN_STRETCH_PERCENT,
      lane: typeof segment.lane === "number" ? segment.lane : index % 2,
      phone_units: phoneUnits,
      edit_regions: editRegions,
      volume_envelope: arrayValue(segment.volume_envelope ?? [], "volume envelope"),
      pitch_envelope: arrayValue(segment.pitch_envelope ?? [], "pitch envelope"),
      user_guide_source_ms: arrayValue(segment.user_guide_source_ms ?? [], "user guide source times"),
    }
  })
  const oldParentId = typeof value.parent_composition_id === "string" ? value.parent_composition_id : null
  const parentId = oldParentId ? compositionIds.get(oldParentId) ?? null : null
  return {
    ...value,
    composition_id: compositionIds.get(entry.old_composition_id)!,
    corpus_project_id: newProjectId,
    parent_composition_id: parentId,
    parent_composition_updated_at: parentId ? typeof value.parent_composition_updated_at === "string" ? value.parent_composition_updated_at : null : null,
    mode: value.mode === "PROFESSIONAL" ? "PROFESSIONAL" : "SIMPLE",
    schema_version: typeof value.schema_version === "number" ? value.schema_version : 1,
    tempo_bpm: typeof value.tempo_bpm === "number" ? value.tempo_bpm : PROFESSIONAL_TEMPO_DEFAULT_BPM,
    beats_per_bar: typeof value.beats_per_bar === "number" ? value.beats_per_bar : PROFESSIONAL_BEATS_PER_BAR_DEFAULT,
    beat_division: typeof value.beat_division === "number" ? value.beat_division : PROFESSIONAL_BEAT_DIVISION_DEFAULT,
    grid_offset_units: typeof value.grid_offset_units === "number" ? value.grid_offset_units : PROFESSIONAL_GRID_OFFSET_UNITS_DEFAULT,
    pitch_notes: arrayValue(value.pitch_notes ?? [], "composition pitch notes"),
    segments,
  } as unknown as CompositionProject
}

function uniqueMediaIndexKey(index: Record<string, BrowserVideoIndexEntry>, filename: string): string {
  if (!Object.hasOwn(index, filename)) return filename
  const extensionIndex = filename.lastIndexOf(".")
  const stem = extensionIndex > 0 ? filename.slice(0, extensionIndex) : filename
  const extension = extensionIndex > 0 ? filename.slice(extensionIndex) : ""
  let suffix = 2
  while (Object.hasOwn(index, `${stem} (imported ${suffix})${extension}`)) suffix += 1
  return `${stem} (imported ${suffix})${extension}`
}

export async function importLegacyPythonData(
  dataRoot: FileSystemDirectoryHandle,
  onProgress: (progress: BrowserLegacyImportProgress) => void = () => undefined,
): Promise<BrowserLegacyImportSummary> {
  const output = await optionalDirectory(dataRoot, "output")
  const projects = await optionalDirectory(dataRoot, "projects")
  if (!output && !projects) throw new Error("Select the Python data folder containing its output and/or projects directories.")
  const outputEntries: Array<[string, FileSystemDirectoryHandle]> = []
  if (output) for await (const [name, entry] of output.entries()) if (entry.kind === "directory") outputEntries.push([name, entry as FileSystemDirectoryHandle])
  const collectionEntries: Array<[string, FileSystemDirectoryHandle]> = []
  if (projects) for await (const [name, entry] of projects.entries()) if (entry.kind === "directory") collectionEntries.push([name, entry as FileSystemDirectoryHandle])
  const legacyCompositions = await collectLegacyCompositions(dataRoot, [
    ...outputEntries.map(([projectId]) => [projectId, ["output", projectId]] as [string, string[]]),
    ...collectionEntries.map(([projectId]) => [projectId, ["projects", projectId]] as [string, string[]]),
  ])
  const compositionIds = new Map<string, string>()
  for (const entry of legacyCompositions) {
    if (compositionIds.has(entry.old_composition_id)) throw new Error(`Duplicate Python composition id: ${entry.old_composition_id}`)
    compositionIds.set(entry.old_composition_id, crypto.randomUUID())
  }
  const summary: BrowserLegacyImportSummary = { projects_imported: 0, analyses_imported: 0, collages_imported: 0, composition_parent_links_missing: 0, audio_files_imported: 0, media_files_imported: 0, media_files_missing: 0, database_files_preserved: 0, centroid_files_imported: 0, version_files_preserved: 0, export_files_preserved: 0 }
  const importedByOldProject = new Map<string, BrowserLegacyImportedAnalysis[]>()
  const newProjectIds = new Map<string, string>()
  const newSourceIds = new Map<string, Map<string, string>>()
  const rollbackPaths: string[] = []
  const fileIndex = Object.assign(Object.create(null), await readWorkspaceJson<Record<string, BrowserVideoIndexEntry>>(BROWSER_VIDEO_INDEX).catch(() => ({}))) as Record<string, BrowserVideoIndexEntry>
  const total = outputEntries.length + collectionEntries.length + legacyCompositions.length
  let completed = 0
  try {
  for (const [projectId] of outputEntries) {
    const parts = ["output", projectId]
    const manifestFile = await optionalFileAt(dataRoot, parts, "project.json")
    if (!manifestFile) continue
    const manifest = await readJson(manifestFile, `${projectId}/project.json`)
    const imported = await collectPythonAnalysis(dataRoot, parts, projectId, manifest)
    rollbackPaths.push(...imported.map((item) => `analyses/${item.new_analysis_id}`))
    importedByOldProject.set(projectId, imported)
    const newProjectId = crypto.randomUUID()
    rollbackPaths.push(`projects/${newProjectId}`, `${BROWSER_LEGACY_IMPORT_DIRECTORY}/${newProjectId}`)
    newProjectIds.set(projectId, newProjectId)
    newSourceIds.set(projectId, new Map(imported.map((item) => [item.old_source_id, item.new_source_id])))
    const oldName = typeof manifest.nickname === "string" && manifest.nickname.trim() ? manifest.nickname : imported[0].record.source.path.split(/[\\/]/u).at(-1) || projectId
    let centroidPath: string | null = null
    if (typeof manifest.acoustic_unit_centroids_file === "string") {
      const sourceCentroidPath = normalizedParts(parts, manifest.acoustic_unit_centroids_file)
      const centroidFile = await optionalFileAt(dataRoot, [], sourceCentroidPath.join("/"))
      if (!centroidFile) throw new Error(`Python centroid file is missing: ${manifest.acoustic_unit_centroids_file}`)
      const centroids = await parseCentroids(centroidFile)
      centroidPath = `${BROWSER_LEGACY_IMPORT_DIRECTORY}/${newProjectId}/acoustic-unit-centroids.json`
      await writeWorkspaceJson(centroidPath, { model_name: "legacy-python", model_revision: "unknown", dimensions: centroids[0]?.length ?? 768, cluster_count: centroids.length, centroids })
      summary.centroid_files_imported += 1
    }
    if (typeof manifest.database_file === "string") {
      if (!(await preserveLegacyFile(dataRoot, parts, manifest.database_file, `${BROWSER_LEGACY_IMPORT_DIRECTORY}/${newProjectId}/corpus.sqlite3`))) throw new Error(`Python SQLite file is missing: ${manifest.database_file}`)
      summary.database_files_preserved += 1
    }
    if (typeof manifest.acoustic_unit_centroids_file === "string") await preserveLegacyFile(dataRoot, parts, manifest.acoustic_unit_centroids_file, `${BROWSER_LEGACY_IMPORT_DIRECTORY}/${newProjectId}/original-centroids.npy`)
    summary.version_files_preserved += await preserveVersionHistory(dataRoot, parts, newProjectId)
    for (const item of imported) {
      await writeWorkspaceFile(item.record.audio_path, item.audio)
      if (item.media) {
        await writeWorkspaceFile(item.record.media_path, item.media)
        fileIndex[uniqueMediaIndexKey(fileIndex, item.media_name)] = { path: item.record.media_path, type: item.media.type, size: item.media.size }
        summary.media_files_imported += 1
      } else summary.media_files_missing += 1
      await writeWorkspaceJson(`analyses/${item.new_analysis_id}/${BROWSER_ANALYSIS_RECORD_FILENAME}`, item.record)
      summary.analyses_imported += 1
      summary.audio_files_imported += 1
    }
    await saveImportedProject(newProjectId, oldName, typeof manifest.created_at === "string" ? manifest.created_at : new Date().toISOString(), typeof manifest.model_name === "string" ? manifest.model_name : "legacy-python", typeof manifest.inference_backend === "string" ? manifest.inference_backend : "unknown", typeof manifest.inference_device === "string" ? manifest.inference_device : "unknown", imported, centroidPath)
    summary.projects_imported += 1
    completed += 1
    onProgress({ completed, total, name: projectId })
  }
  for (const [projectId] of collectionEntries) {
    const parts = ["projects", projectId]
    const manifestFile = await optionalFileAt(dataRoot, parts, "project.json")
    if (!manifestFile) continue
    const manifest = await readJson(manifestFile, `${projectId}/project.json`)
    const ids = arrayValue(manifest.analysis_ids ?? [], "collection analysis ids").map((value) => stringValue(value, "analysis id"))
    const sourceMap = objectValue(manifest.source_analyses ?? {}, "source analysis mapping")
    const imported = ids.flatMap((id) => importedByOldProject.get(id) ?? [])
    if (!imported.length) throw new Error(`Collection ${projectId} references analyses that were not imported from output/.`)
    const projectSources = arrayValue(manifest.sources ?? [], "collection sources").map((value) => objectValue(value, "collection source"))
    const ordered = projectSources.flatMap((source) => {
      const sourceId = typeof source.source_id === "string" ? source.source_id : ""
      const oldAnalysisId = typeof sourceMap[sourceId] === "string" ? sourceMap[sourceId] as string : ""
      return (importedByOldProject.get(oldAnalysisId) ?? []).filter((item) => item.old_source_id === sourceId)
    })
    const selected = ordered.length ? ordered : imported
    const newProjectId = crypto.randomUUID()
    rollbackPaths.push(`projects/${newProjectId}`, `${BROWSER_LEGACY_IMPORT_DIRECTORY}/${newProjectId}`)
    newProjectIds.set(projectId, newProjectId)
    newSourceIds.set(projectId, new Map(selected.map((item) => [item.old_source_id, item.new_source_id])))
    await saveImportedProject(newProjectId, typeof manifest.name === "string" ? manifest.name : projectId, typeof manifest.created_at === "string" ? manifest.created_at : new Date().toISOString(), typeof manifest.model_name === "string" ? manifest.model_name : "legacy-python", typeof manifest.inference_backend === "string" ? manifest.inference_backend : "unknown", typeof manifest.inference_device === "string" ? manifest.inference_device : "unknown", selected, null)
    if (typeof manifest.database_file === "string") {
      if (!(await preserveLegacyFile(dataRoot, parts, manifest.database_file, `${BROWSER_LEGACY_IMPORT_DIRECTORY}/${newProjectId}/corpus.sqlite3`))) throw new Error(`Python SQLite file is missing: ${manifest.database_file}`)
      summary.database_files_preserved += 1
    }
    summary.version_files_preserved += await preserveVersionHistory(dataRoot, parts, newProjectId)
    summary.projects_imported += 1
    completed += 1
    onProgress({ completed, total, name: projectId })
  }
  for (const entry of legacyCompositions) {
    const newProjectId = newProjectIds.get(entry.old_project_id)
    const sourceIds = newSourceIds.get(entry.old_project_id)
    if (!newProjectId || !sourceIds) throw new Error(`Python composition ${entry.old_composition_id} references a project that was not imported: ${entry.old_project_id}`)
    const oldParentId = entry.composition.parent_composition_id
    if (typeof oldParentId === "string" && !compositionIds.has(oldParentId)) summary.composition_parent_links_missing += 1
    const composition = convertLegacyComposition(entry, newProjectId, sourceIds, compositionIds)
    rollbackPaths.push(`collages/${composition.composition_id}`)
    await writeWorkspaceJson(`collages/${composition.composition_id}/collage.json`, composition)
    const compositionExports = await optionalDirectoryAt(dataRoot, entry.export_parts)
    if (compositionExports) summary.export_files_preserved += await preserveDirectoryTree(compositionExports, `${BROWSER_LEGACY_IMPORT_DIRECTORY}/${newProjectId}/collages/${composition.composition_id}/exports`)
    summary.collages_imported += 1
    completed += 1
    onProgress({ completed, total, name: entry.old_composition_id })
  }
  await writeWorkspaceJson(BROWSER_VIDEO_INDEX, fileIndex)
  return summary
  } catch (error) {
    await rollbackImport(rollbackPaths)
    throw error
  }
}
