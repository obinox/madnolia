import type { BrowserMecabModule } from "../../../types/browserPhonetics"

declare const LoadMecab: (options: { locateFile: (filename: string) => string }) => Promise<BrowserMecabModule>

export default LoadMecab
