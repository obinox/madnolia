import json
import sqlite3
from pathlib import Path

from madnolia.types.common import (
    AlignmentMethod,
    AlignmentStatus,
    AnalysisResult,
    AudioRegion,
    AudioRegionType,
    MediaSource,
    PhoneAcousticFeatures,
    PhoneOccurrence,
    ProjectManifest,
    TranscriptCandidate,
    TranscriptSentence,
    TranscriptWord,
)


def initialize_database(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS media_sources (
            source_id TEXT PRIMARY KEY,
            path TEXT NOT NULL,
            duration_ms INTEGER NOT NULL,
            metadata_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS phone_occurrences (
            occurrence_id TEXT PRIMARY KEY,
            source_id TEXT NOT NULL,
            word_index INTEGER NOT NULL,
            grapheme TEXT NOT NULL,
            pronunciation TEXT NOT NULL,
            phone_id TEXT NOT NULL,
            ipa TEXT NOT NULL,
            start_ms INTEGER NOT NULL,
            end_ms INTEGER NOT NULL,
            confidence REAL,
            alignment_method TEXT NOT NULL,
            sentence_index INTEGER NOT NULL DEFAULT -1,
            alignment_status TEXT NOT NULL DEFAULT 'ESTIMATED',
            FOREIGN KEY(source_id) REFERENCES media_sources(source_id)
        );
        CREATE INDEX IF NOT EXISTS idx_phone_occurrences_phone_id
        ON phone_occurrences(phone_id);
        CREATE INDEX IF NOT EXISTS idx_phone_occurrences_ipa
        ON phone_occurrences(ipa);
        CREATE TABLE IF NOT EXISTS audio_regions (
            source_id TEXT NOT NULL,
            region_index INTEGER NOT NULL,
            region_type TEXT NOT NULL,
            start_ms INTEGER NOT NULL,
            end_ms INTEGER NOT NULL,
            PRIMARY KEY(source_id, region_index),
            FOREIGN KEY(source_id) REFERENCES media_sources(source_id)
        );
        CREATE TABLE IF NOT EXISTS phone_acoustic_features (
            occurrence_id TEXT PRIMARY KEY,
            rms_db REAL NOT NULL,
            peak_db REAL NOT NULL,
            f0_hz REAL,
            voiced_probability REAL NOT NULL,
            acoustic_unit_id INTEGER,
            FOREIGN KEY(occurrence_id) REFERENCES phone_occurrences(occurrence_id)
        );
        """
    )
    _migrate_nullable_confidence(connection)
    _migrate_phone_columns(connection)
    return connection


def _migrate_nullable_confidence(connection: sqlite3.Connection) -> None:
    columns = connection.execute("PRAGMA table_info(phone_occurrences)").fetchall()
    confidence_column = next((column for column in columns if column[1] == "confidence"), None)
    if confidence_column is None or confidence_column[3] == 0:
        return
    connection.executescript(
        """
        DROP INDEX IF EXISTS idx_phone_occurrences_phone_id;
        DROP INDEX IF EXISTS idx_phone_occurrences_ipa;
        ALTER TABLE phone_occurrences RENAME TO phone_occurrences_legacy;
        CREATE TABLE phone_occurrences (
            occurrence_id TEXT PRIMARY KEY,
            source_id TEXT NOT NULL,
            word_index INTEGER NOT NULL,
            grapheme TEXT NOT NULL,
            pronunciation TEXT NOT NULL,
            phone_id TEXT NOT NULL,
            ipa TEXT NOT NULL,
            start_ms INTEGER NOT NULL,
            end_ms INTEGER NOT NULL,
            confidence REAL,
            alignment_method TEXT NOT NULL,
            FOREIGN KEY(source_id) REFERENCES media_sources(source_id)
        );
        INSERT INTO phone_occurrences SELECT * FROM phone_occurrences_legacy;
        DROP TABLE phone_occurrences_legacy;
        CREATE INDEX idx_phone_occurrences_phone_id ON phone_occurrences(phone_id);
        CREATE INDEX idx_phone_occurrences_ipa ON phone_occurrences(ipa);
        """
    )
    connection.commit()


def _migrate_phone_columns(connection: sqlite3.Connection) -> None:
    columns = {column[1] for column in connection.execute("PRAGMA table_info(phone_occurrences)")}
    if "sentence_index" not in columns:
        connection.execute(
            "ALTER TABLE phone_occurrences ADD COLUMN sentence_index INTEGER NOT NULL DEFAULT -1"
        )
    if "alignment_status" not in columns:
        connection.execute(
            "ALTER TABLE phone_occurrences ADD COLUMN alignment_status TEXT NOT NULL DEFAULT 'ESTIMATED'"
        )
    connection.commit()


def save_analysis(connection: sqlite3.Connection, result: AnalysisResult) -> None:
    source = result.source
    connection.execute(
        "INSERT OR REPLACE INTO media_sources VALUES (?, ?, ?, ?)",
        (source.source_id, source.path, source.duration_ms, json.dumps(result.to_dict()["source"], ensure_ascii=False)),
    )
    previous_occurrences = connection.execute(
        "SELECT occurrence_id FROM phone_occurrences WHERE source_id = ?",
        (source.source_id,),
    ).fetchall()
    if previous_occurrences:
        connection.executemany(
            "DELETE FROM phone_acoustic_features WHERE occurrence_id = ?",
            previous_occurrences,
        )
    connection.execute("DELETE FROM phone_occurrences WHERE source_id = ?", (source.source_id,))
    connection.executemany(
        """
        INSERT OR REPLACE INTO phone_occurrences VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                phone.occurrence_id,
                phone.source_id,
                phone.word_index,
                phone.grapheme,
                phone.pronunciation,
                phone.phone_id,
                phone.ipa,
                phone.start_ms,
                phone.end_ms,
                phone.confidence,
                phone.alignment_method.value,
                phone.sentence_index,
                phone.alignment_status.value,
            )
            for phone in result.phones
        ],
    )
    connection.execute("DELETE FROM audio_regions WHERE source_id = ?", (source.source_id,))
    connection.executemany(
        "INSERT INTO audio_regions VALUES (?, ?, ?, ?, ?)",
        [
            (
                source.source_id,
                region_index,
                region.region_type.value,
                region.start_ms,
                region.end_ms,
            )
            for region_index, region in enumerate(result.audio_regions)
        ],
    )
    occurrence_ids = [phone.occurrence_id for phone in result.phones]
    if occurrence_ids:
        connection.executemany(
            "DELETE FROM phone_acoustic_features WHERE occurrence_id = ?",
            [(occurrence_id,) for occurrence_id in occurrence_ids],
        )
    connection.executemany(
        "INSERT OR REPLACE INTO phone_acoustic_features VALUES (?, ?, ?, ?, ?, ?)",
        [
            (
                feature.occurrence_id,
                feature.rms_db,
                feature.peak_db,
                feature.f0_hz,
                feature.voiced_probability,
                feature.acoustic_unit_id,
            )
            for feature in result.acoustic_features
        ],
    )
    connection.commit()


def write_json(path: Path, data: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def save_project(path: Path, project: ProjectManifest) -> None:
    write_json(path, project.to_dict())


def load_analysis(path: Path) -> AnalysisResult:
    data = json.loads(path.read_text(encoding="utf-8"))
    return AnalysisResult(
        source=MediaSource(**data["source"]),
        transcript=data["transcript"],
        language=data["language"],
        language_probability=data["language_probability"],
        audio_regions=[
            AudioRegion(
                region_type=AudioRegionType(region["region_type"]),
                start_ms=region["start_ms"],
                end_ms=region["end_ms"],
            )
            for region in data.get("audio_regions", [])
        ],
        sentences=[TranscriptSentence(**sentence) for sentence in data.get("sentences", [])],
        words=[TranscriptWord(**word) for word in data["words"]],
        phones=[
            PhoneOccurrence(
                **{
                    **phone,
                    "sentence_index": phone.get("sentence_index", -1),
                    "alignment_method": AlignmentMethod(phone["alignment_method"]),
                    "alignment_status": AlignmentStatus(
                        phone.get("alignment_status", AlignmentStatus.ESTIMATED)
                    ),
                }
            )
            for phone in data["phones"]
        ],
        acoustic_features=[
            PhoneAcousticFeatures(**feature)
            for feature in data.get("acoustic_features", [])
        ],
        transcript_candidates=[
            TranscriptCandidate(
                candidate_id=candidate["candidate_id"],
                model_name=candidate["model_name"],
                transcript=candidate["transcript"],
                language_probability=candidate.get("language_probability"),
                words=[TranscriptWord(**word) for word in candidate["words"]],
                sentences=[
                    TranscriptSentence(**sentence)
                    for sentence in candidate.get("sentences", [])
                ],
            )
            for candidate in data.get("transcript_candidates", [])
        ],
    )
