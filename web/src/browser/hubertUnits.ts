import { HubertModel, Tensor } from "@huggingface/transformers"
import type { BrowserAnalysisWord, BrowserHubertModel, BrowserPhoneAlignment, BrowserPhoneInterval } from "../types/browserAnalysis"
import type { AnalysisPrecision, BrowserPronunciation } from "../types"
import { BROWSER_ASR_SAMPLE_RATE, BROWSER_CTC_MIN_INPUT_SAMPLES, BROWSER_HUBERT_CHUNK_GAP_MS, BROWSER_HUBERT_CHUNK_MS, BROWSER_HUBERT_EMBEDDING_DIMENSIONS, BROWSER_HUBERT_MODEL, BROWSER_HUBERT_PADDING_MS, BROWSER_HUBERT_REVISION } from "../browserAnalysisConstants"

function phoneIntervals(words: BrowserAnalysisWord[], phones: BrowserPronunciation[], alignments: BrowserPhoneAlignment[], durationMs: number): BrowserPhoneInterval[] {
  const byWord = new Map<number, number[]>()
  phones.forEach((phone, phone_index) => byWord.set(phone.word_index, [...(byWord.get(phone.word_index) ?? []), phone_index]))
  const aligned = new Map(alignments.map((alignment) => [alignment.phone_index, alignment]))
  const intervals: BrowserPhoneInterval[] = []
  for (const [wordIndex, phoneIndices] of byWord) {
    const word = words[wordIndex]
    if (!word) continue
    const weights = phoneIndices.map((index) => phones[index].phone_id.includes(".vowel.") ? 1 : 0.65)
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
    let accumulatedWeight = 0
    const estimates = [word.start_ms]
    for (const weight of weights.slice(0, -1)) {
      accumulatedWeight += weight
      estimates.push(word.start_ms + Math.round((word.end_ms - word.start_ms) * accumulatedWeight / Math.max(1e-9, totalWeight)))
    }
    estimates.push(word.end_ms)
    phoneIndices.forEach((phoneIndex, offset) => {
      const alignment = aligned.get(phoneIndex)
      const start = alignment?.start_ms ?? estimates[offset]
      const end = alignment?.end_ms ?? estimates[offset + 1]
      const safeStart = Math.max(0, Math.min(Math.max(0, durationMs - 1), start))
      intervals.push({ phone_index: phoneIndex, start_ms: safeStart, end_ms: Math.min(durationMs, Math.max(safeStart + 1, end)) })
    })
  }
  return intervals.sort((left, right) => left.start_ms - right.start_ms)
}

function groupsForPhones(intervals: BrowserPhoneInterval[]): BrowserPhoneInterval[][] {
  const groups: BrowserPhoneInterval[][] = []
  for (const phone of intervals) {
    const group = groups.at(-1)
    const previous = group?.at(-1)
    if (!group || phone.end_ms - group[0].start_ms > BROWSER_HUBERT_CHUNK_MS || phone.start_ms - (previous?.end_ms ?? 0) > BROWSER_HUBERT_CHUNK_GAP_MS) groups.push([phone])
    else group.push(phone)
  }
  return groups
}

export async function extractBrowserHubertEmbeddings(
  samples: Float32Array,
  words: BrowserAnalysisWord[],
  phones: BrowserPronunciation[],
  alignments: BrowserPhoneAlignment[],
  device: "webgpu" | "wasm",
  precision: AnalysisPrecision,
  checkpoint: () => Promise<void>,
  progress: (percent: number) => void,
): Promise<number[][]> {
  const embeddings = Array.from({ length: phones.length }, () => new Array(BROWSER_HUBERT_EMBEDDING_DIMENSIONS).fill(0) as number[])
  if (!phones.length) return embeddings
  const intervals = phoneIntervals(words, phones, alignments, samples.length * 1000 / BROWSER_ASR_SAMPLE_RATE)
  const groups = groupsForPhones(intervals)
  const model = await HubertModel.from_pretrained(BROWSER_HUBERT_MODEL, {
    revision: BROWSER_HUBERT_REVISION,
    device,
    dtype: precision === "baseline" ? "fp32" : device === "webgpu" ? "fp16" : "q8",
  }) as unknown as BrowserHubertModel
  try {
    for (const [groupIndex, group] of groups.entries()) {
      await checkpoint()
      const chunkStartMs = Math.max(0, group[0].start_ms - BROWSER_HUBERT_PADDING_MS)
      const chunkEndMs = Math.min(samples.length * 1000 / BROWSER_ASR_SAMPLE_RATE, group.at(-1)!.end_ms + BROWSER_HUBERT_PADDING_MS)
      const startSample = Math.round(chunkStartMs * BROWSER_ASR_SAMPLE_RATE / 1000)
      const endSample = Math.round(chunkEndMs * BROWSER_ASR_SAMPLE_RATE / 1000)
      let waveform = samples.slice(startSample, endSample)
      let mean = 0
      for (const value of waveform) mean += value
      mean /= Math.max(1, waveform.length)
      let variance = 0
      for (const value of waveform) variance += (value - mean) ** 2
      const deviation = Math.sqrt(variance / Math.max(1, waveform.length) + 1e-7)
      waveform = Float32Array.from(waveform, (value) => (value - mean) / deviation)
      if (waveform.length < BROWSER_CTC_MIN_INPUT_SAMPLES) {
        const padded = new Float32Array(BROWSER_CTC_MIN_INPUT_SAMPLES)
        padded.set(waveform)
        waveform = padded
      }
      const result = await model({ input_values: new Tensor("float32", waveform, [1, waveform.length]) })
      await checkpoint()
      const hidden = result.last_hidden_state
      const [frameCount, dimensions] = hidden.dims.slice(-2)
      if (!frameCount || dimensions !== BROWSER_HUBERT_EMBEDDING_DIMENSIONS) throw new Error(`HuBERT returned an unexpected hidden state shape: ${hidden.dims.join("×")}`)
      const frameMs = waveform.length * 1000 / BROWSER_ASR_SAMPLE_RATE / frameCount
      for (const phone of group) {
        const first = Math.max(0, Math.min(frameCount - 1, Math.floor((phone.start_ms - chunkStartMs) / frameMs)))
        const last = Math.max(first + 1, Math.min(frameCount, Math.ceil((phone.end_ms - chunkStartMs) / frameMs)))
        const vector = embeddings[phone.phone_index]
        for (let frame = first; frame < last; frame += 1) {
          const offset = frame * dimensions
          for (let dimension = 0; dimension < dimensions; dimension += 1) vector[dimension] += hidden.data[offset + dimension] / (last - first)
        }
      }
      progress((groupIndex + 1) * 100 / groups.length)
    }
  } finally {
    await model.dispose?.()
  }
  return embeddings
}
