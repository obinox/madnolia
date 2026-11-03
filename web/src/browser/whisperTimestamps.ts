import { Tensor, cat, dynamic_time_warping, mean, medianFilter, stack, std_mean } from "@huggingface/transformers"
import type { BrowserWhisperTimestampOptions } from "../types/browserWhisperTimestamps"
import {
  BROWSER_WHISPER_TIMESTAMP_DEFAULT_MEDIAN_FILTER_WIDTH,
  BROWSER_WHISPER_TIMESTAMP_DEFAULT_TIME_PRECISION_SECONDS,
  BROWSER_WHISPER_TIMESTAMP_SINGLE_BATCH_SIZE,
} from "../browserWhisperTimestampConstants"

/** Use actual encoder frames; remove restored context timestamps with their tokens before tokenizer._decode_asr. */
export function extractWhisperTokenTimestamps({
  crossAttentions,
  sequences,
  alignmentHeads,
  encoderFrameCount,
  timePrecisionSeconds = BROWSER_WHISPER_TIMESTAMP_DEFAULT_TIME_PRECISION_SECONDS,
  medianFilterWidth = BROWSER_WHISPER_TIMESTAMP_DEFAULT_MEDIAN_FILTER_WIDTH,
  previousContextTokenCount = 0,
}: BrowserWhisperTimestampOptions): Tensor {
  if (!Array.isArray(crossAttentions) || crossAttentions.length === 0) throw new Error("Whisper timestamp extraction requires cross-attention steps.")
  if (!(sequences instanceof Tensor) || sequences.dims.length !== 2 || sequences.dims[0] !== BROWSER_WHISPER_TIMESTAMP_SINGLE_BATCH_SIZE) {
    throw new Error("Whisper timestamp extraction supports exactly one sequence batch with shape [1, tokens].")
  }
  if (!Array.isArray(alignmentHeads) || alignmentHeads.length === 0) throw new Error("Whisper timestamp extraction requires at least one alignment head.")
  if (!Number.isInteger(encoderFrameCount) || encoderFrameCount <= 0) throw new RangeError("encoderFrameCount must be a positive integer from the actual encoder output.")
  if (!Number.isFinite(timePrecisionSeconds) || timePrecisionSeconds <= 0) throw new RangeError("timePrecisionSeconds must be finite and positive.")
  if (!Number.isInteger(medianFilterWidth) || medianFilterWidth <= 0 || medianFilterWidth % 2 === 0) throw new RangeError("medianFilterWidth must be a positive odd integer.")
  if (!Number.isInteger(previousContextTokenCount) || previousContextTokenCount < 0 || previousContextTokenCount >= sequences.dims[1]) {
    throw new RangeError("previousContextTokenCount must be a nonnegative integer smaller than the sequence length.")
  }

  const originalTokenCount = sequences.dims[1]
  const layerCount = crossAttentions[0]?.length ?? 0
  if (layerCount === 0) throw new Error("Whisper cross-attention steps must contain decoder layers.")
  const layerTensors: Tensor[][] = Array.from({ length: layerCount }, () => [])
  let totalQueryRows = 0
  let stepQueryRows = 0
  let frameWidth = -1
  let headCount = -1

  for (let stepIndex = 0; stepIndex < crossAttentions.length; stepIndex += 1) {
    const step = crossAttentions[stepIndex]
    if (!Array.isArray(step) || step.length !== layerCount) throw new Error(`Whisper cross-attention step ${stepIndex} has an inconsistent decoder layer count.`)
    for (let layerIndex = 0; layerIndex < layerCount; layerIndex += 1) {
      const attention = step[layerIndex]
      if (!(attention instanceof Tensor) || attention.dims.length !== 4 || attention.dims[0] !== BROWSER_WHISPER_TIMESTAMP_SINGLE_BATCH_SIZE) {
        throw new Error(`Whisper cross-attention at step ${stepIndex}, layer ${layerIndex} must have shape [1, heads, query, frames].`)
      }
      const [batch, heads, queryRows, frames] = attention.dims
      if (heads <= 0 || queryRows <= 0 || frames <= 0) throw new Error(`Whisper cross-attention at step ${stepIndex}, layer ${layerIndex} has an empty dimension.`)
      if (frameWidth < 0) { frameWidth = frames; headCount = heads }
      if (frames !== frameWidth || heads !== headCount) throw new Error("Whisper cross-attention heads and frame widths must match across steps and layers.")
      if (layerIndex === 0) stepQueryRows = queryRows
      else if (queryRows !== stepQueryRows) throw new Error(`Whisper cross-attention step ${stepIndex} has inconsistent query row counts across layers.`)
      if (attention.data.length !== batch * heads * queryRows * frames) throw new Error(`Whisper cross-attention at step ${stepIndex}, layer ${layerIndex} has inconsistent tensor data.`)
      for (const value of attention.data) if (!Number.isFinite(value)) throw new Error(`Whisper cross-attention contains a non-finite value at step ${stepIndex}, layer ${layerIndex}.`)
      layerTensors[layerIndex].push(attention)
    }
    totalQueryRows += step[0].dims[2]
  }

  if (encoderFrameCount > frameWidth) throw new RangeError(`encoderFrameCount (${encoderFrameCount}) exceeds the available cross-attention frame width (${frameWidth}).`)
  if (totalQueryRows + 1 !== originalTokenCount) throw new Error(`Whisper cross-attention has ${totalQueryRows} query rows for ${originalTokenCount} autoregressive sequence tokens; expected one query per token after the initial token.`)
  if (previousContextTokenCount >= totalQueryRows) throw new RangeError("previousContextTokenCount must leave at least one autoregressive attention query.")
  if (previousContextTokenCount > (crossAttentions[0][0].dims[2] - 1)) throw new RangeError("previousContextTokenCount exceeds the first-step context query rows and would remove task prompt tokens.")

  const croppedByLayer = layerTensors.map((steps) => {
    const joined = cat(steps, 2)
    const remaining = previousContextTokenCount === 0 ? joined : joined.slice(null, null, [previousContextTokenCount, totalQueryRows], null)
    return remaining.slice(null, null, null, [0, encoderFrameCount])
  })
  const remainingTokenCount = originalTokenCount - previousContextTokenCount - 1
  if (croppedByLayer[0].dims[2] !== remainingTokenCount) throw new Error("Whisper context removal did not match the requested token prefix length.")

  const selectedHeads = alignmentHeads.map((alignmentHead) => {
    if (!Array.isArray(alignmentHead) || alignmentHead.length !== 2) throw new Error("Each Whisper alignment head must contain a layer and head index.")
    const [layerIndex, headIndex] = alignmentHead
    if (!Number.isInteger(layerIndex) || layerIndex < 0 || layerIndex >= layerCount) throw new RangeError(`Whisper alignment layer index ${layerIndex} is out of bounds for ${layerCount} layers.`)
    if (!Number.isInteger(headIndex) || headIndex < 0 || headIndex >= headCount) throw new RangeError(`Whisper alignment head index ${headIndex} is out of bounds for ${headCount} heads.`)
    return croppedByLayer[layerIndex].slice(null, headIndex, null, null)
  })

  const weights = stack(selectedHeads).transpose(1, 0, 2, 3)
  const [std, calculatedMean] = std_mean(weights, -2, 0, true)
  const smoothedWeights = weights.clone()
  const smoothedData = smoothedWeights.data as Float32Array
  const stdValues = std.data as Float32Array
  const meanValues = calculatedMean.data as Float32Array
  for (let head = 0; head < smoothedWeights.dims[1]; head += 1) {
    const offset = head * encoderFrameCount
    const stdData = stdValues.subarray(offset, offset + encoderFrameCount)
    const meanData = meanValues.subarray(offset, offset + encoderFrameCount)
    if (stdData.some((value) => !Number.isFinite(value)) || meanData.some((value) => !Number.isFinite(value))) {
      throw new Error(`Whisper attention normalization produced non-finite statistics for alignment head ${head}.`)
    }
    for (let token = 0; token < remainingTokenCount; token += 1) {
      const tokenOffset = (head * remainingTokenCount + token) * encoderFrameCount
      const values = smoothedData.subarray(tokenOffset, tokenOffset + encoderFrameCount)
      for (let frame = 0; frame < values.length; frame += 1) {
        values[frame] = stdData[frame] === 0 ? 0 : (values[frame] - meanData[frame]) / stdData[frame]
        if (!Number.isFinite(values[frame])) throw new Error(`Whisper attention normalization produced a non-finite value for alignment head ${head}, token ${token}, frame ${frame}.`)
      }
      values.set(medianFilter(values, medianFilterWidth))
    }
  }

  const matrix = mean(smoothedWeights, 1).neg().squeeze_(0).tolist() as number[][]
  const [textPath, timePath] = dynamic_time_warping(matrix)
  const tokenFrames = new Array<number>(remainingTokenCount).fill(-1)
  for (let pathIndex = 0; pathIndex < textPath.length; pathIndex += 1) {
    const tokenIndex = textPath[pathIndex]
    if (tokenFrames[tokenIndex] < 0) tokenFrames[tokenIndex] = timePath[pathIndex]
  }
  if (tokenFrames.some((frame) => frame < 0 || frame >= encoderFrameCount)) throw new Error("Whisper DTW did not produce a valid frame for every aligned token.")

  const output = new Tensor("float32", new Float32Array(originalTokenCount), sequences.dims)
  for (let token = 0; token < remainingTokenCount; token += 1) {
    const timestamp = tokenFrames[token] * timePrecisionSeconds
    if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > encoderFrameCount * timePrecisionSeconds) {
      throw new Error(`Whisper DTW produced an invalid timestamp for token ${token}.`)
    }
    output.data[previousContextTokenCount + token + 1] = timestamp
  }
  for (let token = 1; token < originalTokenCount; token += 1) {
    if (output.data[token] < output.data[token - 1]) throw new Error("Whisper DTW produced non-monotonic token timestamps.")
  }
  return output
}
