import { G2p } from "./g2pk/g2pk.js"
import type { BrowserG2pRuntime, BrowserMecabMorph } from "../../types/browserPhonetics"
import { analyzeKoreanMorphology } from "./mecabRuntime"
import { BROWSER_KOREAN_G2P_RULE_FILES } from "../../browserPhoneticsConstants"
import { getCmuDictionary } from "./cmudictRuntime"

const ruleUrls: Record<(typeof BROWSER_KOREAN_G2P_RULE_FILES)[number], URL> = {
  "table.csv": new URL("./g2pk/table.csv", import.meta.url),
  "rules.txt": new URL("./g2pk/rules.txt", import.meta.url),
  "idioms.txt": new URL("./g2pk/idioms.txt", import.meta.url),
}

let runtimePromise: Promise<BrowserG2pRuntime> | null = null

async function fetchText(url: URL): Promise<string> {
  let response: Response
  try {
    response = await fetch(url)
  } catch {
    throw new Error(`한국어 발음 자료 요청에 실패했습니다: ${url.pathname}`)
  }
  if (!response.ok) throw new Error("한국어 발음 규칙 파일을 불러오지 못했습니다.")
  return response.text()
}

async function loadRuntime(): Promise<BrowserG2pRuntime> {
  const [table, rules, idioms] = await Promise.all(BROWSER_KOREAN_G2P_RULE_FILES.map((name) => fetchText(ruleUrls[name])))
  const englishDict = await getCmuDictionary()
  const morphAnalyzer = async (text: string): Promise<Array<[string, string]>> => {
    const morphs: BrowserMecabMorph[] = await analyzeKoreanMorphology(text)
    return morphs.map(({ surface, features }) => [surface, features[0] ?? ""])
  }
  return new G2p({ ruleData: { table, rules, idioms }, englishDict, morphAnalyzer }) as BrowserG2pRuntime
}

export function getKoreanG2p(): Promise<BrowserG2pRuntime> {
  runtimePromise ??= loadRuntime().catch((error: unknown) => {
    runtimePromise = null
    throw error
  })
  return runtimePromise
}
