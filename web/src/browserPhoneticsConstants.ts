export const BROWSER_KOREAN_MECAB_DICTIONARY_FILES = ["char.bin", "dicrc", "matrix.bin", "sys.dic", "unk.dic"] as const
export const BROWSER_KOREAN_G2P_RULE_FILES = ["table.csv", "rules.txt", "idioms.txt"] as const
export const BROWSER_CMU_DICTIONARY_ASSET = "cmudict.json"
export const BROWSER_JAPANESE_G2P_ASSET = "pykakasi.json.gzbin"
export const BROWSER_ENGLISH_G2P_HIDDEN_SIZE = 256
export const BROWSER_ENGLISH_G2P_GRAPHEMES = ["<pad>", "<unk>", "</s>", ..."abcdefghijklmnopqrstuvwxyz"] as const
export const BROWSER_ENGLISH_G2P_PHONEMES = [
  "<pad>", "<unk>", "<s>", "</s>", "AA0", "AA1", "AA2", "AE0", "AE1", "AE2", "AH0", "AH1", "AH2", "AO0", "AO1", "AO2",
  "AW0", "AW1", "AW2", "AY0", "AY1", "AY2", "B", "CH", "D", "DH", "EH0", "EH1", "EH2", "ER0", "ER1", "ER2",
  "EY0", "EY1", "EY2", "F", "G", "HH", "IH0", "IH1", "IH2", "IY0", "IY1", "IY2", "JH", "K", "L", "M", "N", "NG",
  "OW0", "OW1", "OW2", "OY0", "OY1", "OY2", "P", "R", "S", "SH", "T", "TH", "UH0", "UH1", "UH2", "UW", "UW0",
  "UW1", "UW2", "V", "W", "Y", "Z", "ZH",
] as const
export const BROWSER_ENGLISH_G2P_WEIGHT_LAYOUT = [
  ["enc_emb", 29, 256], ["enc_w_ih", 768, 256], ["enc_w_hh", 768, 256], ["enc_b_ih", 768], ["enc_b_hh", 768],
  ["dec_emb", 74, 256], ["dec_w_ih", 768, 256], ["dec_w_hh", 768, 256], ["dec_b_ih", 768], ["dec_b_hh", 768],
  ["fc_w", 74, 256], ["fc_b", 74],
] as const
export const BROWSER_ENGLISH_ARPABET_IPA: Record<string, readonly [string, string][]> = {
  AA: [["en.vowel.a", "ɑ"]], AE: [["en.vowel.ae", "æ"]], AH: [["en.vowel.eo", "ʌ"]], AO: [["en.vowel.o", "ɔ"]],
  AW: [["en.vowel.a", "a"], ["en.vowel.u", "ʊ"]], AY: [["en.vowel.a", "a"], ["en.vowel.i", "ɪ"]], EH: [["en.vowel.e", "ɛ"]],
  ER: [["en.vowel.eo", "ɝ"]], EY: [["en.vowel.e", "e"], ["en.vowel.i", "ɪ"]], IH: [["en.vowel.i", "ɪ"]], IY: [["en.vowel.i", "i"]],
  OW: [["en.vowel.o", "o"], ["en.vowel.u", "ʊ"]], OY: [["en.vowel.o", "ɔ"], ["en.vowel.i", "ɪ"]], UH: [["en.vowel.u", "ʊ"]], UW: [["en.vowel.u", "u"]],
  B: [["en.consonant.bilabial.plosive.voiced", "b"]], CH: [["en.consonant.postalveolar.affricate.voiceless", "tʃ"]],
  D: [["en.consonant.alveolar.plosive.voiced", "d"]], DH: [["en.consonant.dental.fricative.voiced", "ð"]],
  F: [["en.consonant.labiodental.fricative.voiceless", "f"]], G: [["en.consonant.velar.plosive.voiced", "ɡ"]],
  HH: [["en.consonant.glottal.fricative.voiceless", "h"]], JH: [["en.consonant.postalveolar.affricate.voiced", "dʒ"]],
  K: [["en.consonant.velar.plosive.voiceless", "k"]], L: [["en.consonant.alveolar.lateral.voiced", "l"]],
  M: [["en.consonant.bilabial.nasal.voiced", "m"]], N: [["en.consonant.alveolar.nasal.voiced", "n"]],
  NG: [["en.consonant.velar.nasal.voiced", "ŋ"]], P: [["en.consonant.bilabial.plosive.voiceless", "p"]],
  R: [["en.consonant.postalveolar.approximant.voiced", "ɹ"]], S: [["en.consonant.alveolar.fricative.voiceless", "s"]],
  SH: [["en.consonant.postalveolar.fricative.voiceless", "ʃ"]], T: [["en.consonant.alveolar.plosive.voiceless", "t"]],
  TH: [["en.consonant.dental.fricative.voiceless", "θ"]], V: [["en.consonant.labiodental.fricative.voiced", "v"]],
  W: [["en.consonant.labiovelar.approximant.voiced", "w"]], Y: [["en.consonant.palatal.approximant.voiced", "j"]],
  Z: [["en.consonant.alveolar.fricative.voiced", "z"]], ZH: [["en.consonant.postalveolar.fricative.voiced", "ʒ"]],
}
export const BROWSER_JAPANESE_VOWELS: Record<string, readonly [string, string]> = {
  a: ["ja.vowel.a", "a"], i: ["ja.vowel.i", "i"], u: ["ja.vowel.u", "ɯ"], e: ["ja.vowel.e", "e"], o: ["ja.vowel.o", "o"],
}
export const BROWSER_JAPANESE_ONSETS: Record<string, readonly [string, string]> = {
  ky: ["ja.consonant.palatalized.velar.plosive.voiceless", "kʲ"], gy: ["ja.consonant.palatalized.velar.plosive.voiced", "ɡʲ"],
  sh: ["ja.consonant.alveolopalatal.fricative.voiceless", "ɕ"], ch: ["ja.consonant.alveolopalatal.affricate.voiceless", "tɕ"],
  ny: ["ja.consonant.palatalized.alveolar.nasal.voiced", "nʲ"], hy: ["ja.consonant.palatal.fricative.voiceless", "ç"],
  my: ["ja.consonant.palatalized.bilabial.nasal.voiced", "mʲ"], ry: ["ja.consonant.palatalized.alveolar.tap.voiced", "ɾʲ"],
  by: ["ja.consonant.palatalized.bilabial.plosive.voiced", "bʲ"], py: ["ja.consonant.palatalized.bilabial.plosive.voiceless", "pʲ"],
  ts: ["ja.consonant.alveolar.affricate.voiceless", "ts"], j: ["ja.consonant.alveolopalatal.affricate.voiced", "dʑ"],
  f: ["ja.consonant.bilabial.fricative.voiceless", "ɸ"], v: ["ja.consonant.labiodental.fricative.voiced", "v"],
  k: ["ja.consonant.velar.plosive.voiceless", "k"], g: ["ja.consonant.velar.plosive.voiced", "ɡ"],
  s: ["ja.consonant.alveolar.fricative.voiceless", "s"], z: ["ja.consonant.alveolar.fricative.voiced", "z"],
  t: ["ja.consonant.alveolar.plosive.voiceless", "t"], d: ["ja.consonant.alveolar.plosive.voiced", "d"],
  n: ["ja.consonant.alveolar.nasal.voiced", "n"], h: ["ja.consonant.glottal.fricative.voiceless", "h"],
  b: ["ja.consonant.bilabial.plosive.voiced", "b"], p: ["ja.consonant.bilabial.plosive.voiceless", "p"],
  m: ["ja.consonant.bilabial.nasal.voiced", "m"], y: ["ja.consonant.palatal.approximant.voiced", "j"],
  r: ["ja.consonant.alveolar.tap.voiced", "ɾ"], w: ["ja.consonant.labiovelar.approximant.voiced", "w"],
}
export const BROWSER_JAPANESE_MORAIC_NASAL = ["ja.consonant.uvular.nasal.voiced", "ɴ"] as const
export const BROWSER_JAPANESE_MORAIC_NASAL_VELAR = ["ja.consonant.velar.nasal.voiced", "ŋ"] as const
export const BROWSER_JAPANESE_GEMINATE = ["ja.consonant.geminate", "Q"] as const
export const BROWSER_JAPANESE_LONG_VOWELS: Record<string, string> = {
  aa: "a", ii: "i", uu: "u", ee: "e", oo: "o", ou: "o", ei: "e",
}
