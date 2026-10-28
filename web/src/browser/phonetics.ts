import type { BrowserPronunciation, InputLanguage } from "../types"
import {
  BROWSER_UNKNOWN_PHONE_ID,
  BROWSER_UNKNOWN_PHONE_IPA,
  ENGLISH_LEXICON,
  ENGLISH_PHONE_IPA,
  ENGLISH_SINGLE_LETTER_PHONEMES,
  HANGUL_FINAL_COUNT,
  HANGUL_MEDIAL_COUNT,
  HANGUL_SYLLABLE_BASE,
  HANGUL_SYLLABLE_END,
  JAPANESE_COMMON_KANJI,
  JAPANESE_KANA_ROMAJI,
  JAPANESE_ONSET_IPA,
  JAPANESE_VOWEL_IPA,
  KOREAN_FINAL_IPA,
  KOREAN_FINALS,
  KOREAN_INITIAL_IPA,
  KOREAN_INITIALS,
  KOREAN_MEDIAL_IPA,
  KOREAN_MEDIALS,
} from "../browserAnalysisConstants"

function resolveLanguage(text: string, language: InputLanguage): Exclude<InputLanguage, "AUTO"> {
  if (language !== "AUTO") return language
  if (/[\uac00-\ud7a3]/u.test(text)) return "KO"
  if (/[\u3040-\u30ff\u4e00-\u9fff]/u.test(text)) return "JA"
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

function codaRepresentative(final: string): string {
  if (["ㄱ", "ㄲ", "ㄳ", "ㅋ", "ㄺ"].includes(final)) return "ㄱ"
  if (["ㄴ", "ㄵ", "ㄶ"].includes(final)) return "ㄴ"
  if (["ㄷ", "ㅅ", "ㅆ", "ㅈ", "ㅊ", "ㅌ", "ㅎ"].includes(final)) return "ㄷ"
  if (["ㄹ", "ㄼ", "ㄽ", "ㄾ", "ㅀ"].includes(final)) return "ㄹ"
  if (["ㅁ", "ㄻ"].includes(final)) return "ㅁ"
  if (["ㅂ", "ㅍ", "ㅄ", "ㄿ"].includes(final)) return "ㅂ"
  return final
}

function pronounceKoreanWord(word: string, wordIndex: number): BrowserPronunciation[] {
  const chars = [...word]
  const syllables = chars.map(decomposeHangul)
  for (let index = 0; index < syllables.length - 1; index += 1) {
    const current = syllables[index]
    const next = syllables[index + 1]
    if (!current || !next) continue
    if (current.final && next.initial === "ㅇ") {
      const onset = current.final.length === 2 ? current.final[1] : current.final
      if (KOREAN_INITIAL_IPA[onset]) {
        next.initial = onset
        current.final = current.final.length === 2 ? current.final[0] : ""
      }
    }
    if (current.final && ["ㄴ", "ㅁ"].includes(next.initial)) {
      const coda = codaRepresentative(current.final)
      if (coda === "ㄱ") current.final = "ㅇ"
      else if (coda === "ㄷ") current.final = "ㄴ"
      else if (coda === "ㅂ") current.final = "ㅁ"
    }
  }
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
      const final = KOREAN_FINAL_IPA[codaRepresentative(syllable.final)]
      if (final) phones.push({ grapheme, phone_id: final[0], ipa: final[1], word_index: wordIndex })
    }
  })
  return phones
}

function englishPhonemes(word: string): string[] {
  const lower = word.toLowerCase().replace(/[^a-z']/gu, "")
  if (!lower) return []
  const known = ENGLISH_LEXICON[lower]
  if (known) return [...known]
  const units = lower.match(/tch|ch|sh|th|ph|wh|ng|ck|qu|ee|ea|ai|ay|oa|ow|oo|ou|oi|oy|igh|[a-z]/gu) ?? []
  return units.map((unit, index) => {
    const next = units[index + 1] ?? ""
    const previous = units[index - 1] ?? ""
    if (unit === "tch") return "CH"
    if (unit === "ch") return "CH"
    if (unit === "sh") return "SH"
    if (unit === "th") return lower.startsWith("the") || ["this", "that", "these", "those"].some((item) => lower.startsWith(item)) ? "DH" : "TH"
    if (unit === "ph") return "F"
    if (unit === "wh") return "W"
    if (unit === "ng") return "NG"
    if (unit === "ck") return "K"
    if (unit === "qu") return "K"
    if (["ee", "ea"].includes(unit)) return "IY"
    if (["ai", "ay"].includes(unit)) return "EY"
    if (unit === "oa") return "OW"
    if (unit === "ow") return "AW"
    if (unit === "oo") return "UW"
    if (unit === "ou") return "AW"
    if (["oi", "oy"].includes(unit)) return "OY"
    if (unit === "igh") return "AY"
    const isFinalSilentE = unit === "e" && index === units.length - 1 && units.length > 1
    if (isFinalSilentE) return ""
    if ("aeiou".includes(unit)) {
      if (unit === "a") return next === "r" ? "AA" : "AE"
      if (unit === "e") return "EH"
      if (unit === "i") return "IH"
      if (unit === "o") return "AA"
      return "AH"
    }
    if (unit === "c") return "K"
    if (unit === "x") return "K"
    if (unit === "j") return "JH"
    if (unit === "y") return index === 0 && next ? "Y" : "IY"
    if (unit === "w" && previous === "q") return ""
    if (unit === "w") return "W"
    return ENGLISH_SINGLE_LETTER_PHONEMES[unit] ?? ""
  }).filter(Boolean)
}

function pronounceEnglishWord(word: string, wordIndex: number): BrowserPronunciation[] {
  const phones: BrowserPronunciation[] = []
  for (const symbol of englishPhonemes(word)) {
    for (const [phone_id, ipa] of ENGLISH_PHONE_IPA[symbol] ?? []) {
      phones.push({ grapheme: word, phone_id, ipa, word_index: wordIndex })
    }
  }
  return phones
}

function normalizeKana(text: string): string {
  return [...text].map((character) => {
    const code = character.codePointAt(0) ?? 0
    return code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : character
  }).join("")
}

function expandKnownKanji(text: string): string {
  return Object.entries(JAPANESE_COMMON_KANJI).sort((left, right) => right[0].length - left[0].length)
    .reduce((value, [kanji, kana]) => value.replaceAll(kanji, kana), text)
}

function japaneseRomaji(text: string): Array<{ kana: string; romaji: string }> {
  const normalized = normalizeKana(expandKnownKanji(text))
  const chars = [...normalized]
  const output: Array<{ kana: string; romaji: string }> = []
  for (let index = 0; index < chars.length; index += 1) {
    const pair = chars[index] + (chars[index + 1] ?? "")
    if (JAPANESE_KANA_ROMAJI[pair]) {
      output.push({ kana: pair, romaji: JAPANESE_KANA_ROMAJI[pair] })
      index += 1
    } else if (JAPANESE_KANA_ROMAJI[chars[index]]) {
      output.push({ kana: chars[index], romaji: JAPANESE_KANA_ROMAJI[chars[index]] })
    } else if (/[\u3400-\u9fff]/u.test(chars[index])) {
      output.push({ kana: chars[index], romaji: "a" })
    } else if (chars[index] === "っ") {
      const next = chars[index + 1] ?? ""
      const upcoming = JAPANESE_KANA_ROMAJI[next] ?? ""
      output.push({ kana: chars[index], romaji: upcoming[0] && !"aeiou".includes(upcoming[0]) ? upcoming[0] : "" })
    } else if (chars[index] === "ー") {
      const lastVowel = [...(output.at(-1)?.romaji ?? "")].reverse().find((item) => "aeiou".includes(item)) ?? ""
      output.push({ kana: chars[index], romaji: lastVowel })
    }
  }
  return output
}

function pronounceJapaneseWord(word: string, wordIndex: number): BrowserPronunciation[] {
  const phones: BrowserPronunciation[] = []
  const morae = japaneseRomaji(word)
  for (let index = 0; index < morae.length; index += 1) {
    const { kana, romaji } = morae[index]
    if (/[\u3400-\u9fff]/u.test(kana)) {
      phones.push({ grapheme: kana, phone_id: BROWSER_UNKNOWN_PHONE_ID, ipa: BROWSER_UNKNOWN_PHONE_IPA, word_index: wordIndex })
      continue
    }
    if (!romaji) continue
    if (kana === "ん") {
      const next = morae.slice(index + 1).map((item) => item.romaji).find(Boolean)?.[0] ?? ""
      const nasal = "pbm".includes(next) ? ["ja.consonant.bilabial.nasal", "m"] as const
        : "kg".includes(next) ? ["ja.consonant.velar.nasal", "ŋ"] as const
          : JAPANESE_ONSET_IPA.n
      phones.push({ grapheme: kana, phone_id: nasal[0], ipa: nasal[1], word_index: wordIndex })
      continue
    }
    if (kana === "っ") {
      const next = morae[index + 1]?.romaji ?? ""
      const onset = Object.keys(JAPANESE_ONSET_IPA).sort((left, right) => right.length - left.length).find((item) => next.startsWith(item))
      if (onset) phones.push({ grapheme: kana, phone_id: `ja.consonant.geminate.${onset}`, ipa: onset === "sh" ? "ɕː" : `${JAPANESE_ONSET_IPA[onset][1]}ː`, word_index: wordIndex })
      continue
    }
    const onset = Object.keys(JAPANESE_ONSET_IPA).sort((left, right) => right.length - left.length).find((item) => romaji.startsWith(item)) ?? ""
    if (onset) {
      const [phone_id, ipa] = JAPANESE_ONSET_IPA[onset]
      phones.push({ grapheme: kana, phone_id, ipa, word_index: wordIndex })
    }
    const vowel = [...romaji].reverse().find((character) => "aeiou".includes(character))
    if (vowel) {
      const [phone_id, ipa] = JAPANESE_VOWEL_IPA[vowel]
      phones.push({ grapheme: kana, phone_id, ipa, word_index: wordIndex })
    }
  }
  return phones
}

export function pronounceBrowserText(text: string, language: InputLanguage): BrowserPronunciation[] {
  const normalized = text.trim().replace(/\s+/gu, " ")
  if (!normalized) throw new Error("검색할 문장이 비어 있습니다.")
  if (!/[\p{L}\p{N}]/u.test(normalized)) throw new Error("검색할 발음이 없습니다.")
  const resolved = resolveLanguage(normalized, language)
  const words = splitWords(normalized)
  const phones = words.flatMap((word, wordIndex) => {
    if (resolved === "KO") return pronounceKoreanWord(word, wordIndex)
    if (resolved === "EN") return pronounceEnglishWord(word, wordIndex)
    return pronounceJapaneseWord(word, wordIndex)
  })
  if (!phones.length) return words.flatMap((word, word_index) => [...word].map((grapheme) => ({
    grapheme, phone_id: BROWSER_UNKNOWN_PHONE_ID, ipa: BROWSER_UNKNOWN_PHONE_IPA, word_index,
  })))
  return phones
}
