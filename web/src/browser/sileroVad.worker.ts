import * as ort from "onnxruntime-web"
import wasmMjsUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url"
import wasmUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url"
import type { BrowserSileroVadCancel, BrowserSileroVadRequest, BrowserSileroVadResponse } from "../types/browserSpeech"
import {
  BROWSER_SILERO_CHUNK_MS,
  BROWSER_SILERO_CONTEXT_SAMPLES,
  BROWSER_SILERO_SAMPLE_RATE,
  BROWSER_SILERO_STATE_SIZE,
  BROWSER_SILERO_WINDOW_SAMPLES,
} from "../browserSpeechConstants"

ort.env.wasm.numThreads = 1
ort.env.wasm.proxy = false
ort.env.wasm.wasmPaths = { mjs: wasmMjsUrl, wasm: wasmUrl }

let cancelRequested = false

function throwIfCancelled(): void {
  if (cancelRequested) throw new DOMException("Silero VAD was cancelled.", "AbortError")
}

async function infer(request: BrowserSileroVadRequest): Promise<BrowserSileroVadResponse> {
  let session: ort.InferenceSession | null = null
  try {
    if (!request.samples.every(Number.isFinite)) throw new TypeError("PCM samples must be finite.")
    if (request.samples.length === 0) return { kind: "complete", probabilities: new Float32Array(), chunkFrameCounts: [] }
    session = await ort.InferenceSession.create(request.modelUrl, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "basic",
      enableCpuMemArena: false,
    })
    const chunkSamples = BROWSER_SILERO_SAMPLE_RATE * BROWSER_SILERO_CHUNK_MS / 1000
    const chunkFrameCounts: number[] = []
    const probabilityChunks: Float32Array[] = []
    for (let chunkStart = 0; chunkStart < request.samples.length; chunkStart += chunkSamples) {
      throwIfCancelled()
      const chunk = request.samples.subarray(chunkStart, Math.min(chunkStart + chunkSamples, request.samples.length))
      const paddingSamples = BROWSER_SILERO_WINDOW_SAMPLES - chunk.length % BROWSER_SILERO_WINDOW_SAMPLES
      const padded = new Float32Array(chunk.length + paddingSamples)
      padded.set(chunk)
      const frameCount = padded.length / BROWSER_SILERO_WINDOW_SAMPLES
      let stateH = new Float32Array(BROWSER_SILERO_STATE_SIZE)
      let stateC = new Float32Array(BROWSER_SILERO_STATE_SIZE)
      let context = new Float32Array(BROWSER_SILERO_CONTEXT_SAMPLES)
      const probabilities = new Float32Array(frameCount)
      for (let frame = 0; frame < frameCount; frame += 1) {
        throwIfCancelled()
        const input = new Float32Array(BROWSER_SILERO_WINDOW_SAMPLES + BROWSER_SILERO_CONTEXT_SAMPLES)
        input.set(context)
        const frameStart = frame * BROWSER_SILERO_WINDOW_SAMPLES
        input.set(padded.subarray(frameStart, frameStart + BROWSER_SILERO_WINDOW_SAMPLES), BROWSER_SILERO_CONTEXT_SAMPLES)
        const output = await session.run({
          input: new ort.Tensor("float32", input, [1, input.length]),
          h: new ort.Tensor("float32", stateH, [1, 1, BROWSER_SILERO_STATE_SIZE]),
          c: new ort.Tensor("float32", stateC, [1, 1, BROWSER_SILERO_STATE_SIZE]),
        })
        const probability = output.speech_probs
        const nextH = output.hn
        const nextC = output.cn
        if (!probability || !nextH || !nextC) throw new Error("Silero VAD model returned unexpected output names.")
        if (!(probability.data instanceof Float32Array) || !(nextH.data instanceof Float32Array) || !(nextC.data instanceof Float32Array)) {
          throw new Error("Silero VAD model returned non-float outputs.")
        }
        probabilities[frame] = probability.data[0]
        stateH = Float32Array.from(nextH.data)
        stateC = Float32Array.from(nextC.data)
        context = padded.slice(frameStart + BROWSER_SILERO_WINDOW_SAMPLES - BROWSER_SILERO_CONTEXT_SAMPLES, frameStart + BROWSER_SILERO_WINDOW_SAMPLES)
        if (frame % 50 === 0 || frame === frameCount - 1) {
          const completedSamples = Math.min(request.samples.length, chunkStart + Math.min(frame * BROWSER_SILERO_WINDOW_SAMPLES, chunk.length))
          self.postMessage({ kind: "progress", completedSamples, totalSamples: request.samples.length } satisfies BrowserSileroVadResponse)
        }
      }
      probabilityChunks.push(probabilities)
      chunkFrameCounts.push(frameCount)
    }
    const probabilities = new Float32Array(probabilityChunks.reduce((total, chunk) => total + chunk.length, 0))
    let offset = 0
    for (const chunk of probabilityChunks) {
      probabilities.set(chunk, offset)
      offset += chunk.length
    }
    return { kind: "complete", probabilities, chunkFrameCounts }
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") return { kind: "cancelled" }
    return { kind: "failure", message: cause instanceof Error ? cause.message : String(cause) }
  } finally {
    await session?.release()
  }
}

self.onmessage = (event: MessageEvent<BrowserSileroVadRequest | BrowserSileroVadCancel>) => {
  if (event.data.kind === "cancel") {
    cancelRequested = true
    return
  }
  cancelRequested = false
  void infer(event.data).then(
    (response) => self.postMessage(response),
    (cause: unknown) => self.postMessage({ kind: "failure", message: cause instanceof Error ? cause.message : String(cause) } satisfies BrowserSileroVadResponse),
  )
}
