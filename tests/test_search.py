from madnolia.search import search_candidates
from madnolia.types.common import (
    AlignmentMethod,
    AlignmentStatus,
    AnalysisResult,
    MatchStatus,
    MediaSource,
    PhoneOccurrence,
)


def test_search_returns_overlapping_exact_spans() -> None:
    result = search_candidates("가", [_analysis([_phone("k", 0), _phone("a", 40)])])
    ranges = {
        (candidate.target_start_index, candidate.target_end_index)
        for candidate in result.candidates
    }
    assert (0, 1) in ranges
    assert (0, 2) in ranges
    assert all(candidate.match_status == MatchStatus.EXACT for candidate in result.candidates)


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
