from madnolia.storage import initialize_database, save_analysis
from madnolia.types.common import (
    AlignmentMethod,
    AnalysisResult,
    MediaSource,
    PhoneOccurrence,
)


def test_openvino_phone_without_confidence_is_stored(tmp_path) -> None:
    source = MediaSource(
        source_id="source",
        path="video.mp4",
        duration_ms=1000,
        audio_sample_rate=44100,
        audio_channels=2,
        video_width=1920,
        video_height=1080,
        video_fps=60.0,
    )
    phone = PhoneOccurrence(
        occurrence_id="phone",
        source_id="source",
        word_index=0,
        grapheme="안",
        pronunciation="안",
        phone_id="ko.vowel.a",
        ipa="a",
        start_ms=0,
        end_ms=100,
        confidence=None,
        alignment_method=AlignmentMethod.ESTIMATED_WORD,
    )
    result = AnalysisResult(
        source=source,
        transcript="안",
        language="ko",
        language_probability=None,
        audio_regions=[],
        words=[],
        phones=[phone],
    )
    connection = initialize_database(tmp_path / "corpus.sqlite3")
    try:
        save_analysis(connection, result)
        stored = connection.execute(
            "SELECT confidence FROM phone_occurrences WHERE occurrence_id = ?",
            (phone.occurrence_id,),
        ).fetchone()
    finally:
        connection.close()
    assert stored == (None,)
