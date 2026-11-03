import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import test from "node:test"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/u.test(specifier)) {
      try { return nextResolve(`${specifier}.ts`, context) } catch {}
    }
    return nextResolve(specifier, context)
  },
})

const workspace = await import("../src/browser/workspace.ts")
const { importLegacyPythonData } = await import("../src/browser/legacyImport.ts")
const { BROWSER_VIDEO_INDEX } = await import("../src/browserAnalysisConstants.ts")

class MemoryFileHandle {
  constructor(name, bytes = new Uint8Array()) { this.name = name; this.kind = "file"; this.bytes = bytes }
  async getFile() { return new File([this.bytes], this.name) }
  async createWritable() {
    return { write: async (data) => { this.bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data) }, close: async () => {}, abort: async () => {} }
  }
}

class MemoryDirectoryHandle {
  constructor(name) { this.name = name; this.kind = "directory"; this.entriesMap = new Map(); this.permission = "granted" }
  async queryPermission() { return this.permission }
  async requestPermission() { return this.permission }
  async isSameEntry(other) { return this === other }
  async getDirectoryHandle(name, options = {}) {
    if (!this.entriesMap.has(name)) {
      if (!options.create) throw new DOMException("Missing directory", "NotFoundError")
      this.entriesMap.set(name, new MemoryDirectoryHandle(name))
    }
    const entry = this.entriesMap.get(name)
    if (entry.kind !== "directory") throw new DOMException("Not a directory", "TypeMismatchError")
    return entry
  }
  async getFileHandle(name, options = {}) {
    if (!this.entriesMap.has(name)) {
      if (!options.create) throw new DOMException("Missing file", "NotFoundError")
      this.entriesMap.set(name, new MemoryFileHandle(name))
    }
    const entry = this.entriesMap.get(name)
    if (entry.kind !== "file") throw new DOMException("Not a file", "TypeMismatchError")
    return entry
  }
  async *entries() { yield* this.entriesMap.entries() }
  async *values() { yield* this.entriesMap.values() }
  async removeEntry(name) { if (!this.entriesMap.delete(name)) throw new DOMException("Missing entry", "NotFoundError") }
}

async function putFile(root, path, content) {
  const parts = path.split("/")
  let directory = root
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true })
  const file = await directory.getFileHandle(parts.at(-1), { create: true })
  file.bytes = typeof content === "string" ? new TextEncoder().encode(content) : content
}

function centroidNpy(values, byteOrder = "<") {
  const shape = `{'descr': '${byteOrder}f8', 'fortran_order': False, 'shape': (${values.length}, ${values[0].length}), }`
  const prefix = 10
  const headerLength = Math.ceil((prefix + shape.length + 1) / 16) * 16 - prefix
  const header = Buffer.from(`${shape}${" ".repeat(headerLength - shape.length - 1)}\n`)
  const bytes = Buffer.alloc(prefix + header.length + values.length * values[0].length * 8)
  Buffer.from([0x93, ...Buffer.from("NUMPY"), 1, 0]).copy(bytes)
  bytes.writeUInt16LE(header.length, 8)
  header.copy(bytes, prefix)
  let offset = prefix + header.length
  for (const row of values) for (const value of row) { byteOrder === ">" ? bytes.writeDoubleBE(value, offset) : bytes.writeDoubleLE(value, offset); offset += 8 }
  return new Uint8Array(bytes)
}

function analysisFixture(sourceId) {
  const source = { source_id: sourceId, path: "videos/sample.wav", duration_ms: 1200, audio_sample_rate: 16000, audio_channels: 1, video_width: null, video_height: null, video_fps: null }
  const words = [{ text: "hello", start_ms: 0, end_ms: 900, confidence: 0.9 }]
  const sentences = [{ sentence_index: 0, text: "hello", start_ms: 0, end_ms: 900, word_start_index: 0, word_end_index: 1 }]
  const phones = [{ occurrence_id: "phone-1", source_id: sourceId, sentence_index: 0, word_index: 0, grapheme: "h", pronunciation: "h", phone_id: "en.consonant.glottal.fricative", ipa: "h", start_ms: 100, end_ms: 250, confidence: 0.85, alignment_method: "CTC_FORCED", alignment_status: "ALIGNED" }]
  return { source, transcript: "hello", language: "en", language_probability: null, audio_regions: [{ region_type: "SPEECH", start_ms: 0, end_ms: 900 }], sentences, words, phones, acoustic_features: [{ occurrence_id: "phone-1", rms_db: -20, peak_db: -2, f0_hz: 180, voiced_probability: 0.8, acoustic_unit_id: 1 }], transcript_candidates: [] }
}

function compositionFixture(compositionId, sourceId, parent = null, projectId = "proj_20261031_123456") {
  return {
    composition_id: compositionId, corpus_project_id: projectId, name: compositionId,
    target_text: "hello", target_pronunciation: "h ə l oʊ", created_at: "2026-10-31T12:34:56+00:00",
    updated_at: "2026-10-31T12:35:56+00:00", crossfade_ms: 0, tempo_bpm: 120, beats_per_bar: 4,
    beat_division: 4, grid_offset_units: 0, pitch_notes: [], mode: parent ? "PROFESSIONAL" : "SIMPLE",
    schema_version: 1, parent_composition_id: parent, parent_composition_updated_at: parent ? "2026-10-31T12:34:56+00:00" : null,
    segments: [{ segment_id: "segment-1", candidate_id: "candidate-1", target_start_index: 0, target_end_index: 1,
      source_id: sourceId, source_start_ms: 0, source_end_ms: 900, timeline_start_ms: 0, timeline_end_ms: 900,
      match_status: "EXACT", target_ipa: ["h", "ə", "l", "oʊ"], matched_ipa: ["h", "ə", "l", "oʊ"],
      gap_before_ms: 0, crossfade_ms: 0, stretch_percent: 100, lane: 0, phone_units: [], edit_regions: [],
      volume_envelope: [], pitch_envelope: [], user_guide_source_ms: [] }],
  }
}

async function fixtureRoot(audioPath = "../../cache/audio/source-1.wav", includeMedia = false) {
  const root = new MemoryDirectoryHandle("python-data")
  const source = { source_id: "source-1", path: "videos/sample.wav", duration_ms: 1200, audio_sample_rate: 16000, audio_channels: 1, video_width: null, video_height: null, video_fps: null }
  const outputManifest = {
    project_id: "proj_20261031_123456",
    schema_version: "0.3.0",
    created_at: "2026-10-31T12:34:56+00:00",
    model_name: "whisper-large-v3",
    inference_backend: "openvino",
    inference_device: "GPU",
    alignment_mode: "ctc",
    sources: [source],
    analysis_files: ["versions/v1/analysis/source-1.json"],
    database_file: "versions/v1/corpus.sqlite3",
    audio_files: { "source-1": audioPath },
    acoustic_unit_centroids_file: "versions/v1/analysis/acoustic_unit_centroids.npy",
  }
  await putFile(root, "output/proj_20261031_123456/project.json", JSON.stringify(outputManifest))
  await putFile(root, "output/proj_20261031_123456/versions/v1/analysis/source-1.json", JSON.stringify(analysisFixture("source-1")))
  await putFile(root, "output/proj_20261031_123456/versions/v1/corpus.sqlite3", new Uint8Array([1, 2, 3, 4]))
  await putFile(root, "output/proj_20261031_123456/versions/v0/analysis/old.json", "{}")
  await putFile(root, "output/proj_20261031_123456/versions/v0/corpus.sqlite3", new Uint8Array([5, 6]))
  const centroidA = new Array(768).fill(0)
  const centroidB = new Array(768).fill(0)
  centroidA.splice(0, 3, 0, 1, 2)
  centroidB.splice(0, 3, 3, 4, 5)
  await putFile(root, "output/proj_20261031_123456/versions/v1/analysis/acoustic_unit_centroids.npy", centroidNpy([centroidA, centroidB], "<"))
  await putFile(root, "cache/audio/source-1.wav", new Uint8Array([82, 73, 70, 70]))
  if (includeMedia) await putFile(root, "input/videos/sample.wav", new Uint8Array([87, 65, 86, 69]))
  await putFile(root, "output/proj_20261031_123456/compositions/comp_1111111111111111.json", JSON.stringify(compositionFixture("comp_1111111111111111", "source-1")))
  await putFile(root, "output/proj_20261031_123456/compositions/comp_2222222222222222.json", JSON.stringify(compositionFixture("comp_2222222222222222", "source-1", "comp_1111111111111111")))
  await putFile(root, "output/proj_20261031_123456/exports/comp_1111111111111111/render.wav", new Uint8Array([10, 20, 30]))
  await putFile(root, "collages/comp_4444444444444444/collage.json", JSON.stringify(compositionFixture("comp_4444444444444444", "source-1")))
  await putFile(root, "collages/comp_4444444444444444/exports/metadata.json", "{\"source\":\"legacy\"}")
  await putFile(root, "projects/collection_0123456789abcdef/project.json", JSON.stringify({
    project_id: "collection_0123456789abcdef", name: "Imported Collection", created_at: "2026-11-01T00:00:00+00:00",
    analysis_ids: ["proj_20261031_123456"], source_analyses: { "source-1": "proj_20261031_123456" }, sources: [source],
    model_name: "whisper-large-v3", inference_backend: "openvino", inference_device: "GPU",
    database_file: "versions/v2/corpus.sqlite3",
  }))
  await putFile(root, "projects/collection_0123456789abcdef/versions/v2/corpus.sqlite3", new Uint8Array([9, 8, 7]))
  const olderComposition = compositionFixture("comp_3333333333333333", "source-1", null, "collection_0123456789abcdef")
  for (const field of ["mode", "schema_version", "tempo_bpm", "beats_per_bar", "beat_division", "grid_offset_units", "pitch_notes"]) delete olderComposition[field]
  for (const field of ["gap_before_ms", "crossfade_ms", "stretch_percent", "lane", "phone_units", "edit_regions", "volume_envelope", "pitch_envelope", "user_guide_source_ms"]) delete olderComposition.segments[0][field]
  await putFile(root, "projects/collection_0123456789abcdef/compositions/comp_3333333333333333.json", JSON.stringify(olderComposition))
  return root
}

test("imports Python JSON analysis, cached audio, SQLite and NPY centroids without changing the source", async () => {
  const destination = new MemoryDirectoryHandle("browser-workspace")
  const source = await fixtureRoot(undefined, true)
  const values = new Map()
  const database = {
    objectStoreNames: { contains: () => true },
    transaction() {
      const transaction = {}
      transaction.objectStore = () => ({
        get(key) { const request = {}; queueMicrotask(() => { request.result = values.get(key); request.onsuccess?.(); transaction.oncomplete?.() }); return request },
        put(value, key) { const request = {}; queueMicrotask(() => { values.set(key, value); request.result = key; request.onsuccess?.(); transaction.oncomplete?.() }); return request },
      })
      return transaction
    },
    close() {},
  }
  globalThis.indexedDB = { open() { const request = {}; queueMicrotask(() => { request.result = database; request.onsuccess?.() }); return request } }
  globalThis.window = { showDirectoryPicker: async () => destination }
  await workspace.connectWorkspace()
  await workspace.writeWorkspaceJson(BROWSER_VIDEO_INDEX, { "sample.wav": { path: "media/existing.wav", type: "audio/wav", size: 7 } })
  const summary = await importLegacyPythonData(source)
  assert.deepEqual(summary, { projects_imported: 2, analyses_imported: 1, collages_imported: 4, composition_parent_links_missing: 0, audio_files_imported: 1, media_files_imported: 1, media_files_missing: 0, database_files_preserved: 2, centroid_files_imported: 1, version_files_preserved: 6, export_files_preserved: 2 })
  const analyses = await workspace.listWorkspaceDirectories("analyses")
  assert.equal(analyses.length, 1)
  const record = await workspace.readWorkspaceJson(`analyses/${analyses[0]}/analysis.json`)
  assert.equal(record.overview.transcript, "hello")
  assert.equal(record.phones[0].source_id, record.source.source_id)
  assert.equal(record.phones[0].alignment_status, "ALIGNED")
  assert.equal(await (await workspace.readWorkspaceFile(record.audio_path)).arrayBuffer().then((value) => value.byteLength), 4)
  assert.equal(await (await workspace.readWorkspaceFile(record.media_path)).arrayBuffer().then((value) => value.byteLength), 4)
  const projects = await workspace.listWorkspaceDirectories("projects")
  assert.equal(projects.length, 2)
  const collages = await workspace.listWorkspaceDirectories("collages")
  assert.equal(collages.length, 4)
  const collageRecords = await Promise.all(collages.map((id) => workspace.readWorkspaceJson(`collages/${id}/collage.json`)))
  const baseCollage = collageRecords.find((item) => item.name === "comp_1111111111111111")
  const professionalCollage = collageRecords.find((item) => item.name === "comp_2222222222222222")
  assert.ok(baseCollage)
  assert.ok(professionalCollage)
  assert.notEqual(baseCollage.composition_id, "comp_1111111111111111")
  assert.equal(baseCollage.corpus_project_id, professionalCollage.corpus_project_id)
  assert.equal(baseCollage.segments[0].source_id, record.source.source_id)
  assert.equal(professionalCollage.parent_composition_id, baseCollage.composition_id)
  const collectionProject = await Promise.all(projects.map((id) => workspace.readWorkspaceJson(`projects/${id}/project.json`))).then((items) => items.find((item) => item.detail.manifest.name === "Imported Collection"))
  const collectionCollage = collageRecords.find((item) => item.corpus_project_id === collectionProject.detail.manifest.project_id)
  assert.ok(collectionCollage)
  assert.equal(collectionCollage.segments[0].source_id, record.source.source_id)
  assert.equal(collectionCollage.mode, "SIMPLE")
  assert.equal(collectionCollage.schema_version, 1)
  assert.equal(collectionCollage.segments[0].gap_before_ms, 0)
  assert.equal(collectionCollage.segments[0].stretch_percent, 100)
  assert.deepEqual(collectionCollage.segments[0].phone_units, [])
  const projectRecords = await Promise.all(projects.map((id) => workspace.readWorkspaceJson(`projects/${id}/project.json`)))
  const outputProject = projectRecords.find((item) => item.detail.manifest.name === "sample.wav")
  const archivedVersions = await workspace.listWorkspaceDirectories(`legacy-imports/${outputProject.detail.manifest.project_id}/analysis-versions`)
  assert.deepEqual(archivedVersions, ["v0", "v1"])
  assert.equal(await workspace.readWorkspaceFile(`legacy-imports/${outputProject.detail.manifest.project_id}/analysis-versions/v0/analysis/old.json`).then((file) => file.text()), "{}")
  const archivedExport = await workspace.readWorkspaceFile(`legacy-imports/${baseCollage.corpus_project_id}/collages/${baseCollage.composition_id}/exports/render.wav`)
  assert.equal((await archivedExport.arrayBuffer()).byteLength, 3)
  const migratedCollage = collageRecords.find((item) => item.name === "comp_4444444444444444")
  assert.ok(migratedCollage)
  const migratedExport = await workspace.readWorkspaceFile(`legacy-imports/${migratedCollage.corpus_project_id}/collages/${migratedCollage.composition_id}/exports/metadata.json`)
  assert.equal(await migratedExport.text(), "{\"source\":\"legacy\"}")
  const centroidProject = await Promise.all(projects.map((id) => workspace.readWorkspaceJson(`projects/${id}/project.json`))).then((items) => items.find((item) => item.legacy_centroids_path))
  const centroids = await workspace.readWorkspaceJson(centroidProject.legacy_centroids_path)
  assert.equal(centroids.centroids.length, 2)
  assert.equal(centroids.centroids[0].length, 768)
  assert.deepEqual(centroids.centroids.map((row) => row.slice(0, 3)), [[0, 1, 2], [3, 4, 5]])
  const legacyDirectories = await workspace.listWorkspaceDirectories("legacy-imports")
  const legacyProjectFiles = await Promise.all(legacyDirectories.map((directory) => workspace.listWorkspaceFiles(`legacy-imports/${directory}`)))
  assert.ok(legacyProjectFiles.flat().some((filename) => filename === "corpus.sqlite3"))
  const videoIndex = await workspace.readWorkspaceJson(BROWSER_VIDEO_INDEX)
  assert.deepEqual(videoIndex["sample.wav"], { path: "media/existing.wav", type: "audio/wav", size: 7 })
  assert.ok(videoIndex["sample (imported 2).wav"])
  const originalComposition = await source.getDirectoryHandle("output").then((directory) => directory.getDirectoryHandle("proj_20261031_123456")).then((directory) => directory.getDirectoryHandle("compositions")).then((directory) => directory.getFileHandle("comp_1111111111111111.json")).then((file) => file.getFile()).then((file) => file.text())
  assert.equal(JSON.parse(originalComposition).composition_id, "comp_1111111111111111")
  const sourceManifest = await (await (await source.getDirectoryHandle("output")).getDirectoryHandle("proj_20261031_123456")).getFileHandle("project.json").then((file) => file.getFile()).then((file) => file.text())
  assert.equal(JSON.parse(sourceManifest).project_id, "proj_20261031_123456")
})

test("decodes big-endian Python centroid arrays correctly", async () => {
  const destination = new MemoryDirectoryHandle("browser-workspace-big-endian")
  const source = await fixtureRoot()
  const centroidFile = await source.getDirectoryHandle("output").then((directory) => directory.getDirectoryHandle("proj_20261031_123456"))
  const versions = await centroidFile.getDirectoryHandle("versions")
  const v1 = await versions.getDirectoryHandle("v1")
  const analysis = await v1.getDirectoryHandle("analysis")
  const file = await analysis.getFileHandle("acoustic_unit_centroids.npy")
  const rows = [new Array(768).fill(0), new Array(768).fill(0)]
  rows[0].splice(0, 3, 0.25, 1.5, -2.75)
  rows[1].splice(0, 3, 3.25, 4.5, -5.75)
  file.bytes = centroidNpy(rows, ">")
  globalThis.window = { showDirectoryPicker: async () => destination }
  await workspace.connectWorkspace()
  await importLegacyPythonData(source)
  const projects = await workspace.listWorkspaceDirectories("projects")
  const project = await Promise.all(projects.map((id) => workspace.readWorkspaceJson(`projects/${id}/project.json`))).then((items) => items.find((item) => item.legacy_centroids_path))
  const centroids = await workspace.readWorkspaceJson(project.legacy_centroids_path)
  assert.deepEqual(centroids.centroids.map((row) => row.slice(0, 3)), [[0.25, 1.5, -2.75], [3.25, 4.5, -5.75]])
})

test("rejects legacy file paths that escape the selected data root before importing an analysis", async () => {
  const destination = new MemoryDirectoryHandle("browser-workspace")
  const source = await fixtureRoot("../../../../outside.wav")
  globalThis.window = { showDirectoryPicker: async () => destination }
  await workspace.connectWorkspace()
  await assert.rejects(importLegacyPythonData(source), /escapes the selected data folder/)
  assert.deepEqual(await workspace.listWorkspaceDirectories("analyses"), [])
})

test("rolls back imported workspace records when a legacy collage references an unknown source", async () => {
  const destination = new MemoryDirectoryHandle("browser-workspace-rollback")
  const source = await fixtureRoot(undefined, true)
  const collection = await source.getDirectoryHandle("projects").then((directory) => directory.getDirectoryHandle("collection_0123456789abcdef"))
  const collages = await collection.getDirectoryHandle("compositions")
  const file = await collages.getFileHandle("comp_3333333333333333.json")
  const original = JSON.parse(await (await file.getFile()).text())
  original.segments[0].source_id = "unknown-source"
  file.bytes = new TextEncoder().encode(JSON.stringify(original))
  globalThis.window = { showDirectoryPicker: async () => destination }
  await workspace.connectWorkspace()
  await assert.rejects(importLegacyPythonData(source), /references a source that was not imported/)
  assert.deepEqual(await workspace.listWorkspaceDirectories("analyses"), [])
  assert.deepEqual(await workspace.listWorkspaceDirectories("projects"), [])
  assert.deepEqual(await workspace.listWorkspaceDirectories("collages"), [])
  assert.deepEqual(await workspace.listWorkspaceDirectories("legacy-imports"), [])
})
