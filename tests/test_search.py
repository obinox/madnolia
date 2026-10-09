from dataclasses import replace

from madnolia.constants import (
    JAPANESE_GEMINATE,
    JAPANESE_MORAIC_NASAL,
    JAPANESE_MORAIC_NASAL_VELAR,
    JAPANESE_ONSETS,
    JAPANESE_VOWELS,
    SEARCH_PHONE_FALLBACK_SIMILARITIES,
    SEARCH_PHONE_SIMILARITY_OVERRIDES,
)
from madnolia.search import search_candidates
from madnolia.types.common import (
    AlignmentMethod,
    AlignmentStatus,
    AnalysisResult,
    AudioRegion,
    AudioRegionType,
    InputLanguage,
    MatchStatus,
    MediaSource,
    PhoneAcousticFeatures,
    PhoneOccurrence,
    SearchCancelled,
)


def test_search_returns_overlapping_exact_spans() -> None:
    result = search_candidates("가", [_analysis([_phone("k", 0), _phone("a", 40)])])
    ranges = {
        (candidate.target_start_index, candidate.target_end_index)
        for candidate in result.candidates
    }
    assert (0, 1) in ranges
    assert (0, 2) in ranges
    assert any(candidate.match_status == MatchStatus.EXACT for candidate in result.candidates)
    assert all(candidate.alignments for candidate in result.candidates)


def test_selected_consonant_tail_stops_before_next_phone_with_margin() -> None:
    consonant = replace(_phone("k", 0), end_ms=20)
    vowel = _phone("a", 100)
    analysis = _analysis([consonant, vowel])

    result = search_candidates("가", [analysis], include_approximate=False)
    candidate = next(item for item in result.candidates if item.occurrence_ids == [consonant.occurrence_id])

    assert candidate.source_end_ms == 90
    assert candidate.alignments[0].source_end_ms == 90
    assert analysis.phones == [consonant, vowel]


def test_selected_vowel_tail_stops_at_analyzed_silence_before_next_phone() -> None:
    phones = [_phone("k", 0), replace(_phone("a", 40), end_ms=60), _phone("n", 200, "ko.consonant.alveolar.nasal")]
    analysis = replace(
        _analysis(phones),
        audio_regions=[
            AudioRegion(AudioRegionType.SPEECH, 0, 80),
            AudioRegion(AudioRegionType.NON_SPEECH, 80, 140),
            AudioRegion(AudioRegionType.SPEECH, 140, 1000),
        ],
    )

    result = search_candidates("가", [analysis], include_approximate=False)
    candidate = next(item for item in result.candidates if item.occurrence_ids == [phones[0].occurrence_id, phones[1].occurrence_id])

    assert candidate.source_end_ms == 80
    assert candidate.alignments[0].source_end_ms == phones[0].end_ms
    assert candidate.alignments[1].source_end_ms == 80
    assert analysis.phones[-1].end_ms == 240


def test_tail_uses_speech_end_without_next_phone_and_eof_is_a_ceiling() -> None:
    vowel = _phone("a", 100)
    speech_ended = replace(
        _analysis([vowel]),
        audio_regions=[AudioRegion(AudioRegionType.SPEECH, 0, 500)],
    )
    result = search_candidates("아", [speech_ended], include_approximate=False)
    candidate = next(item for item in result.candidates if item.occurrence_ids == [vowel.occurrence_id])
    assert candidate.source_end_ms == 500

    eof_capped = replace(
        speech_ended,
        audio_regions=[AudioRegion(AudioRegionType.SPEECH, 0, 1200)],
    )
    eof_result = search_candidates("아", [eof_capped], include_approximate=False)
    eof_candidate = next(item for item in eof_result.candidates if item.occurrence_ids == [vowel.occurrence_id])
    assert eof_candidate.source_end_ms == eof_capped.source.duration_ms


def test_tail_preserves_original_end_for_overlapping_or_too_close_next_phone() -> None:
    for next_start in (35, 45):
        consonant = replace(_phone("k", 0), end_ms=40)
        vowel = _phone("a", next_start)
        result = search_candidates(
            "가",
            [_analysis([consonant, vowel])],
            include_approximate=False,
        )
        candidate = next(item for item in result.candidates if item.occurrence_ids == [consonant.occurrence_id])
        assert candidate.source_end_ms == consonant.end_ms
        assert candidate.alignments[0].source_end_ms == consonant.end_ms


def test_tail_does_not_cross_containing_non_speech_or_invent_eof_boundary() -> None:
    vowel = _phone("a", 100)
    analysis = replace(
        _analysis([vowel]),
        audio_regions=[
            AudioRegion(AudioRegionType.SPEECH, 0, 100),
            AudioRegion(AudioRegionType.NON_SPEECH, 100, 200),
            AudioRegion(AudioRegionType.SPEECH, 200, 1000),
        ],
    )
    result = search_candidates("아", [analysis], include_approximate=False)
    candidate = next(item for item in result.candidates if item.occurrence_ids == [vowel.occurrence_id])

    no_boundary = search_candidates("아", [_analysis([vowel])], include_approximate=False)
    conservative = next(item for item in no_boundary.candidates if item.occurrence_ids == [vowel.occurrence_id])
    assert candidate.source_end_ms == vowel.end_ms
    assert conservative.source_end_ms == vowel.end_ms


def test_tail_preserves_original_end_when_speech_boundary_precedes_it() -> None:
    vowel = _phone("a", 100)
    analysis = replace(
        _analysis([vowel]),
        audio_regions=[
            AudioRegion(AudioRegionType.SPEECH, 0, 120),
            AudioRegion(AudioRegionType.NON_SPEECH, 120, 200),
        ],
    )
    result = search_candidates("아", [analysis])
    candidate = next(item for item in result.candidates if item.occurrence_ids == [vowel.occurrence_id])
    assert candidate.source_end_ms == vowel.end_ms


def test_tail_boundary_lookup_stays_with_its_source() -> None:
    candidates = []
    for source_id, next_start in (("first", 100), ("second", 200)):
        consonant = replace(
            _phone("k", 0), occurrence_id="shared-k", source_id=source_id, end_ms=20
        )
        vowel = replace(_phone("a", next_start), source_id=source_id)
        analysis = replace(
            _analysis([consonant, vowel]),
            source=MediaSource(source_id, f"{source_id}.mp4", 1000, 16000, 1, 1920, 1080, 30),
        )
        result = search_candidates("가", [analysis], include_approximate=False)
        candidates.extend(
            candidate
            for candidate in result.candidates
            if candidate.occurrence_ids == [consonant.occurrence_id]
        )

    assert {candidate.source_id: candidate.source_end_ms for candidate in candidates} == {
        "first": 90,
        "second": 190,
    }


def test_approximate_fallback_candidate_tail_alignment_is_extended() -> None:
    phone = _phone("p", 0, "ko.consonant.bilabial.plosive.lenis")
    analysis = replace(
        _analysis([phone]),
        audio_regions=[AudioRegion(AudioRegionType.SPEECH, 0, 400)],
    )
    result = search_candidates(
        "ヴ",
        [replace(
            analysis,
            phones=[phone, replace(_phone("\u026f", 40, "ko.vowel.eu"), occurrence_id="vowel")],
        )],
        input_language=InputLanguage.JA,
        include_exact=False,
    )
    fallback = next(candidate for candidate in result.candidates if candidate.fallback)
    assert fallback.source_end_ms == 400
    assert next(
        alignment
        for alignment in fallback.alignments
        if alignment.source_occurrence_id == fallback.occurrence_ids[-1]
    ).source_end_ms == 400


def test_exact_search_balances_long_and_short_spans_within_limit() -> None:
    result = search_candidates(
        "가",
        [_analysis([
            _phone("k", 0),
            _phone("a", 40),
            _phone("k", 80),
            _phone("a", 120),
        ])],
        max_candidates_per_start=2,
        include_approximate=False,
    )

    ranges = {
        (candidate.target_start_index, candidate.target_end_index)
        for candidate in result.candidates
        if candidate.target_start_index == 0
    }
    assert ranges == {(0, 1), (0, 2)}


def test_search_reports_stages_and_supports_cancellation() -> None:
    stages: list[str] = []
    search_candidates(
        "가",
        [_analysis([_phone("k", 0), _phone("a", 40)])],
        progress_callback=lambda stage, percent: stages.append(stage),
    )
    assert stages[0] == "phonetic"
    assert {"exact", "approximate", "sorting"}.issubset(stages)
    assert stages[-1] == "sorting"

    def cancel() -> None:
        raise SearchCancelled()

    try:
        search_candidates("가", [], checkpoint=cancel)
    except SearchCancelled:
        pass
    else:
        raise AssertionError("search checkpoint did not cancel the search")


def test_search_marks_absent_phone_and_offers_approximation() -> None:
    result = search_candidates(
        "가",
        [_analysis([_phone("n", 0, "ko.consonant.alveolar.nasal"), _phone("a", 40)])],
    )
    assert result.target_phones[0].exact_available is False
    approximate = [
        candidate
        for candidate in result.candidates
        if candidate.target_start_index == 0
    ]
    assert approximate
    assert approximate[0].match_status == MatchStatus.APPROXIMATE


def test_approximate_candidates_are_additive_to_exact_search() -> None:
    exact_analysis = _analysis([_phone("k", 0), _phone("a", 40)])
    similar_phone = replace(
        _phone("p", 0, "ko.consonant.bilabial.plosive.lenis"),
        source_id="similar_source",
        occurrence_id="similar_phone",
    )
    similar_analysis = replace(
        _analysis([similar_phone]),
        source=MediaSource("similar_source", "similar.mp4", 1000, 16000, 1, 1920, 1080, 30),
    )

    exact_only = search_candidates("가", [exact_analysis])
    combined = search_candidates("가", [exact_analysis, similar_analysis])

    exact_ids = {
        candidate.candidate_id
        for candidate in combined.candidates
        if candidate.match_status == MatchStatus.EXACT
    }
    assert exact_ids == {
        candidate.candidate_id
        for candidate in exact_only.candidates
        if candidate.match_status == MatchStatus.EXACT
    }
    assert any(
        candidate.match_status == MatchStatus.APPROXIMATE
        for candidate in combined.candidates
    )


def test_approximate_results_respect_requested_per_start_limit() -> None:
    phones = [
        _phone("p", index * 50, "ko.consonant.bilabial.plosive.lenis")
        for index in range(40)
    ]
    result = search_candidates("가", [_analysis(phones)], max_candidates_per_start=1)

    approximate_counts: dict[int, int] = {}
    for candidate in result.candidates:
        if candidate.match_status == MatchStatus.APPROXIMATE:
            approximate_counts[candidate.target_start_index] = (
                approximate_counts.get(candidate.target_start_index, 0) + 1
            )

    assert approximate_counts
    assert all(count <= 1 for count in approximate_counts.values())


def test_exact_search_can_skip_approximate_candidates() -> None:
    result = search_candidates(
        "가",
        [_analysis([
            _phone("k", 0),
            _phone("a", 40),
            _phone("p", 80, "ko.consonant.bilabial.plosive.lenis"),
        ])],
        include_approximate=False,
    )

    assert result.candidates
    assert all(candidate.match_status == MatchStatus.EXACT for candidate in result.candidates)


def test_approximate_search_can_skip_exact_candidates() -> None:
    result = search_candidates(
        "가",
        [_analysis([
            _phone("k", 0),
            _phone("a", 40),
            _phone("p", 80, "ko.consonant.bilabial.plosive.lenis"),
        ])],
        include_exact=False,
    )

    assert result.candidates
    assert all(candidate.match_status == MatchStatus.APPROXIMATE for candidate in result.candidates)


def test_search_aligns_inserted_and_deleted_phones() -> None:
    inserted = search_candidates(
        "가",
        [_analysis([
            _phone("k", 0),
            _phone("n", 40, "ko.consonant.alveolar.nasal"),
            _phone("a", 80),
        ])],
        max_candidates_per_start=20,
    )
    deleted = search_candidates(
        "가",
        [_analysis([_phone("k", 0)])],
        max_candidates_per_start=20,
    )

    assert any(
        alignment.operation == "INSERT"
        for candidate in inserted.candidates
        for alignment in candidate.alignments
    )
    assert any(
        alignment.operation == "DELETE"
        for candidate in deleted.candidates
        for alignment in candidate.alignments
    )


def test_search_includes_source_pitch_in_alignment() -> None:
    phone = _phone("a", 0)
    analysis = replace(
        _analysis([phone]),
        acoustic_features=[
            PhoneAcousticFeatures(
                occurrence_id=phone.occurrence_id,
                rms_db=-12.0,
                peak_db=-3.0,
                f0_hz=220.0,
                voiced_probability=0.9,
                acoustic_unit_id=None,
            )
        ],
    )

    result = search_candidates("아", [analysis])
    alignment = next(
        item
        for candidate in result.candidates
        for item in candidate.alignments
        if item.source_occurrence_id == phone.occurrence_id
    )

    assert alignment.source_f0_hz == 220.0
    assert alignment.voiced_probability == 0.9


def test_english_phones_can_match_similar_korean_phones() -> None:
    result = search_candidates(
        "be",
        [_analysis([
            _phone("p", 0, "ko.consonant.bilabial.plosive.lenis"),
            _phone("i", 40, "ko.vowel.i"),
        ])],
        max_candidates_per_start=20,
        input_language=InputLanguage.EN,
    )

    assert result.input_language == InputLanguage.EN
    assert result.target_phones[0].exact_available is False
    assert any(candidate.match_status == MatchStatus.APPROXIMATE for candidate in result.candidates)


def test_japanese_vowels_can_match_korean_vowels() -> None:
    result = search_candidates(
        "あ",
        [_analysis([_phone("a", 0, "ko.vowel.a")])],
        input_language=InputLanguage.JA,
    )

    assert result.input_language == InputLanguage.JA
    assert result.target_phones[0].ipa == "a"
    assert result.candidates


def test_japanese_ipa_match_is_exact_across_language_ids() -> None:
    result = search_candidates(
        "か",
        [_analysis([
            _phone("k", 0, "ko.consonant.velar.plosive.lenis"),
            _phone("a", 40, "ko.vowel.a"),
        ])],
        input_language=InputLanguage.JA,
    )

    assert all(phone.exact_available for phone in result.target_phones)
    assert any(candidate.match_status == MatchStatus.EXACT for candidate in result.candidates)


def test_voiced_g_and_d_find_korean_lenis_candidates() -> None:
    result = search_candidates(
        "good",
        [_analysis([
            _phone("k", 0, "ko.consonant.velar.plosive.lenis"),
            _phone("t", 40, "ko.consonant.alveolar.plosive.lenis"),
        ])],
        input_language=InputLanguage.EN,
        include_exact=False,
    )

    similarities = [
        alignment.similarity
        for candidate in result.candidates
        for alignment in candidate.alignments
        if alignment.target_ipa in {"ɡ", "d"}
    ]
    assert similarities
    assert max(similarities) >= 0.9


def test_japanese_moraic_nasal_finds_korean_nasal_candidates() -> None:
    result = search_candidates(
        "ん",
        [_analysis([
            _phone("n", 0, "ko.consonant.alveolar.nasal"),
            _phone("ŋ", 40, "ko.coda.velar.nasal"),
            _phone("m", 80, "ko.coda.bilabial.nasal"),
        ])],
        input_language=InputLanguage.JA,
        include_exact=False,
    )

    assert result.candidates
    assert max(candidate.similarity for candidate in result.candidates) >= 0.9


def test_japanese_special_sounds_use_primary_korean_pronunciation_rules() -> None:
    cases = [
        ("し", "ɕ", "ko.consonant.alveolopalatal.fricative.lenis", "i", "ko.vowel.i"),
        ("つ", "tɕʰ", "ko.consonant.alveolopalatal.affricate.aspirated", "ɯ", "ko.vowel.eu"),
        ("ふ", "h", "ko.consonant.glottal.fricative", "u", "ko.vowel.u"),
        ("ら", "ɾ", "ko.consonant.alveolar.tap", "a", "ko.vowel.a"),
    ]

    for text, consonant_ipa, consonant_id, vowel_ipa, vowel_id in cases:
        result = search_candidates(
            text,
            [_analysis([
                _phone(consonant_ipa, 0, consonant_id),
                _phone(vowel_ipa, 40, vowel_id),
            ])],
            input_language=InputLanguage.JA,
            include_exact=False,
        )
        assert any(not candidate.fallback for candidate in result.candidates), text


def test_japanese_missing_sound_uses_labeled_fallback_candidate() -> None:
    result = search_candidates(
        "ヴ",
        [_analysis([
            _phone("p", 0, "ko.consonant.bilabial.plosive.lenis"),
            _phone("ɯ", 40, "ko.vowel.eu"),
        ])],
        input_language=InputLanguage.JA,
        include_exact=False,
    )

    first_phone_candidates = [
        candidate for candidate in result.candidates if candidate.target_start_index == 0
    ]
    assert first_phone_candidates
    assert all(candidate.fallback for candidate in first_phone_candidates)


def test_every_japanese_phone_has_an_explicit_korean_search_rule() -> None:
    mapped_ids = {
        phone_id
        for pair in (
            *SEARCH_PHONE_SIMILARITY_OVERRIDES,
            *SEARCH_PHONE_FALLBACK_SIMILARITIES,
        )
        for phone_id in pair
    }
    japanese_ids = {
        phone_id for phone_id, _ in (
            *JAPANESE_VOWELS.values(),
            *JAPANESE_ONSETS.values(),
            JAPANESE_MORAIC_NASAL,
            JAPANESE_MORAIC_NASAL_VELAR,
            JAPANESE_GEMINATE,
        )
    }

    assert japanese_ids <= mapped_ids


def test_common_voicing_pairs_have_strong_korean_substitutions() -> None:
    cases = (
        ("en.consonant.velar.plosive.voiced", "ko.consonant.velar.plosive.lenis"),
        ("en.consonant.velar.plosive.voiceless", "ko.consonant.velar.plosive.lenis"),
        ("en.consonant.alveolar.plosive.voiced", "ko.consonant.alveolar.plosive.lenis"),
        ("en.consonant.alveolar.plosive.voiceless", "ko.consonant.alveolar.plosive.lenis"),
        ("en.consonant.bilabial.plosive.voiced", "ko.consonant.bilabial.plosive.lenis"),
        ("en.consonant.bilabial.plosive.voiceless", "ko.consonant.bilabial.plosive.lenis"),
        ("en.consonant.alveolar.fricative.voiced", "ko.consonant.alveolar.fricative.lenis"),
        ("en.consonant.alveolar.fricative.voiceless", "ko.consonant.alveolar.fricative.lenis"),
    )

    assert all(
        SEARCH_PHONE_SIMILARITY_OVERRIDES[frozenset(pair)] >= 0.9
        for pair in cases
    )


def _phone(ipa: str, start_ms: int, phone_id: str | None = None) -> PhoneOccurrence:
    return PhoneOccurrence(
        occurrence_id=f"phone_{ipa}_{start_ms}",
        source_id="source",
        sentence_index=0,
        word_index=0,
        grapheme="가",
        pronunciation="가",
        phone_id=phone_id or (
            "ko.vowel.a" if ipa == "a" else "ko.consonant.velar.plosive.lenis"
        ),
        ipa=ipa,
        start_ms=start_ms,
        end_ms=start_ms + 40,
        confidence=0.9,
        alignment_method=AlignmentMethod.CTC_FORCED,
        alignment_status=AlignmentStatus.ALIGNED,
    )


def _analysis(phones: list[PhoneOccurrence]) -> AnalysisResult:
    return AnalysisResult(
        source=MediaSource("source", "video.mp4", 1000, 16000, 1, 1920, 1080, 30),
        transcript="가",
        language="ko",
        language_probability=1.0,
        audio_regions=[],
        sentences=[],
        words=[],
        phones=phones,
        acoustic_features=[],
        transcript_candidates=[],
    )
