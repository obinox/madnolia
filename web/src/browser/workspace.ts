import {
  BROWSER_WORKSPACE_DB_NAME,
  BROWSER_WORKSPACE_DB_VERSION,
  BROWSER_WORKSPACE_DIRECTORIES,
  BROWSER_WORKSPACE_HANDLE_KEY,
  BROWSER_WORKSPACE_MANIFEST_PATH,
  BROWSER_WORKSPACE_OBJECT_STORE,
  BROWSER_WORKSPACE_SCHEMA_VERSION,
} from "../browserConstants"
import type { BrowserDirectoryPickerWindow, BrowserPermissionDirectoryHandle, BrowserWorkspaceManifest } from "../types/browser"

let activeWorkspace: FileSystemDirectoryHandle | null = null

function openWorkspaceDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BROWSER_WORKSPACE_DB_NAME, BROWSER_WORKSPACE_DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(BROWSER_WORKSPACE_OBJECT_STORE)) {
        request.result.createObjectStore(BROWSER_WORKSPACE_OBJECT_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("브라우저 작업공간 저장소를 열 수 없습니다."))
  })
}

async function storedHandle(operation: "get" | "put", handle?: BrowserPermissionDirectoryHandle): Promise<BrowserPermissionDirectoryHandle | null> {
  const database = await openWorkspaceDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(BROWSER_WORKSPACE_OBJECT_STORE, operation === "put" ? "readwrite" : "readonly")
      const store = transaction.objectStore(BROWSER_WORKSPACE_OBJECT_STORE)
      const request = operation === "put"
        ? store.put(handle, BROWSER_WORKSPACE_HANDLE_KEY)
        : store.get(BROWSER_WORKSPACE_HANDLE_KEY)
      let result: BrowserPermissionDirectoryHandle | null = null
      request.onsuccess = () => { result = operation === "get" ? (request.result as BrowserPermissionDirectoryHandle | null) ?? null : handle ?? null }
      request.onerror = () => reject(request.error ?? new Error("브라우저 작업공간 정보를 저장하지 못했습니다."))
      transaction.oncomplete = () => resolve(result)
      transaction.onerror = () => reject(transaction.error ?? new Error("브라우저 작업공간 정보를 저장하지 못했습니다."))
      transaction.onabort = () => reject(transaction.error ?? new Error("브라우저 작업공간 저장이 취소되었습니다."))
    })
  } finally {
    database.close()
  }
}

export async function getSavedWorkspaceHandle(): Promise<BrowserPermissionDirectoryHandle | null> {
  return storedHandle("get")
}

export async function restoreWorkspaceHandle(handle?: BrowserPermissionDirectoryHandle | null): Promise<BrowserPermissionDirectoryHandle | null> {
  const saved = handle === undefined ? await storedHandle("get") : handle
  if (!saved) return null
  const permission = await saved.queryPermission({ mode: "readwrite" })
  if (permission !== "granted") return null
  await initializeWorkspace(saved)
  return saved
}

export async function requestSavedWorkspace(): Promise<BrowserPermissionDirectoryHandle | null> {
  const handle = await storedHandle("get")
  if (!handle) return null
  const permission = await handle.requestPermission({ mode: "readwrite" })
  if (permission !== "granted") throw new Error("폴더 읽기와 저장 권한을 허용해야 작업공간을 사용할 수 있습니다.")
  await initializeWorkspace(handle)
  return handle
}

export async function connectWorkspace(): Promise<BrowserPermissionDirectoryHandle> {
  const pickerWindow = window as unknown as BrowserDirectoryPickerWindow
  if (typeof pickerWindow.showDirectoryPicker !== "function") {
    throw new Error("로컬 폴더 연결은 HTTPS의 최신 Chrome 또는 Edge에서 사용할 수 있습니다.")
  }
  const handle = await pickerWindow.showDirectoryPicker({ id: "madnolia-workspace", mode: "readwrite" })
  const permission = await handle.requestPermission({ mode: "readwrite" })
  if (permission !== "granted") throw new Error("폴더 읽기와 저장 권한을 허용해야 작업공간을 사용할 수 있습니다.")
  await initializeWorkspace(handle)
  await storedHandle("put", handle)
  return handle
}

export async function reconnectWorkspace(): Promise<BrowserPermissionDirectoryHandle> {
  const handle = await storedHandle("get")
  if (!handle) return connectWorkspace()
  const permission = await handle.requestPermission({ mode: "readwrite" })
  if (permission !== "granted") throw new Error("폴더 읽기와 저장 권한을 허용해야 작업공간을 사용할 수 있습니다.")
  await initializeWorkspace(handle)
  activeWorkspace = handle
  return handle
}

async function initializeWorkspace(handle: BrowserPermissionDirectoryHandle): Promise<void> {
  const hasManifest = await validateWorkspaceRoot(handle)
  if (!hasManifest) {
  const marker = await handle.getFileHandle(BROWSER_WORKSPACE_MANIFEST_PATH, { create: true })
  const markerWritable = await marker.createWritable()
  await markerWritable.write(new Blob([JSON.stringify({
    application: "madnolia-browser",
    schema_version: BROWSER_WORKSPACE_SCHEMA_VERSION,
    created_at: new Date().toISOString(),
  } satisfies BrowserWorkspaceManifest)], { type: "application/json" }))
  await markerWritable.close()
  }
  activeWorkspace = handle
}

async function validateWorkspaceRoot(handle: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    const marker = await handle.getFileHandle(BROWSER_WORKSPACE_MANIFEST_PATH)
    const value = JSON.parse(await (await marker.getFile()).text()) as BrowserWorkspaceManifest
    if (value.application !== "madnolia-browser" || value.schema_version !== BROWSER_WORKSPACE_SCHEMA_VERSION) {
      throw new Error("선택한 폴더는 다른 Madnolia 작업공간 형식입니다.")
    }
    return true
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error
  }
  for (const name of BROWSER_WORKSPACE_DIRECTORIES) {
    try {
      const directory = await handle.getDirectoryHandle(name)
      for await (const entry of directory.values()) {
        if (entry.kind === "directory" || entry.kind === "file") {
          throw new Error("기존 데이터가 있는 폴더입니다. 브라우저용 새 작업공간 폴더를 선택하세요.")
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("브라우저용 새 작업공간")) throw error
      if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error
    }
  }
  return false
}

export function getWorkspaceHandle(): FileSystemDirectoryHandle {
  if (!activeWorkspace) throw new Error("브라우저 작업공간에 연결되지 않았습니다.")
  return activeWorkspace
}

function pathParts(path: string): string[] {
  if (!path || path.startsWith("/") || path.includes("\\") || /^[a-z]:/i.test(path)) {
    throw new Error("작업공간 경로가 올바르지 않습니다.")
  }
  const parts = path.split("/")
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("작업공간 경로가 올바르지 않습니다.")
  return parts
}

async function directoryAt(parts: string[], create = false): Promise<FileSystemDirectoryHandle> {
  let directory = getWorkspaceHandle()
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create })
  return directory
}

export async function readWorkspaceJson<T>(path: string): Promise<T> {
  const parts = pathParts(path)
  const parent = await directoryAt(parts.slice(0, -1))
  const file = await parent.getFileHandle(parts.at(-1)!)
  return JSON.parse(await (await file.getFile()).text()) as T
}

export async function writeWorkspaceJson(path: string, value: unknown): Promise<void> {
  await writeWorkspaceFile(path, new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }))
}

export async function readWorkspaceFile(path: string): Promise<File> {
  const parts = pathParts(path)
  const parent = await directoryAt(parts.slice(0, -1))
  return (await parent.getFileHandle(parts.at(-1)!)).getFile()
}

export async function writeWorkspaceFile(path: string, data: Blob | BufferSource, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError")
  const parts = pathParts(path)
  const parent = await directoryAt(parts.slice(0, -1), true)
  const file = await parent.getFileHandle(parts.at(-1)!, { create: true })
  const writable = await file.createWritable()
  let abortHandler: (() => void) | undefined
  try {
    const write = (async () => { await writable.write(data); await writable.close() })()
    if (signal) {
      const aborted = new Promise<never>((_, reject) => {
        abortHandler = () => { const error = new DOMException("Operation cancelled", "AbortError"); void writable.abort(error); reject(error) }
        signal.addEventListener("abort", abortHandler, { once: true })
        if (signal.aborted) abortHandler()
      })
      await Promise.race([write, aborted])
    } else await write
  } catch (error) {
    try { await writable.abort(error) } catch { }
    throw error
  } finally {
    if (abortHandler) signal?.removeEventListener("abort", abortHandler)
  }
}

export async function listWorkspaceDirectories(path: string): Promise<string[]> {
  let directory: FileSystemDirectoryHandle
  try { directory = path ? await directoryAt(pathParts(path)) : getWorkspaceHandle() }
  catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return []
    throw error
  }
  const names: string[] = []
  for await (const entry of directory.values()) if (entry.kind === "directory") names.push(entry.name)
  return names.sort((left, right) => left.localeCompare(right))
}

export async function listWorkspaceFiles(path: string): Promise<string[]> {
  let directory: FileSystemDirectoryHandle
  try { directory = path ? await directoryAt(pathParts(path)) : getWorkspaceHandle() }
  catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return []
    throw error
  }
  const names: string[] = []
  for await (const entry of directory.values()) if (entry.kind === "file") names.push(entry.name)
  return names.sort((left, right) => left.localeCompare(right))
}

export async function removeWorkspaceEntry(path: string): Promise<void> {
  const parts = pathParts(path)
  const parent = await directoryAt(parts.slice(0, -1))
  await parent.removeEntry(parts.at(-1)!, { recursive: true })
}
