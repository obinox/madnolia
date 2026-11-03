export const BROWSER_SEARCH_CANDIDATES_PER_START_MAX = 100
export const BROWSER_SEARCH_APPROXIMATE_MIN_SIMILARITY = 0.55
export const BROWSER_SEARCH_APPROXIMATE_ANCHORS_PER_SOURCE = 48
export const BROWSER_SEARCH_EDIT_COST = 0.8
export const BROWSER_SEARCH_MAX_EDIT_COUNT = 2
export const BROWSER_SEARCH_MAX_JOIN_GAP_MS = 500
export const BROWSER_SEARCH_MAX_RANKED_PER_START = 32
export const BROWSER_SEARCH_MAX_TARGET_SPAN = 8
export const BROWSER_SEARCH_MIN_SIMILARITY = 0.42
export const BROWSER_SEARCH_YIELD_INTERVAL = 128
export const SEARCH_PHONE_SIMILARITY_OVERRIDES: Record<string, number> = {
  "ja.vowel.a|ko.vowel.a": 0.99, "ja.vowel.i|ko.vowel.i": 0.99, "ja.vowel.u|ko.vowel.eu": 0.97, "ja.vowel.u|ko.vowel.u": 0.88,
  "ja.vowel.e|ko.vowel.e": 0.99, "ja.vowel.o|ko.vowel.o": 0.99,
  "ja.consonant.velar.plosive.voiceless|ko.consonant.velar.plosive.lenis": 0.94,
  "en.consonant.velar.plosive.voiced|ko.consonant.velar.plosive.lenis": 0.92,
  "en.consonant.velar.plosive.voiceless|ko.consonant.velar.plosive.lenis": 0.94,
  "ja.consonant.velar.plosive.voiced|ko.consonant.velar.plosive.lenis": 0.92,
  "en.consonant.alveolar.plosive.voiced|ko.consonant.alveolar.plosive.lenis": 0.92,
  "en.consonant.alveolar.plosive.voiceless|ko.consonant.alveolar.plosive.lenis": 0.94,
  "ja.consonant.alveolar.plosive.voiced|ko.consonant.alveolar.plosive.lenis": 0.92,
  "ja.consonant.alveolar.plosive.voiceless|ko.consonant.alveolar.plosive.lenis": 0.94,
  "ja.consonant.alveolar.fricative.voiceless|ko.consonant.alveolar.fricative.lenis": 0.96,
  "en.consonant.alveolar.fricative.voiceless|ko.consonant.alveolar.fricative.lenis": 0.96,
  "en.consonant.alveolar.fricative.voiced|ko.consonant.alveolar.fricative.lenis": 0.92,
  "ja.consonant.alveolopalatal.fricative.voiceless|ko.consonant.alveolopalatal.fricative.lenis": 0.97,
  "ja.consonant.alveolopalatal.affricate.voiceless|ko.consonant.alveolopalatal.affricate.aspirated": 0.91,
  "ja.consonant.alveolopalatal.affricate.voiced|ko.consonant.alveolopalatal.affricate.lenis": 0.9,
  "en.consonant.postalveolar.affricate.voiceless|ko.consonant.alveolopalatal.affricate.aspirated": 0.91,
  "en.consonant.postalveolar.affricate.voiced|ko.consonant.alveolopalatal.affricate.lenis": 0.9,
  "ja.consonant.alveolar.affricate.voiceless|ko.consonant.alveolopalatal.affricate.aspirated": 0.82,
  "ja.consonant.alveolar.fricative.voiced|ko.consonant.alveolopalatal.affricate.lenis": 0.82,
  "ja.consonant.alveolar.nasal.voiced|ko.consonant.alveolar.nasal": 0.98,
  "ja.consonant.velar.nasal.voiced|ko.coda.velar.nasal": 0.98,
  "ja.consonant.glottal.fricative.voiceless|ko.consonant.glottal.fricative": 0.98,
  "ja.consonant.bilabial.plosive.voiced|ko.consonant.bilabial.plosive.lenis": 0.92,
  "ja.consonant.bilabial.plosive.voiceless|ko.consonant.bilabial.plosive.lenis": 0.88,
  "en.consonant.bilabial.plosive.voiced|ko.consonant.bilabial.plosive.lenis": 0.92,
  "en.consonant.bilabial.plosive.voiceless|ko.consonant.bilabial.plosive.lenis": 0.94,
  "ja.consonant.bilabial.nasal.voiced|ko.consonant.bilabial.nasal": 0.98,
  "ja.consonant.alveolar.tap.voiced|ko.consonant.alveolar.tap": 0.98,
  "ja.consonant.labiovelar.approximant.voiced|ko.vowel.wa": 0.78,
  "ja.consonant.palatal.approximant.voiced|ko.vowel.ya": 0.78,
  "ja.consonant.palatalized.velar.plosive.voiceless|ko.consonant.velar.plosive.lenis": 0.84,
  "ja.consonant.palatalized.velar.plosive.voiced|ko.consonant.velar.plosive.lenis": 0.86,
  "ja.consonant.palatalized.alveolar.nasal.voiced|ko.consonant.alveolar.nasal": 0.86,
  "ja.consonant.palatal.fricative.voiceless|ko.consonant.glottal.fricative": 0.8,
  "ja.consonant.bilabial.fricative.voiceless|ko.consonant.glottal.fricative": 0.82,
  "ja.consonant.palatalized.bilabial.nasal.voiced|ko.consonant.bilabial.nasal": 0.86,
  "ja.consonant.palatalized.alveolar.tap.voiced|ko.consonant.alveolar.tap": 0.86,
  "ja.consonant.palatalized.bilabial.plosive.voiced|ko.consonant.bilabial.plosive.lenis": 0.84,
  "ja.consonant.palatalized.bilabial.plosive.voiceless|ko.consonant.bilabial.plosive.aspirated": 0.84,
  "ja.consonant.uvular.nasal.voiced|ko.coda.velar.nasal": 0.95,
  "ja.consonant.uvular.nasal.voiced|ko.consonant.alveolar.nasal": 0.9,
  "ja.consonant.uvular.nasal.voiced|ko.coda.bilabial.nasal": 0.86,
}
export const SEARCH_PHONE_FALLBACK_SIMILARITIES: Record<string, number> = {
  "ja.consonant.labiodental.fricative.voiced|ko.consonant.bilabial.plosive.lenis": 0.64,
  "ja.consonant.geminate|ko.consonant.velar.plosive.fortis": 0.64,
  "ja.consonant.geminate|ko.consonant.alveolar.plosive.fortis": 0.64,
  "ja.consonant.geminate|ko.consonant.bilabial.plosive.fortis": 0.64,
  "ja.consonant.geminate|ko.consonant.alveolar.fricative.fortis": 0.62,
  "ja.consonant.geminate|ko.consonant.alveolopalatal.affricate.fortis": 0.62,
  "ja.consonant.palatal.approximant.voiced|ko.vowel.yeo": 0.62,
  "ja.consonant.palatal.approximant.voiced|ko.vowel.yo": 0.62,
  "ja.consonant.palatal.approximant.voiced|ko.vowel.yu": 0.62,
  "ja.consonant.labiovelar.approximant.voiced|ko.vowel.wo": 0.62,
}
export const searchPhonePairKey = (left: string, right: string): string => [left, right].sort().join("|")
