import type { BrowserAsrAcceptedWord } from "../types/browserAsrDecoding"
import type { BrowserAsrWindowCallbacks, BrowserAsrWindowDecoder } from "../types/browserAsrWindowTranscription"
import type { BrowserSpeechInterval } from "../types/browserSpeech"
import { BROWSER_SILERO_SAMPLE_RATE } from "../browserSpeechConstants"
import {
  asrContextPrompt,
  asrMaxNewTokens,
  asrSpeechWindows,
  hasRepeatedAsrTranscription,
  mergeAsrWindowWords,
} from "./asrDecoding"

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("ASR transcription was cancelled.", "AbortError")
}

async function acceptedContextHash(words: BrowserAsrAcceptedWord[]): Promise<string> {
  const context = JSON.stringify(words.map(({ text, start_ms, end_ms }) => [text, start_ms, end_ms]))
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(context))
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")
}

export async function transcribeAsrWindows(
  samples: Float32Array,
  regions: BrowserSpeechInterval[],
  decode: BrowserAsrWindowDecoder,
  callbacks: BrowserAsrWindowCallbacks = {},
): Promise<BrowserAsrAcceptedWord[]> {
  const windows = asrSpeechWindows(regions)
  if (!windows.length) return []

  const accepted: BrowserAsrAcceptedWord[] = []
  let reused = 0
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index]
    throwIfCancelled(callbacks.signal)
    await callbacks.onBoundary?.({ window, index: index + 1, total: windows.length })
    throwIfCancelled(callbacks.signal)

    const startSample = window.start_ms * BROWSER_SILERO_SAMPLE_RATE / 1000
    const endSample = window.end_ms * BROWSER_SILERO_SAMPLE_RATE / 1000
    const contextHash = await acceptedContextHash(accepted)
    let rawWords = await callbacks.loadCheckpoint?.(index, window, contextHash) ?? null
    if (rawWords) reused += 1
    else {
      rawWords = await decode(samples.subarray(startSample, endSample), {
        contextPrompt: asrContextPrompt(accepted, window.start_ms),
        maxNewTokens: asrMaxNewTokens((window.end_ms - window.start_ms) / 1000),
        window,
      })
      throwIfCancelled(callbacks.signal)
      if (hasRepeatedAsrTranscription(rawWords)) throw new Error("repeated transcription detected")
      await callbacks.saveCheckpoint?.(index, window, rawWords, contextHash)
    }
    throwIfCancelled(callbacks.signal)
    accepted.push(...mergeAsrWindowWords(rawWords, window, regions))
    throwIfCancelled(callbacks.signal)
    await callbacks.onProgress?.({ window, index: index + 1, total: windows.length, completed: index + 1, reused })
  }

  throwIfCancelled(callbacks.signal)
  return accepted
}
