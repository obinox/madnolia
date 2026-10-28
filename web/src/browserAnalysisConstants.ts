export const BROWSER_UNKNOWN_PHONE_ID = "und.approximate.unknown"
export const BROWSER_UNKNOWN_PHONE_IPA = "?"
export const BROWSER_ASR_MODELS = [
  { id: "Xenova/whisper-tiny", label: "Whisper tiny", size_label: "~150 MB" },
  { id: "Xenova/whisper-base", label: "Whisper base", size_label: "~290 MB" },
  { id: "Xenova/whisper-small", label: "Whisper small", size_label: "~950 MB" },
] as const

export const BROWSER_ASR_DEFAULT_MODEL = BROWSER_ASR_MODELS[0].id
export const BROWSER_MODEL_CACHE_ROOT = "models/_transformers-cache"
export const BROWSER_MODEL_CACHE_INDEX = `${BROWSER_MODEL_CACHE_ROOT}/index.json`
export const BROWSER_ASR_SAMPLE_RATE = 16_000
export const BROWSER_ASR_CHUNK_SECONDS = 30
export const BROWSER_ASR_OVERLAP_SECONDS = 5
export const BROWSER_ASR_WASM_THREADS = 1
export const BROWSER_ANALYSIS_JOB_PREFIX = "madnolia.browser.analysisJob."
export const BROWSER_ANALYSIS_JOB_INDEX = "jobs/analysis-index.json"
export const BROWSER_VIDEO_INDEX = "media/index.json"
export const BROWSER_ANALYSIS_STORAGE_DIRECTORY = "analyses"
export const BROWSER_MEDIA_STORAGE_DIRECTORY = "media"
export const BROWSER_JOB_STORAGE_DIRECTORY = "jobs"
export const BROWSER_ANALYSIS_PAUSE_STAGE = "Paused at a chunk boundary"
export const BROWSER_ANALYSIS_INTERRUPTED_STAGE = "Interrupted when the page closed"
export const BROWSER_ANALYSIS_VAD_FRAME_MS = 20
export const BROWSER_ANALYSIS_VAD_MIN_RMS = 0.008
export const BROWSER_ANALYSIS_VAD_MIN_SPEECH_MS = 100
export const BROWSER_ANALYSIS_VAD_PADDING_MS = 80
export const BROWSER_ANALYSIS_SENTENCE_GAP_MS = 900
export const BROWSER_ANALYSIS_JOB_PROGRESS_WRITE_INTERVAL_MS = 250
export const BROWSER_ANALYSIS_PHONE_MIN_DURATION_MS = 1
export const BROWSER_ANALYSIS_MODEL_DEVICE_LABELS = {
  webgpu: "WebGPU",
  wasm: "WebAssembly CPU",
} as const
export const HANGUL_SYLLABLE_BASE = 0xac00
export const HANGUL_SYLLABLE_END = 0xd7a3
export const HANGUL_MEDIAL_COUNT = 21
export const HANGUL_FINAL_COUNT = 28
export const ENGLISH_SINGLE_LETTER_PHONEMES: Record<string, string> = {
  b: "B", d: "D", f: "F", g: "G", h: "HH", k: "K", l: "L", m: "M", n: "N",
  p: "P", r: "R", s: "S", t: "T", v: "V", z: "Z",
}

export const KOREAN_INITIALS = [
  "ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ",
  "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
] as const

export const KOREAN_MEDIALS = [
  "ㅏ", "ㅐ", "ㅑ", "ㅒ", "ㅓ", "ㅔ", "ㅕ", "ㅖ", "ㅗ", "ㅘ", "ㅙ",
  "ㅚ", "ㅛ", "ㅜ", "ㅝ", "ㅞ", "ㅟ", "ㅠ", "ㅡ", "ㅢ", "ㅣ",
] as const

export const KOREAN_FINALS = [
  "", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ",
  "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ",
  "ㅋ", "ㅌ", "ㅍ", "ㅎ",
] as const

export const KOREAN_INITIAL_IPA: Record<string, readonly [string, string]> = {
  ㄱ: ["ko.consonant.velar.plosive.lenis", "k"],
  ㄲ: ["ko.consonant.velar.plosive.fortis", "k͈"],
  ㄴ: ["ko.consonant.alveolar.nasal", "n"],
  ㄷ: ["ko.consonant.alveolar.plosive.lenis", "t"],
  ㄸ: ["ko.consonant.alveolar.plosive.fortis", "t͈"],
  ㄹ: ["ko.consonant.alveolar.tap", "ɾ"],
  ㅁ: ["ko.consonant.bilabial.nasal", "m"],
  ㅂ: ["ko.consonant.bilabial.plosive.lenis", "p"],
  ㅃ: ["ko.consonant.bilabial.plosive.fortis", "p͈"],
  ㅅ: ["ko.consonant.alveolar.fricative.lenis", "s"],
  ㅆ: ["ko.consonant.alveolar.fricative.fortis", "s͈"],
  ㅇ: ["ko.consonant.velar.nasal", "ŋ"],
  ㅈ: ["ko.consonant.alveolopalatal.affricate.lenis", "tɕ"],
  ㅉ: ["ko.consonant.alveolopalatal.affricate.fortis", "tɕ͈"],
  ㅊ: ["ko.consonant.alveolopalatal.affricate.aspirated", "tɕʰ"],
  ㅋ: ["ko.consonant.velar.plosive.aspirated", "kʰ"],
  ㅌ: ["ko.consonant.alveolar.plosive.aspirated", "tʰ"],
  ㅍ: ["ko.consonant.bilabial.plosive.aspirated", "pʰ"],
  ㅎ: ["ko.consonant.glottal.fricative", "h"],
}

export const KOREAN_MEDIAL_IPA: Record<string, readonly [string, string]> = {
  ㅏ: ["ko.vowel.a", "a"], ㅐ: ["ko.vowel.ae", "ɛ"], ㅑ: ["ko.vowel.ya", "ja"],
  ㅒ: ["ko.vowel.yae", "jɛ"], ㅓ: ["ko.vowel.eo", "ʌ"], ㅔ: ["ko.vowel.e", "e"],
  ㅕ: ["ko.vowel.yeo", "jʌ"], ㅖ: ["ko.vowel.ye", "je"], ㅗ: ["ko.vowel.o", "o"],
  ㅘ: ["ko.vowel.wa", "wa"], ㅙ: ["ko.vowel.wae", "wɛ"], ㅚ: ["ko.vowel.oe", "we"],
  ㅛ: ["ko.vowel.yo", "jo"], ㅜ: ["ko.vowel.u", "u"], ㅝ: ["ko.vowel.wo", "wʌ"],
  ㅞ: ["ko.vowel.we", "we"], ㅟ: ["ko.vowel.wi", "wi"], ㅠ: ["ko.vowel.yu", "ju"],
  ㅡ: ["ko.vowel.eu", "ɯ"], ㅢ: ["ko.vowel.ui", "ɰi"], ㅣ: ["ko.vowel.i", "i"],
}

export const KOREAN_FINAL_IPA: Record<string, readonly [string, string]> = {
  ㄱ: ["ko.coda.velar", "k̚"], ㄲ: ["ko.coda.velar", "k̚"], ㄳ: ["ko.coda.velar", "k̚"],
  ㄴ: ["ko.coda.alveolar.nasal", "n"], ㄵ: ["ko.coda.alveolar.nasal", "n"], ㄶ: ["ko.coda.alveolar.nasal", "n"],
  ㄷ: ["ko.coda.alveolar", "t̚"], ㄹ: ["ko.coda.alveolar.lateral", "l"], ㄺ: ["ko.coda.velar", "k̚"],
  ㄻ: ["ko.coda.bilabial.nasal", "m"], ㄼ: ["ko.coda.alveolar.lateral", "l"], ㄽ: ["ko.coda.alveolar", "t̚"],
  ㄾ: ["ko.coda.alveolar.lateral", "l"], ㄿ: ["ko.coda.bilabial", "p̚"], ㅀ: ["ko.coda.alveolar.lateral", "l"],
  ㅁ: ["ko.coda.bilabial.nasal", "m"], ㅂ: ["ko.coda.bilabial", "p̚"], ㅄ: ["ko.coda.bilabial", "p̚"],
  ㅅ: ["ko.coda.alveolar", "t̚"], ㅆ: ["ko.coda.alveolar", "t̚"], ㅇ: ["ko.coda.velar.nasal", "ŋ"],
  ㅈ: ["ko.coda.alveolar", "t̚"], ㅊ: ["ko.coda.alveolar", "t̚"], ㅋ: ["ko.coda.velar", "k̚"],
  ㅌ: ["ko.coda.alveolar", "t̚"], ㅍ: ["ko.coda.bilabial", "p̚"], ㅎ: ["ko.coda.alveolar", "t̚"],
}

export const ENGLISH_PHONE_IPA: Record<string, readonly [string, string][]> = {
  AA: [["en.vowel.open.back", "ɑ"]], AE: [["en.vowel.near_open.front", "æ"]],
  AH: [["en.vowel.mid.central", "ʌ"]], AO: [["en.vowel.open_mid.back", "ɔ"]],
  AW: [["en.vowel.diphthong", "aʊ"]], AY: [["en.vowel.diphthong", "aɪ"]],
  EH: [["en.vowel.open_mid.front", "ɛ"]], ER: [["en.vowel.rhotic", "ɝ"]],
  EY: [["en.vowel.diphthong", "eɪ"]], IH: [["en.vowel.near_close.front", "ɪ"]],
  IY: [["en.vowel.close.front", "i"]], OW: [["en.vowel.diphthong", "oʊ"]],
  OY: [["en.vowel.diphthong", "ɔɪ"]], UH: [["en.vowel.near_close.back", "ʊ"]],
  UW: [["en.vowel.close.back", "u"]], B: [["en.consonant.bilabial.plosive", "b"]],
  CH: [["en.consonant.postalveolar.affricate", "tʃ"]], D: [["en.consonant.alveolar.plosive", "d"]],
  DH: [["en.consonant.dental.fricative", "ð"]], F: [["en.consonant.labiodental.fricative", "f"]],
  G: [["en.consonant.velar.plosive", "ɡ"]], HH: [["en.consonant.glottal.fricative", "h"]],
  JH: [["en.consonant.postalveolar.affricate", "dʒ"]], K: [["en.consonant.velar.plosive", "k"]],
  L: [["en.consonant.alveolar.lateral", "l"]], M: [["en.consonant.bilabial.nasal", "m"]],
  N: [["en.consonant.alveolar.nasal", "n"]], NG: [["en.consonant.velar.nasal", "ŋ"]],
  P: [["en.consonant.bilabial.plosive", "p"]], R: [["en.consonant.alveolar.approximant", "ɹ"]],
  S: [["en.consonant.alveolar.fricative", "s"]], SH: [["en.consonant.postalveolar.fricative", "ʃ"]],
  T: [["en.consonant.alveolar.plosive", "t"]], TH: [["en.consonant.dental.fricative", "θ"]],
  V: [["en.consonant.labiodental.fricative", "v"]], W: [["en.consonant.labial_velar.approximant", "w"]],
  Y: [["en.consonant.palatal.approximant", "j"]], Z: [["en.consonant.alveolar.fricative", "z"]],
  ZH: [["en.consonant.postalveolar.fricative", "ʒ"]],
}

export const ENGLISH_LEXICON: Record<string, readonly string[]> = {
  a: ["AH"], about: ["AH", "B", "AW", "T"], and: ["AE", "N", "D"], are: ["AA", "R"],
  be: ["B", "IY"], can: ["K", "AE", "N"], do: ["D", "UW"], for: ["F", "AO", "R"],
  from: ["F", "R", "AH", "M"], good: ["G", "UH", "D"], hello: ["HH", "AH", "L", "OW"],
  i: ["AY"], in: ["IH", "N"], is: ["IH", "Z"], it: ["IH", "T"], like: ["L", "AY", "K"],
  madnolia: ["M", "AE", "D", "N", "OW", "L", "IY", "AH"], my: ["M", "AY"],
  not: ["N", "AA", "T"], of: ["AH", "V"], on: ["AA", "N"], that: ["DH", "AE", "T"],
  the: ["DH", "AH"], this: ["DH", "IH", "S"], to: ["T", "UW"], what: ["W", "AH", "T"],
  world: ["W", "ER", "L", "D"], you: ["Y", "UW"],
}

export const JAPANESE_KANA_ROMAJI: Record<string, string> = {
  あ: "a", い: "i", う: "u", え: "e", お: "o", か: "ka", き: "ki", く: "ku", け: "ke", こ: "ko",
  さ: "sa", し: "shi", す: "su", せ: "se", そ: "so", た: "ta", ち: "chi", つ: "tsu", て: "te", と: "to",
  な: "na", に: "ni", ぬ: "nu", ね: "ne", の: "no", は: "ha", ひ: "hi", ふ: "fu", へ: "he", ほ: "ho",
  ま: "ma", み: "mi", む: "mu", め: "me", も: "mo", や: "ya", ゆ: "yu", よ: "yo",
  ら: "ra", り: "ri", る: "ru", れ: "re", ろ: "ro", わ: "wa", を: "o", ん: "n",
  が: "ga", ぎ: "gi", ぐ: "gu", げ: "ge", ご: "go", ざ: "za", じ: "ji", ず: "zu", ぜ: "ze", ぞ: "zo",
  だ: "da", ぢ: "ji", づ: "zu", で: "de", ど: "do", ば: "ba", び: "bi", ぶ: "bu", べ: "be", ぼ: "bo",
  ぱ: "pa", ぴ: "pi", ぷ: "pu", ぺ: "pe", ぽ: "po", きゃ: "kya", きゅ: "kyu", きょ: "kyo",
  しゃ: "sha", しゅ: "shu", しょ: "sho", ちゃ: "cha", ちゅ: "chu", ちょ: "cho",
  にゃ: "nya", にゅ: "nyu", にょ: "nyo", ひゃ: "hya", ひゅ: "hyu", ひょ: "hyo",
  みゃ: "mya", みゅ: "myu", みょ: "myo", りゃ: "rya", りゅ: "ryu", りょ: "ryo",
  じゃ: "ja", じゅ: "ju", じょ: "jo", ぎゃ: "gya", ぎゅ: "gyu", ぎょ: "gyo",
  びゃ: "bya", びゅ: "byu", びょ: "byo", ぴゃ: "pya", ぴゅ: "pyu", ぴょ: "pyo",
}

export const JAPANESE_COMMON_KANJI: Record<string, string> = {
  今日: "きょう", こんにちは: "こんにちは", こんばんは: "こんばんは", 日本: "にほん", 日本語: "にほんご",
  私: "わたし", 世界: "せかい", 音楽: "おんがく", 東京: "とうきょう", 明日: "あした", 人: "ひと",
}

export const JAPANESE_ONSET_IPA: Record<string, readonly [string, string]> = {
  k: ["ja.consonant.velar.plosive", "k"], s: ["ja.consonant.alveolar.fricative", "s"],
  sh: ["ja.consonant.postalveolar.fricative", "ɕ"], t: ["ja.consonant.alveolar.plosive", "t"],
  ch: ["ja.consonant.alveolopalatal.affricate", "tɕ"], ts: ["ja.consonant.alveolar.affricate", "ts"],
  n: ["ja.consonant.alveolar.nasal", "n"], h: ["ja.consonant.glottal.fricative", "h"],
  f: ["ja.consonant.bilabial.fricative", "ɸ"], m: ["ja.consonant.bilabial.nasal", "m"],
  y: ["ja.consonant.palatal.approximant", "j"], r: ["ja.consonant.alveolar.tap", "ɾ"],
  w: ["ja.consonant.labial_velar.approximant", "w"], g: ["ja.consonant.velar.plosive", "ɡ"],
  z: ["ja.consonant.alveolar.fricative", "z"], j: ["ja.consonant.alveolopalatal.affricate", "dʑ"],
  d: ["ja.consonant.alveolar.plosive", "d"], b: ["ja.consonant.bilabial.plosive", "b"],
  p: ["ja.consonant.bilabial.plosive", "p"],
}

export const JAPANESE_VOWEL_IPA: Record<string, readonly [string, string]> = {
  a: ["ja.vowel.a", "a"], i: ["ja.vowel.i", "i"], u: ["ja.vowel.u", "ɯ"],
  e: ["ja.vowel.e", "e"], o: ["ja.vowel.o", "o"],
}
