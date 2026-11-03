import type { BrowserAnalysisRecord } from "./browser"

export type BrowserLegacyJson = Record<string, unknown>

export interface BrowserLegacyImportProgress {
  completed: number
  total: number
  name: string
}

export interface BrowserLegacyImportSummary {
  projects_imported: number
  analyses_imported: number
  collages_imported: number
  composition_parent_links_missing: number
  audio_files_imported: number
  media_files_imported: number
  media_files_missing: number
  database_files_preserved: number
  centroid_files_imported: number
  version_files_preserved: number
  export_files_preserved: number
}

export interface BrowserLegacyImportComposition {
  old_project_id: string
  export_parts: string[]
  old_composition_id: string
  composition: BrowserLegacyJson
}

export interface BrowserLegacyImportedAnalysis {
  old_project_id: string
  new_project_id: string
  old_source_id: string
  new_source_id: string
  old_analysis_id: string
  new_analysis_id: string
  record: BrowserAnalysisRecord
  audio: Blob
  media: Blob | null
  media_name: string
}
