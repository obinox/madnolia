import type { BrowserG2pOptions, BrowserG2pRuntime } from "../../../types/browserPhonetics"

export class G2p implements BrowserG2pRuntime {
  constructor(options: BrowserG2pOptions)
  convert(text: string): Promise<string>
}
