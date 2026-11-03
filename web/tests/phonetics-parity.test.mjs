import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { readFile as readFileAsync } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"
import test from "node:test"
import { G2p } from "../src/browser/phonetics/g2pk/g2pk.js"

const packagePath = new URL("../src/browser/phonetics/mecab/", import.meta.url)
const dictionaryPath = new URL("../src/browser/phonetics/assets/ko-dic/", import.meta.url)
const rulePath = new URL("../src/browser/phonetics/g2pk/", import.meta.url)
const originalGlobals = {
  process: globalThis.process,
  window: globalThis.window,
  document: globalThis.document,
  XMLHttpRequest: globalThis.XMLHttpRequest,
}

class LocalAssetRequest {
  open(_method, url) {
    this.url = url
  }

  send() {
    const bytes = readFileSync(fileURLToPath(this.url))
    this.status = 200
    this.response = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    this.onload?.()
  }
}

let mecab
try {
  globalThis.process = undefined
  globalThis.XMLHttpRequest = LocalAssetRequest
  globalThis.window = { location: { pathname: "/phonetics-test.html" }, encodeURIComponent }
  globalThis.document = { currentScript: { src: new URL("../src/browser/phonetics/mecab/libmecab.js", import.meta.url).href }, title: "" }
  const { default: LoadMecab } = await import("../src/browser/phonetics/mecab/libmecab.js")
  mecab = await LoadMecab({ locateFile: (name) => new URL(name, packagePath).href })
} finally {
  globalThis.process = originalGlobals.process
  globalThis.window = originalGlobals.window
  globalThis.document = originalGlobals.document
  globalThis.XMLHttpRequest = originalGlobals.XMLHttpRequest
}
mecab.FS_createPath("/", "mecab-ko", true, true)
for (const name of ["char.bin", "dicrc", "matrix.bin", "sys.dic", "unk.dic"]) {
  const compressed = readFileSync(new URL(`${name}.gzbin`, dictionaryPath))
  mecab.FS_createDataFile("/mecab-ko", name, new Uint8Array(gunzipSync(compressed)), true, false, true)
}
const instance = mecab.ccall("mecab_new2", "number", ["string"], ["-r /mecab-ko/dicrc -d /mecab-ko"])

const analyzer = async (text) => {
  const length = mecab.lengthBytesUTF8(text) * 128 + 4096
  const output = mecab._malloc(length)
  const pointer = mecab.ccall("mecab_sparse_tostr3", "number", ["number", "string", "number", "number", "number"], [
    instance,
    text,
    mecab.lengthBytesUTF8(text) + 1,
    output,
    length,
  ])
  const result = mecab.UTF8ToString(pointer).split("\n").flatMap((line) => {
    const separator = line.indexOf("\t")
    return separator < 0 ? [] : [[line.slice(0, separator), line.slice(separator + 1).split(",")[0]]]
  })
  mecab._free(output)
  return result
}

const ruleData = Object.fromEntries(await Promise.all(["table.csv", "rules.txt", "idioms.txt"].map(async (name) => [
  name === "table.csv" ? "table" : name === "rules.txt" ? "rules" : "idioms",
  await readFileAsync(new URL(name, rulePath), "utf8"),
])))
const englishDict = JSON.parse(await readFileAsync(new URL("cmudict.json", rulePath), "utf8"))
const g2p = new G2p({ ruleData, englishDict, morphAnalyzer: analyzer })

test("Korean G2P matches legacy rule output with WASM MeCab morphology", async () => {
  assert.equal(await g2p.convert("국물"), "궁물")
  assert.equal(await g2p.convert("나는 학교에 간다"), "나는 학꾜에 간다")
  assert.equal(await g2p.convert("나의 친구가 mp3 file 3개를 다운받고 있다"), "나의 친구가 엠피쓰리 파일 세개를 다운받꼬 읻따")
})

