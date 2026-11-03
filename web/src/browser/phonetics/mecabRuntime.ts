import type { BrowserMecabModule, BrowserMecabMorph, BrowserMecabRuntime } from "../../types/browserPhonetics"
import { BROWSER_KOREAN_MECAB_DICTIONARY_FILES } from "../../browserPhoneticsConstants"

const dictionaryAssets = [
  new URL("./assets/ko-dic/char.bin.gzbin", import.meta.url),
  new URL("./assets/ko-dic/dicrc.gzbin", import.meta.url),
  new URL("./assets/ko-dic/matrix.bin.gzbin", import.meta.url),
  new URL("./assets/ko-dic/sys.dic.gzbin", import.meta.url),
  new URL("./assets/ko-dic/unk.dic.gzbin", import.meta.url),
] as const
const wasmUrl = new URL("./mecab/libmecab.wasm", import.meta.url)
const dataUrl = new URL("./mecab/libmecab.data", import.meta.url)

let mecabPromise: Promise<BrowserMecabRuntime> | null = null

async function loadDictionaryFile(name: string, url: URL): Promise<Uint8Array> {
  let response: Response
  try {
    response = await fetch(url)
  } catch {
    throw new Error(`한국어 사전 파일 요청에 실패했습니다: ${name}`)
  }
  if (!response.ok || !response.body) throw new Error(`한국어 발음 사전 파일을 불러오지 못했습니다: ${name}`)
  const stream = response.body.pipeThrough(new DecompressionStream("gzip"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function createMecab(): Promise<BrowserMecabRuntime> {
  const { default: LoadMecab } = await import("./mecab/libmecab.js")
  let module: BrowserMecabModule
  try {
    module = await LoadMecab({
      locateFile: (filename) => filename.endsWith(".wasm") ? wasmUrl.toString() : dataUrl.toString(),
    })
  } catch {
    throw new Error("MeCab WASM 파일을 불러오지 못했습니다.")
  }
  module.FS_createPath("/", "mecab-ko", true, true)
  const files = await Promise.all(dictionaryAssets.map((url, index) => loadDictionaryFile(BROWSER_KOREAN_MECAB_DICTIONARY_FILES[index], url)))
  files.forEach((file, index) => module.FS_createDataFile("/mecab-ko", BROWSER_KOREAN_MECAB_DICTIONARY_FILES[index], file, true, false, true))
  const instance = module.ccall("mecab_new2", "number", ["string"], ["-r /mecab-ko/dicrc -d /mecab-ko"])
  if (!instance) throw new Error("한국어 형태소 분석기를 초기화하지 못했습니다.")
  return { module, instance }
}

async function getMecab(): Promise<BrowserMecabRuntime> {
  mecabPromise ??= createMecab().catch((error: unknown) => {
    mecabPromise = null
    throw error
  })
  return mecabPromise
}

export async function analyzeKoreanMorphology(text: string): Promise<BrowserMecabMorph[]> {
  const { module, instance } = await getMecab()
  const outputLength = module.lengthBytesUTF8(text) * 128 + 4096
  const outputPointer = module._malloc(outputLength)
  if (!outputPointer) throw new Error("한국어 형태소 분석기 메모리를 할당하지 못했습니다.")
  try {
    const resultPointer = module.ccall("mecab_sparse_tostr3", "number", ["number", "string", "number", "number", "number"], [
      instance,
      text,
      module.lengthBytesUTF8(text) + 1,
      outputPointer,
      outputLength,
    ])
    if (!resultPointer) throw new Error("한국어 형태소 분석에 실패했습니다.")
    return module.UTF8ToString(resultPointer).split("\n").flatMap((line) => {
      const separator = line.indexOf("\t")
      if (separator < 0) return []
      return [{ surface: line.slice(0, separator), features: line.slice(separator + 1).split(",") }]
    })
  } finally {
    module._free(outputPointer)
  }
}
