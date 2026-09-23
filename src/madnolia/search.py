from collections import defaultdict
from hashlib import sha1

from madnolia.constants import SEARCH_MAX_CANDIDATES_PER_TARGET_START, SEARCH_MAX_JOIN_GAP_MS
from madnolia.phonetics import KoreanPhonetics
from madnolia.types.common import (
    AlignmentStatus,
    AnalysisResult,
    CandidateSearchResult,
    MatchStatus,
    PhoneOccurrence,
    QueryPhone,
    UnitCandidate,
    UnitType,
)


def search_candidates(
    text: str,
    analyses: list[AnalysisResult],
    max_candidates_per_start: int = 8,
) -> CandidateSearchResult:
    normalized = text.strip()
    if not normalized:
        raise ValueError("검색할 문장이 비어 있습니다.")
    if not 1 <= max_candidates_per_start <= 50:
        raise ValueError("max_candidates_per_start는 1 이상 50 이하여야 합니다.")
    phonetics = KoreanPhonetics()
    pronunciation = phonetics.pronounce(normalized)
    raw_targets = phonetics.to_phones(pronunciation)
    if not raw_targets:
        raise ValueError("입력 문장에서 한국어 음소를 만들 수 없습니다.")
    sources = {
        analysis.source.source_id: sorted(analysis.phones, key=lambda phone: phone.start_ms)
        for analysis in analyses
    }
    all_phones = [phone for phones in sources.values() for phone in phones]
    exact_ids = {phone.phone_id for phone in all_phones}
    targets = [
        QueryPhone(
            target_index=index,
            grapheme=grapheme,
            phone_id=phone_id,
            ipa=ipa,
            exact_available=phone_id in exact_ids,
        )
        for index, (phone_id, ipa, grapheme) in enumerate(raw_targets)
    ]
    candidates = _exact_candidates(targets, sources, max_candidates_per_start)
    covered_starts = {candidate.target_start_index for candidate in candidates}
    for target in targets:
        if target.exact_available or target.target_index in covered_starts:
            continue
        candidates.extend(_approximate_candidates(target, all_phones, max_candidates_per_start))
    candidates.sort(
        key=lambda candidate: (
            candidate.target_start_index,
            -(candidate.target_end_index - candidate.target_start_index),
            -candidate.score,
            candidate.source_start_ms,
        )
    )
    selected: list[UnitCandidate] = []
    counts: dict[int, int] = defaultdict(int)
    for candidate in candidates:
        start = candidate.target_start_index
        if counts[start] >= SEARCH_MAX_CANDIDATES_PER_TARGET_START:
            continue
        selected.append(candidate)
        counts[start] += 1
    return CandidateSearchResult(
        target_text=normalized,
        target_pronunciation=pronunciation,
        target_phones=targets,
        candidates=selected,
    )


def _exact_candidates(
    targets: list[QueryPhone],
    sources: dict[str, list[PhoneOccurrence]],
    limit: int,
) -> list[UnitCandidate]:
    grouped: dict[tuple[int, int], list[UnitCandidate]] = defaultdict(list)
    for source_id, phones in sources.items():
        for source_start, first in enumerate(phones):
            for target_start, target in enumerate(targets):
                if first.phone_id != target.phone_id:
                    continue
                matched: list[PhoneOccurrence] = []
                source_index = source_start
                target_index = target_start
                while source_index < len(phones) and target_index < len(targets):
                    phone = phones[source_index]
                    if phone.phone_id != targets[target_index].phone_id:
                        break
                    if matched and phone.start_ms - matched[-1].end_ms > SEARCH_MAX_JOIN_GAP_MS:
                        break
                    matched.append(phone)
                    grouped[(target_start, target_index + 1)].append(
                        _candidate(
                            targets[target_start:target_index + 1],
                            matched,
                            source_id,
                            MatchStatus.EXACT,
                            1.0,
                        )
                    )
                    source_index += 1
                    target_index += 1
    result: list[UnitCandidate] = []
    for items in grouped.values():
        items.sort(key=lambda candidate: (-candidate.score, candidate.source_start_ms))
        result.extend(items[:limit])
    return result


def _approximate_candidates(
    target: QueryPhone,
    phones: list[PhoneOccurrence],
    limit: int,
) -> list[UnitCandidate]:
    ranked = sorted(
        (
            (_phone_similarity(target.phone_id, phone.phone_id), phone)
            for phone in phones
            if phone.alignment_status != AlignmentStatus.MISSING
        ),
        key=lambda item: (-item[0], -(item[1].confidence or 0.0), item[1].start_ms),
    )
    return [
        _candidate([target], [phone], phone.source_id, MatchStatus.APPROXIMATE, similarity)
        for similarity, phone in ranked[:limit]
        if similarity > 0
    ]


def _phone_similarity(target_id: str, candidate_id: str) -> float:
    if target_id == candidate_id:
        return 1.0
    target = target_id.split(".")
    candidate = candidate_id.split(".")
    if len(target) < 3 or len(candidate) < 3 or target[1] != candidate[1]:
        return 0.0
    shared = len(set(target[2:]) & set(candidate[2:]))
    denominator = max(len(set(target[2:])), len(set(candidate[2:])), 1)
    return 0.35 + 0.55 * shared / denominator


def _candidate(
    targets: list[QueryPhone],
    phones: list[PhoneOccurrence],
    source_id: str,
    status: MatchStatus,
    similarity: float,
) -> UnitCandidate:
    occurrence_ids = [phone.occurrence_id for phone in phones]
    target_start = targets[0].target_index
    target_end = targets[-1].target_index + 1
    digest = sha1(
        f"{target_start}:{target_end}:{':'.join(occurrence_ids)}".encode(),
        usedforsecurity=False,
    ).hexdigest()[:16]
    confidence = sum(phone.confidence or 0.0 for phone in phones) / len(phones)
    aligned_ratio = sum(
        phone.alignment_status == AlignmentStatus.ALIGNED for phone in phones
    ) / len(phones)
    score = len(phones) * 10 + similarity * 3 + confidence + aligned_ratio
    unit_type = UnitType.PHONEME
    if len(phones) > 1:
        unit_type = (
            UnitType.SYLLABLE
            if len({target.grapheme for target in targets}) == 1
            else UnitType.PHONE_SEQUENCE
        )
    return UnitCandidate(
        candidate_id=f"cand_{digest}",
        target_start_index=target_start,
        target_end_index=target_end,
        target_ipa=[target.ipa for target in targets],
        matched_ipa=[phone.ipa for phone in phones],
        occurrence_ids=occurrence_ids,
        source_id=source_id,
        source_start_ms=phones[0].start_ms,
        source_end_ms=phones[-1].end_ms,
        unit_type=unit_type,
        match_status=status,
        similarity=similarity,
        score=score,
    )
