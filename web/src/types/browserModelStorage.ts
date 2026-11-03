import type { BrowserPermissionDirectoryHandle } from "./browser"

export type BrowserModelTaskKind = "asr" | "ctc" | "hubert"
export type BrowserModelPrecision = "baseline" | "compact"
export type BrowserModelDevice = "webgpu" | "wasm"

export interface BrowserModelSelection {
  kind: BrowserModelTaskKind
  model_id: string
  revision: string | null
  dtype: string
  subfolder?: string
  external_data_format?: Record<string, boolean | number>
}

export interface BrowserModelFolderFile {
  model_id: string
  revision: string
  dtype: string
  file: string
  path: string
  size_bytes: number
}

export interface BrowserModelFolderIndex {
  schema_version: 1
  files: BrowserModelFolderFile[]
  bindings?: BrowserModelFolderBinding[]
}

export interface BrowserModelFolderBinding {
  model_id: string
  revision: string
  dtype: string
  files: string[]
}

export interface BrowserModelRepositoryFile {
  path: string
  size?: number
  type?: string
}

export interface BrowserLocalModelFile {
  file: File
  path: string
}

export interface BrowserModelRequiredFiles {
  files: BrowserModelRepositoryFile[]
  missing: BrowserModelRepositoryFile[]
}

export interface BrowserModelPreparationProgress {
  model_id: string
  completed_files: number
  total_files: number
  current_file: string
  received_bytes: number
  expected_bytes: number | null
}

export interface BrowserModelReadyState {
  ready: boolean
  present_files: number
  total_files: number
  message: string
}

export interface BrowserModelFolderWindow extends Window {
  showDirectoryPicker?: (options?: { id?: string; mode?: "read" | "readwrite" }) => Promise<BrowserPermissionDirectoryHandle>
}

