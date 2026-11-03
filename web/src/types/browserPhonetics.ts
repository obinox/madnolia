export interface BrowserMecabModule {
  FS_createPath(parent: string, path: string, canRead: boolean, canWrite: boolean): void
  FS_createDataFile(parent: string, name: string, data: Uint8Array, canRead: boolean, canWrite: boolean, canOwn: boolean): void
  ccall(name: string, returnType: string | null, argumentTypes: string[], arguments_: Array<string | number>): number
  lengthBytesUTF8(value: string): number
  UTF8ToString(pointer: number): string
  _malloc(size: number): number
  _free(pointer: number): void
}

export interface BrowserMecabMorph {
  surface: string
  features: string[]
}

export interface BrowserMecabRuntime {
  module: BrowserMecabModule
  instance: number
}

export interface BrowserG2pOptions {
  ruleData: { table: string; rules: string; idioms: string }
  englishDict: Record<string, string[]>
  morphAnalyzer: (text: string) => Promise<Array<[string, string]>>
}

export interface BrowserG2pRuntime {
  convert(text: string): Promise<string>
}

export type BrowserCmuDictionary = Record<string, string[]>

export type BrowserEnglishG2pWeights = Record<string, Float32Array>

export interface BrowserEnglishG2pRuntime {
  pronunciation(word: string): Promise<string[]>
}

export interface BrowserJapaneseG2pItem {
  orig: string
  hira: string
  hepburn: string
}

export interface BrowserJapaneseG2pRuntime {
  convert(text: string): BrowserJapaneseG2pItem[]
  romanize(text: string): string
}

export interface BrowserJapaneseG2pData {
  kanwa: Record<string, Record<string, Array<[string, string[] | null]>>>
  itaiji: Record<string, string>
  hepburn: Record<string, string>
}
