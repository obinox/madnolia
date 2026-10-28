import type {
  CandidatePhoneAlignment,
  CandidateSearchResult,
  MatchStatus,
  PhoneOccurrence,
  QueryPhone,
  UnitCandidate,
} from "../types"
import type { SearchAlignmentPath, SearchCheckpoint } from "../types/browserSearch"
import type { BrowserAnalysisRecord, BrowserProjectRecord, BrowserSearchRequest } from "../types"
import type { BrowserSearchProgressCallback } from "../types/browser"
import {
  BROWSER_ANALYSIS_RECORD_FILENAME,
  BROWSER_PROJECT_RECORD_FILENAME,
} from "../browserConstants"
import {
  BROWSER_SEARCH_APPROXIMATE_ANCHORS_PER_SOURCE,
  BROWSER_SEARCH_APPROXIMATE_MIN_SIMILARITY,
  BROWSER_SEARCH_CANDIDATES_PER_START_MAX,
  BROWSER_SEARCH_EDIT_COST,
  BROWSER_SEARCH_MAX_EDIT_COUNT,
  BROWSER_SEARCH_MAX_JOIN_GAP_MS,
  BROWSER_SEARCH_MAX_RANKED_PER_START,
  BROWSER_SEARCH_MAX_TARGET_SPAN,
  BROWSER_SEARCH_MIN_SIMILARITY,
  BROWSER_SEARCH_YIELD_INTERVAL,
} from "../browserSearchConstants"
import { listWorkspaceDirectories, readWorkspaceJson } from "./workspace"

function phoneSimilarity(targetId: string, sourceId: string): number {
  if (targetId === "und.approximate.unknown" || sourceId === "und.approximate.unknown") return 0
  if (targetId === sourceId) return 1
  const target = targetId.split(".")
  const source = sourceId.split(".")
  if (target.length < 3 || source.length < 3) return 0
  const kind = (parts: string[]) => parts.includes("vowel") ? "vowel" : parts.includes("consonant") || parts.includes("coda") ? "consonant" : parts[1]
  if (kind(target) !== kind(source)) return 0
  const traits = (parts: string[]) => new Set(parts.slice(2).filter((part) => !["consonant", "vowel", "coda"].includes(part)))
  const targetTraits = traits(target)
  const sourceTraits = traits(source)
  const shared = [...targetTraits].filter((part) => sourceTraits.has(part)).length
  return 0.35 + 0.55 * shared / Math.max(targetTraits.size, sourceTraits.size, 1)
}

function alignment(
  operation: CandidatePhoneAlignment["operation"],
  target: QueryPhone | null,
  source: PhoneOccurrence | null,
  features: Map<string, BrowserAnalysisRecord["acoustic_features"][number]>,
): CandidatePhoneAlignment {
  const acoustic = source ? features.get(source.occurrence_id) : undefined
  return {
    operation,
    target_index: target?.target_index ?? null,
    target_phone_id: target?.phone_id ?? null,
    target_ipa: target?.ipa ?? null,
    source_occurrence_id: source?.occurrence_id ?? null,
    source_phone_id: source?.phone_id ?? null,
    source_ipa: source?.ipa ?? null,
    source_start_ms: source?.start_ms ?? null,
    source_end_ms: source?.end_ms ?? null,
    similarity: target && source ? phoneSimilarity(target.phone_id, source.phone_id) : 0,
    source_f0_hz: acoustic?.f0_hz ?? null,
    voiced_probability: acoustic?.voiced_probability ?? 0,
  }
}

function alignSequence(
  targets: QueryPhone[],
  sources: PhoneOccurrence[],
  features: Map<string, BrowserAnalysisRecord["acoustic_features"][number]>,
): SearchAlignmentPath {
  const costs = Array.from({ length: targets.length + 1 }, () => Array<number>(sources.length + 1).fill(0))
  const steps: Array<Array<CandidatePhoneAlignment["operation"] | null>> = Array.from(
    { length: targets.length + 1 },
    () => Array<CandidatePhoneAlignment["operation"] | null>(sources.length + 1).fill(null),
  )
  for (let i = 1; i <= targets.length; i += 1) { costs[i][0] = i * BROWSER_SEARCH_EDIT_COST; steps[i][0] = "DELETE" }
  for (let j = 1; j <= sources.length; j += 1) { costs[0][j] = j * BROWSER_SEARCH_EDIT_COST; steps[0][j] = "INSERT" }
  for (let i = 1; i <= targets.length; i += 1) {
    for (let j = 1; j <= sources.length; j += 1) {
      const similarity = phoneSimilarity(targets[i - 1].phone_id, sources[j - 1].phone_id)
      const options = [
        { cost: costs[i - 1][j - 1] + 1 - similarity, operation: similarity === 1 ? "MATCH" as const : "SUBSTITUTE" as const },
        { cost: costs[i - 1][j] + BROWSER_SEARCH_EDIT_COST, operation: "DELETE" as const },
        { cost: costs[i][j - 1] + BROWSER_SEARCH_EDIT_COST, operation: "INSERT" as const },
      ]
      const best = options.reduce((left, right) => right.cost < left.cost ? right : left)
      costs[i][j] = best.cost
      steps[i][j] = best.operation
    }
  }
  const alignments: CandidatePhoneAlignment[] = []
  let i = targets.length
  let j = sources.length
  while (i > 0 || j > 0) {
    const operation = steps[i][j]
    if (operation === "MATCH" || operation === "SUBSTITUTE") {
      alignments.push(alignment(operation, targets[--i], sources[--j], features))
    } else if (operation === "DELETE") {
      alignments.push(alignment(operation, targets[--i], null, features))
    } else if (operation === "INSERT") {
      alignments.push(alignment(operation, null, sources[--j], features))
    } else {
      throw new Error("검색 음소 정렬 경로가 잘못되었습니다.")
    }
  }
  alignments.reverse()
  const editCount = alignments.filter((item) => item.operation !== "MATCH").length
  return {
    alignments,
    similarity: Math.max(0, 1 - costs[targets.length][sources.length] / Math.max(targets.length, sources.length, 1)),
    editCount,
  }
}

function makeCandidate(
  targets: QueryPhone[],
  sources: PhoneOccurrence[],
  sourceId: string,
  path: SearchAlignmentPath,
  exact: boolean,
  fallback = false,
): UnitCandidate {
  const first = targets[0]
  const last = targets.at(-1)!
  const sourceIds = sources.map((phone) => phone.occurrence_id)
  const sourceStart = sources[0].start_ms
  const sourceEnd = sources.at(-1)!.end_ms
  const targetCount = targets.length
  const confidence = sources.reduce((total, phone) => total + (phone.confidence ?? 0), 0) / sources.length
  const alignedRatio = sources.filter((phone) => phone.alignment_status === "ALIGNED").length / sources.length
  const score = targetCount * 10 + path.similarity * 3 + confidence + alignedRatio - path.editCount
  const status: MatchStatus = exact ? "EXACT" : "APPROXIMATE"
  const unitType = targetCount === 1 ? "PHONEME" : new Set(targets.map((item) => item.grapheme)).size === 1 ? "SYLLABLE" : "PHONE_SEQUENCE"
  return {
    candidate_id: `${sourceId}:${first.target_index}:${last.target_index + 1}:${sourceIds.join(":")}`,
    target_start_index: first.target_index,
    target_end_index: last.target_index + 1,
    target_ipa: targets.map((phone) => phone.ipa),
    matched_ipa: sources.filter((phone) => path.alignments.some((item) => item.source_occurrence_id === phone.occurrence_id && item.operation !== "DELETE")).map((phone) => phone.ipa),
    occurrence_ids: sourceIds,
    source_id: sourceId,
    source_start_ms: sourceStart,
    source_end_ms: sourceEnd,
    unit_type: unitType,
    match_status: status,
    similarity: path.similarity,
    score,
    fallback,
    alignments: path.alignments,
  }
}

function balancedCandidates(candidates: UnitCandidate[], limit: number): UnitCandidate[] {
  const grouped = new Map<number, Map<number, UnitCandidate[]>>()
  for (const candidate of candidates) {
    const spans = grouped.get(candidate.target_start_index) ?? new Map<number, UnitCandidate[]>()
    const bucket = spans.get(candidate.target_end_index) ?? []
    bucket.push(candidate)
    spans.set(candidate.target_end_index, bucket)
    grouped.set(candidate.target_start_index, spans)
  }
  const selected: UnitCandidate[] = []
  for (const spans of grouped.values()) {
    const ends = [...spans.keys()].sort((left, right) => right - left)
    const offsets = new Map(ends.map((end) => [end, 0]))
  while (true) {
      let added = false
      for (const end of ends) {
        const bucket = spans.get(end)!
        const offset = offsets.get(end) ?? 0
        if (offset >= bucket.length) continue
        selected.push(bucket[offset])
        offsets.set(end, offset + 1)
        added = true
        if ([...offsets.values()].reduce((sum, value) => sum + value, 0) >= limit) break
      }
      if (!added || [...offsets.values()].reduce((sum, value) => sum + value, 0) >= limit) break
    }
  }
  return selected
}

function isJoinable(phones: PhoneOccurrence[]): boolean {
  return phones.every((phone, index) => index === 0 || phone.start_ms - phones[index - 1].end_ms <= BROWSER_SEARCH_MAX_JOIN_GAP_MS)
}

function rankAnchors(target: QueryPhone, phones: PhoneOccurrence[]): number[] {
  return phones.map((phone, index) => ({
    index,
    score: Math.max(
      phone.alignment_status === "MISSING" ? 0 : phoneSimilarity(target.phone_id, phone.phone_id),
      phone.alignment_status === "MISSING" || !phones[index + 1] ? 0 : phoneSimilarity(target.phone_id, phones[index + 1].phone_id) - 0.1,
    ),
    confidence: phone.confidence ?? 0,
  })).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.confidence - left.confidence || left.index - right.index)
    .slice(0, BROWSER_SEARCH_APPROXIMATE_ANCHORS_PER_SOURCE)
    .map((item) => item.index)
}

function sortCandidates(left: UnitCandidate, right: UnitCandidate): number {
  return left.target_start_index - right.target_start_index
    || (left.match_status === "EXACT" ? 0 : 1) - (right.match_status === "EXACT" ? 0 : 1)
    || right.target_end_index - left.target_end_index
    || right.score - left.score
    || left.source_start_ms - right.source_start_ms
}

export async function startBrowserSearch(
  projectId: string,
  request: BrowserSearchRequest,
  progress: BrowserSearchProgressCallback = () => undefined,
  signal?: AbortSignal,
): Promise<CandidateSearchResult> {
  if (signal?.aborted) throw new DOMException("Search cancelled", "AbortError")
  const project = await readWorkspaceJson<BrowserProjectRecord>(`projects/${projectId}/${BROWSER_PROJECT_RECORD_FILENAME}`)
  const ids = await listWorkspaceDirectories("analyses")
  const records = await Promise.all(ids.map((id) => readWorkspaceJson<BrowserAnalysisRecord>(`analyses/${id}/${BROWSER_ANALYSIS_RECORD_FILENAME}`)))
  if (signal?.aborted) throw new DOMException("Search cancelled", "AbortError")
  const included = records.filter((item) => project.analysis_ids.includes(item.summary.analysis_id))
  return searchBrowserAnalyses(request, included, progress, signal)
}

export async function searchBrowserAnalyses(
  request: BrowserSearchRequest,
  included: BrowserAnalysisRecord[],
  progress: BrowserSearchProgressCallback = () => undefined,
  signal?: AbortSignal,
): Promise<CandidateSearchResult> {
  const checkpoint: SearchCheckpoint = async () => {
    if (signal?.aborted) throw new DOMException("Search cancelled", "AbortError")
  }
  await checkpoint()
  const { pronounceBrowserText } = await import("./phonetics")
  const pronunciation = pronounceBrowserText(request.text, request.input_language)
  if (!pronunciation.length) throw new Error("검색할 발음이 없습니다.")
  const allPhones = included.flatMap((record) => record.phones)
  const exactIds = new Set(allPhones.filter((phone) => phone.phone_id !== "und.approximate.unknown").map((phone) => phone.phone_id))
  const exactIpas = new Set(allPhones.map((phone) => phone.ipa))
  const targets: QueryPhone[] = pronunciation.map((phone, target_index) => ({
    target_index,
    grapheme: phone.grapheme,
    phone_id: phone.phone_id,
    ipa: phone.ipa,
    exact_available: phone.phone_id !== "und.approximate.unknown" && (exactIds.has(phone.phone_id) || exactIpas.has(phone.ipa)),
  }))
  const sourceLabels = Object.fromEntries(included.map((record) => [
    record.source.source_id,
    record.source.path.split(/[\\/]/).at(-1) ?? record.source.source_id,
  ]))
  const sourceViews = included.map((record) => ({
    record,
    phones: [...record.phones].sort((left, right) => left.start_ms - right.start_ms),
    features: new Map(record.acoustic_features.map((item) => [item.occurrence_id, item])),
  }))
  const exactBuckets = new Map<string, UnitCandidate[]>()
  const approximateCandidates: UnitCandidate[] = []
  const perStart = Math.max(1, Math.min(BROWSER_SEARCH_CANDIDATES_PER_START_MAX, request.max_candidates_per_start ?? 20))
  const totalStarts = Math.max(1, included.reduce((total, item) => total + item.phones.length, 0))
  let processedStarts = 0
  let lastYield = 0
  const maybeYield = async (force = false) => {
    if (force || processedStarts - lastYield >= BROWSER_SEARCH_YIELD_INTERVAL) {
      await checkpoint()
      lastYield = processedStarts
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      await checkpoint()
    }
  }
  progress({ stage: "exact", percent: 0 })
  if (request.include_exact) {
    for (const { record, phones, features } of sourceViews) {
      for (let sourceStart = 0; sourceStart < phones.length; sourceStart += 1) {
        processedStarts += 1
        if (sourceStart % 16 === 0) {
          progress({ stage: "exact", percent: processedStarts / totalStarts * 100 })
          await maybeYield()
        }
        for (let targetStart = 0; targetStart < targets.length; targetStart += 1) {
          const first = phones[sourceStart]
          if (targets[targetStart].phone_id === "und.approximate.unknown"
            || first.phone_id === "und.approximate.unknown"
            || (first.phone_id !== targets[targetStart].phone_id && first.ipa !== targets[targetStart].ipa)) continue
          const matched: PhoneOccurrence[] = []
          let sourceIndex = sourceStart
          let targetIndex = targetStart
          while (sourceIndex < phones.length && targetIndex < targets.length) {
            const phone = phones[sourceIndex]
            const target = targets[targetIndex]
            if (target.phone_id === "und.approximate.unknown" || phone.phone_id === "und.approximate.unknown"
              || (phone.phone_id !== target.phone_id && phone.ipa !== target.ipa)
              || (matched.length > 0 && phone.start_ms - matched.at(-1)!.end_ms > BROWSER_SEARCH_MAX_JOIN_GAP_MS)) break
            matched.push(phone)
            const targetSlice = targets.slice(targetStart, targetIndex + 1)
            const alignments = targetSlice.map((targetPhone, index) => alignment("MATCH", targetPhone, matched[index], features))
            const candidate = makeCandidate(targetSlice, [...matched], record.source.source_id, { alignments, similarity: 1, editCount: 0 }, true)
            const key = `${candidate.target_start_index}:${candidate.target_end_index}`
            const bucket = exactBuckets.get(key) ?? []
            bucket.push(candidate)
            bucket.sort((left, right) => right.score - left.score || left.source_start_ms - right.source_start_ms)
            if (bucket.length > Math.min(perStart, 120)) bucket.pop()
            exactBuckets.set(key, bucket)
            sourceIndex += 1
            targetIndex += 1
          }
        }
      }
    }
  }
  progress({ stage: "exact", percent: 100 })
  const exactCandidates = [...exactBuckets.values()].flat().sort(sortCandidates)
  const selectedExact = balancedCandidates(exactCandidates, Math.min(perStart, 120))
  progress({ stage: "approximate", percent: 0 })
  if (request.include_approximate) {
    for (let targetStart = 0; targetStart < targets.length; targetStart += 1) {
      await checkpoint()
      const ranked = new Map<string, UnitCandidate>()
      const maxSpan = Math.min(BROWSER_SEARCH_MAX_TARGET_SPAN, targets.length - targetStart)
      if (targets[targetStart].phone_id === "und.approximate.unknown") continue
      const anchors = new Map(sourceViews.map(({ record, phones }) => [
        record.source.source_id,
        rankAnchors(targets[targetStart], phones),
      ]))
      for (let targetLength = 1; targetLength <= maxSpan; targetLength += 1) {
        const targetSlice = targets.slice(targetStart, targetStart + targetLength)
        if (targetSlice.some((phone) => phone.phone_id === "und.approximate.unknown")) continue
        const minSourceLength = Math.max(1, targetLength - BROWSER_SEARCH_MAX_EDIT_COUNT)
        const maxSourceLength = targetLength + BROWSER_SEARCH_MAX_EDIT_COUNT
        for (const { record, phones, features } of sourceViews) {
          const sourceAnchors = anchors.get(record.source.source_id)!
          for (const sourceStart of sourceAnchors) {
            processedStarts += 1
            if (processedStarts % 128 === 0) {
              progress({ stage: "approximate", percent: targetStart / Math.max(targets.length, 1) * 100 })
              await maybeYield()
            }
            for (let sourceLength = minSourceLength; sourceLength <= maxSourceLength; sourceLength += 1) {
              const sourceSlice = phones.slice(sourceStart, sourceStart + sourceLength)
              if (sourceSlice.length !== sourceLength || !isJoinable(sourceSlice)) continue
              const path = alignSequence(targetSlice, sourceSlice, features)
              if (path.editCount === 0 || path.editCount > BROWSER_SEARCH_MAX_EDIT_COUNT || path.similarity < BROWSER_SEARCH_MIN_SIMILARITY) continue
              const candidate = makeCandidate(
                targetSlice,
                sourceSlice,
                record.source.source_id,
                path,
                false,
                path.similarity < BROWSER_SEARCH_APPROXIMATE_MIN_SIMILARITY,
              )
              const key = candidate.candidate_id
              const previous = ranked.get(key)
              if (!previous || candidate.score > previous.score) ranked.set(key, candidate)
              if (ranked.size > BROWSER_SEARCH_MAX_RANKED_PER_START) {
                const lowest = [...ranked.entries()].sort((a, b) => a[1].score - b[1].score)[0]
                ranked.delete(lowest[0])
              }
            }
          }
        }
      }
      approximateCandidates.push(...ranked.values())
    }
  }
  progress({ stage: "approximate", percent: 100 })
  const exactIdsSelected = new Set(selectedExact.map((candidate) => candidate.candidate_id))
  const primaryStarts = new Set(approximateCandidates.filter((item) => !item.fallback).map((item) => item.target_start_index))
  const eligibleApproximate = approximateCandidates.filter((candidate) => !exactIdsSelected.has(candidate.candidate_id) && !(candidate.fallback && primaryStarts.has(candidate.target_start_index)))
  eligibleApproximate.sort(sortCandidates)
  const selectedApproximate = balancedCandidates(eligibleApproximate, perStart)
  progress({ stage: "sorting", percent: 100 })
  return {
    target_text: request.text.trim(),
    target_pronunciation: pronunciation.map((phone) => phone.ipa).join(" "),
    input_language: request.input_language,
    target_phones: targets,
    candidates: [...selectedExact, ...selectedApproximate].sort(sortCandidates),
    source_labels: sourceLabels,
  }
}
