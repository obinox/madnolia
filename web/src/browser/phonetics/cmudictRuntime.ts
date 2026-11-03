import dictionary from "./g2pk/cmudict.json" with { type: "json" }
import type { BrowserCmuDictionary } from "../../types/browserPhonetics"

export async function getCmuDictionary(): Promise<BrowserCmuDictionary> {
  return dictionary as BrowserCmuDictionary
}
