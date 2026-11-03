import type { BrowserEnglishG2pRuntime, BrowserEnglishG2pWeights } from "../../types/browserPhonetics"
import { BROWSER_ENGLISH_G2P_GRAPHEMES, BROWSER_ENGLISH_G2P_HIDDEN_SIZE, BROWSER_ENGLISH_G2P_PHONEMES, BROWSER_ENGLISH_G2P_WEIGHT_LAYOUT } from "../../browserPhoneticsConstants"
import { getCmuDictionary } from "./cmudictRuntime"

const weightsUrl = new URL("./assets/en-g2p/checkpoint20.bin", import.meta.url)
let runtimePromise: Promise<BrowserEnglishG2pRuntime> | null = null
let weightsPromise: Promise<BrowserEnglishG2pWeights> | null = null

async function loadWeights(): Promise<BrowserEnglishG2pWeights> {
  const response = await fetch(weightsUrl)
  if (!response.ok) throw new Error("영어 OOV 발음 모델을 불러오지 못했습니다.")
  const buffer = await response.arrayBuffer()
  const weights: BrowserEnglishG2pWeights = {}
  let offset = 0
  for (const [name, ...dimensions] of BROWSER_ENGLISH_G2P_WEIGHT_LAYOUT) {
    const length = dimensions.reduce((product, dimension) => product * dimension, 1)
    weights[name] = new Float32Array(buffer, offset, length)
    offset += length * Float32Array.BYTES_PER_ELEMENT
  }
  if (offset !== buffer.byteLength) throw new Error("영어 OOV 발음 모델의 크기가 올바르지 않습니다.")
  return weights
}

function multiply(vector: Float32Array, weights: Float32Array, rows: number, columns: number): Float32Array {
  const output = new Float32Array(rows)
  for (let row = 0; row < rows; row += 1) {
    let sum = 0
    const offset = row * columns
    for (let column = 0; column < columns; column += 1) sum += vector[column] * weights[offset + column]
    output[row] = sum
  }
  return output
}

function addBias(values: Float32Array, bias: Float32Array): void {
  for (let index = 0; index < values.length; index += 1) values[index] += bias[index]
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value))
}

function gruCell(
  input: Float32Array,
  hidden: Float32Array,
  inputWeights: Float32Array,
  hiddenWeights: Float32Array,
  inputBias: Float32Array,
  hiddenBias: Float32Array,
): Float32Array {
  const inputGates = multiply(input, inputWeights, BROWSER_ENGLISH_G2P_HIDDEN_SIZE * 3, BROWSER_ENGLISH_G2P_HIDDEN_SIZE)
  const hiddenGates = multiply(hidden, hiddenWeights, BROWSER_ENGLISH_G2P_HIDDEN_SIZE * 3, BROWSER_ENGLISH_G2P_HIDDEN_SIZE)
  addBias(inputGates, inputBias)
  addBias(hiddenGates, hiddenBias)
  const next = new Float32Array(BROWSER_ENGLISH_G2P_HIDDEN_SIZE)
  for (let index = 0; index < BROWSER_ENGLISH_G2P_HIDDEN_SIZE; index += 1) {
    const reset = sigmoid(inputGates[index] + hiddenGates[index])
    const update = sigmoid(inputGates[BROWSER_ENGLISH_G2P_HIDDEN_SIZE + index] + hiddenGates[BROWSER_ENGLISH_G2P_HIDDEN_SIZE + index])
    const candidate = Math.tanh(inputGates[BROWSER_ENGLISH_G2P_HIDDEN_SIZE * 2 + index] + reset * hiddenGates[BROWSER_ENGLISH_G2P_HIDDEN_SIZE * 2 + index])
    next[index] = (1 - update) * candidate + update * hidden[index]
  }
  return next
}

function predict(word: string, weights: BrowserEnglishG2pWeights): string[] {
  const graphemeIndex = new Map(BROWSER_ENGLISH_G2P_GRAPHEMES.map((grapheme, index) => [grapheme, index]))
  const phonemeIndex = new Map(BROWSER_ENGLISH_G2P_PHONEMES.map((phoneme, index) => [phoneme, index]))
  const charIndexes = [...word, "</s>"].map((character) => graphemeIndex.get(character) ?? 1)
  let hidden: Float32Array = new Float32Array(BROWSER_ENGLISH_G2P_HIDDEN_SIZE)
  for (const index of charIndexes) {
    const input = weights.enc_emb.subarray(index * BROWSER_ENGLISH_G2P_HIDDEN_SIZE, (index + 1) * BROWSER_ENGLISH_G2P_HIDDEN_SIZE)
    hidden = gruCell(input, hidden, weights.enc_w_ih, weights.enc_w_hh, weights.enc_b_ih, weights.enc_b_hh)
  }
  let inputIndex = phonemeIndex.get("<s>") ?? 2
  const output: string[] = []
  for (let step = 0; step < 20; step += 1) {
    const input = weights.dec_emb.subarray(inputIndex * BROWSER_ENGLISH_G2P_HIDDEN_SIZE, (inputIndex + 1) * BROWSER_ENGLISH_G2P_HIDDEN_SIZE)
    hidden = gruCell(input, hidden, weights.dec_w_ih, weights.dec_w_hh, weights.dec_b_ih, weights.dec_b_hh)
    const logits = multiply(hidden, weights.fc_w, BROWSER_ENGLISH_G2P_PHONEMES.length, BROWSER_ENGLISH_G2P_HIDDEN_SIZE)
    addBias(logits, weights.fc_b)
    let best = 0
    for (let index = 1; index < logits.length; index += 1) {
      if (logits[index] > logits[best]) best = index
    }
    if (best === (phonemeIndex.get("</s>") ?? 3)) break
    output.push(BROWSER_ENGLISH_G2P_PHONEMES[best] ?? "<unk>")
    inputIndex = best
  }
  return output
}

async function loadRuntime(): Promise<BrowserEnglishG2pRuntime> {
  const dictionary = await getCmuDictionary()
  return {
    pronunciation: async (word) => {
      if (dictionary[word]) return dictionary[word]
      weightsPromise ??= loadWeights().catch((error: unknown) => {
        weightsPromise = null
        throw error
      })
      return predict(word, await weightsPromise)
    },
  }
}

export function getEnglishG2p(): Promise<BrowserEnglishG2pRuntime> {
  runtimePromise ??= loadRuntime().catch((error: unknown) => {
    runtimePromise = null
    throw error
  })
  return runtimePromise
}
