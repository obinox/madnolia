from dataclasses import replace

from madnolia.search import search_candidates
from madnolia.types.common import (
    AlignmentMethod,
    AlignmentStatus,
    AnalysisResult,
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
