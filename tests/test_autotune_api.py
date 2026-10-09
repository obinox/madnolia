import pytest
from fastapi.testclient import TestClient

from madnolia import viewer
from madnolia.types.common import (
    AutotuneSegmentResult,
    PhoneAlignmentOperation,
    PhonePitchOwnerRef,
    PhonePitchPoint,
    PhoneUnit,
)


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(viewer, "_project_dir", lambda _project_id: tmp_path)
    return TestClient(viewer.app)


def _request(mode="PROFESSIONAL", strength=100, speed=50):
    return {
        "composition": {
            "name": "Draft",
            "target_text": "",
            "target_pronunciation": "",
            "crossfade_ms": 0,
            "mode": mode,
            "segments": [
                {
                    "segment_id": "segment",
                    "candidate_id": "candidate",
                    "target_start_index": 0,
                    "target_end_index": 1,
                    "source_id": "source",
                    "source_start_ms": 0,
                    "source_end_ms": 1000,
                    "timeline_start_ms": 0,
                    "timeline_end_ms": 1000,
                    "match_status": "EXACT",
                    "target_ipa": [],
                    "matched_ipa": [],
                    "edit_regions": [
                        {
                            "region_id": "region",
                            "source_start_ms": 0,
                            "source_end_ms": 1000,
                            "output_duration_ms": 1000,
                        }
                    ],
                }
            ],
        },
        "strength_percent": strength,
        "speed_ms": speed,
    }


@pytest.mark.parametrize(
    ("strength", "speed"),
    ((101, 50), (100, -1)),
)
def test_autotune_rejects_invalid_settings(client, strength, speed) -> None:
    response = client.post(
        "/api/projects/project/compositions/autotune",
        json=_request(strength=strength, speed=speed),
    )
    assert response.status_code == 400


def test_autotune_rejects_simple_and_legacy_segments(client) -> None:
    simple = client.post(
        "/api/projects/project/compositions/autotune",
        json=_request(mode="SIMPLE"),
    )
    assert simple.status_code == 400
    assert "professional" in simple.json()["detail"]

    legacy = _request()
    legacy["composition"]["segments"][0]["edit_regions"] = []
    response = client.post("/api/projects/project/compositions/autotune", json=legacy)
    assert response.status_code == 400


def test_autotune_returns_editable_phone_pitch_curves(client, monkeypatch) -> None:
    monkeypatch.setattr(viewer, "validate_preview_request", lambda *_args: None)
    unit = PhoneUnit(
        phone_unit_id="phone",
        operation=PhoneAlignmentOperation.MATCH,
        target_index=0,
        target_phone_id="ko.vowel.a",
        target_ipa="a",
        source_occurrence_id="phone",
        source_phone_id="ko.vowel.a",
        source_ipa="a",
        source_start_ms=0,
        source_end_ms=1000,
        output_duration_ms=1000,
        pitch_points=[PhonePitchPoint(0, 69), PhonePitchPoint(1, 69)],
        pitch_owner_ref=PhonePitchOwnerRef("segment", "phone"),
    )
    monkeypatch.setattr(
        viewer,
        "generate_autotune_envelopes",
        lambda *_args: [AutotuneSegmentResult(segment_id="segment", phone_units=[unit])],
    )
    response = client.post(
        "/api/projects/project/compositions/autotune",
        json=_request(speed=0),
    )
    assert response.status_code == 200
    result = response.json()["segments"][0]
    assert result["segment_id"] == "segment"
    assert result["pitch_envelope"] == []
    assert result["phone_units"][0]["pitch_points"] == [
        {"position": 0, "midi": 69},
        {"position": 1, "midi": 69},
    ]
    assert result["phone_units"][0]["pitch_owner_ref"] == {
        "segment_id": "segment",
        "phone_unit_id": "phone",
    }


def test_autotune_request_and_response_round_trip_region_curves(client, monkeypatch) -> None:
    monkeypatch.setattr(viewer, "validate_preview_request", lambda *_args: None)
    request = _request()
    request["composition"]["segments"][0]["edit_regions"][0]["pitch_points"] = [
        {"position": 0, "midi": 69},
        {"position": 1, "midi": 70},
    ]
    request["composition"]["segments"][0]["edit_regions"][0]["source_f0_hz"] = 440
    monkeypatch.setattr(
        viewer,
        "generate_autotune_envelopes",
        lambda _directory, segments, *_args: [
            AutotuneSegmentResult(segment_id="segment", phone_units=[], edit_regions=segments[0].edit_regions)
        ],
    )
    response = client.post("/api/projects/project/compositions/autotune", json=request)
    assert response.status_code == 200
    region = response.json()["segments"][0]["edit_regions"][0]
    assert region["source_f0_hz"] == 440
    assert region["pitch_points"] == [
        {"position": 0, "midi": 69},
        {"position": 1, "midi": 70},
    ]


def test_autotune_surfaces_source_validation_errors(client, monkeypatch) -> None:
    def reject_source(*_args) -> None:
        raise ValueError("Unknown source")

    monkeypatch.setattr(viewer, "validate_preview_request", reject_source)
    response = client.post(
        "/api/projects/project/compositions/autotune",
        json=_request(),
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "Unknown source"
