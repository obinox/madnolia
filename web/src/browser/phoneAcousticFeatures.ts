import type { PhoneAcousticFeatures, PhoneOccurrence } from "../types"
import { BROWSER_PHONE_ACOUSTIC_AMPLITUDE_FLOOR, BROWSER_PHONE_ACOUSTIC_CONTEXT_MS, BROWSER_PHONE_ACOUSTIC_MAX_F0_HZ, BROWSER_PHONE_ACOUSTIC_MIN_ENERGY, BROWSER_PHONE_ACOUSTIC_MIN_F0_HZ, BROWSER_PHONE_ACOUSTIC_MIN_VOICED_PROBABILITY, BROWSER_PHONE_ACOUSTIC_VOICED_CATEGORIES } from "../browserAnalysisConstants"
import { roundEven, windowedAutocorrelation } from "./audioDsp"

function amplitudeDb(value: number): number {
  return 20 * Math.log10(Math.max(value, BROWSER_PHONE_ACOUSTIC_AMPLITUDE_FLOOR))
}

function supportsVoicing(phoneId: string): boolean {
  return BROWSER_PHONE_ACOUSTIC_VOICED_CATEGORIES.some((category) => phoneId.includes(category))
}

function estimateContextF0(samples: Float32Array, sampleRate: number): { f0Hz: number | null; probability: number } {
  if (samples.length < roundEven(sampleRate * BROWSER_PHONE_ACOUSTIC_CONTEXT_MS / 1000)) return { f0Hz: null, probability: 0 }
  let mean = 0
  for (const sample of samples) mean += sample
  mean = Math.fround(mean / samples.length)
  const centered = new Float32Array(samples.length)
  let energy = 0
  const window = new Float64Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    centered[index] = samples[index] - mean
    energy += centered[index] * centered[index]
    window[index] = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (samples.length - 1))
  }
  if (energy < BROWSER_PHONE_ACOUSTIC_MIN_ENERGY) return { f0Hz: null, probability: 0 }
  const autocorrelation = windowedAutocorrelation(centered, window)
  const minimumLag = Math.max(1, Math.floor(sampleRate / BROWSER_PHONE_ACOUSTIC_MAX_F0_HZ))
  const maximumLag = Math.min(autocorrelation.length - 1, Math.floor(sampleRate / BROWSER_PHONE_ACOUSTIC_MIN_F0_HZ))
  if (maximumLag <= minimumLag || autocorrelation[0] <= 0) return { f0Hz: null, probability: 0 }
  let lag = minimumLag
  for (let candidate = minimumLag + 1; candidate <= maximumLag; candidate += 1) {
    if (autocorrelation[candidate] > autocorrelation[lag]) lag = candidate
  }
  const probability = Math.max(0, Math.min(1, autocorrelation[lag] / autocorrelation[0]))
  return probability < BROWSER_PHONE_ACOUSTIC_MIN_VOICED_PROBABILITY
    ? { f0Hz: null, probability }
    : { f0Hz: sampleRate / lag, probability }
}

export function analyzePhoneAcousticFeatures(samples: Float32Array, sampleRate: number, phones: PhoneOccurrence[]): PhoneAcousticFeatures[] {
  return phones.map((phone) => {
    const start = Math.min(samples.length, Math.max(0, roundEven(phone.start_ms * sampleRate / 1000)))
    const end = Math.max(start, Math.min(samples.length, roundEven(phone.end_ms * sampleRate / 1000)))
    let squareSum = 0
    let peak = 0
    for (let index = start; index < end; index += 1) {
      const value = samples[index]
      squareSum += Math.fround(value * value)
      peak = Math.max(peak, Math.abs(value))
    }
    const length = end - start
    const center = Math.floor((start + end) / 2)
    const radius = roundEven(BROWSER_PHONE_ACOUSTIC_CONTEXT_MS * sampleRate / 1000)
    const context = samples.subarray(Math.max(0, center - radius), Math.min(samples.length, center + radius))
    const estimate = supportsVoicing(phone.phone_id) ? estimateContextF0(context, sampleRate) : { f0Hz: null, probability: 0 }
    return {
      occurrence_id: phone.occurrence_id,
      rms_db: amplitudeDb(length ? Math.fround(Math.sqrt(Math.fround(squareSum / length))) : 0),
      peak_db: amplitudeDb(peak),
      f0_hz: estimate.f0Hz,
      voiced_probability: estimate.probability,
      acoustic_unit_id: null,
    }
  })
}
