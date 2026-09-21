from madnolia.transcription import _complete_audio_regions
from madnolia.types.common import AudioRegion, AudioRegionType


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
