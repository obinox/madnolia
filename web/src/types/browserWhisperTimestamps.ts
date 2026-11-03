import type { Tensor } from "@huggingface/transformers"

export type BrowserWhisperAlignmentHead = readonly [layerIndex: number, headIndex: number]

export interface BrowserWhisperTimestampOptions {
  crossAttentions: Tensor[][]
  sequences: Tensor
  alignmentHeads: BrowserWhisperAlignmentHead[]
  /** Actual encoder output frames after the model's audio downsampling. */
  encoderFrameCount: number
  timePrecisionSeconds?: number
  medianFilterWidth?: number
  /** Remove preceding context query rows while retaining later task prompt rows. */
  previousContextTokenCount?: number
}
