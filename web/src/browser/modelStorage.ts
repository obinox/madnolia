import { BROWSER_ASR_MODELS, BROWSER_CTC_MODEL, BROWSER_CTC_REVISION, BROWSER_HUBERT_MODEL, BROWSER_HUBERT_REVISION } from "../browserAnalysisConstants"
import { BROWSER_HUGGINGFACE_BASE_URL, BROWSER_MODEL_FLAT_CONFIG_IDENTITY_ALIASES, BROWSER_MODEL_FOLDER_DATA, BROWSER_MODEL_FOLDER_HANDLE_KEY, BROWSER_MODEL_FOLDER_INDEX, BROWSER_MODEL_FOLDER_PICKER_ID, BROWSER_MODEL_SHARED_REPOSITORY_FILES } from "../browserModelStorageConstants"
import { BROWSER_WORKSPACE_DB_NAME, BROWSER_WORKSPACE_DB_VERSION, BROWSER_WORKSPACE_OBJECT_STORE } from "../browserConstants"
import type { AnalysisSettings } from "../types"
import type { BrowserLocalModelFile, BrowserModelDevice, BrowserModelFolderFile, BrowserModelFolderIndex, BrowserModelFolderWindow, BrowserModelPrecision, BrowserModelPreparationProgress, BrowserModelReadyState, BrowserModelRepositoryFile, BrowserModelRequiredFiles, BrowserModelSelection } from "../types/browserModelStorage"
import type { BrowserPermissionDirectoryHandle } from "../types/browser"

const emptyIndex = (): BrowserModelFolderIndex => ({ schema_version: 1, files: [] })
let activeFolder: BrowserPermissionDirectoryHandle | null = null
let operationQueue: Promise<void> = Promise.resolve()
const indexQueues = new WeakMap<FileSystemDirectoryHandle, Promise<void>>()

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BROWSER_WORKSPACE_DB_NAME, BROWSER_WORKSPACE_DB_VERSION)
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(BROWSER_WORKSPACE_OBJECT_STORE)) request.result.createObjectStore(BROWSER_WORKSPACE_OBJECT_STORE) }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("Could not open model folder storage."))
  })
}

async function storedHandle(write?: BrowserPermissionDirectoryHandle | null): Promise<BrowserPermissionDirectoryHandle | null> {
  const db = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(BROWSER_WORKSPACE_OBJECT_STORE, write === undefined ? "readonly" : "readwrite")
      const store = tx.objectStore(BROWSER_WORKSPACE_OBJECT_STORE)
      const request = write === undefined ? store.get(BROWSER_MODEL_FOLDER_HANDLE_KEY) : write ? store.put(write, BROWSER_MODEL_FOLDER_HANDLE_KEY) : store.delete(BROWSER_MODEL_FOLDER_HANDLE_KEY)
      let result: BrowserPermissionDirectoryHandle | null = null
      request.onsuccess = () => { result = write === undefined ? (request.result as BrowserPermissionDirectoryHandle | null) ?? null : write ?? null }
      request.onerror = () => reject(request.error ?? new Error("Could not save the model folder handle."))
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error ?? new Error("Could not save the model folder handle."))
    })
  } finally { db.close() }
}

export async function getSavedModelFolder(): Promise<BrowserPermissionDirectoryHandle | null> { return storedHandle() }
export async function restoreModelFolder(handle?: BrowserPermissionDirectoryHandle | null): Promise<BrowserPermissionDirectoryHandle | null> {
  const folder = handle === undefined ? await storedHandle() : handle
  if (!folder || await folder.queryPermission({ mode: "readwrite" }) !== "granted") return null
  activeFolder = folder
  return folder
}
export async function requestModelFolderPermission(): Promise<BrowserPermissionDirectoryHandle | null> {
  const folder = await storedHandle()
  if (!folder) return null
  if (await folder.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error("Allow read and write access to the selected model folder.")
  activeFolder = folder
  return folder
}
export async function connectModelFolder(): Promise<BrowserPermissionDirectoryHandle> {
  const picker = window as BrowserModelFolderWindow
  if (!picker.showDirectoryPicker) throw new Error("Model folders require HTTPS and a recent Chrome or Edge browser.")
  const folder = await picker.showDirectoryPicker({ id: BROWSER_MODEL_FOLDER_PICKER_ID, mode: "readwrite" })
  if (await folder.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error("Allow read and write access to the selected model folder.")
  await storedHandle(folder)
  activeFolder = folder
  return folder
}
export async function resetModelFolder(): Promise<void> { activeFolder = null; await storedHandle(null) }
export function getModelFolderHandle(): BrowserPermissionDirectoryHandle | null { return activeFolder }

function parts(path: string): string[] {
  const value = path.split("/")
  if (!path || path.startsWith("/") || path.includes("\\") || value.some((part) => !part || part === "." || part === "..")) throw new Error("Invalid model file path.")
  return value
}
async function directory(root: FileSystemDirectoryHandle, path: string, create = false): Promise<FileSystemDirectoryHandle> {
  let current = root
  for (const part of path ? parts(path) : []) current = await current.getDirectoryHandle(part, { create })
  return current
}
async function readFile(root: FileSystemDirectoryHandle, path: string): Promise<File | null> {
  const pathParts = parts(path)
  try { return await (await directory(root, pathParts.slice(0, -1).join("/"))).getFileHandle(pathParts.at(-1)!).then((handle) => handle.getFile()) }
  catch (error) { if (error instanceof DOMException && error.name === "NotFoundError") return null; throw error }
}
async function readIndex(root: FileSystemDirectoryHandle): Promise<BrowserModelFolderIndex> {
  try {
    const file = await readFile(root, BROWSER_MODEL_FOLDER_INDEX)
    if (!file) return emptyIndex()
    const value: unknown = JSON.parse(await file.text())
    return value && typeof value === "object" && (value as BrowserModelFolderIndex).schema_version === 1 && Array.isArray((value as BrowserModelFolderIndex).files) ? value as BrowserModelFolderIndex : emptyIndex()
  } catch { return emptyIndex() }
}
async function writeIndex(root: FileSystemDirectoryHandle, index: BrowserModelFolderIndex): Promise<void> {
  const pathParts = parts(BROWSER_MODEL_FOLDER_INDEX)
  const parent = await directory(root, pathParts.slice(0, -1).join("/"), true)
  const file = await parent.getFileHandle(pathParts.at(-1)!, { create: true })
  const writer = await file.createWritable()
  await writer.write(new Blob([JSON.stringify(index, null, 2)], { type: "application/json" }))
  await writer.close()
}
async function updateIndex(root: FileSystemDirectoryHandle, update: (index: BrowserModelFolderIndex) => BrowserModelFolderIndex): Promise<void> {
  const previous = indexQueues.get(root) ?? Promise.resolve()
  const commit = previous.then(async () => writeIndex(root, update(await readIndex(root))))
  indexQueues.set(root, commit.catch(() => undefined))
  await commit
}
async function bindSelection(root: FileSystemDirectoryHandle, selection: BrowserModelSelection, files: string[], present: Array<BrowserLocalModelFile | null>): Promise<void> {
  if (!selection.revision) return
  const key = selection.model_id + "@" + selection.revision + ":" + selection.dtype
  const binding = { model_id: selection.model_id, revision: selection.revision, dtype: selection.dtype, files }
  await updateIndex(root, (index) => {
    const entries = new Map(index.files.map((entry) => [entry.model_id + "@" + entry.revision + ":" + entry.dtype + ":" + entry.file, entry]))
    present.forEach((item, position) => {
      if (!item?.path.startsWith(BROWSER_MODEL_FOLDER_DATA + "/")) return
      const file = files[position]
      entries.set(key + ":" + file, { model_id: selection.model_id, revision: selection.revision!, dtype: selection.dtype, file, path: item.path, size_bytes: item.file.size })
    })
    return { ...index, files: [...entries.values()], bindings: [...(index.bindings ?? []).filter((item) => item.model_id + "@" + item.revision + ":" + item.dtype !== key), binding] }
  })
}
const encodedId = (id: string): string => id.split("/").map(encodeURIComponent).join("/")
export function modelSelection(kind: BrowserModelSelection["kind"], modelId: string, precision: BrowserModelPrecision, device: BrowserModelDevice): BrowserModelSelection {
  if (kind === "asr") {
    const model = BROWSER_ASR_MODELS.find((item) => item.id === modelId)
    if (!model) throw new Error("Unsupported ASR model: " + modelId)
    const artifact = model.artifacts[precision]
    const subfolder = "subfolder" in artifact && typeof artifact.subfolder === "string" ? artifact.subfolder : undefined
    return { kind, model_id: artifact.model_id, revision: artifact.revision, dtype: artifact.dtype[device], external_data_format: artifact.external_data_format, subfolder }
  }
  return kind === "ctc"
    ? { kind, model_id: BROWSER_CTC_MODEL, revision: BROWSER_CTC_REVISION, dtype: precision === "baseline" ? "fp32" : device === "webgpu" ? "fp16" : "q4" }
    : { kind, model_id: BROWSER_HUBERT_MODEL, revision: BROWSER_HUBERT_REVISION, dtype: precision === "baseline" ? "fp32" : device === "webgpu" ? "fp16" : "q8" }
}

export function analysisModelSelections(settings: Pick<AnalysisSettings, "model_name" | "candidate_models" | "alignment_mode" | "acoustic_units" | "precision" | "device">): BrowserModelSelection[] {
  const selections = [settings.model_name, ...settings.candidate_models].map((model) => modelSelection("asr", model, settings.precision, settings.device))
  if (settings.alignment_mode === "ctc") selections.push(modelSelection("ctc", "", settings.precision, settings.device))
  if (settings.acoustic_units) selections.push(modelSelection("hubert", "", settings.precision, settings.device))
  return selections
}

export function analysisReprocessModelSelections(precision: BrowserModelPrecision, device: BrowserModelDevice, acousticUnits: boolean): BrowserModelSelection[] {
  return [modelSelection("ctc", "", precision, device), ...(acousticUnits ? [modelSelection("hubert", "", precision, device)] : [])]
}

function onnxPaths(selection: BrowserModelSelection): string[] {
  const names = selection.kind === "asr" ? ["encoder_model", "decoder_model_merged"] : ["model"]
  const suffix = selection.dtype === "fp32" ? "" : selection.dtype === "q8" ? "_quantized" : "_" + selection.dtype
  const graphFolder = selection.subfolder === undefined ? "onnx" : selection.subfolder.replace(/^\/+|\/+$/gu, "")
  const prefix = graphFolder ? graphFolder + "/" : ""
  return names.map((name) => prefix + name + suffix + ".onnx")
}
function acceptedFiles(tree: BrowserModelRepositoryFile[], selection: BrowserModelSelection): BrowserModelRepositoryFile[] {
  const models = onnxPaths(selection)
  const sharedPaths = new Set<string>(BROWSER_MODEL_SHARED_REPOSITORY_FILES)
  const picked = tree.filter((file) => file.type !== "directory" && (sharedPaths.has(file.path) || models.includes(file.path) ||
    models.some((model) => file.path.startsWith(model + ".") || file.path.startsWith(model + "_data") || file.path.startsWith(model.replace(/\.onnx$/u, "") + "_data"))))
  const required = ["config.json", ...onnxPaths(selection)]
  if (selection.kind === "asr") required.push("preprocessor_config.json", "generation_config.json", "tokenizer_config.json", "tokenizer.json")
  if (selection.kind !== "asr") required.push("preprocessor_config.json")
  if (selection.kind === "ctc") required.push("vocab.json")
  const missing = required.filter((path) => !picked.some((file) => file.path === path))
  if (missing.length) throw new Error("Missing browser ONNX files: " + missing.join(", ") + ". PyTorch and .safetensors weights cannot run in this browser workflow.")
  for (const [name, chunks] of Object.entries(selection.external_data_format ?? {})) {
    const count = Number(chunks)
    if (!Number.isFinite(count) || count <= 0) continue
    const modelName = name.endsWith(".onnx") ? name : name + ".onnx"
    const modelPath = models.find((path) => path.endsWith("/" + modelName) || path === modelName)
    const sidecars = modelPath ? picked.filter((file) => file.path.startsWith(modelPath + "_data")) : []
    if (sidecars.length < count) throw new Error("The selected ONNX model is missing external data chunks for " + modelName + ".")
  }
  return picked
}
function modelRoot(selection: BrowserModelSelection): string {
  if (!selection.revision) throw new Error("The selected model has no pinned revision and cannot be prepared safely.")
  return BROWSER_HUGGINGFACE_BASE_URL + "/" + encodedId(selection.model_id) + "/resolve/" + encodeURIComponent(selection.revision)
}
function localPaths(selection: BrowserModelSelection, relative: string): string[] {
  const id = selection.model_id.replaceAll("/", "--")
  const revision = selection.revision ?? "main"
  return [
    BROWSER_MODEL_FOLDER_DATA + "/" + encodeURIComponent(selection.model_id) + "/" + revision + "/" + selection.dtype + "/" + relative,
    "models--" + id + "/snapshots/" + revision + "/" + relative,
    "snapshots/" + revision + "/" + relative,
    relative,
  ]
}
async function findLocal(root: FileSystemDirectoryHandle, selection: BrowserModelSelection, relative: string): Promise<BrowserLocalModelFile | null> {
  const index = await readIndex(root)
  const found = index.files.find((item) => item.model_id === selection.model_id && item.revision === selection.revision && item.dtype === selection.dtype && item.file === relative)
  for (const path of [...(found ? [found.path] : []), ...localPaths(selection, relative)]) {
    const file = await readFile(root, path)
    if (!file || file.size === 0 || await isGitLfsPointer(file)) continue
    if (found?.path === path && found.size_bytes !== file.size) continue
    const isFlat = path === relative
    if (isFlat && !await flatConfigMatches(root, selection)) continue
    return { file, path }
  }
  return null
}
async function isGitLfsPointer(file: File): Promise<boolean> {
  return (await file.slice(0, 128).text()).startsWith("version https://git-lfs.github.com/spec/v1")
}
async function flatConfigMatches(root: FileSystemDirectoryHandle, selection: BrowserModelSelection | string): Promise<boolean> {
  try {
    const file = await readFile(root, "config.json")
    if (!file) return false
    const config = JSON.parse(await file.text()) as Record<string, unknown>
    const identity = config._name_or_path ?? config.model_id ?? config.name_or_path
    const modelType = String(config.model_type ?? "").toLowerCase()
    const kind = typeof selection === "string" ? null : selection.kind
    const modelId = typeof selection === "string" ? selection : selection.model_id
    const expectedType = kind === "asr" ? "whisper" : kind === "ctc" ? "wav2vec2" : kind === "hubert" ? "hubert" : null
    if ((expectedType && modelType !== expectedType) || typeof identity !== "string") return false
    const expectedName = modelId.split("/").at(-1)!.toLowerCase().replace(/-onnx$|_onnx$/u, "")
    const aliases = BROWSER_MODEL_FLAT_CONFIG_IDENTITY_ALIASES[modelId] ?? []
    const localName = identity.split("/").at(-1)!.toLowerCase().replace(/-onnx$|_onnx$/u, "")
    return localName === expectedName || aliases.some((alias) => alias.toLowerCase() === identity.toLowerCase())
  } catch { return false }
}
const repoPath = (_selection: BrowserModelSelection, path: string): string => path
async function localExternalData(root: FileSystemDirectoryHandle, selection: BrowserModelSelection): Promise<BrowserModelRepositoryFile[] | null> {
  const files: BrowserModelRepositoryFile[] = []
  for (const [name, chunks] of Object.entries(selection.external_data_format ?? {})) {
    const count = Number(chunks)
    if (!Number.isFinite(count) || count <= 0) continue
    const modelName = name.endsWith(".onnx") ? name : name + ".onnx"
    const modelPath = onnxPaths(selection).find((path) => path.endsWith("/" + modelName) || path === modelName)
    if (!modelPath) return null
    const base = modelPath.split("/").at(-1)!
    const repoParent = modelPath.split("/").slice(0, -1).join("/")
    const prefixes = [base + ".", base + "_data", base.replace(/\.onnx$/u, "") + "_data"]
    const candidates = new Set<string>()
    for (const localModelPath of localPaths(selection, modelPath)) {
      const parentPath = localModelPath.split("/").slice(0, -1).join("/")
      const modelBase = localModelPath.split("/").at(-1)!
      try {
        const parent = await directory(root, parentPath)
        for await (const [entryName, entry] of parent.entries()) if (entry.kind === "file" && prefixes.some((prefix) => entryName.startsWith(modelBase.replace(base, prefix)))) candidates.add(repoParent ? repoParent + "/" + entryName : entryName)
      } catch (error) { if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error }
    }
    const indexed = await readIndex(root)
    for (const entry of indexed.files) if (entry.model_id === selection.model_id && entry.revision === selection.revision && entry.dtype === selection.dtype && (entry.file.startsWith(modelPath + ".") || entry.file.startsWith(modelPath.replace(/\.onnx$/u, "") + "_data"))) candidates.add(entry.file)
    const valid: string[] = []
    for (const path of candidates) if (await findLocal(root, selection, path)) valid.push(path)
    if (valid.length < count) return null
    files.push(...valid.map((path) => ({ path })))
  }
  return files
}
async function requiredFiles(root: FileSystemDirectoryHandle, selection: BrowserModelSelection, signal?: AbortSignal): Promise<BrowserModelRequiredFiles> {
  if (!selection.revision) throw new Error("This model has no pinned revision.")
  const essential = [repoPath(selection, "config.json"), repoPath(selection, "preprocessor_config.json"), ...(selection.kind === "asr" ? [repoPath(selection, "generation_config.json"), repoPath(selection, "tokenizer_config.json"), repoPath(selection, "tokenizer.json")] : []), ...(selection.kind === "ctc" ? [repoPath(selection, "vocab.json")] : []), ...onnxPaths(selection)]
  const localEssential: BrowserModelRepositoryFile[] = []
  for (const path of essential) if (await findLocal(root, selection, path)) localEssential.push({ path })
  const localSidecars = await localExternalData(root, selection)
  if (localEssential.length === essential.length && localSidecars !== null) {
    localEssential.push(...localSidecars)
    return { files: localEssential, missing: [] }
  }
  const url = BROWSER_HUGGINGFACE_BASE_URL + "/api/models/" + encodedId(selection.model_id) + "/tree/" + encodeURIComponent(selection.revision) + "?recursive=true"
  try {
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error("Could not inspect pinned model repository (" + response.status + ").")
    const files = acceptedFiles(await response.json() as BrowserModelRepositoryFile[], selection)
    const missing: BrowserModelRepositoryFile[] = []
    for (const item of files) if (!await findLocal(root, selection, item.path)) missing.push(item)
    return { files, missing }
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Download cancelled", "AbortError")
    if (Object.keys(selection.external_data_format ?? {}).length && !localSidecars) throw new Error((error instanceof Error ? error.message : String(error)) + " Missing local ONNX external data sidecars. Use the pinned Hugging Face snapshot layout or prepare online.")
    const required = [repoPath(selection, "config.json"), repoPath(selection, "preprocessor_config.json"), ...(selection.kind === "asr" ? [repoPath(selection, "generation_config.json"), repoPath(selection, "tokenizer_config.json"), repoPath(selection, "tokenizer.json")] : []), ...(selection.kind === "ctc" ? [repoPath(selection, "vocab.json")] : []), ...onnxPaths(selection)]
    required.push(...(localSidecars ?? []).map((item) => item.path))
    const missing: string[] = []
    for (const path of required) if (!await findLocal(root, selection, path)) missing.push(path)
    if (missing.length) throw new Error((error instanceof Error ? error.message : String(error)) + " Missing local files: " + missing.join(", ") + ". Use a pinned Hugging Face ONNX snapshot or prepare online. Flat folders need matching config.json and exact dtype ONNX files.")
    return { files: required.map((path) => ({ path })), missing: [] }
  }
}
export async function getModelReadiness(selection: BrowserModelSelection, folder = activeFolder): Promise<BrowserModelReadyState> {
  if (!folder) return { ready: false, present_files: 0, total_files: 0, message: "Connect a model folder first." }
  try {
    const { files } = await requiredFiles(folder, selection)
    const present = await Promise.all(files.map((item) => findLocal(folder, selection, item.path)))
    const count = present.filter(Boolean).length
    const ready = count === files.length
    if (ready) await bindSelection(folder, selection, files.map((file) => file.path), present)
    return { ready, present_files: count, total_files: files.length, message: ready ? "Ready in the selected folder." : (files.length - count) + " required files will be downloaded." }
  } catch (error) { return { ready: false, present_files: 0, total_files: 0, message: error instanceof Error ? error.message : String(error) } }
}
async function removeFile(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  const pathParts = parts(path)
  try { await (await directory(root, pathParts.slice(0, -1).join("/"))).removeEntry(pathParts.at(-1)!) } catch { }
}
async function downloadOne(root: FileSystemDirectoryHandle, selection: BrowserModelSelection, item: BrowserModelRepositoryFile, ordinal: number, total: number, signal: AbortSignal, progress: (value: BrowserModelPreparationProgress) => void): Promise<BrowserModelFolderFile> {
  const path = BROWSER_MODEL_FOLDER_DATA + "/" + encodeURIComponent(selection.model_id) + "/" + selection.revision + "/" + selection.dtype + "/" + item.path
  const before = await readFile(root, path)
  if (before && !await isGitLfsPointer(before)) return { model_id: selection.model_id, revision: selection.revision!, dtype: selection.dtype, file: item.path, path, size_bytes: before.size }
  if (before) throw new Error("Existing Git LFS pointer preserved: " + item.path)
  const response = await fetch(modelRoot(selection) + "/" + item.path.split("/").map(encodeURIComponent).join("/"), { signal })
  if (!response.ok || !response.body) throw new Error("Could not download " + item.path + " (" + response.status + ").")
  const pathParts = parts(path)
  const parent = await directory(root, pathParts.slice(0, -1).join("/"), true)
  const name = pathParts.at(-1)!
  try { await parent.getFileHandle(name); throw new Error("Existing model file preserved: " + item.path) } catch (error) { if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error }
  const temp = name + "." + crypto.randomUUID() + ".partial"
  const tempHandle = await parent.getFileHandle(temp, { create: true })
  const writer = await tempHandle.createWritable()
  const reader = response.body.getReader()
  const expected = Number(response.headers.get("content-length")) || item.size || null
  let received = 0
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Download cancelled", "AbortError")
      const chunk = await reader.read()
      if (chunk.done) break
      await writer.write(chunk.value)
      received += chunk.value.byteLength
      progress({ model_id: selection.model_id, completed_files: ordinal, total_files: total, current_file: item.path, received_bytes: received, expected_bytes: expected })
    }
    await writer.close()
    if (expected !== null && received !== expected) throw new Error("Incomplete download: " + item.path)
    if (await isGitLfsPointer(await tempHandle.getFile())) throw new Error("Hugging Face returned a Git LFS pointer instead of model data: " + item.path)
    try { await parent.getFileHandle(name); throw new Error("Existing model file preserved: " + item.path) } catch (error) { if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error }
    const output = await parent.getFileHandle(name, { create: true })
    const outputWriter = await output.createWritable()
    await outputWriter.write(await tempHandle.getFile())
    await outputWriter.close()
    await parent.removeEntry(temp)
    return { model_id: selection.model_id, revision: selection.revision!, dtype: selection.dtype, file: item.path, path, size_bytes: received }
  } catch (error) {
    try { await reader.cancel(error) } catch { }
    try { await writer.abort(error) } catch { }
    await removeFile(root, pathParts.slice(0, -1).concat(temp).join("/"))
    throw error
  }
}
export async function prepareModel(selection: BrowserModelSelection, signal: AbortSignal, progress: (value: BrowserModelPreparationProgress) => void, folder = activeFolder): Promise<BrowserModelReadyState> {
  if (!folder) throw new Error("Connect a model folder first.")
  const run = operationQueue.then(async () => {
    if (signal.aborted) throw new DOMException("Download cancelled", "AbortError")
    const { files, missing } = await requiredFiles(folder, selection, signal)
    const added: BrowserModelFolderFile[] = []
    try {
      for (const [i, item] of missing.entries()) added.push(await downloadOne(folder, selection, item, i, missing.length, signal, progress))
      if (signal.aborted) throw new DOMException("Download cancelled", "AbortError")
      await updateIndex(folder, (index) => {
        const entries = new Map(index.files.map((entry) => [entry.model_id + "@" + entry.revision + ":" + entry.dtype + ":" + entry.file, entry]))
        for (const entry of added) entries.set(entry.model_id + "@" + entry.revision + ":" + entry.dtype + ":" + entry.file, entry)
        return { ...index, schema_version: 1, files: [...entries.values()] }
      })
    } catch (error) {
      for (const entry of added) await removeFile(folder, entry.path)
      throw error
    }
    const found = await Promise.all(files.map((item) => findLocal(folder, selection, item.path)))
    const ready = found.every(Boolean)
    if (ready) await bindSelection(folder, selection, files.map((item) => item.path), found)
    return { ready, present_files: found.filter(Boolean).length, total_files: files.length, message: "Model files are ready in the selected folder." }
  })
  operationQueue = run.then(() => undefined, () => undefined)
  return run
}
export function createModelFolderCache(folder: FileSystemDirectoryHandle): Cache {
  return {
    async match(request: RequestInfo | URL): Promise<Response | undefined> {
      const raw = request instanceof Request ? request.url : String(request)
      let url: URL
      try { url = new URL(raw) } catch { return undefined }
      const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/u)
      if (!match) return undefined
      const id = match[1].split("/").map(decodeURIComponent).join("/")
      const revision = decodeURIComponent(match[2])
      const fileName = match[3].split("/").map(decodeURIComponent).join("/")
      const index = await readIndex(folder)
      const indexed = index.files.find((item) => item.model_id === id && item.revision === revision && item.file === fileName)
      const paths = [...(indexed ? [indexed.path] : []), "models--" + id.replaceAll("/", "--") + "/snapshots/" + revision + "/" + fileName, "snapshots/" + revision + "/" + fileName]
      for (const path of paths) {
        const file = await readFile(folder, path)
        if (file && file.size > 0 && !await isGitLfsPointer(file)) return new Response(file, { headers: { "Content-Type": fileName.endsWith(".json") ? "application/json" : "application/octet-stream", "Content-Length": String(file.size) } })
      }
      const binding = index.bindings?.find((item) => item.model_id === id && item.revision === revision && item.files.includes(fileName))
      if (binding && await flatConfigMatches(folder, id)) {
        const file = await readFile(folder, fileName)
        if (file && file.size > 0 && !await isGitLfsPointer(file)) return new Response(file, { headers: { "Content-Type": fileName.endsWith(".json") ? "application/json" : "application/octet-stream", "Content-Length": String(file.size) } })
      }
      return undefined
    },
    async put(request: RequestInfo | URL, response: Response): Promise<void> {
      if (!response.ok) return
      const raw = request instanceof Request ? request.url : String(request)
      let url: URL
      try { url = new URL(raw) } catch { return }
      const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/u)
      if (!match) return
      const modelId = match[1].split("/").map(decodeURIComponent).join("/")
      const revision = decodeURIComponent(match[2])
      const file = match[3].split("/").map(decodeURIComponent).join("/")
      const dtype = file.endsWith("_q4f16.onnx") ? "q4f16" : file.endsWith("_quantized.onnx") ? "q8" : file.endsWith("_q4.onnx") ? "q4" : file.endsWith("_fp16.onnx") ? "fp16" : "fp32"
      const path = BROWSER_MODEL_FOLDER_DATA + "/" + encodeURIComponent(modelId) + "/" + revision + "/" + dtype + "/" + file
      const pathParts = parts(path)
      const parent = await directory(folder, pathParts.slice(0, -1).join("/"), true)
      const name = pathParts.at(-1)!
      try { await parent.getFileHandle(name); return } catch (error) { if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error }
      const temp = name + "." + crypto.randomUUID() + ".partial"
      const tempHandle = await parent.getFileHandle(temp, { create: true })
      const writer = await tempHandle.createWritable()
      const reader = response.body?.getReader()
      let size = 0
      try {
        if (reader) {
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            size += chunk.value.byteLength
            await writer.write(chunk.value)
          }
        } else {
          const bytes = await response.arrayBuffer()
          size = bytes.byteLength
          await writer.write(bytes)
        }
        await writer.close()
        const tempFile = await tempHandle.getFile()
        if (await isGitLfsPointer(tempFile)) throw new Error("Hugging Face returned a Git LFS pointer instead of model data: " + file)
        try { await parent.getFileHandle(name); throw new Error("Existing model file preserved: " + file) } catch (error) { if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error }
        const output = await parent.getFileHandle(name, { create: true })
        const outputWriter = await output.createWritable()
        await outputWriter.write(tempFile)
        await outputWriter.close()
        await parent.removeEntry(temp)
        const key = modelId + "@" + revision + ":" + dtype + ":" + file
        const entry = { model_id: modelId, revision, dtype, file, path, size_bytes: size }
        await updateIndex(folder, (index) => ({ ...index, files: [...index.files.filter((item) => item.model_id + "@" + item.revision + ":" + item.dtype + ":" + item.file !== key), entry] }))
      } catch (error) {
        try { await reader?.cancel(error) } catch { }
        try { await writer.abort(error) } catch { }
        await removeFile(folder, pathParts.slice(0, -1).concat(temp).join("/"))
        throw error
      }
    },
  } as unknown as Cache
}
export async function getModelFolderIndex(folder = activeFolder): Promise<BrowserModelFolderIndex> { return folder ? readIndex(folder) : emptyIndex() }
