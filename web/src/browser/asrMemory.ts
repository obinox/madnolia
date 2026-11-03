import type { BrowserAsrArtifactConfig, BrowserInferenceDevice, BrowserInferenceDType } from "../types/browserAnalysis"
import { BROWSER_ASR_WASM_MEMORY_EVIDENCE, BROWSER_ASR_WASM_MEMORY_ERROR } from "../browserAsrMemoryConstants"

export function assertAsrMemoryPreflight(
  artifact: Pick<BrowserAsrArtifactConfig, "model_id" | "revision">,
  dtype: BrowserInferenceDType,
  device: BrowserInferenceDevice,
): void {
  const { artifact: knownArtifact } = BROWSER_ASR_WASM_MEMORY_EVIDENCE
  if (
    device === "wasm" &&
    dtype === "fp32" &&
    artifact.model_id === knownArtifact.modelId &&
    artifact.revision === knownArtifact.revision
  ) {
    throw new Error(BROWSER_ASR_WASM_MEMORY_ERROR)
  }
}
