import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { extname, join, resolve } from "node:path"

const dist = resolve("dist")
await stat(join(dist, "index.html"))
const browserCandidates = [
  join(process.env.ProgramFiles ?? "C:/Program Files", "Google/Chrome/Application/chrome.exe"),
  join(process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"),
]
let chromePath = process.env.CHROME_PATH
if (!chromePath) {
  for (const candidate of browserCandidates) {
    try { await access(candidate); chromePath = candidate; break } catch {}
  }
}
assert.ok(chromePath, "Set CHROME_PATH to a Chrome or Edge executable")

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname
    if (!pathname.startsWith("/madnolia/")) {
      response.writeHead(404).end("not found")
      return
    }
    let relative = decodeURIComponent(pathname.slice("/madnolia/".length)) || "index.html"
    if (relative.split(/[\\/]/u).includes("..")) {
      response.writeHead(400).end("bad path")
      return
    }
    let filename = join(dist, relative)
    try { await stat(filename) } catch { filename = join(dist, "index.html") }
    const bytes = await readFile(filename)
    response.writeHead(200, { "Content-Type": mimeTypes[extname(filename)] ?? "application/octet-stream" })
    response.end(bytes)
  } catch {
    response.writeHead(500).end("static file error")
  }
})

server.listen(0, "127.0.0.1")
await once(server, "listening")
const address = server.address()
const profile = await mkdtemp(join(tmpdir(), "madnolia-gh-pages-smoke-"))
const browser = spawn(chromePath, [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  "--remote-debugging-port=0",
  "--remote-allow-origins=*",
  `--user-data-dir=${profile}`,
], { stdio: "ignore", windowsHide: true })

let socket
try {
  const endpointFile = join(profile, "DevToolsActivePort")
  let endpoint = ""
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (browser.exitCode !== null) throw new Error(`Browser exited with code ${browser.exitCode}`)
    try { endpoint = (await readFile(endpointFile, "utf8")).split(/\r?\n/u)[1]; break } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  assert.ok(endpoint, "Chrome did not start its DevTools endpoint")
  socket = new WebSocket(`ws://127.0.0.1:${(await readFile(endpointFile, "utf8")).split(/\r?\n/u)[0]}${endpoint}`)
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener("open", resolveOpen, { once: true })
    socket.addEventListener("error", reject, { once: true })
  })
  let commandId = 0
  const pending = new Map()
  const requests = []
  const responseFailures = []
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result)
    }
    if (message.method === "Network.requestWillBeSent") requests.push(new URL(message.params.request.url))
    if (message.method === "Network.responseReceived" && message.params.response.status >= 400 && !message.params.response.url.endsWith("/favicon.ico")) {
      responseFailures.push(`${message.params.response.status} ${message.params.response.url}`)
    }
  })
  const command = (method, params = {}, sessionId) => new Promise((resolveCommand, rejectCommand) => {
    const id = ++commandId
    pending.set(id, { resolve: resolveCommand, reject: rejectCommand })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      rejectCommand(new Error(`Timed out: ${method}`))
    }, 15_000).unref()
  })
  const target = await command("Target.createTarget", { url: "about:blank" })
  const attached = await command("Target.attachToTarget", { targetId: target.targetId, flatten: true })
  const session = attached.sessionId
  await Promise.all(["Page.enable", "Runtime.enable", "Network.enable"].map((method) => command(method, {}, session)))
  await command("Page.addScriptToEvaluateOnNewDocument", { source: `
    Object.defineProperty(FileSystemDirectoryHandle.prototype, "queryPermission", { value: async () => "granted" });
    Object.defineProperty(FileSystemDirectoryHandle.prototype, "requestPermission", { value: async () => "granted" });
    Object.defineProperty(window, "showDirectoryPicker", { value: async () => {
      const storage = await navigator.storage.getDirectory();
      const picks = Number(localStorage.getItem("madnolia-smoke-picks") || "0") + 1;
      localStorage.setItem("madnolia-smoke-picks", String(picks));
      return storage.getDirectoryHandle("workspace-" + picks, { create: true });
    }});
  ` }, session)
  await command("Page.navigate", { url: `http://127.0.0.1:${address.port}/madnolia/` }, session)
  const evaluate = async (expression) => (await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session)).result.value
  const waitFor = async (expression, label) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await evaluate(expression)) return
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
    throw new Error(`Timed out waiting for ${label}`)
  }

  await waitFor("!!document.querySelector('.browser-workspace-gate')", "workspace chooser")
  await evaluate("document.querySelector('.browser-workspace-actions button:last-child').click()")
  await waitFor("!!document.querySelector('.app-header')", "application after granting workspace")
  await waitFor("document.body.innerText.includes('workspace-1')", "selected OPFS workspace")
  await waitFor("document.body.innerText.includes('No projects') || document.body.innerText.includes('프로젝트')", "local projects screen")
  assert.equal(await evaluate("location.pathname"), "/madnolia/", "asset base should work under the Pages project path")

  const firstRequestCount = requests.length
  await command("Page.reload", {}, session)
  await waitFor("!!document.querySelector('.app-header')", "workspace restoration after reload")
  await waitFor("document.body.innerText.includes('workspace-1')", "restored OPFS workspace")
  assert.equal(await evaluate("!!document.querySelector('.browser-workspace-gate')"), false, "reload should restore the granted directory without a new picker")
  assert.ok(requests.length >= firstRequestCount)
  assert.deepEqual(responseFailures, [], `Static assets must load successfully: ${responseFailures.join(", ")}`)
  const apiNetworkRequests = requests.filter((url) => url.pathname.startsWith("/api/"))
  assert.deepEqual(apiNetworkRequests.map((url) => url.href), [], "the static app should route API calls locally")
  const escapedAssets = requests.filter((url) => url.origin === `http://127.0.0.1:${address.port}` && !url.pathname.startsWith("/madnolia/") && !url.pathname.endsWith("/favicon.ico"))
  assert.deepEqual(escapedAssets.map((url) => url.pathname), [], "all same-origin app assets should honor the Pages subpath")
  await command("Browser.close")
  process.stdout.write("GitHub Pages browser smoke passed: subpath assets, OPFS folder selection/reload, and no API network requests.\n")
} finally {
  socket?.close()
  browser.kill()
  if (browser.exitCode === null) await Promise.race([once(browser, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 5_000))])
  await new Promise((resolveClose) => server.close(resolveClose))
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { await rm(profile, { recursive: true, force: true }); break }
    catch (error) {
      if (attempt === 7) throw error
      await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    }
  }
}
