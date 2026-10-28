import type { BrowserAudioData } from "../types"
import type { BrowserPitchFrame } from "../types/browserAudio"
import type { PhonePitchPoint } from "../types"
import {
  BROWSER_AUDIO_MAX_F0_HZ,
  BROWSER_AUDIO_MAX_OUTPUT_SAMPLES,
  BROWSER_AUDIO_MIN_F0_HZ,
  BROWSER_AUDIO_MIN_PERIODICITY,
  BROWSER_AUDIO_MIN_RMS,
  BROWSER_AUDIO_PITCH_HOP_MS,
  BROWSER_AUDIO_PITCH_WINDOW_MS,
  BROWSER_AUDIO_PEAK_CORRELATION_TOLERANCE,
  BROWSER_AUDIO_SAMPLE_RATE,
  BROWSER_AUDIO_WAV_BITS,
} from "../browserAudioConstants"

const checkAbort = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError")
}

const yieldToBrowser = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

export function encodeWav(data: BrowserAudioData): Blob {
  if (!Number.isFinite(data.sampleRate) || data.sampleRate < 1) throw new Error("Invalid audio sample rate")
  if (data.samples.length > BROWSER_AUDIO_MAX_OUTPUT_SAMPLES) throw new Error("브라우저 WAV 출력은 30분까지 지원합니다.")
  const bytesPerSample = BROWSER_AUDIO_WAV_BITS / 8
  const dataBytes = data.samples.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const writeAscii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }
  writeAscii(0, "RIFF")
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(8, "WAVE")
  writeAscii(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, data.sampleRate, true)
  view.setUint32(28, data.sampleRate * bytesPerSample, true)
  view.setUint16(32, bytesPerSample, true)
  view.setUint16(34, BROWSER_AUDIO_WAV_BITS, true)
  writeAscii(36, "data")
  view.setUint32(40, dataBytes, true)
  for (let index = 0; index < data.samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, Number.isFinite(data.samples[index]) ? data.samples[index] : 0))
    view.setInt16(44 + index * 2, Math.round(value < 0 ? value * 32768 : value * 32767), true)
  }
  return new Blob([buffer], { type: "audio/wav" })
}

export const resampleLinear = (samples: Float32Array, sourceRate: number, targetRate: number): Float32Array => {
  if (sourceRate === targetRate) return new Float32Array(samples)
  const length = Math.max(1, Math.round(samples.length * targetRate / sourceRate))
  const output = new Float32Array(length)
  const scale = sourceRate / targetRate
  for (let index = 0; index < length; index += 1) {
    const position = index * scale
    const left = Math.min(samples.length - 1, Math.floor(position))
    const right = Math.min(samples.length - 1, left + 1)
    const fraction = position - left
    output[index] = samples[left] * (1 - fraction) + samples[right] * fraction
  }
  return output
}

export function estimatePitch(samples: Float32Array, sampleRate = BROWSER_AUDIO_SAMPLE_RATE): BrowserPitchFrame[] {
  const frameSize = Math.max(2, Math.round(sampleRate * BROWSER_AUDIO_PITCH_WINDOW_MS / 1000))
  const hopSize = Math.max(1, Math.round(sampleRate * BROWSER_AUDIO_PITCH_HOP_MS / 1000))
  if (samples.length < frameSize) return []
  const minLag = Math.max(2, Math.floor(sampleRate / BROWSER_AUDIO_MAX_F0_HZ))
  const maxLag = Math.min(frameSize - 2, Math.ceil(sampleRate / BROWSER_AUDIO_MIN_F0_HZ))
  const output: BrowserPitchFrame[] = []
  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    let mean = 0
    for (let index = 0; index < frameSize; index += 1) mean += samples[start + index]
    mean /= frameSize
    let energy = 0
    for (let index = 0; index < frameSize; index += 1) {
      const centered = samples[start + index] - mean
      energy += centered * centered
    }
    const rms = Math.sqrt(energy / frameSize)
    const timeMs = (start + frameSize / 2) * 1000 / sampleRate
    if (rms < BROWSER_AUDIO_MIN_RMS) {
      output.push({ hz: null, timeMs, periodicity: 0 })
      continue
    }
    let best = -Infinity
    const correlations = new Float64Array(maxLag + 2)
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let dot = 0
      let leftEnergy = 0
      let rightEnergy = 0
      for (let index = 0; index + lag < frameSize; index += 1) {
        const left = samples[start + index] - mean
        const right = samples[start + index + lag] - mean
        dot += left * right
        leftEnergy += left * left
        rightEnergy += right * right
      }
      correlations[lag] = dot / Math.max(1e-12, Math.sqrt(leftEnergy * rightEnergy))
      best = Math.max(best, correlations[lag])
    }
    if (best < BROWSER_AUDIO_MIN_PERIODICITY) {
      output.push({ hz: null, timeMs, periodicity: best })
      continue
    }
    let bestLag = minLag + correlations.slice(minLag, maxLag + 1).indexOf(best)
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      if (correlations[lag] < correlations[lag - 1] || correlations[lag] < correlations[lag + 1]) continue
      if (correlations[lag] >= best - BROWSER_AUDIO_PEAK_CORRELATION_TOLERANCE) {
        bestLag = lag
        break
      }
    }
    let adjustment = 0
    if (bestLag > minLag && bestLag < maxLag) {
      const left = correlations[bestLag - 1]
      const center = correlations[bestLag]
      const right = correlations[bestLag + 1]
      const denominator = left - 2 * center + right
      if (Math.abs(denominator) > 1e-12) adjustment = Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / denominator))
    }
    output.push({ hz: sampleRate / (bestLag + adjustment), timeMs, periodicity: best })
  }
  return output
}

export function stretchAudio(samples: Float32Array, targetLength: number): Float32Array {
  if (targetLength === samples.length) return new Float32Array(samples)
  if (targetLength <= 0) return new Float32Array(0)
  if (samples.length < 2) return new Float32Array(targetLength).fill(samples[0] ?? 0)
  const frameSize = Math.min(1024, samples.length, targetLength)
  const hop = Math.max(1, frameSize >> 1)
  const lastOutput = targetLength - frameSize
  const lastSource = samples.length - frameSize
  const positions = Array.from({ length: Math.ceil(lastOutput / hop) }, (_, index) => index * hop)
  if (!positions.length || positions[positions.length - 1] !== lastOutput) positions.push(lastOutput)
  const output = new Float32Array(targetLength)
  const weights = new Float32Array(targetLength)
  for (let part = 0; part < positions.length; part += 1) {
    const position = positions[part]
    const expected = lastOutput ? Math.round(position * lastSource / lastOutput) : 0
    let bestStart = part === 0 ? 0 : part === positions.length - 1 ? lastSource : expected
    if (part > 0 && part < positions.length - 1) {
      let bestScore = -Infinity
      const left = Math.max(0, position - hop)
      const overlap = Math.min(hop, frameSize, position - left)
      for (let candidate = Math.max(0, expected - 64); candidate <= Math.min(lastSource, expected + 64); candidate += 2) {
        let dot = 0
        let a = 0
        let b = 0
        for (let index = 0; index < overlap; index += 1) {
          const outputIndex = left + index
          const weight = weights[outputIndex]
          const prior = weight > 0 ? output[outputIndex] / weight : 0
          const current = samples[candidate + index]
          dot += prior * current
          a += prior * prior
          b += current * current
        }
        const score = dot / Math.max(1e-12, Math.sqrt(a * b))
        if (score > bestScore) {
          bestScore = score
          bestStart = candidate
        }
      }
    }
    for (let index = 0; index < frameSize; index += 1) {
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * (index + 0.5) / frameSize)
      output[position + index] += samples[bestStart + index] * window
      weights[position + index] += window
    }
  }
  for (let index = 0; index < output.length; index += 1) {
    output[index] = weights[index] > 1e-8 ? output[index] / weights[index] : 0
  }
  return output
}

export const pitchShift = (samples: Float32Array, cents: number, targetLength = samples.length): Float32Array => {
  const bounded = Math.max(-2400, Math.min(2400, Number.isFinite(cents) ? cents : 0))
  if (!samples.length) return new Float32Array(targetLength)
  if (Math.abs(bounded) < 0.5) return stretchAudio(samples, targetLength)
  const ratio = 2 ** (bounded / 1200)
  const pitchedLength = Math.max(2, Math.round(samples.length / ratio))
  const pitched = resampleLinear(samples, samples.length, pitchedLength)
  return stretchAudio(pitched, targetLength)
}

const interpPoints = (position: number, points: PhonePitchPoint[]): number => {
  if (!points.length) return 0
  if (position <= points[0].position) return points[0].midi
  for (let index = 1; index < points.length; index += 1) {
    if (position <= points[index].position) {
      const left = points[index - 1]
      const right = points[index]
      const t = (position - left.position) / Math.max(1e-9, right.position - left.position)
      return left.midi + (right.midi - left.midi) * t
    }
  }
  return points[points.length - 1].midi
}

const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440)
const midiToHz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12)

const fftInPlace = (real: Float64Array, imag: Float64Array, inverse: boolean): void => {
  const length = real.length
  for (let index = 1, reverse = 0; index < length; index += 1) {
    let bit = length >> 1
    for (; reverse & bit; bit >>= 1) reverse ^= bit
    reverse ^= bit
    if (index < reverse) {
      ;[real[index], real[reverse]] = [real[reverse], real[index]]
      ;[imag[index], imag[reverse]] = [imag[reverse], imag[index]]
    }
  }
  for (let size = 2; size <= length; size <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / size
    const stepReal = Math.cos(angle)
    const stepImag = Math.sin(angle)
    for (let start = 0; start < length; start += size) {
      let phaseReal = 1
      let phaseImag = 0
      const half = size >> 1
      for (let offset = 0; offset < half; offset += 1) {
        const even = start + offset
        const odd = even + half
        const oddReal = real[odd] * phaseReal - imag[odd] * phaseImag
        const oddImag = real[odd] * phaseImag + imag[odd] * phaseReal
        real[odd] = real[even] - oddReal
        imag[odd] = imag[even] - oddImag
        real[even] += oddReal
        imag[even] += oddImag
        const nextReal = phaseReal * stepReal - phaseImag * stepImag
        phaseImag = phaseReal * stepImag + phaseImag * stepReal
        phaseReal = nextReal
      }
    }
  }
  if (inverse) for (let index = 0; index < length; index += 1) {
    real[index] /= length
    imag[index] /= length
  }
}

const formantCorrect = (source: Float32Array, pitched: Float32Array, semitones: number): Float32Array => {
  if (Math.abs(semitones) < 0.01 || source.length < 2) return pitched
  const frameSize = Math.min(2048, 2 ** Math.floor(Math.log2(source.length)))
  if (frameSize < 128) return pitched
  const hop = frameSize >> 2
  const bins = frameSize >> 1
  const ratio = 2 ** (Math.max(-12, Math.min(12, semitones)) / 12)
  const output = new Float32Array(pitched.length)
  const weights = new Float32Array(pitched.length)
  for (let start = 0; start < pitched.length; start += hop) {
    const sourceReal = new Float64Array(frameSize)
    const sourceImag = new Float64Array(frameSize)
    const currentReal = new Float64Array(frameSize)
    const currentImag = new Float64Array(frameSize)
    for (let index = 0; index < frameSize; index += 1) {
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * (index + 0.5) / frameSize)
      sourceReal[index] = (source[start + index] ?? source[source.length - 1] ?? 0) * window
      currentReal[index] = (pitched[start + index] ?? pitched[pitched.length - 1] ?? 0) * window
    }
    fftInPlace(sourceReal, sourceImag, false)
    fftInPlace(currentReal, currentImag, false)
    const sourceEnvelope = new Float64Array(bins + 1)
    const currentEnvelope = new Float64Array(bins + 1)
    for (let bin = 0; bin <= bins; bin += 1) {
      let sourceMagnitude = 0
      let currentMagnitude = 0
      let count = 0
      for (let nearby = Math.max(0, bin - 18); nearby <= Math.min(bins, bin + 18); nearby += 1) {
        sourceMagnitude += Math.hypot(sourceReal[nearby], sourceImag[nearby])
        currentMagnitude += Math.hypot(currentReal[nearby], currentImag[nearby])
        count += 1
      }
      sourceEnvelope[bin] = sourceMagnitude / count
      currentEnvelope[bin] = currentMagnitude / count
    }
    for (let bin = 0; bin <= bins; bin += 1) {
      const sourceBin = Math.min(bins, Math.round(bin / ratio))
      const gain = Math.max(0.25, Math.min(4, sourceEnvelope[sourceBin] / Math.max(1e-8, currentEnvelope[bin])))
      currentReal[bin] *= gain
      currentImag[bin] *= gain
      if (bin > 0 && bin < bins) {
        currentReal[frameSize - bin] *= gain
        currentImag[frameSize - bin] *= gain
      }
    }
    fftInPlace(currentReal, currentImag, true)
    for (let index = 0; index < frameSize && start + index < output.length; index += 1) {
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * (index + 0.5) / frameSize)
      output[start + index] += currentReal[index] * window
      weights[start + index] += window * window
    }
    if (start + frameSize >= pitched.length) break
  }
  for (let index = 0; index < output.length; index += 1) output[index] = weights[index] > 1e-8 ? output[index] / weights[index] : pitched[index]
  return output
}

export const renderPitchCurve = (
  samples: Float32Array,
  cents: Float32Array,
  signal?: AbortSignal,
  formantSemitones = 0,
): Promise<Float32Array> => {
  if (samples.length < 2 || samples.length !== cents.length || (!cents.some((value) => Math.abs(value) > 0.5) && Math.abs(formantSemitones) < 0.01)) {
    return Promise.resolve(new Float32Array(samples))
  }
  const frameSize = Math.min(2048, samples.length)
  const hop = Math.min(512, Math.max(1, frameSize >> 2))
  const lastStart = samples.length - frameSize
  const starts = Array.from({ length: Math.floor(lastStart / hop) + 1 }, (_, index) => index * hop)
  if (starts[starts.length - 1] !== lastStart) starts.push(lastStart)
  const output = new Float32Array(samples.length)
  const weights = new Float32Array(samples.length)
  return (async () => {
    for (const [frameIndex, start] of starts.entries()) {
      checkAbort(signal)
      const local = samples.slice(start, start + frameSize)
      let amount = 0
      for (let index = 0; index < local.length; index += 1) amount += cents[start + index]
      const rendered = pitchShift(local, amount / local.length, local.length)
      for (let index = 0; index < frameSize; index += 1) {
        const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * (index + 0.5) / frameSize)
        output[start + index] += rendered[index] * window
        weights[start + index] += window
      }
      if (frameIndex % 48 === 47) await yieldToBrowser()
    }
    for (let index = 0; index < output.length; index += 1) {
      const value = weights[index] > 1e-8 ? output[index] / weights[index] : samples[index]
      output[index] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0
    }
    return formantCorrect(samples, output, formantSemitones)
  })()
}
