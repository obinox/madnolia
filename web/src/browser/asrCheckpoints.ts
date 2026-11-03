import type { BrowserAsrRawWord } from "../types/browserAsrDecoding"
import type { BrowserAsrWindowCheckpoint } from "../types/browserAsrWindowTranscription"
import type { BrowserSpeechWindow } from "../types/browserSpeech"
import { BROWSER_ASR_CHECKPOINT_VERSION } from "../browserAnalysisConstants"
import { hasRepeatedAsrTranscription } from "./asrDecoding"

async function directoryAt(root: FileSystemDirectoryHandle, path: string, create = false): Promise<FileSystemDirectoryHandle> {
  let directory = root
  for (const part of path.split("/")) directory = await directory.getDirectoryHandle(part, { create })
  return directory
}

export function validateAsrCheckpoint(value: unknown, identity: string, window: BrowserSpeechWindow, contextHash = ""): BrowserAsrRawWord[] | null {
  if (!value || typeof value !== "object") return null
  const checkpoint = value as Partial<BrowserAsrWindowCheckpoint>
  if (checkpoint.version !== BROWSER_ASR_CHECKPOINT_VERSION || checkpoint.identity !== identity || checkpoint.context_hash !== contextHash
    || !checkpoint.window || !Number.isFinite(checkpoint.window.start_ms) || !Number.isFinite(checkpoint.window.end_ms)
    || !Number.isFinite(checkpoint.window.keep_start_ms) || !Number.isFinite(checkpoint.window.keep_end_ms)
    || checkpoint.window.start_ms < 0 || checkpoint.window.end_ms <= checkpoint.window.start_ms
    || checkpoint.window.keep_start_ms < checkpoint.window.start_ms || checkpoint.window.keep_end_ms > checkpoint.window.end_ms
    || checkpoint.window.keep_end_ms <= checkpoint.window.keep_start_ms
    || checkpoint.window.start_ms !== window.start_ms || checkpoint.window.end_ms !== window.end_ms
    || checkpoint.window.keep_start_ms !== window.keep_start_ms || checkpoint.window.keep_end_ms !== window.keep_end_ms
    || !Array.isArray(checkpoint.words)) return null
  const words = checkpoint.words
  if (words.some((word) => !word || typeof word.text !== "string" || !word.text.trim()
    || !Number.isFinite(word.start_ms) || !Number.isFinite(word.end_ms)
    || word.start_ms < 0 || word.end_ms <= word.start_ms || word.end_ms > window.end_ms - window.start_ms)) return null
  if (hasRepeatedAsrTranscription(words as BrowserAsrRawWord[])) return null
  return words as BrowserAsrRawWord[]
}

export async function readAsrWindowCheckpoint(root: FileSystemDirectoryHandle, path: string, index: number, identity: string, window: BrowserSpeechWindow, contextHash = ""): Promise<BrowserAsrRawWord[] | null> {
  let directory: FileSystemDirectoryHandle
  try { directory = await directoryAt(root, path) } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null
    throw error
  }
  const prefix = `${String(index + 1).padStart(6, "0")}-`
  const candidates: FileSystemFileHandle[] = []
  for await (const entry of directory.values()) if (entry.kind === "file" && entry.name.startsWith(prefix)) candidates.push(entry)
  candidates.sort((left, right) => right.name.localeCompare(left.name))
  for (const entry of candidates) {
    try {
      const saved = JSON.parse(await (await entry.getFile()).text()) as unknown
      const words = validateAsrCheckpoint(saved, identity, window, contextHash)
      if (words) return words
    } catch (error) {
      if (error instanceof SyntaxError) continue
      throw error
    }
  }
  return null
}

export async function writeAsrWindowCheckpoint(root: FileSystemDirectoryHandle, path: string, index: number, identity: string, window: BrowserSpeechWindow, words: BrowserAsrRawWord[], contextHash = ""): Promise<void> {
  if (!validateAsrCheckpoint({ version: BROWSER_ASR_CHECKPOINT_VERSION, identity, context_hash: contextHash, window, words }, identity, window, contextHash)) throw new Error("Refusing to persist invalid ASR checkpoint words.")
  const directory = await directoryAt(root, path, true)
  const sequence = String(Date.now()).padStart(16, "0")
  const file = await directory.getFileHandle(`${String(index + 1).padStart(6, "0")}-${sequence}-${crypto.randomUUID()}.json`, { create: true })
  const writable = await file.createWritable()
  try {
    await writable.write(new Blob([JSON.stringify({ version: BROWSER_ASR_CHECKPOINT_VERSION, identity, context_hash: contextHash, window, words } satisfies BrowserAsrWindowCheckpoint)], { type: "application/json" }))
    await writable.close()
  } catch (error) {
    try { await writable.abort(error) } catch { }
    throw error
  }
}
