import type { BrowserModelCacheEntry, BrowserModelCacheItem } from "../types/browserAnalysis"
import { BROWSER_MODEL_CACHE_INDEX, BROWSER_MODEL_CACHE_ROOT } from "../browserAnalysisConstants"
import { getWorkspaceHandle, listWorkspaceFiles, readWorkspaceJson, removeWorkspaceEntry, writeWorkspaceJson } from "./workspace"

let cacheIndexQueue: Promise<void> = Promise.resolve()

async function entries(root?: FileSystemDirectoryHandle): Promise<Record<string, BrowserModelCacheEntry>> {
  try {
    if (root) return JSON.parse(await (await workerRead(root, BROWSER_MODEL_CACHE_INDEX)).text()) as Record<string, BrowserModelCacheEntry>
    return await readWorkspaceJson<Record<string, BrowserModelCacheEntry>>(BROWSER_MODEL_CACHE_INDEX)
  } catch {
    return {}
  }
}

async function keyFor(url: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url))
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("")
}

function requestUrl(request: RequestInfo | URL): string {
  return request instanceof Request ? request.url : String(request)
}

function modelIdFromUrl(url: string): string {
  const parsed = new URL(url)
  const segments = parsed.pathname.split("/").filter(Boolean)
  const resolveIndex = segments.indexOf("resolve")
  return resolveIndex > 1 ? segments.slice(0, resolveIndex).join("/") : segments.slice(0, 2).join("/")
}

async function workerRead(root: FileSystemDirectoryHandle, path: string): Promise<File> {
  let directory = root
  const parts = path.split("/")
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part)
  return (await directory.getFileHandle(parts.at(-1)!)).getFile()
}

async function workerWrite(root: FileSystemDirectoryHandle, path: string, data: Blob | BufferSource): Promise<void> {
  let directory = root
  const parts = path.split("/")
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true })
  const file = await directory.getFileHandle(parts.at(-1)!, { create: true })
  const writable = await file.createWritable()
  try {
    await writable.write(data)
    await writable.close()
  } catch (error) {
    try { await writable.abort(error) } catch { }
    throw error
  }
}

async function workerWriteResponse(root: FileSystemDirectoryHandle, path: string, response: Response): Promise<number> {
  let directory = root
  const parts = path.split("/")
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true })
  const file = await directory.getFileHandle(parts.at(-1)!, { create: true })
  const writable = await file.createWritable()
  const reader = response.body?.getReader()
  let size = 0
  try {
    if (reader) {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        await writable.write(chunk.value)
      }
    } else {
      const buffer = await response.arrayBuffer()
      size = buffer.byteLength
      await writable.write(buffer)
    }
    await writable.close()
    return size
  } catch (error) {
    try { await reader?.cancel(error) } catch { }
    try { await writable.abort(error) } catch { }
    throw error
  }
}

async function workerRemove(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  let directory = root
  const parts = path.split("/")
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part)
  await directory.removeEntry(parts.at(-1)!)
}

export function createWorkspaceModelCache(root = getWorkspaceHandle()): Cache {
  return {
    async match(request: RequestInfo | URL): Promise<Response | undefined> {
      const url = requestUrl(request)
      const key = await keyFor(url)
      const entry = (await entries(root))[key]
      if (!entry) return undefined
      try {
        const file = await workerRead(root, entry.path)
        return new Response(file, { headers: { "Content-Type": entry.content_type } })
      } catch {
        return undefined
      }
    },
    async put(request: RequestInfo | URL, response: Response): Promise<void> {
      if (!response.ok) return
      const url = requestUrl(request)
      const key = await keyFor(url)
      const path = `${BROWSER_MODEL_CACHE_ROOT}/${key}.bin`
      const commit = cacheIndexQueue.then(async () => {
        try {
          const size = await workerWriteResponse(root, path, response.clone())
          const index = await entries(root)
          index[key] = {
            url,
            path,
            model_id: modelIdFromUrl(url),
            size_bytes: size,
            content_type: response.headers.get("content-type") ?? "application/octet-stream",
          }
          await workerWrite(root, BROWSER_MODEL_CACHE_INDEX, new Blob([JSON.stringify(index, null, 2)], { type: "application/json" }))
        } catch (error) {
          try { await workerRemove(root, path) } catch { }
          throw error
        }
      })
      cacheIndexQueue = commit.catch(() => undefined)
      await commit
    },
  } as Cache
}

export async function listCachedModels(): Promise<BrowserModelCacheItem[]> {
  const grouped = new Map<string, { file_count: number; size_bytes: number }>()
  for (const entry of Object.values(await entries())) {
    const current = grouped.get(entry.model_id) ?? { file_count: 0, size_bytes: 0 }
    current.file_count += 1
    current.size_bytes += entry.size_bytes
    grouped.set(entry.model_id, current)
  }
  return [...grouped.entries()].map(([model_id, size]) => ({
    model_id,
    label: model_id,
    size_label: `${Math.max(1, Math.round(size.size_bytes / 1_048_576))} MB`,
    ...size,
  })).sort((left, right) => left.model_id.localeCompare(right.model_id))
}

export async function deleteCachedModel(modelId: string): Promise<void> {
  const index = await entries()
  const retained = Object.fromEntries(Object.entries(index).filter(([, entry]) => entry.model_id !== modelId))
  await Promise.all(Object.entries(index).filter(([, entry]) => entry.model_id === modelId).map(([, entry]) => removeWorkspaceEntry(entry.path)))
  await writeWorkspaceJson(BROWSER_MODEL_CACHE_INDEX, retained)
}

export async function listCacheFiles(): Promise<string[]> {
  return listWorkspaceFiles(BROWSER_MODEL_CACHE_ROOT)
}
