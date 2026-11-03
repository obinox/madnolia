import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import test from "node:test"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try { return nextResolve(`${specifier}.ts`, context) } catch {}
    }
    return nextResolve(specifier, context)
  },
})

const { searchBrowserAnalyses, phoneSimilarity } = await import("../src/browser/search.ts")

function phone(id, phoneId, ipa, start) {
  return {
    occurrence_id: id,
    source_id: "source-1",
    sentence_index: 0,
    word_index: 0,
    grapheme: "hello",
    pronunciation: ipa,
    phone_id: phoneId,
    ipa,
    start_ms: start,
    end_ms: start + 80,
    confidence: 0.95,
    alignment_method: "CTC_FORCED",
    alignment_status: "ALIGNED",
  }
}

function record(phones) {
  return {
    summary: { analysis_id: "analysis-1" },
    source: { source_id: "source-1", path: "clip.wav" },
    phones,
    acoustic_features: phones.map((item) => ({
      occurrence_id: item.occurrence_id,
      rms_db: -10,
      peak_db: -3,
      f0_hz: 180,
      voiced_probability: 0.9,
      acoustic_unit_id: 1,
    })),
  }
}

test("search returns exact phrase fragments with absolute target indexes and acoustic F0", async () => {
  const source = record([
    phone("l-1", "en.consonant.alveolar.lateral", "l", 0),
    phone("o-1", "en.vowel.o", "o", 100),
    phone("u-1", "en.vowel.u", "ʊ", 200),
  ])
  const result = await searchBrowserAnalyses({
    text: "hello world",
    input_language: "EN",
    include_exact: true,
    include_approximate: false,
    max_candidates_per_start: 20,
  }, [source])
  const fragment = result.candidates.find((item) => item.match_status === "EXACT" && item.target_start_index === 2 && item.target_end_index === 5)
  assert.ok(fragment, "the L OW target fragment should be available for sentence assembly")
  assert.deepEqual(fragment.occurrence_ids, ["l-1", "o-1", "u-1"])
  assert.equal(fragment.alignments[0].source_f0_hz, 180)
  assert.equal(fragment.alignments[0].voiced_probability, 0.9)
  assert.equal(result.target_phones[2].exact_available, true)
  assert.equal(result.target_phones[3].exact_available, true)
  assert.equal(result.target_phones[0].exact_available, false)
})

test("an already-aborted search rejects with AbortError", async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(searchBrowserAnalyses({
    text: "hello",
    input_language: "EN",
    include_exact: true,
    include_approximate: true,
  }, [record([phone("hh-1", "en.consonant.glottal.fricative", "h", 0)])], undefined, controller.signal), { name: "AbortError" })
})

test("search phone similarities match pinned Japanese and Korean override and fallback pairs symmetrically", () => {
  assert.equal(phoneSimilarity("ja.vowel.u", "ko.vowel.eu"), 0.97)
  assert.equal(phoneSimilarity("ko.vowel.eu", "ja.vowel.u"), 0.97)
  assert.equal(phoneSimilarity("ja.consonant.geminate", "ko.consonant.velar.plosive.fortis"), 0.64)
  assert.equal(phoneSimilarity("ko.consonant.velar.plosive.fortis", "ja.consonant.geminate"), 0.64)
  assert.equal(phoneSimilarity("ja.consonant.geminate", "ko.consonant.velar.plosive.lenis"), 0.35)
})
