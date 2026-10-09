from collections import defaultdict
from collections.abc import Callable
from dataclasses import replace
from functools import lru_cache
from hashlib import sha1
from heapq import heappop, heappush, nsmallest
from itertools import pairwise

from madnolia.constants import (
    SEARCH_INSERT_DELETE_COST,
    SEARCH_MAX_APPROXIMATE_ANCHORS_PER_SOURCE,
    SEARCH_MAX_APPROXIMATE_RANKED_POOL_PER_TARGET_START,
    SEARCH_MAX_CANDIDATES_PER_TARGET_START,
    SEARCH_MAX_EDIT_COUNT,
    SEARCH_MAX_JOIN_GAP_MS,
    SEARCH_MAX_TARGET_SPAN,
    SEARCH_MIN_SEQUENCE_SIMILARITY,
    SEARCH_PHONE_FALLBACK_SIMILARITIES,
    SEARCH_PHONE_SIMILARITY_OVERRIDES,
    SEARCH_PRIMARY_APPROXIMATE_SIMILARITY,
    SYNTHESIS_TAIL_MARGIN_MS,
)
from madnolia.phonetics import MultilingualPhonetics
from madnolia.types.common import (
    AlignmentStatus,
    AnalysisResult,
    AudioRegionType,
    CandidatePhoneAlignment,
    CandidateSearchResult,
    InputLanguage,
    MatchStatus,
    PhoneAcousticFeatures,
    PhoneAlignmentOperation,
    PhoneOccurrence,
    QueryPhone,
    SearchCheckpoint,
    SearchProgressCallback,
    UnitCandidate,
    UnitType,
)


def search_candidates(
    text: str,
    analyses: list[AnalysisResult],
    max_candidates_per_start: int = 8,
    input_language: InputLanguage = InputLanguage.AUTO,
    include_exact: bool = True,
    include_approximate: bool = True,
    progress_callback: SearchProgressCallback | None = None,
    checkpoint: SearchCheckpoint | None = None,
) -> CandidateSearchResult:
    report = progress_callback or (lambda stage, percent: None)
    check = checkpoint or (lambda: None)
    normalized = text.strip()
    if not normalized:
        raise ValueError("검색할 문장이 비어 있습니다.")
    if not 1 <= max_candidates_per_start <= 50:
        raise ValueError("max_candidates_per_start는 1 이상 50 이하여야 합니다.")
    report("phonetic", 0)
    check()
    transcription = MultilingualPhonetics().transcribe(normalized, input_language)
    report("phonetic", 100)
    check()
    pronunciation = transcription.pronunciation
    raw_targets = transcription.phones
    if not raw_targets:
        raise ValueError("입력 문장에서 음소를 만들 수 없습니다.")
    sources = {
        analysis.source.source_id: sorted(analysis.phones, key=lambda phone: phone.start_ms)
        for analysis in analyses
    }
    features = {
        feature.occurrence_id: feature
        for analysis in analyses
        for feature in analysis.acoustic_features
    }
    exact_ids = {phone.phone_id for phones in sources.values() for phone in phones}
    exact_ipas = {phone.ipa for phones in sources.values() for phone in phones}
    targets = [
        QueryPhone(
            target_index=index,
            grapheme=grapheme,
            phone_id=phone_id,
            ipa=ipa,
            exact_available=phone_id in exact_ids or ipa in exact_ipas,
        )
        for index, (phone_id, ipa, grapheme) in enumerate(raw_targets)
    ]
    exact_candidates = _exact_candidates(
        targets, sources, features, max_candidates_per_start,
        progress=lambda percent: report("exact", percent), checkpoint=check,
    ) if include_exact else []
    if not include_exact:
        report("exact", 100)
    exact_candidates.sort(key=_candidate_sort_key)
    exact_limit = min(max_candidates_per_start, SEARCH_MAX_CANDIDATES_PER_TARGET_START)
    selected_exact = _balanced_candidates_by_span(exact_candidates, exact_limit)

    approximate_candidates = _approximate_sequence_candidates(
        targets, sources, features,
        progress=lambda percent: report("approximate", percent), checkpoint=check,
    ) if include_approximate else []
    if not include_approximate:
        report("approximate", 100)
    report("sorting", 0)
    check()
    approximate_candidates.sort(key=_candidate_sort_key)
    primary_starts = {
        candidate.target_start_index
        for candidate in approximate_candidates
        if not candidate.fallback
    }
    eligible_approximate: list[UnitCandidate] = []
    seen = {candidate.candidate_id for candidate in selected_exact}
    total = max(1, len(approximate_candidates))
    for index, candidate in enumerate(approximate_candidates):
        if index % 64 == 0:
            check()
            report("sorting", index / total * 100)
        start = candidate.target_start_index
        if (
            candidate.candidate_id in seen
            or (candidate.fallback and start in primary_starts)
        ):
            continue
        eligible_approximate.append(candidate)
        seen.add(candidate.candidate_id)
    selected_approximate = _balanced_candidates_by_span(
        eligible_approximate,
        max_candidates_per_start,
    )

    selected = sorted(selected_exact + selected_approximate, key=_candidate_sort_key)
    selected = _extend_candidate_tails(selected, analyses, sources, check)
    report("sorting", 100)
    return CandidateSearchResult(
        target_text=normalized,
        target_pronunciation=pronunciation,
        input_language=transcription.language,
        target_phones=targets,
        candidates=selected,
    )


def _synthesis_tail_end_ms(
    phone: PhoneOccurrence,
    phone_index: int,
    phones: list[PhoneOccurrence],
    analysis: AnalysisResult,
    lower_bound_ms: int | None = None,
) -> int:
    duration_ms = analysis.source.duration_ms
    original_end = phone.end_ms
    lower_bound = max(original_end, lower_bound_ms or original_end)
    if (
        phone.start_ms < 0
        or original_end < phone.start_ms
        or original_end > duration_ms
        or lower_bound > duration_ms
    ):
        return lower_bound
    boundaries: list[int] = []
    if phone_index + 1 < len(phones):
        boundaries.append(phones[phone_index + 1].start_ms - SYNTHESIS_TAIL_MARGIN_MS)
    in_non_speech = False
    for region in analysis.audio_regions:
        if (
            region.region_type == AudioRegionType.NON_SPEECH
            and region.start_ms <= phone.start_ms < region.end_ms
        ):
            in_non_speech = True
        elif region.region_type == AudioRegionType.NON_SPEECH and region.start_ms >= phone.start_ms:
            boundaries.append(region.start_ms)
        elif (
            region.region_type == AudioRegionType.SPEECH
            and region.start_ms <= phone.start_ms < region.end_ms
        ):
            boundaries.append(region.end_ms)
    if in_non_speech or not boundaries:
        return lower_bound
    return min(duration_ms, max(lower_bound, min(boundaries)))


def _extend_candidate_tails(
    candidates: list[UnitCandidate],
    analyses: list[AnalysisResult],
    sources: dict[str, list[PhoneOccurrence]],
    checkpoint: SearchCheckpoint,
) -> list[UnitCandidate]:
    analysis_by_source = {analysis.source.source_id: analysis for analysis in analyses}
    phone_indices = {
        source_id: {phone.occurrence_id: index for index, phone in enumerate(phones)}
        for source_id, phones in sources.items()
    }
    extended: list[UnitCandidate] = []
    for index, candidate in enumerate(candidates):
        if index % 64 == 0:
            checkpoint()
        if not candidate.occurrence_ids:
            extended.append(candidate)
            continue
        analysis = analysis_by_source.get(candidate.source_id)
        phones = sources.get(candidate.source_id, [])
        phone_index = phone_indices.get(candidate.source_id, {}).get(candidate.occurrence_ids[-1])
        if analysis is None or phone_index is None:
            extended.append(candidate)
            continue
        phone = phones[phone_index]
        if candidate.source_end_ms < phone.end_ms:
            extended.append(candidate)
            continue
        source_end = _synthesis_tail_end_ms(
            phone, phone_index, phones, analysis, candidate.source_end_ms
        )
        if source_end <= candidate.source_end_ms:
            extended.append(candidate)
            continue
        alignments = [
            replace(alignment, source_end_ms=source_end)
            if alignment.source_occurrence_id == phone.occurrence_id
            else alignment
            for alignment in candidate.alignments
        ]
        extended.append(
            replace(candidate, source_end_ms=source_end, alignments=alignments)
        )
    return extended


def _balanced_candidates_by_span(
    candidates: list[UnitCandidate],
    limit_per_start: int,
) -> list[UnitCandidate]:
    grouped: dict[int, dict[int, list[UnitCandidate]]] = defaultdict(lambda: defaultdict(list))
    for candidate in candidates:
        grouped[candidate.target_start_index][candidate.target_end_index].append(candidate)

    selected: list[UnitCandidate] = []
    for start in sorted(grouped):
        spans = grouped[start]
        ends = sorted(spans, reverse=True)
        offsets = {end: 0 for end in ends}
        selected_count = 0
        while selected_count < limit_per_start:
            added = False
            for end in ends:
                offset = offsets[end]
                if offset >= len(spans[end]):
                    continue
                selected.append(spans[end][offset])
                offsets[end] += 1
                selected_count += 1
                added = True
                if selected_count >= limit_per_start:
                    break
            if not added:
                break
    return selected


def _exact_candidates(
    targets: list[QueryPhone],
    sources: dict[str, list[PhoneOccurrence]],
    features: dict[str, PhoneAcousticFeatures],
    limit: int,
    progress: Callable[[float], None] | None = None,
    checkpoint: SearchCheckpoint | None = None,
) -> list[UnitCandidate]:
    grouped: dict[tuple[int, int], list[UnitCandidate]] = defaultdict(list)
    total = max(1, sum(len(phones) for phones in sources.values()))
    processed = 0
    check = checkpoint or (lambda: None)
    report = progress or (lambda percent: None)
    for source_id, phones in sources.items():
        for source_start, first in enumerate(phones):
            if source_start % 128 == 0:
                check()
                report(processed / total * 100)
            processed += 1
            for target_start, target in enumerate(targets):
                if not _is_exact_phone(target.phone_id, target.ipa, first):
                    continue
                matched: list[PhoneOccurrence] = []
                source_index = source_start
                target_index = target_start
                while source_index < len(phones) and target_index < len(targets):
                    phone = phones[source_index]
                    if not _is_exact_phone(
                        targets[target_index].phone_id,
                        targets[target_index].ipa,
                        phone,
                    ):
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
                            _positional_alignments(
                                targets[target_start:target_index + 1], matched, features
                            ),
                        )
                    )
                    source_index += 1
                    target_index += 1
    result: list[UnitCandidate] = []
    report(100)
    for items in grouped.values():
        items.sort(key=lambda candidate: (-candidate.score, candidate.source_start_ms))
        result.extend(items[:limit])
    return result


def _approximate_sequence_candidates(
    targets: list[QueryPhone],
    sources: dict[str, list[PhoneOccurrence]],
    features: dict[str, PhoneAcousticFeatures],
    progress: Callable[[float], None] | None = None,
    checkpoint: SearchCheckpoint | None = None,
) -> list[UnitCandidate]:
    result: list[UnitCandidate] = []
    check = checkpoint or (lambda: None)
    report = progress or (lambda percent: None)
    for target_start in range(len(targets)):
        check()
        report(target_start / max(1, len(targets)) * 100)
        ranked: list[tuple[tuple[float | int, ...], int, UnitCandidate]] = []
        sequence = 0
        maximum_span = min(SEARCH_MAX_TARGET_SPAN, len(targets) - target_start)
        for source_id, phones in sources.items():
            source_starts = _source_anchor_starts(targets[target_start], phones, check)
            for target_length in range(1, maximum_span + 1):
                target_slice = targets[target_start:target_start + target_length]
                minimum_source_length = max(1, target_length - SEARCH_MAX_EDIT_COUNT)
                maximum_source_length = target_length + SEARCH_MAX_EDIT_COUNT
                for source_start in source_starts:
                    check()
                    for source_length in range(minimum_source_length, maximum_source_length + 1):
                        source_slice = phones[source_start:source_start + source_length]
                        if len(source_slice) != source_length or not _is_joinable(source_slice):
                            continue
                        alignments, similarity, edit_count = _align(
                            target_slice, source_slice, features
                        )
                        if (
                            edit_count == 0
                            or edit_count > SEARCH_MAX_EDIT_COUNT
                            or similarity < SEARCH_MIN_SEQUENCE_SIMILARITY
                        ):
                            continue
                        candidate = _candidate(
                            target_slice,
                            source_slice,
                            source_id,
                            MatchStatus.APPROXIMATE,
                            similarity,
                            alignments,
                            fallback=(
                                similarity < SEARCH_PRIMARY_APPROXIMATE_SIMILARITY
                                or any(_is_fallback_alignment(item) for item in alignments)
                            ),
                        )
                        key = _candidate_sort_key(candidate)
                        heappush(ranked, (tuple(-value for value in key), sequence, candidate))
                        sequence += 1
                        if len(ranked) > SEARCH_MAX_APPROXIMATE_RANKED_POOL_PER_TARGET_START:
                            heappop(ranked)
        result.extend(
            candidate
            for _, _, candidate in sorted(
                ranked, key=lambda item: tuple(-value for value in item[0])
            )
        )
    report(100)
    return result


def _source_anchor_starts(
    target: QueryPhone, phones: list[PhoneOccurrence], checkpoint: SearchCheckpoint | None = None
) -> list[int]:
    check = checkpoint or (lambda: None)
    def ranked_starts():
        for index, phone in enumerate(phones):
            if index % 512 == 0:
                check()
            direct = _phone_similarity(target.phone_id, phone.phone_id)
            after_insertion = (
                _phone_similarity(target.phone_id, phones[index + 1].phone_id) - 0.1
                if index + 1 < len(phones)
                else 0.0
            )
            score = max(direct, after_insertion)
            if score > 0 and phone.alignment_status != AlignmentStatus.MISSING:
                yield (-score, -(phone.confidence or 0.0), index)

    return [
        index
        for _, _, index in nsmallest(
            SEARCH_MAX_APPROXIMATE_ANCHORS_PER_SOURCE, ranked_starts()
        )
    ]


def _align(
    targets: list[QueryPhone],
    phones: list[PhoneOccurrence],
    features: dict[str, PhoneAcousticFeatures],
) -> tuple[list[CandidatePhoneAlignment], float, int]:
    target_count = len(targets)
    source_count = len(phones)
    costs = [[0.0] * (source_count + 1) for _ in range(target_count + 1)]
    steps: list[list[PhoneAlignmentOperation | None]] = [
        [None] * (source_count + 1) for _ in range(target_count + 1)
    ]
    for target_index in range(1, target_count + 1):
        costs[target_index][0] = target_index * SEARCH_INSERT_DELETE_COST
        steps[target_index][0] = PhoneAlignmentOperation.DELETE
    for source_index in range(1, source_count + 1):
        costs[0][source_index] = source_index * SEARCH_INSERT_DELETE_COST
        steps[0][source_index] = PhoneAlignmentOperation.INSERT
    for target_index in range(1, target_count + 1):
        for source_index in range(1, source_count + 1):
            similarity = _phone_similarity(
                targets[target_index - 1].phone_id,
                phones[source_index - 1].phone_id,
            )
            operation = (
                PhoneAlignmentOperation.MATCH
                if similarity == 1.0
                else PhoneAlignmentOperation.SUBSTITUTE
            )
            choices = (
                (costs[target_index - 1][source_index - 1] + 1.0 - similarity, operation),
                (
                    costs[target_index - 1][source_index] + SEARCH_INSERT_DELETE_COST,
                    PhoneAlignmentOperation.DELETE,
                ),
                (
                    costs[target_index][source_index - 1] + SEARCH_INSERT_DELETE_COST,
                    PhoneAlignmentOperation.INSERT,
                ),
            )
            costs[target_index][source_index], steps[target_index][source_index] = min(
                choices, key=lambda item: item[0]
            )

    alignments: list[CandidatePhoneAlignment] = []
    target_index = target_count
    source_index = source_count
    while target_index or source_index:
        operation = steps[target_index][source_index]
        if operation in (PhoneAlignmentOperation.MATCH, PhoneAlignmentOperation.SUBSTITUTE):
            target = targets[target_index - 1]
            phone = phones[source_index - 1]
            alignments.append(_alignment(operation, target, phone, features))
            target_index -= 1
            source_index -= 1
        elif operation == PhoneAlignmentOperation.DELETE:
            alignments.append(
                _alignment(operation, targets[target_index - 1], None, features)
            )
            target_index -= 1
        elif operation == PhoneAlignmentOperation.INSERT:
            alignments.append(
                _alignment(operation, None, phones[source_index - 1], features)
            )
            source_index -= 1
        else:
            raise RuntimeError("음소열 정렬 경로가 손상되었습니다.")
    alignments.reverse()
    edit_count = sum(item.operation != PhoneAlignmentOperation.MATCH for item in alignments)
    normalized_cost = costs[target_count][source_count] / max(target_count, source_count, 1)
    return alignments, max(0.0, 1.0 - normalized_cost), edit_count


def _positional_alignments(
    targets: list[QueryPhone],
    phones: list[PhoneOccurrence],
    features: dict[str, PhoneAcousticFeatures],
) -> list[CandidatePhoneAlignment]:
    return [
        _alignment(PhoneAlignmentOperation.MATCH, target, phone, features)
        for target, phone in zip(targets, phones, strict=True)
    ]


def _alignment(
    operation: PhoneAlignmentOperation,
    target: QueryPhone | None,
    phone: PhoneOccurrence | None,
    features: dict[str, PhoneAcousticFeatures],
) -> CandidatePhoneAlignment:
    similarity = 1.0 if operation == PhoneAlignmentOperation.MATCH else (
        _phone_similarity(target.phone_id, phone.phone_id)
        if target is not None and phone is not None
        else 0.0
    )
    acoustic = features.get(phone.occurrence_id) if phone else None
    return CandidatePhoneAlignment(
        operation=operation,
        target_index=target.target_index if target else None,
        target_phone_id=target.phone_id if target else None,
        target_ipa=target.ipa if target else None,
        source_occurrence_id=phone.occurrence_id if phone else None,
        source_phone_id=phone.phone_id if phone else None,
        source_ipa=phone.ipa if phone else None,
        source_start_ms=phone.start_ms if phone else None,
        source_end_ms=phone.end_ms if phone else None,
        similarity=similarity,
        source_f0_hz=acoustic.f0_hz if acoustic else None,
        voiced_probability=acoustic.voiced_probability if acoustic else 0.0,
    )


def _is_joinable(phones: list[PhoneOccurrence]) -> bool:
    return all(
        current.start_ms - previous.end_ms <= SEARCH_MAX_JOIN_GAP_MS
        for previous, current in pairwise(phones)
    )


def _is_fallback_alignment(alignment: CandidatePhoneAlignment) -> bool:
    if alignment.target_phone_id is None or alignment.source_phone_id is None:
        return False
    return frozenset((
        alignment.target_phone_id,
        alignment.source_phone_id,
    )) in SEARCH_PHONE_FALLBACK_SIMILARITIES


def _is_exact_phone(target_id: str, target_ipa: str, candidate: PhoneOccurrence) -> bool:
    return target_id == candidate.phone_id or target_ipa == candidate.ipa


@lru_cache(maxsize=65536)
def _phone_similarity(target_id: str, candidate_id: str) -> float:
    if target_id == candidate_id:
        return 1.0
    override = SEARCH_PHONE_SIMILARITY_OVERRIDES.get(frozenset((target_id, candidate_id)))
    if override is not None:
        return override
    fallback = SEARCH_PHONE_FALLBACK_SIMILARITIES.get(frozenset((target_id, candidate_id)))
    if fallback is not None:
        return fallback
    target = target_id.split(".")
    candidate = candidate_id.split(".")
    if len(target) < 3 or len(candidate) < 3:
        return 0.0
    target_kind = "vowel" if "vowel" in target else "consonant" if "consonant" in target or "coda" in target else target[1]
    candidate_kind = "vowel" if "vowel" in candidate else "consonant" if "consonant" in candidate or "coda" in candidate else candidate[1]
    if target_kind != candidate_kind:
        return 0.0
    target_traits = set(target[2:]) - {"consonant", "vowel", "coda"}
    candidate_traits = set(candidate[2:]) - {"consonant", "vowel", "coda"}
    shared = len(target_traits & candidate_traits)
    denominator = max(len(target_traits), len(candidate_traits), 1)
    return 0.35 + 0.55 * shared / denominator


def _candidate(
    targets: list[QueryPhone],
    phones: list[PhoneOccurrence],
    source_id: str,
    status: MatchStatus,
    similarity: float,
    alignments: list[CandidatePhoneAlignment],
    fallback: bool = False,
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
    edit_count = sum(item.operation != PhoneAlignmentOperation.MATCH for item in alignments)
    score = len(targets) * 10 + similarity * 3 + confidence + aligned_ratio - edit_count
    unit_type = UnitType.PHONEME
    if len(targets) > 1:
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
        fallback=fallback,
        alignments=alignments,
    )


def _candidate_sort_key(candidate: UnitCandidate) -> tuple[float | int, ...]:
    return (
        candidate.target_start_index,
        0 if candidate.match_status == MatchStatus.EXACT else 1,
        1 if candidate.fallback else 0,
        -(candidate.target_end_index - candidate.target_start_index),
        -candidate.score,
        candidate.source_start_ms,
    )
