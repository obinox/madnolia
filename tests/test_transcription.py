from madnolia.transcription import _complete_audio_regions, _context_prompt, _speech_windows
from madnolia.types.common import AudioRegion, AudioRegionType, TranscriptWord


def test_audio_regions_cover_full_timeline() -> None:
    speech_regions = [
        AudioRegion(AudioRegionType.SPEECH, 100, 200),
        AudioRegion(AudioRegionType.SPEECH, 500, 600),
    ]
    regions = _complete_audio_regions(1000, speech_regions)
    assert regions == [
        AudioRegion(AudioRegionType.NON_SPEECH, 0, 100),
        AudioRegion(AudioRegionType.SPEECH, 100, 600),
        AudioRegion(AudioRegionType.NON_SPEECH, 600, 1000),
    ]


def test_short_speech_region_is_one_exact_window() -> None:
    region = AudioRegion(AudioRegionType.SPEECH, 1000, 6000)
    assert list(_speech_windows([region])) == [(1000, 6000, 1000, 6000)]


def test_long_speech_region_has_contiguous_ownership() -> None:
    region = AudioRegion(AudioRegionType.SPEECH, 1000, 61_000)
    assert list(_speech_windows([region])) == [
        (1000, 31_000, 1000, 28_500),
        (26_000, 56_000, 28_500, 53_500),
        (51_000, 61_000, 53_500, 61_000),
    ]


def test_context_prompt_is_cleared_after_long_gap() -> None:
    words = [TranscriptWord("이전", 1000, 1200, None)]
    assert _context_prompt(words, 2000) == "이전"
    assert _context_prompt(words, 20_000) == ""
