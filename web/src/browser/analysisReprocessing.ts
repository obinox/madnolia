import type { BrowserAnalysisRecord, BrowserProjectRecord, PhoneOccurrence } from "../types"
import type { BrowserAnalysisActiveLease, BrowserAnalysisReprocessJob, BrowserAnalysisReprocessResult } from "../types/browserAnalysis"
import type { BrowserPronunciation } from "../types/browser"

export const browserPhoneIdentity = (phone: Pick<BrowserPronunciation, "word_index" | "phone_id" | "grapheme" | "ipa">): string =>
  `${phone.word_index}\u0000${phone.phone_id}\u0000${phone.grapheme}\u0000${phone.ipa}`

export function indexStablePhoneOccurrences(phones: PhoneOccurrence[]): Map<string, PhoneOccurrence[]> {
  const indexed = new Map<string, PhoneOccurrence[]>()
  for (const phone of phones) {
    const key = browserPhoneIdentity({ word_index: phone.word_index, phone_id: phone.phone_id, grapheme: phone.grapheme, ipa: phone.ipa })
    indexed.set(key, [...(indexed.get(key) ?? []), phone])
  }
  return indexed
}

export function takeStableOccurrenceId(indexed: Map<string, PhoneOccurrence[]>, phone: BrowserPronunciation): string | null {
  return indexed.get(browserPhoneIdentity(phone))?.shift()?.occurrence_id ?? null
}

export function withBrowserReprocessingMetadata(record: BrowserAnalysisRecord, result: BrowserAnalysisReprocessResult, processedAt: string): BrowserAnalysisRecord {
  return { ...record, reprocessing_metadata: { ...result.inference, processed_at: processedAt } }
}

export function updateProjectAnalysisSnapshot(project: BrowserProjectRecord, record: BrowserAnalysisRecord): BrowserProjectRecord {
  return {
    ...project,
    detail: {
      ...project.detail,
      manifest: { ...project.detail.manifest, sources: project.detail.manifest.sources.map((source) => source.source_id === record.source.source_id ? record.source : source) },
      analyses: project.detail.analyses.map((overview) => overview.source_id === record.source.source_id ? record.overview : overview),
    },
  }
}

export const mayCommitReprocessing = (job: BrowserAnalysisReprocessJob | null | undefined): boolean => job?.status === "running"

export const browserAnalysisLeaseAllowsJob = (lease: BrowserAnalysisActiveLease | null, jobId: string, ownerId: string, now: number): boolean =>
  !lease || !Number.isFinite(lease.expires_at) || lease.expires_at <= now || (lease.job_id === jobId && lease.owner_id === ownerId)

export const browserAnalysisLeaseIsLiveForJob = (lease: BrowserAnalysisActiveLease | null, jobId: string, now: number): boolean =>
  !!lease && Number.isFinite(lease.expires_at) && lease.expires_at > now && lease.job_id === jobId
