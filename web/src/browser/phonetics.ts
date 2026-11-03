import type { BrowserPronunciation, InputLanguage } from "../types"
import type { BrowserJapaneseG2pRuntime } from "../types/browserPhonetics"
import {
  BROWSER_UNKNOWN_PHONE_ID,
  BROWSER_UNKNOWN_PHONE_IPA,
  HANGUL_FINAL_COUNT,
  HANGUL_MEDIAL_COUNT,
  HANGUL_SYLLABLE_BASE,
  HANGUL_SYLLABLE_END,
  KOREAN_FINAL_IPA,
  KOREAN_FINALS,
  KOREAN_INITIAL_IPA,
  KOREAN_INITIALS,
  KOREAN_MEDIAL_IPA,
  KOREAN_MEDIALS,
} from "../browserAnalysisConstants"
import {
  BROWSER_ENGLISH_ARPABET_IPA,
  BROWSER_JAPANESE_GEMINATE,
  BROWSER_JAPANESE_LONG_VOWELS,
  BROWSER_JAPANESE_MORAIC_NASAL,
  BROWSER_JAPANESE_MORAIC_NASAL_VELAR,
  BROWSER_JAPANESE_ONSETS,
  BROWSER_JAPANESE_VOWELS,
} from "../browserPhoneticsConstants"

function resolveLanguage(text: string, language: InputLanguage): Exclude<InputLanguage, "AUTO"> {
  if (language !== "AUTO") return language
  if (/[\uac00-\ud7a3]/u.test(text)) return "KO"
  if (/[\u3040-\u30ff]/u.test(text)) return "JA"
  if (/[\u3400-\u9fff]/u.test(text)) throw new Error("한자만 입력된 문장은 언어 선택에서 일본어를 지정해 주세요.")
  if (/[a-z]/iu.test(text)) return "EN"
  throw new Error("한국어, 영어, 일본어 문장을 입력하거나 언어를 선택해 주세요.")
}

function splitWords(text: string): string[] {
  return text.trim().split(/\s+/u).filter(Boolean)
}

function decomposeHangul(character: string): { initial: string; medial: string; final: string } | null {
  const code = character.codePointAt(0) ?? 0
  if (code < HANGUL_SYLLABLE_BASE || code > HANGUL_SYLLABLE_END) return null
  const syllable = code - HANGUL_SYLLABLE_BASE
  return {
    initial: KOREAN_INITIALS[Math.floor(syllable / (HANGUL_MEDIAL_COUNT * HANGUL_FINAL_COUNT))],
    medial: KOREAN_MEDIALS[Math.floor((syllable % (HANGUL_MEDIAL_COUNT * HANGUL_FINAL_COUNT)) / HANGUL_FINAL_COUNT)],
    final: KOREAN_FINALS[syllable % HANGUL_FINAL_COUNT],
  }
}

function pronounceKoreanWord(word: string, wordIndex: number): BrowserPronunciation[] {
  const chars = [...word]
  const syllables = chars.map(decomposeHangul)
  const phones: BrowserPronunciation[] = []
  syllables.forEach((syllable, index) => {
    if (!syllable) return
    const grapheme = chars[index]
    if (syllable.initial !== "ㅇ") {
      const entry = KOREAN_INITIAL_IPA[syllable.initial]
      if (entry) {
        const [phone_id, baseIpa] = entry
        const palatal = ["ㅅ", "ㅆ"].includes(syllable.initial)
          && ["ㅑ", "ㅒ", "ㅕ", "ㅖ", "ㅛ", "ㅠ", "ㅣ"].includes(syllable.medial)
        phones.push({
          grapheme,
          phone_id: palatal ? phone_id.replace("alveolar", "alveolopalatal") : phone_id,
          ipa: palatal ? baseIpa.replace("s", "ɕ") : baseIpa,
          word_index: wordIndex,
        })
      }
    }
    const vowel = KOREAN_MEDIAL_IPA[syllable.medial]
    if (vowel) phones.push({ grapheme, phone_id: vowel[0], ipa: vowel[1], word_index: wordIndex })
    if (syllable.final) {
      const final = KOREAN_FINAL_IPA[syllable.final]
      if (final) phones.push({ grapheme, phone_id: final[0], ipa: final[1], word_index: wordIndex })
    }
  })
  return phones
}

function japaneseRomaji(text: string, converted: Array<{ orig: string; hira: string }>, romanize: (text: string) => string): { romanized: string; graphemes: string[] } {
  const units: Array<{ mora: string; grapheme: string; original: string; itemIndex: number }> = []
  for (const [itemIndex, item] of converted.entries()) {
    let moras: string[] = []
    for (const character of item.hira) {
      if (("ぁぃぅぇぉゃゅょゎゕゖー".includes(character)) && moras.length) moras[moras.length - 1] += character
      else moras.push(character)
    }
    for (const mora of moras) units.push({ mora, grapheme: mora, original: item.orig, itemIndex })
  }
  const chunks: Array<{ roman: string; grapheme: string }> = []
  for (let index = 0; index < units.length; index += 1) {
    const { mora, grapheme, original, itemIndex } = units[index]
    const previousItem = units[index - 1]?.itemIndex
    if (previousItem !== undefined && previousItem !== itemIndex) chunks.push({ roman: "-", grapheme: "" })
    if (mora === "っ") {
      const following = units[index + 1]?.mora ?? ""
      const nextRoman = romanize(following)
      chunks.push({ roman: nextRoman[0] && !"aeiou".includes(nextRoman[0]) ? nextRoman[0] : "", grapheme })
    } else if (original === "は" || (["こんにちは", "こんばんは", "今日は"].includes(text) && index === units.length - 1)) {
      chunks.push({ roman: "wa", grapheme })
    } else if (original === "へ") {
      chunks.push({ roman: "e", grapheme })
    } else if (original === "を") {
      chunks.push({ roman: "o", grapheme })
    } else {
      const long = mora.endsWith("ー")
      const base = long ? mora.slice(0, -1) : mora
      let romaji = romanize(base).toLowerCase()
      if (long) romaji += [...romaji].reverse().find((character) => "aeiou".includes(character)) ?? ""
      chunks.push({ roman: romaji, grapheme })
    }
  }
  const romanized = chunks.map(({ roman }) => roman).join("")
  const graphemes = chunks.flatMap(({ roman, grapheme }) => [...roman].map(() => grapheme))
  return { romanized, graphemes }
}

function pronounceJapaneseWord(word: string, wordIndex: number, kakasi: BrowserJapaneseG2pRuntime): BrowserPronunciation[] {
  const phones: BrowserPronunciation[] = []
  const { romanized, graphemes } = japaneseRomaji(word, kakasi.convert(word), kakasi.romanize)
  let index = 0
  while (index < romanized.length) {
    if (/[\s'・-]/u.test(romanized[index])) {
      index += 1
      continue
    }
    const grapheme = graphemes[index] ?? ""
    if (grapheme === "ん") {
      const following = romanized.slice(index + 1).split("").find((character) => !"-' ".includes(character)) ?? ""
      const nasal = following && "pbm".includes(following) ? ["ja.consonant.bilabial.nasal", "m"] as const
        : following && "kg".includes(following) ? BROWSER_JAPANESE_MORAIC_NASAL_VELAR
          : following && "tdnsz".includes(following) ? ["ja.consonant.alveolar.nasal.voiced", "n"] as const
            : BROWSER_JAPANESE_MORAIC_NASAL
      phones.push({ grapheme, phone_id: nasal[0], ipa: nasal[1], word_index: wordIndex })
      index += 1
      continue
    }
    if (index + 1 < romanized.length && romanized[index] === romanized[index + 1] && !"aeioun".includes(romanized[index])) {
      phones.push({ grapheme, phone_id: BROWSER_JAPANESE_GEMINATE[0], ipa: BROWSER_JAPANESE_GEMINATE[1], word_index: wordIndex })
      index += 1
      continue
    }
    const onset = Object.keys(BROWSER_JAPANESE_ONSETS).sort((left, right) => right.length - left.length).find((item) => romanized.startsWith(item, index)) ?? ""
    if (onset) {
      const [phone_id, ipa] = BROWSER_JAPANESE_ONSETS[onset]
      phones.push({ grapheme, phone_id, ipa, word_index: wordIndex })
      index += onset.length
    }
    if (index < romanized.length && "aeiou".includes(romanized[index])) {
      const longVowel = BROWSER_JAPANESE_LONG_VOWELS[romanized.slice(index, index + 2)]
      const vowel = longVowel ?? romanized[index]
      const [phone_id, baseIpa] = BROWSER_JAPANESE_VOWELS[vowel]
      const ipa = longVowel ? `${baseIpa}ː` : baseIpa
      phones.push({ grapheme, phone_id, ipa, word_index: wordIndex })
      if (longVowel) index += 1
    }
    if (!onset && /\p{Script=Han}/u.test(grapheme)) {
      phones.push({ grapheme, phone_id: BROWSER_UNKNOWN_PHONE_ID, ipa: BROWSER_UNKNOWN_PHONE_IPA, word_index: wordIndex })
    }
    index += 1
  }
  return phones
}

export async function pronounceBrowserText(text: string, language: InputLanguage): Promise<BrowserPronunciation[]> {
  const normalized = text.trim().replace(/\s+/gu, " ")
  if (!normalized) throw new Error("검색할 문장이 비어 있습니다.")
  if (!/[\p{L}\p{N}]/u.test(normalized)) throw new Error("검색할 발음이 없습니다.")
  const resolved = resolveLanguage(normalized, language)
  if (resolved === "EN") {
    const tokens = normalized.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/gu) ?? []
    if (!tokens.length) throw new Error("영어 발음으로 변환할 단어가 없습니다.")
    const { getEnglishG2p } = await import("./phonetics/englishG2pRuntime")
    const g2p = await getEnglishG2p()
    const pronunciations = await Promise.all(tokens.map((word) => g2p.pronunciation(word)))
    return pronunciations.flatMap((symbols, wordIndex) => {
      const word = tokens[wordIndex]
      return symbols.flatMap((symbol) => {
      const phones = BROWSER_ENGLISH_ARPABET_IPA[symbol.replace(/\d/gu, "")] ?? []
      return phones.map(([phone_id, ipa]) => ({ grapheme: word, phone_id, ipa, word_index: wordIndex }))
      })
    })
  }
  if (resolved === "JA") {
    const { getJapaneseG2p } = await import("./phonetics/japaneseG2pRuntime")
    const kakasi = await getJapaneseG2p()
    const phones = splitWords(normalized).flatMap((word, wordIndex) => pronounceJapaneseWord(word, wordIndex, kakasi))
    if (!phones.length) throw new Error("일본어 발음으로 변환할 수 없습니다.")
    return phones
  }
  const { getKoreanG2p } = await import("./phonetics/koreanG2pRuntime")
  const pronunciation = await (await getKoreanG2p()).convert(normalized)
  return splitWords(pronunciation).flatMap((word, wordIndex) => pronounceKoreanWord(word, wordIndex))
}

export async function pronounceBrowserWords(words: string[], language: InputLanguage): Promise<BrowserPronunciation[]> {
  const indexedWords = words.map((word, wordIndex) => ({ word: word.trim(), wordIndex })).filter(({ word }) => word.length > 0)
  if (!indexedWords.length) return []
  const sentencePhones = await pronounceBrowserText(indexedWords.map(({ word }) => word).join(" "), language)
  const sentenceWordCount = sentencePhones.reduce((count, phone) => Math.max(count, phone.word_index + 1), 0)
  if (sentenceWordCount === indexedWords.length) {
    return sentencePhones.map((phone) => ({ ...phone, word_index: indexedWords[phone.word_index].wordIndex }))
  }
  const fallback = await Promise.all(indexedWords.map(({ word }) => pronounceBrowserText(word, language)))
  return fallback.flatMap((phones, index) => phones.map((phone) => ({ ...phone, word_index: indexedWords[index].wordIndex })))
}
