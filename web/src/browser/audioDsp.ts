import type { BrowserAudioData } from "../types"
import type { BrowserFftSpectrum, BrowserPitchFrame } from "../types/browserAudio"
import {
  BROWSER_AUDIO_MAX_F0_HZ,
  BROWSER_AUDIO_MAX_OUTPUT_SAMPLES,
  BROWSER_AUDIO_MIN_F0_HZ,
  BROWSER_AUDIO_MIN_PERIODICITY,
  BROWSER_AUDIO_MIN_RMS,
  BROWSER_AUDIO_FORMANT_ENVELOPE_LIFTER,
  BROWSER_AUDIO_FORMANT_GAIN_MAX,
  BROWSER_AUDIO_FORMANT_GAIN_MIN,
  BROWSER_AUDIO_PITCH_CURVE_FRAME_SAMPLES,
  BROWSER_AUDIO_PITCH_CURVE_HOP_SAMPLES,
  BROWSER_AUDIO_PITCH_CURVE_PHASE_ALIGN_SAMPLES,
  BROWSER_AUDIO_PITCH_CURVE_STATIC_TOLERANCE_CENTS,
  BROWSER_AUDIO_PITCH_HOP_MS,
  BROWSER_AUDIO_PITCH_WINDOW_MS,
  BROWSER_AUDIO_PITCH_SHIFT_FRAME_SAMPLES,
  BROWSER_AUDIO_PITCH_SHIFT_HOP_SAMPLES,
  BROWSER_AUDIO_PITCH_SHIFT_MIN_SEMITONES,
  BROWSER_AUDIO_PEAK_CORRELATION_TOLERANCE,
  BROWSER_AUDIO_SAMPLE_RATE,
  BROWSER_AUDIO_STRETCH_FRAME_SAMPLES,
  BROWSER_AUDIO_STRETCH_SEARCH_SAMPLES,
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
  if (maxLag <= minLag) return []
  const finalStart = samples.length - frameSize
  const starts: number[] = []
  for (let start = 0; start <= finalStart; start += hopSize) starts.push(start)
  if (starts[starts.length - 1] !== finalStart) starts.push(finalStart)
  const output: BrowserPitchFrame[] = []
  for (const start of starts) {
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
    }
    const peaks: number[] = []
    let bestLag = minLag
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      if (correlations[lag] >= correlations[lag - 1] && correlations[lag] >= correlations[lag + 1]) peaks.push(lag)
    }
    if (peaks.length) best = Math.max(...peaks.map((lag) => correlations[lag]))
    else {
      bestLag = minLag
      for (let lag = minLag + 1; lag <= maxLag; lag += 1) if (correlations[lag] > correlations[bestLag]) bestLag = lag
      best = correlations[bestLag]
    }
    if (best < BROWSER_AUDIO_MIN_PERIODICITY) {
      output.push({ hz: null, timeMs, periodicity: best })
      continue
    }
    if (peaks.length) {
      bestLag = peaks[0]
      for (const lag of peaks) {
        if (correlations[lag] < best - BROWSER_AUDIO_PEAK_CORRELATION_TOLERANCE) continue
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
    output.push({ hz: sampleRate / (bestLag + adjustment), timeMs, periodicity: correlations[bestLag] })
  }
  return output
}

export function stretchAudio(samples: Float32Array, targetLength: number): Float32Array {
  if (targetLength === samples.length) return new Float32Array(samples)
  if (targetLength <= 0) return new Float32Array(0)
  if (samples.length < 2) return new Float32Array(targetLength).fill(samples[0] ?? 0)
  const frameSize = Math.min(BROWSER_AUDIO_STRETCH_FRAME_SAMPLES, samples.length, targetLength)
  const hop = Math.max(1, frameSize >> 1)
  const lastOutput = targetLength - frameSize
  const lastSource = samples.length - frameSize
  const positions: number[] = []
  for (let position = 0; position < lastOutput; position += hop) positions.push(position)
  positions.push(lastOutput)
  const window = Array.from({ length: frameSize }, (_, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * (index + 1) / (frameSize + 1)))
  const output = new Float32Array(targetLength)
  const weights = new Float32Array(targetLength)
  for (let part = 0; part < positions.length; part += 1) {
    const position = positions[part]
    const expected = lastOutput ? roundEven(position * lastSource / lastOutput) : 0
    let bestStart = part === 0 ? 0 : part === positions.length - 1 ? lastSource : expected
    if (part > 0 && part < positions.length - 1) {
      bestStart = matchingStart(samples, output, weights, position, frameSize, expected, lastSource)
    }
    for (let index = 0; index < frameSize; index += 1) {
      output[position + index] += samples[bestStart + index] * window[index]
      weights[position + index] += window[index]
    }
  }
  for (let index = 0; index < output.length; index += 1) {
    output[index] = weights[index] > 1e-8 ? output[index] / weights[index] : 0
  }
  return output
}

export function roundEven(value: number): number {
  const floor = Math.floor(value)
  const fraction = value - floor
  if (fraction < 0.5) return floor
  if (fraction > 0.5) return floor + 1
  return floor % 2 === 0 ? floor : floor + 1
}

function matchingStart(
  samples: Float32Array,
  output: Float32Array,
  weights: Float32Array,
  position: number,
  frameSize: number,
  expected: number,
  sourceLast: number,
): number {
  const overlap: number[] = []
  for (let index = 0; index < frameSize; index += 1) {
    if (weights[position + index] > 0.1) overlap.push(index)
  }
  if (overlap.length < 4) return expected
  let referenceEnergySquared = 0
  const reference = overlap.map((index) => output[position + index] / weights[position + index])
  for (const value of reference) referenceEnergySquared += value * value
  const referenceEnergy = Math.sqrt(referenceEnergySquared)
  if (referenceEnergy < 1e-6) return expected
  let bestStart = expected
  let bestScore = -Infinity
  for (let candidate = Math.max(0, expected - BROWSER_AUDIO_STRETCH_SEARCH_SAMPLES); candidate <= Math.min(sourceLast, expected + BROWSER_AUDIO_STRETCH_SEARCH_SAMPLES); candidate += 1) {
    let dot = 0
    let candidateEnergySquared = 0
    for (let offset = 0; offset < overlap.length; offset += 1) {
      const value = samples[candidate + overlap[offset]]
      dot += reference[offset] * value
      candidateEnergySquared += value * value
    }
    const candidateEnergy = Math.sqrt(candidateEnergySquared)
    const score = candidateEnergy > 1e-6 ? dot / (referenceEnergy * candidateEnergy) : 0
    if (score > bestScore) {
      bestStart = candidate
      bestScore = score
    }
  }
  return bestStart
}

function shiftFrame(samples: Float32Array, semitones: number): Float32Array {
  if (Math.abs(semitones) < BROWSER_AUDIO_PITCH_SHIFT_MIN_SEMITONES || samples.length < 2) return new Float32Array(samples)
  const ratio = 2 ** (semitones / 12)
  const resampledLength = Math.max(2, roundEven((samples.length - 1) / ratio) + 1)
  const resampled = new Float32Array(resampledLength)
  for (let index = 0; index < resampledLength; index += 1) {
    const position = index * (samples.length - 1) / (resampledLength - 1)
    const left = Math.floor(position)
    const right = Math.min(samples.length - 1, left + 1)
    const fraction = position - left
    resampled[index] = samples[left] * (1 - fraction) + samples[right] * fraction
  }
  return stretchAudio(resampled, samples.length)
}

export const pitchShift = (samples: Float32Array, cents: number, targetLength = samples.length): Float32Array => {
  const safeCents = Number.isFinite(cents) ? cents : 0
  const stretched = stretchAudio(samples, targetLength)
  if (Math.abs(safeCents / 100) < BROWSER_AUDIO_PITCH_SHIFT_MIN_SEMITONES || stretched.length < 2) return stretched
  return shiftFrame(stretched, safeCents / 100)
}

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

const fftAnyLength = (real: Float64Array, imag: Float64Array, inverse: boolean): void => {
  const length = real.length
  if (length < 2 || (length & (length - 1)) === 0) {
    fftInPlace(real, imag, inverse)
    return
  }
  const paddedLength = 2 ** Math.ceil(Math.log2(length * 2 - 1))
  const leftReal = new Float64Array(paddedLength)
  const leftImag = new Float64Array(paddedLength)
  const rightReal = new Float64Array(paddedLength)
  const rightImag = new Float64Array(paddedLength)
  const direction = inverse ? 1 : -1
  for (let index = 0; index < length; index += 1) {
    const angle = Math.PI * ((index * index) % (length * 2)) / length
    const cosine = Math.cos(angle)
    const sine = direction * Math.sin(angle)
    leftReal[index] = real[index] * cosine - imag[index] * sine
    leftImag[index] = real[index] * sine + imag[index] * cosine
    const kernelReal = cosine
    const kernelImag = -sine
    rightReal[index] = kernelReal
    rightImag[index] = kernelImag
    if (index) {
      rightReal[paddedLength - index] = kernelReal
      rightImag[paddedLength - index] = kernelImag
    }
  }
  fftInPlace(leftReal, leftImag, false)
  fftInPlace(rightReal, rightImag, false)
  for (let index = 0; index < paddedLength; index += 1) {
    const nextReal = leftReal[index] * rightReal[index] - leftImag[index] * rightImag[index]
    const nextImag = leftReal[index] * rightImag[index] + leftImag[index] * rightReal[index]
    leftReal[index] = nextReal
    leftImag[index] = nextImag
  }
  fftInPlace(leftReal, leftImag, true)
  for (let index = 0; index < length; index += 1) {
    const angle = Math.PI * ((index * index) % (length * 2)) / length
    const cosine = Math.cos(angle)
    const sine = direction * Math.sin(angle)
    const scale = inverse ? 1 / length : 1
    real[index] = (leftReal[index] * cosine - leftImag[index] * sine) * scale
    imag[index] = (leftReal[index] * sine + leftImag[index] * cosine) * scale
  }
}

export function windowedAutocorrelation(samples: Float32Array, window: Float64Array): Float64Array {
  if (samples.length !== window.length) throw new Error("Autocorrelation window length must match samples.")
  const fftLength = 2 ** Math.ceil(Math.log2(Math.max(2, samples.length * 2 - 1)))
  const real = new Float64Array(fftLength)
  const imag = new Float64Array(fftLength)
  for (let index = 0; index < samples.length; index += 1) real[index] = samples[index] * window[index]
  fftInPlace(real, imag, false)
  for (let index = 0; index < fftLength; index += 1) real[index] = real[index] * real[index] + imag[index] * imag[index]
  imag.fill(0)
  fftInPlace(real, imag, true)
  return real.slice(0, samples.length)
}

const realSpectrum = (samples: ArrayLike<number>): BrowserFftSpectrum => {
  const real = new Float64Array(samples)
  const imag = new Float64Array(samples.length)
  fftAnyLength(real, imag, false)
  return { real: real.slice(0, Math.floor(samples.length / 2) + 1), imag: imag.slice(0, Math.floor(samples.length / 2) + 1) }
}

const inverseRealSpectrum = (realHalf: Float64Array, length: number, imagHalf?: Float64Array): Float64Array => {
  const real = new Float64Array(length)
  const imag = new Float64Array(length)
  const lastPositiveBin = Math.floor(length / 2)
  for (let bin = 0; bin <= lastPositiveBin; bin += 1) {
    real[bin] = realHalf[bin]
    imag[bin] = imagHalf?.[bin] ?? 0
  }
  for (let bin = 1; bin <= lastPositiveBin; bin += 1) {
    if (length % 2 === 0 && bin === lastPositiveBin) continue
    real[length - bin] = realHalf[bin]
    imag[length - bin] = -(imagHalf?.[bin] ?? 0)
  }
  fftAnyLength(real, imag, true)
  return real
}

const spectralEnvelope = (samples: Float32Array): Float64Array => {
  const length = samples.length
  const windowed = new Float64Array(length)
  for (let index = 0; index < length; index += 1) {
    const window = length < 2 ? 1 : 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (length - 1))
    windowed[index] = samples[index] * window
  }
  const magnitude = realSpectrum(windowed)
  const logMagnitude = new Float64Array(magnitude.real.length)
  for (let bin = 0; bin < logMagnitude.length; bin += 1) logMagnitude[bin] = Math.log(Math.max(Math.hypot(magnitude.real[bin], magnitude.imag[bin]), 1e-7))
  const cepstrum = inverseRealSpectrum(logMagnitude, length)
  const liftered = new Float64Array(length)
  const keep = Math.min(BROWSER_AUDIO_FORMANT_ENVELOPE_LIFTER, Math.max(1, Math.floor(length / 2)))
  liftered.set(cepstrum.slice(0, keep), 0)
  if (keep > 1) liftered.set(cepstrum.slice(length - keep + 1), length - keep + 1)
  return realSpectrum(liftered).real
}

const correctFormantFrame = (source: Float32Array, shifted: Float32Array, semitones: number): Float32Array => {
  if (Math.abs(semitones) < BROWSER_AUDIO_PITCH_SHIFT_MIN_SEMITONES || source.length < 2) return shifted
  const sourceEnvelope = spectralEnvelope(source)
  const shiftedEnvelope = spectralEnvelope(shifted)
  const ratio = 2 ** (semitones / 12)
  const halfSpectrum = realSpectrum(shifted)
  const correctedReal = new Float64Array(halfSpectrum.real.length)
  const correctedImag = new Float64Array(halfSpectrum.imag.length)
  for (let bin = 0; bin < correctedReal.length; bin += 1) {
    const sourceBin = bin / ratio
    const left = Math.min(sourceEnvelope.length - 1, Math.floor(sourceBin))
    const right = Math.min(sourceEnvelope.length - 1, left + 1)
    const fraction = sourceBin - left
    const envelope = sourceBin > sourceEnvelope.length - 1
      ? sourceEnvelope[sourceEnvelope.length - 1]
      : sourceEnvelope[left] * (1 - fraction) + sourceEnvelope[right] * fraction
    const gain = Math.max(BROWSER_AUDIO_FORMANT_GAIN_MIN, Math.min(BROWSER_AUDIO_FORMANT_GAIN_MAX, Math.exp(envelope - shiftedEnvelope[bin])))
    correctedReal[bin] = halfSpectrum.real[bin] * gain
    correctedImag[bin] = halfSpectrum.imag[bin] * gain
  }
  const corrected = inverseRealSpectrum(correctedReal, source.length, correctedImag)
  let originalEnergy = 0
  let correctedEnergy = 0
  for (let index = 0; index < corrected.length; index += 1) {
    originalEnergy += shifted[index] * shifted[index]
    correctedEnergy += corrected[index] * corrected[index]
  }
  const originalRms = Math.sqrt(originalEnergy / corrected.length)
  const correctedRms = Math.sqrt(correctedEnergy / corrected.length)
  const scale = correctedRms > 1e-8 ? originalRms / correctedRms : 1
  return Float32Array.from(corrected, (value) => Math.max(-1, Math.min(1, value * scale)))
}

const formantCorrect = (source: Float32Array, pitched: Float32Array, semitones: number): Float32Array => {
  if (Math.abs(semitones) < BROWSER_AUDIO_PITCH_SHIFT_MIN_SEMITONES || source.length < 2) return pitched
  const frameSize = Math.min(BROWSER_AUDIO_PITCH_SHIFT_FRAME_SAMPLES, source.length)
  const hop = Math.min(BROWSER_AUDIO_PITCH_SHIFT_HOP_SAMPLES, Math.max(1, frameSize >> 1))
  const lastStart = source.length - frameSize
  const starts: number[] = []
  for (let start = 0; start < lastStart; start += hop) starts.push(start)
  starts.push(lastStart)
  const window = Array.from({ length: frameSize }, (_, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * (index + 1) / (frameSize + 1)))
  const output = new Float32Array(pitched.length)
  const weights = new Float32Array(pitched.length)
  for (const start of starts) {
    const sourceFrame = source.slice(start, start + frameSize)
    const pitchedFrame = pitched.slice(start, start + frameSize)
    const corrected = correctFormantFrame(sourceFrame, pitchedFrame, semitones)
    for (let index = 0; index < frameSize; index += 1) {
      output[start + index] += corrected[index] * window[index]
      weights[start + index] += window[index]
    }
  }
  for (let index = 0; index < output.length; index += 1) output[index] = weights[index] > 1e-8 ? output[index] / weights[index] : pitched[index]
  return output
}

const relativePitchCurve = (samples: Float32Array, cents: Float32Array): Float32Array => {
  const length = samples.length
  const ratios = new Float64Array(length)
  const cumulative = new Float64Array(length)
  for (let index = 0; index < length; index += 1) ratios[index] = 2 ** (cents[index] / 1200)
  for (let index = 1; index < length; index += 1) cumulative[index] = cumulative[index - 1] + (ratios[index - 1] + ratios[index]) * 0.5
  const meanRatio = cumulative[length - 1] / (length - 1)
  const resampledLength = Math.max(2, roundEven((length - 1) / meanRatio) + 1)
  const resampled = new Float32Array(resampledLength)
  for (let index = 0; index < resampledLength; index += 1) {
    const outputPosition = index / (resampledLength - 1)
    const cumulativePosition = outputPosition
    let right = 1
    while (right < length - 1 && right / (length - 1) < cumulativePosition) right += 1
    const left = right - 1
    const relative = (cumulativePosition - left / (length - 1)) * (length - 1)
    const integrated = cumulative[left] + (cumulative[right] - cumulative[left]) * relative
    const sourcePosition = integrated / cumulative[length - 1] * (length - 1)
    const sourceLeft = Math.min(length - 1, Math.floor(sourcePosition))
    const sourceRight = Math.min(length - 1, sourceLeft + 1)
    const fraction = sourcePosition - sourceLeft
    resampled[index] = samples[sourceLeft] * (1 - fraction) + samples[sourceRight] * fraction
  }
  return stretchAudio(resampled, length)
}

const alignPitchFrame = (previous: Float32Array, shifted: Float32Array, overlap: number): Float32Array => {
  const maximumShift = Math.min(BROWSER_AUDIO_PITCH_CURVE_PHASE_ALIGN_SAMPLES, Math.max(0, overlap >> 2))
  let bestShift = 0
  let bestScore = -Infinity
  for (let shift = -maximumShift; shift <= maximumShift; shift += 1) {
    const leftValues = shift < 0 ? previous.slice(-shift, overlap) : previous.slice(0, overlap - shift)
    const rightValues = shift < 0 ? shifted.slice(0, overlap + shift) : shifted.slice(shift, overlap)
    let leftMean = 0
    let rightMean = 0
    for (let index = 0; index < leftValues.length; index += 1) {
      leftMean += leftValues[index]
      rightMean += rightValues[index]
    }
    leftMean /= Math.max(1, leftValues.length)
    rightMean /= Math.max(1, rightValues.length)
    let dot = 0
    let leftEnergy = 0
    let rightEnergy = 0
    for (let index = 0; index < leftValues.length; index += 1) {
      const left = leftValues[index] - leftMean
      const right = rightValues[index] - rightMean
      dot += left * right
      leftEnergy += left * left
      rightEnergy += right * right
    }
    const score = dot / Math.max(1e-12, Math.sqrt(leftEnergy * rightEnergy))
    if (score > bestScore) {
      bestScore = score
      bestShift = shift
    }
  }
  if (!bestShift) return shifted
  const aligned = new Float32Array(shifted.length)
  const sourceStart = Math.max(0, bestShift)
  const copiedLength = shifted.length - Math.abs(bestShift)
  aligned.set(shifted.subarray(sourceStart, sourceStart + copiedLength), Math.max(0, -bestShift))
  if (bestShift > 0) {
    for (let index = 0; index < bestShift; index += 1) aligned[shifted.length - bestShift + index] = shifted[Math.max(0, shifted.length - 2 - index)]
  } else {
    for (let index = 0; index < -bestShift; index += 1) aligned[-bestShift - 1 - index] = shifted[Math.min(shifted.length - 1, 1 + index)]
  }
  return aligned
}

export const renderPitchCurve = (
  samples: Float32Array,
  cents: Float32Array,
  signal?: AbortSignal,
  formantSemitones = 0,
): Promise<Float32Array> => {
  if (samples.length < 2 || samples.length !== cents.length || (!cents.some((value) => value !== 0) && Math.abs(formantSemitones) < BROWSER_AUDIO_PITCH_SHIFT_MIN_SEMITONES)) {
    return Promise.resolve(new Float32Array(samples))
  }
  return (async () => {
    let minimum = Infinity
    let maximum = -Infinity
    for (const value of cents) {
      minimum = Math.min(minimum, value)
      maximum = Math.max(maximum, value)
    }
    const range = cents.length ? maximum - minimum : 0
    let rendered: Float32Array
    if (range <= BROWSER_AUDIO_PITCH_CURVE_STATIC_TOLERANCE_CENTS) {
      rendered = pitchShift(samples, roundEven(cents[0]), samples.length)
    } else if (samples.length <= BROWSER_AUDIO_PITCH_CURVE_FRAME_SAMPLES) {
      rendered = relativePitchCurve(samples, cents)
    } else {
      const frameSize = Math.min(BROWSER_AUDIO_PITCH_CURVE_FRAME_SAMPLES, samples.length)
      const hop = Math.min(BROWSER_AUDIO_PITCH_CURVE_HOP_SAMPLES, Math.max(1, frameSize >> 1))
      const lastStart = samples.length - frameSize
      const starts: number[] = []
      for (let start = 0; start <= lastStart; start += hop) starts.push(start)
      if (starts[starts.length - 1] !== lastStart) starts.push(lastStart)
      const window = Array.from({ length: frameSize }, (_, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * (index + 1) / (frameSize + 1)))
      const output = new Float32Array(samples.length)
      const weights = new Float32Array(samples.length)
      for (const [frameIndex, start] of starts.entries()) {
        checkAbort(signal)
        const local = samples.slice(start, start + frameSize)
        const localCents = cents.slice(start, start + frameSize)
        const shifted = relativePitchCurve(local, localCents)
        const overlap = Math.min(frameSize - hop, samples.length - start)
        if (start) {
          const previous = new Float32Array(overlap)
          for (let index = 0; index < overlap; index += 1) previous[index] = output[start + index] / Math.max(weights[start + index], 1e-12)
          const aligned = alignPitchFrame(previous, shifted, overlap)
          shifted.set(aligned)
        }
        for (let index = 0; index < frameSize; index += 1) {
          output[start + index] += shifted[index] * window[index]
          weights[start + index] += window[index]
        }
        if (frameIndex % 48 === 47) await yieldToBrowser()
      }
      rendered = output
      for (let index = 0; index < rendered.length; index += 1) rendered[index] = weights[index] > 1e-8 ? rendered[index] / weights[index] : samples[index]
    }
    checkAbort(signal)
    return formantCorrect(samples, rendered, formantSemitones)
  })()
}
