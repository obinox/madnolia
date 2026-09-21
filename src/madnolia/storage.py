import json
import sqlite3
from pathlib import Path

from madnolia.types.common import (
    AlignmentMethod,
    AnalysisResult,
    AudioRegion,
    AudioRegionType,
    MediaSource,
    PhoneOccurrence,
    ProjectManifest,
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
        """
    )
    _migrate_nullable_confidence(connection)
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


def save_analysis(connection: sqlite3.Connection, result: AnalysisResult) -> None:
    source = result.source
    connection.execute(
        "INSERT OR REPLACE INTO media_sources VALUES (?, ?, ?, ?)",
        (source.source_id, source.path, source.duration_ms, json.dumps(result.to_dict()["source"], ensure_ascii=False)),
    )
    connection.executemany(
        """
        INSERT OR REPLACE INTO phone_occurrences VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        words=[TranscriptWord(**word) for word in data["words"]],
        phones=[
            PhoneOccurrence(
                **{
                    **phone,
                    "alignment_method": AlignmentMethod(phone["alignment_method"]),
                }
            )
            for phone in data["phones"]
        ],
    )
