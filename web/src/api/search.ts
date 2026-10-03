import type { InputLanguage, JobIdResponse, SearchJob } from "../types"
import { request } from "./client"

export const startSearch = (
  projectId: string,
  text: string,
  inputLanguage: InputLanguage,
  maxCandidatesPerStart: number,
  includeExact: boolean,
  includeApproximate: boolean,
  signal?: AbortSignal,
): Promise<JobIdResponse> => request(
  `/api/projects/${encodeURIComponent(projectId)}/search-jobs`,
  signal,
  { method: "POST", body: JSON.stringify({
    text,
    max_candidates_per_start: maxCandidatesPerStart,
    input_language: inputLanguage,
    include_exact: includeExact,
    include_approximate: includeApproximate,
  }) },
)

export const getSearchJob = (jobId: string, signal?: AbortSignal): Promise<SearchJob> =>
  request(`/api/search-jobs/${encodeURIComponent(jobId)}`, signal)

export const cancelSearch = (jobId: string): Promise<SearchJob> => request(
  `/api/search-jobs/${encodeURIComponent(jobId)}`,
  undefined,
  { method: "DELETE" },
)
