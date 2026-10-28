import { FFmpeg } from "@ffmpeg/ffmpeg"
import coreURL from "@ffmpeg/core?url"
import wasmURL from "@ffmpeg/core/wasm?url"
import classWorkerURL from "../../node_modules/@ffmpeg/ffmpeg/dist/esm/worker.js?worker&url"

let instance: FFmpeg | null = null
let queue: Promise<void> = Promise.resolve()

async function ready(signal?: AbortSignal): Promise<FFmpeg> {
  if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError")
  if (!instance) {
    const ffmpeg = new FFmpeg()
    try {
      await ffmpeg.load({ coreURL, wasmURL, classWorkerURL }, { signal })
    } catch (error) {
      ffmpeg.terminate()
      throw error
    }
    instance = ffmpeg
  }
  return instance
}

export async function withBrowserFfmpeg<T>(
  signal: AbortSignal | undefined,
  action: (ffmpeg: FFmpeg) => Promise<T>,
): Promise<T> {
  let release: () => void = () => undefined
  const previous = queue
  queue = new Promise<void>((resolve) => { release = resolve })
  await previous
  let ffmpeg: FFmpeg | null = null
  let abortHandler: (() => void) | undefined
  try {
    if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError")
    ffmpeg = await ready(signal)
    abortHandler = () => { ffmpeg?.terminate(); instance = null }
    signal?.addEventListener("abort", abortHandler, { once: true })
    return await action(ffmpeg)
  } catch (error) {
    if (signal?.aborted && ffmpeg) {
      ffmpeg.terminate()
      instance = null
    }
    throw error
  } finally {
    if (abortHandler) signal?.removeEventListener("abort", abortHandler)
    release()
  }
}

export async function cleanupFfmpegFiles(ffmpeg: FFmpeg, paths: string[]): Promise<void> {
  await Promise.all(paths.map(async (path) => {
    try { await ffmpeg.deleteFile(path) } catch {}
  }))
}
