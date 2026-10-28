import type { CandidatePhoneAlignment, UnitCandidate } from "./index"

export type SearchCheckpoint = () => Promise<void>

export interface SearchAlignmentPath {
  alignments: CandidatePhoneAlignment[]
  similarity: number
  editCount: number
}

export interface RankedCandidate {
  candidate: UnitCandidate
  span: number
}
