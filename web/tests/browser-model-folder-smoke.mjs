import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = dirname(fileURLToPath(import.meta.url))
const runtimeSmoke = join(root, "browser-runtime-smoke.mjs")
const child = spawn(process.execPath, [runtimeSmoke, "--asr", "--model-folder"], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
  env: {
    ...process.env,
    MADNOLIA_SMOKE_ASR_MODEL: "Xenova/whisper-tiny",
    MADNOLIA_SMOKE_LANGUAGE: "en",
    MADNOLIA_SMOKE_PRECISION: "compact",
    MADNOLIA_SMOKE_DEVICE: "wasm",
    MADNOLIA_SMOKE_ALIGNMENT: "estimated",
    MADNOLIA_SMOKE_ACOUSTIC_UNITS: "false",
  },
})

child.on("error", (error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
