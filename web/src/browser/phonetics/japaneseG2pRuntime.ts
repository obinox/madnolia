import type { BrowserJapaneseG2pData, BrowserJapaneseG2pItem, BrowserJapaneseG2pRuntime } from "../../types/browserPhonetics"
import { BROWSER_JAPANESE_G2P_ASSET } from "../../browserPhoneticsConstants"

const dataUrl = new URL("./assets/ja-g2p/pykakasi.json.gzbin", import.meta.url)
let runtimePromise: Promise<BrowserJapaneseG2pRuntime> | null = null

async function loadData(): Promise<BrowserJapaneseG2pData> {
  const response = await fetch(dataUrl)
  if (!response.ok || !response.body) throw new Error(`일본어 발음 자료를 불러오지 못했습니다: ${BROWSER_JAPANESE_G2P_ASSET}`)
  const stream = response.body.pipeThrough(new DecompressionStream("gzip"))
  return JSON.parse(await new Response(stream).text()) as BrowserJapaneseG2pData
}

function toHiragana(text: string): string {
  return [...text].map((character) => {
    const code = character.codePointAt(0) ?? 0
    if (code >= 0x30a1 && code <= 0x30f6) return String.fromCodePoint(code - 0x60)
    if (code >= 0x1b164 && code <= 0x1b167) return String.fromCodePoint(code - 0x14)
    return character
  }).join("")
}

function makeRuntime(data: BrowserJapaneseG2pData): BrowserJapaneseG2pRuntime {
  const wordCache = new Map<string, string[]>()
  const maxKanaKeyLength = Math.max(...Object.keys(data.hepburn).map((key) => [...key].length))

  const romanize = (hira: string): string => {
    const characters = [...hira]
    let output = ""
    for (let index = 0; index < characters.length;) {
      let matched = 0
      for (let length = Math.min(maxKanaKeyLength, characters.length - index); length > 0; length -= 1) {
        const value = data.hepburn[characters.slice(index, index + length).join("")]
        if (value !== undefined) {
          output += value
          matched = length
          break
        }
      }
      if (matched) {
        index += matched
      } else if (characters[index] === "ー") {
        output += [...output].reverse().find((character) => "aeiou".includes(character)) ?? "-"
        index += 1
      } else {
        output += characters[index]
        index += 1
      }
    }
    return output
  }

  const pickWord = (text: string, index: number, previous: string): [string, string] | null => {
    const first = [...text.slice(index)][0] ?? ""
    const canonical = data.itaiji[first] ?? first
    const words = data.kanwa[canonical]
    if (!words) return null
    let orderedWords = wordCache.get(canonical)
    if (!orderedWords) {
      orderedWords = Object.keys(words).sort((left, right) => [...right].length - [...left].length)
      wordCache.set(canonical, orderedWords)
    }
    let selected: [string, string] | null = null
    for (const word of orderedWords) {
      if ([...word].length <= (selected ? [...selected[0]].length : 0) || !text.startsWith(word, index)) continue
      const reading = words[word].find(([, context]) => context === null || context.includes(previous))
      if (reading) selected = [word, reading[0]]
    }
    return selected
  }

  return {
    romanize,
    convert(text: string): BrowserJapaneseG2pItem[] {
      const normalized = text.normalize("NFKC").replace(/[\u3400-\uE000]/gu, (character) => data.itaiji[character] ?? character)
      const characters = [...normalized]
      const output: BrowserJapaneseG2pItem[] = []
      let index = 0
      let previous = ""
      while (index < characters.length) {
        const character = characters[index]
        const code = character.codePointAt(0) ?? 0
        const isKanji = (code >= 0x3400 && code < 0xe000) || data.itaiji[character] !== undefined
        const isKana = (code >= 0x3041 && code <= 0x30fd) || (code >= 0x1b150 && code <= 0x1b167)
        if (isKanji) {
          const match = pickWord(characters.join(""), index, previous)
          if (match) {
            const [orig, hira] = match
            output.push({ orig, hira, hepburn: romanize(hira) })
            previous = orig
            index += [...orig].length
          } else {
            output.push({ orig: character, hira: character, hepburn: character })
            previous = character
            index += 1
          }
          continue
        }
        if (isKana) {
          let end = index + 1
          while (end < characters.length) {
            const nextCode = characters[end].codePointAt(0) ?? 0
            if (!((nextCode >= 0x3041 && nextCode <= 0x30fd) || (nextCode >= 0x1b150 && nextCode <= 0x1b167))) break
            end += 1
          }
          const orig = characters.slice(index, end).join("")
          const hira = toHiragana(orig)
          output.push({ orig, hira, hepburn: romanize(hira) })
          previous = orig
          index = end
          continue
        }
        output.push({ orig: character, hira: character, hepburn: character })
        previous = character
        index += 1
      }
      return output
    },
  }
}

export function getJapaneseG2p(): Promise<BrowserJapaneseG2pRuntime> {
  runtimePromise ??= loadData().then(makeRuntime).catch((error: unknown) => {
    runtimePromise = null
    throw error
  })
  return runtimePromise
}
