import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { registerHooks, stripTypeScriptTypes } from "node:module"
import { tmpdir } from "node:os"
import { extname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".ts")) return { format: "module", shortCircuit: true, source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" }) }
    return nextLoad(url, context)
  },
})
const { BROWSER_ASR_MODELS } = await import("../src/browserAnalysisConstants.ts")
const { BROWSER_ANALYSIS_INTERRUPTED_STAGE } = await import("../src/browserAnalysisConstants.ts")

const asrMode = process.argv.includes("--asr")
const recoveryMode = process.argv.includes("--recovery")
const reprocessMode = process.argv.includes("--reprocess")
const modelFolderMode = process.argv.includes("--model-folder")
const phoneticsOnly = process.argv.includes("--phonetics-only")
const smokeAsrModel = process.env.MADNOLIA_SMOKE_ASR_MODEL ?? "Xenova/whisper-tiny"
const smokeLanguage = process.env.MADNOLIA_SMOKE_LANGUAGE ?? "en"
const smokePrecision = process.env.MADNOLIA_SMOKE_PRECISION ?? "compact"
const smokeDevice = process.env.MADNOLIA_SMOKE_DEVICE ?? "wasm"
const smokeModelConfig = BROWSER_ASR_MODELS.find((model) => model.id === smokeAsrModel)
assert.ok(smokeModelConfig, `Unknown ASR model in shared browser registry: ${smokeAsrModel}`)
const smokeModelArtifact = smokeModelConfig.artifacts[smokePrecision]
const smokeDtype = smokeModelArtifact.dtype[smokeDevice]
const smokeArtifact = smokeModelArtifact.model_id
const smokeRevision = smokeModelArtifact.revision
const smokeAlignment = process.env.MADNOLIA_SMOKE_ALIGNMENT ?? "ctc"
const smokeAcousticUnits = process.env.MADNOLIA_SMOKE_ACOUSTIC_UNITS !== "false"
const smokeDiagnostics = process.env.MADNOLIA_SMOKE_DIAGNOSTICS === "true"
const failures = []
const requests = []
const networkResponses = []
const blockedWorkerSessions = new Set()
const workerSessions = new Set()
let modelNetworkBlockedAt = null
const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)))
const dist = resolve(process.env.MADNOLIA_SMOKE_DIST ?? join(webRoot, "dist"))
const artifactRoot = resolve(process.env.MADNOLIA_SMOKE_ARTIFACT_ROOT ?? join(webRoot, "..", ".runtime-audit", "web-only-migration"))
await stat(join(dist, "index.html"))
const assetNames = await readdir(join(dist, "assets"))
const routerPath = assetNames.find((name) => /^router-[\w-]+\.js$/u.test(name))
assert.ok(routerPath, "Production router bundle was not found")
const phoneticsPath = assetNames.find((name) => /^phonetics-[\w-]+\.js$/u.test(name))
assert.ok(phoneticsPath, "Production phonetics bundle was not found")
const workspacePath = assetNames.find((name) => /^workspace-[\w-]+\.js$/u.test(name))
assert.ok(workspacePath, "Production workspace bundle was not found")

const candidates = [
  join(process.env.ProgramFiles ?? "C:/Program Files", "Google/Chrome/Application/chrome.exe"),
  join(process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"),
]
let chromePath = process.env.CHROME_PATH
if (!chromePath) {
  for (const candidate of candidates) {
    try { await access(candidate); chromePath = candidate; break } catch {}
  }
}
assert.ok(chromePath, "Set CHROME_PATH to a Chrome or Edge executable")

const mimeTypes = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".mjs": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".woff": "font/woff", ".woff2": "font/woff2" }
const smokePortValue = process.env.MADNOLIA_SMOKE_PORT
const smokePort = smokePortValue === undefined ? 0 : Number(smokePortValue)
assert.ok(smokePortValue === undefined || (/^\d+$/u.test(smokePortValue) && Number.isInteger(smokePort) && smokePort >= 0 && smokePort <= 65535), "MADNOLIA_SMOKE_PORT must be an integer from 0 to 65535")
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname
    if (!pathname.startsWith("/madnolia/")) return response.writeHead(404).end("not found")
    const relative = decodeURIComponent(pathname.slice("/madnolia/".length)) || "index.html"
    if (relative.split(/[\\/]/u).includes("..")) return response.writeHead(400).end("bad path")
    let filename = join(dist, relative)
    try { await stat(filename) } catch { filename = join(dist, "index.html") }
    response.writeHead(200, { "Content-Type": mimeTypes[extname(filename)] ?? "application/octet-stream" })
    response.end(await readFile(filename))
  } catch { response.writeHead(500).end("static file error") }
})
server.listen(smokePort, "127.0.0.1")
await once(server, "listening")
const address = server.address()
const keepProfile = process.env.MADNOLIA_SMOKE_KEEP_PROFILE === "true"
const requestedProfile = process.env.MADNOLIA_SMOKE_PROFILE
const profile = requestedProfile ? resolve(requestedProfile) : await mkdtemp(join(tmpdir(), "madnolia-runtime-smoke-"))
if (requestedProfile) await mkdir(profile, { recursive: true })
const profilePath = resolve(profile)
const expectedPrefix = requestedProfile ? resolve(join(webRoot, "..", ".runtime-audit")) + sep : resolve(tmpdir()) + sep
assert.ok(profilePath.startsWith(expectedPrefix), "Temporary profile escaped the OS temp directory")
await rm(join(profilePath, "DevToolsActivePort"), { force: true })
const browserArgs = ["--headless=new", "--no-sandbox", `--unsafely-treat-insecure-origin-as-secure=http://127.0.0.1:${address.port}`, ...(smokeDevice === "webgpu" ? ["--enable-unsafe-webgpu"] : ["--disable-gpu"]), "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--remote-allow-origins=*", `--user-data-dir=${profilePath}`]
const browser = spawn(chromePath, browserArgs, { stdio: "ignore", windowsHide: true })
let socket
let browserClosed = false
const log = (step, details = {}) => process.stdout.write(`${JSON.stringify({ step, ...details })}\n`)
const makeFixtureWav = () => {
  const rate = 16_000
  const sampleCount = Math.round(rate * 5.6)
  const wav = Buffer.alloc(44 + sampleCount * 2)
  wav.write("RIFF", 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write("WAVEfmt ", 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24)
  wav.writeUInt32LE(rate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write("data", 36)
  wav.writeUInt32LE(sampleCount * 2, 40)
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = 0.24 * Math.sin(2 * Math.PI * 220 * i / rate)
    wav.writeInt16LE(Math.round(sample < 0 ? sample * 32768 : sample * 32767), 44 + i * 2)
  }
  return wav
}

try {
  const endpointFile = join(profilePath, "DevToolsActivePort")
  let endpoint = ""
  for (let i = 0; i < 100; i += 1) {
    if (browser.exitCode !== null) throw new Error(`Browser exited with code ${browser.exitCode}`)
    try { endpoint = (await readFile(endpointFile, "utf8")).split(/\r?\n/u)[1]; break } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  assert.ok(endpoint, "Chrome did not start its DevTools endpoint")
  const port = (await readFile(endpointFile, "utf8")).split(/\r?\n/u)[0]
  socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`)
  await new Promise((resolveOpen, reject) => { socket.addEventListener("open", resolveOpen, { once: true }); socket.addEventListener("error", reject, { once: true }) })
  let commandId = 0
  const pending = new Map()
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result)
    }
    if (message.method === "Network.requestWillBeSent") requests.push(new URL(message.params.request.url))
    if (message.method === "Network.responseReceived" && message.params.response.status >= 400 && !message.params.response.url.endsWith("/favicon.ico")) failures.push(`${message.params.response.status} ${message.params.response.url}`)
    if (message.method === "Network.responseReceived") networkResponses.push({ url: message.params.response.url, status: message.params.response.status, at: Date.now() })
    if (message.method === "Target.attachedToTarget" && ["worker", "shared_worker", "service_worker"].includes(message.params.targetInfo.type)) {
      const workerSession = message.params.sessionId
      workerSessions.add(workerSession)
      void (async () => {
        await command("Network.enable", {}, workerSession)
        if (smokeDiagnostics) await command("Runtime.enable", {}, workerSession)
        if (modelNetworkBlockedAt !== null) {
          await command("Network.setBlockedURLs", { urls: ["*huggingface.co/*", "*hf.co/*", "*cdn.jsdelivr.net/*", "*cdnjs.cloudflare.com/*"] }, workerSession)
          blockedWorkerSessions.add(workerSession)
        }
        await command("Runtime.runIfWaitingForDebugger", {}, workerSession)
      })().catch((error) => failures.push(`Worker network block failed: ${error instanceof Error ? error.message : String(error)}`))
    }
  })
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data)
    if (message.method === "Page.javascriptDialogOpening") {
      void command("Page.handleJavaScriptDialog", { accept: true }, message.sessionId).catch((error) => failures.push(`Beforeunload dialog handling failed: ${error.message}`))
      return
    }
    if (message.method !== "Runtime.consoleAPICalled") return
    const values = message.params.args.map((argument) => argument.value ?? argument.description ?? "")
    if (values[0] === "MADNOLIA_ASR_DIAGNOSTIC") log("asr-runtime-diagnostic", JSON.parse(values[1]))
  })
  const command = (method, params = {}, sessionId, timeoutMs = 20_000) => new Promise((resolveCommand, rejectCommand) => {
    const id = ++commandId
    pending.set(id, { resolve: resolveCommand, reject: rejectCommand })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rejectCommand(new Error(`Timed out: ${method} after ${timeoutMs}ms`)) } }, timeoutMs).unref()
  })
  const target = await command("Target.createTarget", { url: "about:blank" })
  const attached = await command("Target.attachToTarget", { targetId: target.targetId, flatten: true })
  const session = attached.sessionId
  await Promise.all(["Page.enable", "Runtime.enable", "Network.enable"].map((method) => command(method, {}, session)))
  await command("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__runtimeSmokeErrors=[];
    window.__runtimeSmokeClicks=[];
    document.addEventListener('click',event=>window.__runtimeSmokeClicks.push({trusted:event.isTrusted,target:event.target?.textContent?.slice(0,80)}),true);
    window.addEventListener('error',event=>window.__runtimeSmokeErrors.push(event.message));
    window.addEventListener('unhandledrejection',event=>window.__runtimeSmokeErrors.push(String(event.reason)));
    Object.defineProperty(FileSystemDirectoryHandle.prototype, "queryPermission", { value: async () => "granted" });
    Object.defineProperty(FileSystemDirectoryHandle.prototype, "requestPermission", { value: async () => "granted" });
    window.__runtimeSmokePickerCalls=[];
    Object.defineProperty(window, "showDirectoryPicker", { value: async (options={}) => { window.__runtimeSmokePickerCalls.push(options.id); if(window.__cancelNextDirectoryPicker){window.__cancelNextDirectoryPicker=false;throw new DOMException('Picker cancelled','AbortError')} const name=options.id==='madnolia-browser-model-folder'?'runtime-model-folder':'runtime-smoke';return (await navigator.storage.getDirectory()).getDirectoryHandle(name,{create:true}) } });
  ` }, session)
  await command("Page.navigate", { url: `http://127.0.0.1:${address.port}/madnolia/${smokeDiagnostics ? "?asr-diagnostics=1" : ""}` }, session)
  const evaluate = async (expression, timeout = 20_000) => {
    new Function(expression)
    const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout }, session, timeout + 5_000)
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  const waitFor = async (expression, label, attempts = 100) => {
    for (let i = 0; i < attempts; i += 1) {
      if (await evaluate(expression)) return
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
    const details = await evaluate("JSON.stringify({body:document.body.innerText,errors:window.__runtimeSmokeErrors??[],alerts:[...document.querySelectorAll('[role=alert]')].map(item=>item.textContent),buttons:[...document.querySelectorAll('.browser-workspace-gate button')].map(item=>({text:item.textContent,disabled:item.disabled})),pickerCalls:window.__runtimeSmokePickerCalls})").catch(() => "")
    throw new Error(`Timed out waiting for ${label}${details ? `: ${details}` : ""}`)
  }
  const clickWithPointer = async (selector, label) => {
    const point = await evaluate(`(()=>{const button=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(item=>!item.disabled).at(-1);if(!button)throw Error(${JSON.stringify(`${label} enabled button is missing`)});button.scrollIntoView({block:'center'});const rect=button.getBoundingClientRect();const x=rect.x+rect.width/2,y=rect.y+rect.height/2;return {x,y,text:button.textContent,disabled:button.disabled,top:document.elementFromPoint(x,y)?.textContent?.slice(0,80)}})()`)
    await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, session)
    await command("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point }, session)
    await command("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point }, session)
    const events = await evaluate("window.__runtimeSmokeClicks")
    log("production-ui-pointer", { label, ...point, events })
    return events
  }
  await waitFor("document.readyState==='complete'", "static page load")
  if (asrMode || recoveryMode || reprocessMode) await waitFor("!!document.querySelector('.browser-workspace-gate') || !!document.querySelector('.browser-workspace-shell')", "React workspace gate or shell")
  if (asrMode || recoveryMode || reprocessMode) {
    log("folder-picker-context", await evaluate("({secure:window.isSecureContext,picker:typeof window.showDirectoryPicker,pickerSource:String(window.showDirectoryPicker),origin:location.origin})"))
    const openWorkspace = async () => {
      if (await evaluate("!!document.querySelector('.browser-workspace-gate')")) {
        await waitFor("(!!document.querySelector('.browser-workspace-shell') && !document.querySelector('.browser-workspace-gate')) || [...document.querySelectorAll('.browser-workspace-gate button')].some(button=>!button.disabled && button.textContent.includes('작업공간 폴더 선택'))", "restored workspace shell or ready picker")
        if (await evaluate("!!document.querySelector('.browser-workspace-gate') && [...document.querySelectorAll('.browser-workspace-gate button')].some(button=>!button.disabled && button.textContent.includes('작업공간 폴더 선택'))")) {
          await clickWithPointer(".browser-workspace-gate button", "Workspace folder selection")
          await waitFor("!!document.querySelector('.browser-workspace-shell') && !document.querySelector('.browser-workspace-gate')", "production workspace connection")
        }
      }
    }
    const openModelPanel = async () => {
      if (!await evaluate("!!document.querySelector('[aria-label=\"로컬 모델 폴더\"]')")) {
        await evaluate(`(()=>{const button=[...document.querySelectorAll('.browser-workspace-controls button')].find(item=>item.textContent.trim().startsWith('모델 '));if(!button)throw Error('Production model-panel toggle is unavailable');button.click()})()`)
      }
      await waitFor("!!document.querySelector('[aria-label=\"로컬 모델 폴더\"]')", "model-folder controls")
    }
    await openWorkspace()
    if (recoveryMode) {
      await evaluate(`(()=>{if(!document.querySelector('.analysis-page')){const button=[...document.querySelectorAll('button')].find(item=>item.textContent.includes('영상 분석'));if(!button)throw Error('Production navigation to Analysis is missing');button.click()}})()`)
      await waitFor("!!document.querySelector('.analysis-page')", "Analysis screen for stale recovery job")
      const staleJob = await evaluate(`(async()=>{const deadline=Date.now()+120000;let last=null;while(Date.now()<deadline){const id=localStorage.getItem('madnolia.analysisJobId');if(!id)return null;try{const ws=await (await navigator.storage.getDirectory()).getDirectoryHandle('runtime-smoke'),jobs=await ws.getDirectoryHandle('jobs'),job=JSON.parse(await (await (await jobs.getFileHandle('analysis-'+id+'.json')).getFile()).text());last={id,status:job.status,stage:job.stage,error:job.error};if(['failed','stopped','complete'].includes(job.status)){const button=document.querySelector('[data-testid="dismiss-analysis-job"]');if(button){button.click();return last}}}catch(error){if(error.name!=='NotFoundError')throw error}await new Promise(resolve=>setTimeout(resolve,500))}throw Error('Harness-owned saved job did not reach a dismissible state within two minutes: '+JSON.stringify({last,body:document.body.innerText.slice(-1200),task:document.querySelector('.global-task-dialog')?.innerText??null}))})()`, 125_000)
      if (staleJob) {
        await waitFor("!localStorage.getItem('madnolia.analysisJobId') && !document.querySelector('.global-task-dialog')", "production dismissal of prior harness-owned saved job", 300)
        log("recovery-stale-job-dismissed", staleJob)
      }
    }
    await openModelPanel()
    await evaluate(`(()=>{const section=document.querySelector('[aria-label="로컬 모델 폴더"]');const selectFor=label=>{const item=[...section.querySelectorAll('label')].find(node=>node.textContent.includes(label))?.querySelector('select');if(!item)throw Error('Missing production setting: '+label);return item};const set=(label,value)=>{const select=selectFor(label),setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;setter.call(select,value);select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}))};set('모델 종류','asr');set('ASR 모델',${JSON.stringify(smokeAsrModel)});set('모델 정밀도',${JSON.stringify(smokePrecision)});set('실행 장치',${JSON.stringify(smokeDevice)})})()`)
    await evaluate(`(()=>{const section=document.querySelector('[aria-label="로컬 모델 폴더"]');const button=[...section.querySelectorAll('button')].find(item=>item.textContent.includes('모델 폴더 연결')||item.textContent.includes('모델 폴더 변경'));if(!button)throw Error('Production model-folder connect button is unavailable');button.click()})()`)
    await waitFor("document.querySelector('[aria-label=\\'로컬 모델 폴더\\']')?.innerText.includes('runtime-model-folder')", "OPFS model-folder connection")

  }
  if (!phoneticsOnly && !asrMode && !recoveryMode && !reprocessMode) {
    const connected = await evaluate(`(async()=>{const m=await import('/madnolia/assets/${workspacePath}');window.__runtimeWorkspaceExports=m;const connect=Object.values(m).find(value=>typeof value==='function'&&value.toString().includes('showDirectoryPicker'));if(!connect)throw Error('Production workspace bundle exports lack showDirectoryPicker behavior: '+Object.keys(m));const handle=await connect();return {exports:Object.keys(m),name:handle.name}})()`)
    log("workspace-connected", connected)
  }
  const imported = await evaluate(`(async()=>{const m=await import('/madnolia/assets/${routerPath}');window.__runtimeRouterExports=m;if(typeof m.handleBrowserRequest!=='function')throw Error('Production router does not export handleBrowserRequest');window.__runtimeRouter=m.handleBrowserRequest;return {exports:Object.keys(m),callableCount:1}})()`)
  assert.equal(imported.callableCount, 1)
  const noApiNetwork = () => requests.filter((url) => url.origin === `http://127.0.0.1:${address.port}` && url.pathname.startsWith("/api/")).map((url) => url.href)
  if (reprocessMode) {
    const speechResponse = await fetch("https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav")
    assert.ok(speechResponse.ok, `Could not download the JFK speech fixture: ${speechResponse.status}`)
    const fixture = Buffer.from(await speechResponse.arrayBuffer()).toString("base64")
    const seeded = await evaluate(`(async()=>{
      const root=await navigator.storage.getDirectory(),ws=await root.getDirectoryHandle('runtime-smoke');
      const phonetics=await import('/madnolia/assets/${phoneticsPath}');const pronounce=phonetics.pronounceBrowserWords;if(typeof pronounce!=='function')throw Error('Production pronunciation API is unavailable');
      const words=[{text:'And',start_ms:120,end_ms:400,confidence:null},{text:'so',start_ms:400,end_ms:820,confidence:null},{text:'my',start_ms:820,end_ms:1000,confidence:null},{text:'fellow',start_ms:1000,end_ms:1300,confidence:null},{text:'Americans',start_ms:1300,end_ms:2200,confidence:null},{text:'ask',start_ms:2300,end_ms:2650,confidence:null},{text:'not',start_ms:2650,end_ms:3050,confidence:null},{text:'what',start_ms:3050,end_ms:3450,confidence:null},{text:'your',start_ms:3450,end_ms:3850,confidence:null},{text:'country',start_ms:3850,end_ms:4500,confidence:null},{text:'can',start_ms:4500,end_ms:4850,confidence:null},{text:'do',start_ms:4850,end_ms:5200,confidence:null},{text:'for',start_ms:5200,end_ms:5550,confidence:null},{text:'you',start_ms:5550,end_ms:6000,confidence:null},{text:'ask',start_ms:6200,end_ms:6550,confidence:null},{text:'what',start_ms:6550,end_ms:6950,confidence:null},{text:'you',start_ms:6950,end_ms:7250,confidence:null},{text:'can',start_ms:7250,end_ms:7600,confidence:null},{text:'do',start_ms:7600,end_ms:7950,confidence:null},{text:'for',start_ms:7950,end_ms:8300,confidence:null},{text:'your',start_ms:8300,end_ms:8700,confidence:null},{text:'country',start_ms:8700,end_ms:9700,confidence:null}];
      const pronunciations=await pronounce(words.map(word=>word.text),'EN');const counts=new Map();const phones=pronunciations.map((phone,index)=>{const same=pronunciations.slice(0,index).filter(item=>item.word_index===phone.word_index).length;const word=words[phone.word_index],portion=(same+1)/Math.max(1,pronunciations.filter(item=>item.word_index===phone.word_index).length);const start=Math.round(word.start_ms+(word.end_ms-word.start_ms)*(portion-1/Math.max(1,pronunciations.filter(item=>item.word_index===phone.word_index).length)));return {occurrence_id:'saved-phone-'+index,source_id:'reprocess-source',sentence_index:0,word_index:phone.word_index,grapheme:phone.grapheme,pronunciation:phone.ipa,phone_id:phone.phone_id,ipa:phone.ipa,start_ms:start,end_ms:Math.max(start+1,start+50),confidence:null,alignment_method:'ESTIMATED_WORD',alignment_status:'ESTIMATED'}});
      const audioBytes=Uint8Array.from(atob(${JSON.stringify(fixture)}),c=>c.charCodeAt(0));const write=async(path,blob)=>{const parts=path.split('/');let dir=ws;for(const part of parts.slice(0,-1))dir=await dir.getDirectoryHandle(part,{create:true});const handle=await dir.getFileHandle(parts.at(-1),{create:true}),writer=await handle.createWritable();await writer.write(blob);await writer.close()};
      const source={source_id:'reprocess-source',path:'legacy/jfk.wav',duration_ms:11000,audio_sample_rate:new DataView(audioBytes.buffer,audioBytes.byteOffset,audioBytes.byteLength).getUint32(24,true),audio_channels:new DataView(audioBytes.buffer,audioBytes.byteOffset,audioBytes.byteLength).getUint16(22,true),video_width:null,video_height:null,video_fps:null};
      const transcript=words.map(word=>word.text).join(' ');
      const overview={source_id:source.source_id,transcript,audio_regions:[{region_type:'SPEECH',start_ms:0,end_ms:11000}],sentences:[{sentence_index:0,text:transcript,start_ms:120,end_ms:9700,word_start_index:0,word_end_index:words.length}],words,transcript_candidates:[{model_name:'saved-candidate',transcript:'original candidate'}],word_count:words.length,phone_count:phones.length};
      const analysisId='reprocess-saved-analysis',projectId='reprocess-saved-project',collageId='reprocess-saved-collage';
      const inference_metadata={precision:'baseline',asr_language:'en',asr_task:'transcribe',asr_models:[{model_name:'saved-asr',model_revision:'saved-revision',dtype:'fp32',device:'wasm',enabled:true}],alignment:{model_name:'old-ctc',model_revision:'old',dtype:'fp32',device:'wasm',enabled:false},acoustic_units:{model_name:'old-hubert',model_revision:'old',dtype:'fp32',device:'wasm',enabled:false}};
      const record={summary:{analysis_id:analysisId,created_at:new Date().toISOString(),model_name:'legacy-python',nickname:'Imported speech',source},source,overview,phones,acoustic_features:phones.map(phone=>({occurrence_id:phone.occurrence_id,rms_db:-90,peak_db:-90,f0_hz:null,voiced_probability:0,acoustic_unit_id:null})),inference_metadata,audio_path:'analyses/'+analysisId+'/audio.wav',media_path:''};
      const manifest={project_id:projectId,name:'Reprocess fixture',analysis_ids:[analysisId],source_analyses:{[source.source_id]:analysisId},created_at:new Date().toISOString(),model_name:'legacy-python',inference_backend:'unknown',inference_device:'unknown',sources:[source]};
      const project={analysis_ids:[analysisId],detail:{manifest,analyses:[overview]}};
      const collage={composition_id:collageId,corpus_project_id:projectId,name:'Keep occurrence links',target_text:'Hello',target_pronunciation:'',created_at:new Date().toISOString(),updated_at:new Date().toISOString(),crossfade_ms:0,segments:[{source_id:source.source_id,phone_units:[{source_occurrence_id:phones[0].occurrence_id}]}]};
      await write(record.audio_path,new Blob([audioBytes],{type:'audio/wav'}));await write('analyses/'+analysisId+'/analysis.json',new Blob([JSON.stringify(record)],{type:'application/json'}));await write('projects/'+projectId+'/project.json',new Blob([JSON.stringify(project)],{type:'application/json'}));await write('collages/'+collageId+'/collage.json',new Blob([JSON.stringify(collage)],{type:'application/json'}));
      return {analysisId,projectId,collageId,phoneCount:phones.length,record:JSON.stringify(record),collage:JSON.stringify(collage)}
    })()`)
    await evaluate("window.location.hash='#/analysis'")
    await waitFor("(()=>{const page=document.querySelector('.analysis-page');return !!page&&page.getClientRects().length>0&&!document.querySelector('.analysis-list')&&!document.querySelector('#project-name')&&!document.querySelector('.workflow-page:not(.analysis-page)')})()", "visible AnalysisPage mounted and ProjectsPage unmounted before seeded project refresh")
    await evaluate("window.location.hash='#/projects'")
    await waitFor("!!document.querySelector('.workflow-page:not(.analysis-page)')&&!!document.querySelector('.analysis-list')&&[...document.querySelectorAll('.analysis-item')].some(item=>item.innerText.includes('reprocess-saved-analysis'))", "saved imported analysis on ProjectsPage")
    await evaluate(`(()=>{const row=[...document.querySelectorAll('.analysis-item')].find(item=>item.innerText.includes(${JSON.stringify(seeded.analysisId)}));const button=[...row.querySelectorAll('button')].find(item=>item.textContent.includes('재처리 선택'));if(!button)throw Error('Saved analysis reprocess selection is missing');button.click();const precision=document.querySelector('#reprocess-precision'),device=document.querySelector('#reprocess-device');precision.value=${JSON.stringify(smokePrecision)};precision.dispatchEvent(new Event('change',{bubbles:true}));device.value=${JSON.stringify(smokeDevice)};device.dispatchEvent(new Event('change',{bubbles:true}));const hubert=[...document.querySelectorAll('.workflow-card label')].find(item=>item.textContent.includes('HuBERT 음향 특징 포함'))?.querySelector('input');if(!hubert)throw Error('HuBERT reprocessing option is missing');if(!hubert.checked)hubert.click()})()`)
    const prepare = await evaluate(`(async()=>{const button=[...document.querySelectorAll('.workflow-card button')].find(item=>item.textContent.includes('선택한 CTC/HuBERT 모델 준비'));if(!button)throw Error('Reprocessing model preparation action is missing');button.click();const deadline=Date.now()+900000;while(Date.now()<deadline){if(!button.disabled&&document.body.innerText.includes('CTC · 준비됨')&&document.body.innerText.includes('HuBERT · 준비됨'))return true;if(!button.disabled){const status=[...document.querySelectorAll('.workflow-card [role=status]')].map(item=>item.textContent).join(';');if(status)throw Error(status)}await new Promise(resolve=>setTimeout(resolve,500))}throw Error('Reprocessing model preparation timed out')})()`, 910_000)
    assert.equal(prepare, true)
    const preparedFiles = await evaluate(`(async()=>{const root=await navigator.storage.getDirectory(),folder=await root.getDirectoryHandle('runtime-model-folder');const paths=[];const walk=async(dir,prefix='')=>{for await(const [name,entry] of dir.entries()){if(entry.kind==='directory')await walk(entry,prefix+name+'/');else paths.push(prefix+name)}};await walk(folder);return paths})()`)
    assert.ok(preparedFiles.length, "Reprocessing did not prepare CTC/HuBERT artifacts")
    assert.deepEqual(preparedFiles.filter((path) => /whisper|asr/i.test(path)), [], "Reprocessing prepared ASR model artifacts")
    await command("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, session)
    modelNetworkBlockedAt = Date.now()
    await command("Network.setBlockedURLs", { urls: ["*huggingface.co/*", "*hf.co/*", "*cdn.jsdelivr.net/*", "*cdnjs.cloudflare.com/*"] }, session)
    for (const workerSession of workerSessions) {
      await command("Network.setBlockedURLs", { urls: ["*huggingface.co/*", "*hf.co/*", "*cdn.jsdelivr.net/*", "*cdnjs.cloudflare.com/*"] }, workerSession)
      blockedWorkerSessions.add(workerSession)
    }
    const clickStart = await evaluate(`(()=>{const button=[...document.querySelectorAll('.workflow-card button')].find(item=>item.textContent.includes('선택한 분석 재처리'));if(!button||button.disabled)throw Error('Selected analysis reprocess action is disabled');button.click();return true})()`)
    assert.equal(clickStart, true)
    const result = await evaluate(`(async()=>{const deadline=Date.now()+900000;while(Date.now()<deadline){if(!document.querySelector('.global-task-dialog')){const message=[...document.querySelectorAll('.workflow-card [role=status]')].map(item=>item.textContent).find(text=>text.includes('재처리')||text.includes('실패'));if(message&&!message.includes('완료'))throw Error(message);if(message?.includes('완료'))break}await new Promise(resolve=>setTimeout(resolve,500))}if(document.querySelector('.global-task-dialog'))throw Error('Reprocessing inference timed out');const root=await navigator.storage.getDirectory(),ws=await root.getDirectoryHandle('runtime-smoke');const read=async(path)=>{let dir=ws;const parts=path.split('/');for(const part of parts.slice(0,-1))dir=await dir.getDirectoryHandle(part);return JSON.parse(await (await dir.getFileHandle(parts.at(-1))).getFile().then(file=>file.text()))};const after=await read('analyses/${seeded.analysisId}/analysis.json'),project=await read('projects/${seeded.projectId}/project.json');let units=null;if(after.acoustic_units_path){const unitPath=after.acoustic_units_path.split('/');let unitDir=ws;for(const part of unitPath.slice(0,-1))unitDir=await unitDir.getDirectoryHandle(part);units=JSON.parse(await (await unitDir.getFileHandle(unitPath.at(-1))).getFile().then(file=>file.text()))}let collageDir=await ws.getDirectoryHandle('collages').then(dir=>dir.getDirectoryHandle('${seeded.collageId}'));const collageAfter=await collageDir.getFileHandle('collage.json').then(handle=>handle.getFile()).then(file=>file.text());const backupRoot=await ws.getDirectoryHandle('analyses').then(dir=>dir.getDirectoryHandle('${seeded.analysisId}')).then(dir=>dir.getDirectoryHandle('reprocess-backups'));return {after,project,collageAfter,backupExists:(await (async()=>{let found=false;for await(const entry of backupRoot.values())if(entry.kind==='directory')found=true;return found})()),ctcAlignedCount:after.phones.filter(phone=>phone.alignment_method==='CTC_FORCED'&&phone.alignment_status==='ALIGNED').length,hubertCentroids:units?.centroids?.length??0,hubertDimensions:units?.dimensions??0}})()`, 910_000)
    const original = JSON.parse(seeded.record)
    assert.equal(result.after.overview.transcript, original.overview.transcript)
    assert.equal(result.after.overview.phone_count, result.after.phones.length)
    assert.deepEqual(result.after.overview.transcript_candidates, original.overview.transcript_candidates)
    assert.deepEqual(result.after.source, original.source)
    assert.deepEqual(result.after.overview.words, original.overview.words)
    assert.deepEqual(result.after.inference_metadata, original.inference_metadata)
    assert.deepEqual(result.after.phones.map((phone) => phone.occurrence_id), original.phones.map((phone) => phone.occurrence_id))
    assert.equal(result.collageAfter, seeded.collage)
    assert.equal(Object.hasOwn(result.after, "inference_metadata"), true)
    assert.ok(result.after.reprocessing_metadata?.alignment.enabled)
    assert.ok(result.after.reprocessing_metadata?.acoustic_units.enabled)
    assert.ok(result.hubertCentroids > 0 && result.hubertDimensions === 768, "Reprocessing did not persist 768-dimensional HuBERT centroids")
    assert.notDeepEqual(result.after.acoustic_features, original.acoustic_features)
    assert.ok(result.ctcAlignedCount > 0, "Reprocessing did not persist CTC aligned output")
    assert.deepEqual(result.project.detail.analyses[0], result.after.overview)
    assert.deepEqual(result.project.detail.manifest.sources[0], result.after.source)
    assert.notDeepEqual(result.after.phones.map((phone) => [phone.start_ms, phone.end_ms]), original.phones.map((phone) => [phone.start_ms, phone.end_ms]))
    assert.ok(result.backupExists, "Committed analysis backup was not retained")
    assert.ok(blockedWorkerSessions.size > 0, "Reprocessing worker did not inherit blocked model hosts")
    assert.deepEqual([...workerSessions].filter((workerSession) => !blockedWorkerSessions.has(workerSession)), [], "An attached worker did not inherit blocked model hosts")
    const externalModelResponses = networkResponses.filter((item) => item.at >= modelNetworkBlockedAt && /https:\/\/(?:[^/]+\.)?(?:huggingface\.co|hf\.co|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)\//u.test(item.url) && item.status < 400)
    assert.deepEqual(externalModelResponses, [], "Reprocessing received successful responses from external model hosts after blocking")
    assert.deepEqual(failures.filter((failure) => failure.startsWith("Worker network block failed:")), [], "Every reprocessing worker must inherit external model host blocking")
    assert.equal(noApiNetwork().length, 0, "Production UI made HTTP API requests instead of using its local router")
    log("analysis-reprocess-complete", { phoneCount: result.after.phones.length, ctcAligned: result.after.phones.filter((phone) => phone.alignment_status === "ALIGNED").length, acousticUnits: result.after.reprocessing_metadata.acoustic_units.enabled, stablePhoneIds: true, collageUnchanged: true, transcriptAndWordsUnchanged: true, externalModelHostsBlocked: true })
  }
  if (asrMode || recoveryMode) {
    await evaluate("window.location.hash='#/analysis'")
    await waitFor("!!document.querySelector('.analysis-page')", "production analysis page")
    await evaluate(`(async()=>{const m=await import('/madnolia/assets/${routerPath}');window.__runtimeRouter=m.handleBrowserRequest})()`)
    const settingsState = await evaluate(`(async()=>{const root=document.querySelector('.analysis-page');const selectFor=label=>{const select=[...root.querySelectorAll('label')].find(node=>node.textContent.includes(label))?.querySelector('select');if(!select)throw Error('Missing AnalysisPage setting: '+label);return select};const set=async(label,value)=>{const select=selectFor(label),setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;setter.call(select,value);select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,0))};await set('전사 모델',${JSON.stringify(smokeAsrModel)});await set('실행 장치',${JSON.stringify(smokeDevice)});await set('모델 정밀도',${JSON.stringify(smokePrecision)});await set('음소 정렬',${JSON.stringify(smokeAlignment)});await set('추가 전사 모델','');const checkbox=root.querySelector('label.analysis-checkbox input[type=checkbox]');if(!checkbox)throw Error('Missing AnalysisPage HuBERT setting');if(checkbox.checked!==${smokeAcousticUnits})checkbox.click();await new Promise(resolve=>setTimeout(resolve,0));return {model:selectFor('전사 모델').value,device:selectFor('실행 장치').value,precision:selectFor('모델 정밀도').value,alignment:selectFor('음소 정렬').value,candidate:selectFor('추가 전사 모델').value,acoustic:checkbox.checked}})()`)
    assert.deepEqual(settingsState, { model: smokeAsrModel, device: smokeDevice, precision: smokePrecision, alignment: smokeAlignment, candidate: "", acoustic: smokeAcousticUnits })
    const batchPrepare = await evaluate(`(async()=>{const root=document.querySelector('.analysis-page');const button=[...root.querySelectorAll('button')].find(item=>item.textContent.includes('선택 모델 일괄 준비'));if(!button||button.disabled)throw Error('AnalysisPage batch preparation control is unavailable');let observedBusy=false;const observer=new MutationObserver(records=>{if(button.disabled||records.some(record=>record.attributeName==='disabled'&&record.oldValue!==null))observedBusy=true});try{observer.observe(button,{attributes:true,attributeFilter:['disabled'],attributeOldValue:true});button.click();const deadline=Date.now()+900000;while(Date.now()<deadline){if(button.disabled)observedBusy=true;if(observedBusy&&!button.disabled){const errors=[...root.querySelectorAll('[role=alert]')].map(item=>item.textContent).filter(Boolean);if(errors.length)throw Error(errors.join('; '));return {prepared:true,observedBusy}}await new Promise(resolve=>setTimeout(resolve,250))}throw Error('AnalysisPage batch model preparation timed out')}finally{observer.disconnect()}})()`, 910_000)
    assert.equal(batchPrepare.prepared, true)
    log("analysis-page-batch-prepared", { ...settingsState, prepared: batchPrepare.prepared })
    const folderAudit = await evaluate(`(async()=>{const root=await navigator.storage.getDirectory();const folder=await root.getDirectoryHandle('runtime-model-folder');const files=[];const walk=async(dir,prefix='')=>{for await(const [name,entry] of dir.entries()){if(entry.kind==='directory')await walk(entry,prefix+name+'/');else files.push({path:prefix+name,size:(await entry.getFile()).size,lastModified:(await entry.getFile()).lastModified})}};await walk(folder);const model=files.find(file=>file.path.endsWith('.onnx'));if(!model)throw Error('AnalysisPage batch did not place ONNX files in the connected model folder');const sentinel=await folder.getFileHandle('user-owned.txt',{create:true});const writer=await sentinel.createWritable();await writer.write('preserve-this-user-file');await writer.close();return {files:files.length,model:model.path,size:model.size,lastModified:model.lastModified,sentinel:true}})()`);assert.ok(folderAudit.files>0&&folderAudit.size>0,JSON.stringify(folderAudit));log('model-folder-ui-prepared',folderAudit)
    if (modelFolderMode) {
    await evaluate(`(()=>{window.__cancelNextDirectoryPicker=true;const button=[...document.querySelectorAll('button')].find(item=>item.textContent.includes('모델 폴더 변경'));if(!button)throw Error('Production model-folder change button is unavailable');button.click()})()`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    const cancelCheck = await evaluate(`(async()=>{const root=await navigator.storage.getDirectory();const folder=await root.getDirectoryHandle('runtime-model-folder');const file=await folder.getFileHandle('user-owned.txt').then(handle=>handle.getFile());return {connected:document.querySelector('[aria-label="로컬 모델 폴더"]')?.innerText.includes('runtime-model-folder')??false,sentinel:await file.text()}})()`)
    assert.equal(cancelCheck.connected, true)
    assert.equal(cancelCheck.sentinel, "preserve-this-user-file")
    log("model-folder-cancel-preserved", cancelCheck)
    const repair = await evaluate(`(async()=>{const root=await navigator.storage.getDirectory();const folder=await root.getDirectoryHandle('runtime-model-folder');const walk=async(dir,prefix='')=>{for await(const [name,entry] of dir.entries()){if(entry.kind==='directory'){const found=await walk(entry,prefix+name+'/');if(found)return found}else if(name.endsWith('.onnx'))return {path:prefix+name,size:(await entry.getFile()).size}}return null};const missing=await walk(folder);if(!missing)throw Error('No ONNX file available to simulate a partial existing folder');const keepPath=(await (async()=>{const all=[];const scan=async(dir,prefix='')=>{for await(const [name,entry] of dir.entries()){if(entry.kind==='directory')await scan(entry,prefix+name+'/');else if(name.endsWith('.onnx')&&prefix+name!==missing.path)all.push(prefix+name)}};await scan(folder);return all})())[0];if(!keepPath)throw Error('Tiny model has no second ONNX artifact for reuse verification');let keepDir=folder;const keepParts=keepPath.split('/');for(const part of keepParts.slice(0,-1))keepDir=await keepDir.getDirectoryHandle(part);const kept=await keepDir.getFileHandle(keepParts.at(-1)).then(handle=>handle.getFile());let parent=folder;const parts=missing.path.split('/');for(const part of parts.slice(0,-1))parent=await parent.getDirectoryHandle(part);await parent.removeEntry(parts.at(-1));return {missing:missing.path,kept:keepPath,keptSize:kept.size,keptLastModified:kept.lastModified}})()`)
    await evaluate(`(async()=>{const select=[...document.querySelectorAll('label')].find(node=>node.textContent.includes('모델 정밀도'))?.querySelector('select');if(!select)throw Error('Production precision setting is unavailable');select.value='baseline';select.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,100));select.value='compact';select.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    const repaired = await evaluate(`(async()=>{const section=document.querySelector('[aria-label="로컬 모델 폴더"]');const button=[...section.querySelectorAll('button')].find(item=>item.textContent.includes('다운로드'));if(!button)throw Error('Partial model folder is not offered for repair');button.click();const deadline=Date.now()+900000;while(Date.now()<deadline){const ready=[...section.querySelectorAll('button')].find(item=>item.textContent.includes('모델 준비 완료'));if(ready){const root=await navigator.storage.getDirectory();const folder=await root.getDirectoryHandle('runtime-model-folder');const sentinel=await folder.getFileHandle('user-owned.txt').then(handle=>handle.getFile());let keep=folder;for(const part of ${JSON.stringify(repair.kept.split("/").slice(0,-1))})keep=await keep.getDirectoryHandle(part);const keptFile=await keep.getFileHandle(${JSON.stringify(repair.kept.split("/").at(-1))}).then(handle=>handle.getFile());let restored=folder;for(const part of ${JSON.stringify(repair.missing.split("/").slice(0,-1))})restored=await restored.getDirectoryHandle(part);const restoredFile=await restored.getFileHandle(${JSON.stringify(repair.missing.split("/").at(-1))}).then(handle=>handle.getFile());return {sentinel:await sentinel.text(),keptSize:keptFile.size,keptLastModified:keptFile.lastModified,restoredSize:restoredFile.size}}const error=section.querySelector('[role="alert"]')?.textContent;if(error)throw Error(error);await new Promise(resolve=>setTimeout(resolve,500))}throw Error('Production UI partial model preparation timed out')})()`, 910_000)
    assert.equal(repaired.sentinel, "preserve-this-user-file")
    assert.ok(repaired.keptSize > 0 && repaired.restoredSize > 0, JSON.stringify(repaired))
    assert.equal(repaired.keptSize, repair.keptSize)
    assert.equal(repaired.keptLastModified, repair.keptLastModified)
    log("model-folder-reused-and-repaired", { ...repair, ...repaired })
    await command("Page.reload", {}, session)
    await waitFor("document.readyState==='complete'", "reload after model-folder preparation")
    if (await evaluate("!!document.querySelector('.browser-workspace-gate')")) {
      await waitFor("(!!document.querySelector('.browser-workspace-shell') && !document.querySelector('.browser-workspace-gate')) || [...document.querySelectorAll('.browser-workspace-gate button')].some(button=>!button.disabled && button.textContent.includes('작업공간 폴더 선택'))", "restored workspace shell or picker after reload")
      if (await evaluate("!!document.querySelector('.browser-workspace-gate') && [...document.querySelectorAll('.browser-workspace-gate button')].some(button=>!button.disabled && button.textContent.includes('작업공간 폴더 선택'))")) {
        await clickWithPointer(".browser-workspace-gate button", "Workspace folder reconnection")
        await waitFor("!!document.querySelector('.browser-workspace-shell') && !document.querySelector('.browser-workspace-gate')", "workspace reconnect after reload")
      }
    }
    if (!await evaluate("!!document.querySelector('[aria-label=\"로컬 모델 폴더\"]')")) {
      await evaluate(`(()=>{const button=[...document.querySelectorAll('.browser-workspace-controls button')].find(item=>item.textContent.trim().startsWith('모델 '));if(!button)throw Error('Production model-panel toggle is unavailable');button.click()})()`)
    }
    await waitFor("!!document.querySelector('[aria-label=\"로컬 모델 폴더\"]')", "model-folder controls after reload")
    await waitFor("document.querySelector('[aria-label=\\'로컬 모델 폴더\\']')?.innerText.includes('runtime-model-folder')", "saved model-folder reconnect")
    log("model-folder-reconnected", { folder: "runtime-model-folder" })
    }
  }
  const routerChecks = await evaluate(`(async()=>{
    const call=async(path,init={})=>{const r=await window.__runtimeRouter(path,init);if(!r)throw Error('Unmatched local route '+path);return r};
    const audioAssets=await import('/madnolia/assets/${assetNames.find((n)=>/^audio-[\w-]+\.js$/u.test(n))}');
    window.__runtimeAudio=audioAssets;
    const phonetics=await import('/madnolia/assets/${phoneticsPath}');
    const pronounce=Object.values(phonetics).find(value=>typeof value==='function');
    if(typeof pronounce!=='function')throw Error('Production phonetics bundle has no callable export');
    const korean=await pronounce('국물','KO');
    const english=await pronounce('madnolia','EN');
    const japanese=await pronounce('がっこう','JA');
    if(JSON.stringify(korean.map(({ipa})=>ipa))!==JSON.stringify(['k','u','ŋ','m','u','l']))throw Error('Production Korean fixture differs from the reference: '+JSON.stringify(korean));
    if(JSON.stringify(english.map(({ipa})=>ipa))!==JSON.stringify(['m','æ','d','n','o','ʊ','l','j','ʌ']))throw Error('Production English OOV fixture differs from the reference: '+JSON.stringify(english));
    if(!english.length||english.some(phone=>phone.phone_id==='und.approximate.unknown'))throw Error('Production English OOV model returned no usable pronunciation');
    if(JSON.stringify(japanese.map(({ipa,grapheme})=>[ipa,grapheme]))!==JSON.stringify([['ɡ','が'],['a','が'],['Q','っ'],['k','こ'],['oː','こ']]))throw Error('Production Japanese fixture differs from the reference: '+JSON.stringify(japanese));
    return {audioExports:Object.keys(audioAssets),phoneticsExports:Object.keys(phonetics),koreanPhones:korean.length,koreanOutput:korean.map(({grapheme,phone_id,ipa})=>[grapheme,phone_id,ipa]),englishPhones:english.length,englishOutput:english.map(({grapheme,phone_id,ipa})=>[grapheme,phone_id,ipa]),japanesePhones:japanese.length};
  })()`)
  log("production-bundles", { router: imported.exports, audio: routerChecks.audioExports })
    log("production-phonetics", { exports: routerChecks.phoneticsExports, koreanPhones: routerChecks.koreanPhones, koreanOutput: routerChecks.koreanOutput, englishOovPhones: routerChecks.englishPhones, englishOutput: routerChecks.englishOutput, japanesePhones: routerChecks.japanesePhones })

  if (asrMode || recoveryMode) {
    await mkdir(artifactRoot, { recursive: true })
    const recoveryNonce = recoveryMode ? `${Date.now().toString(36)}-${process.pid.toString(36)}` : ""
    const audioPath = join(artifactRoot, recoveryMode ? "recovery-source.wav" : "jfk.wav")
    const response = await fetch("https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav")
    assert.ok(response.ok, `JFK audio download failed: HTTP ${response.status}`)
    const jfk = new Uint8Array(await response.arrayBuffer())
    assert.ok(jfk.length > 44, "Downloaded JFK audio is empty")
    let sourceAudio = Buffer.from(jfk)
    if (recoveryMode) {
      const sourceDataOffset = sourceAudio.indexOf("data") + 8
      assert.ok(sourceDataOffset >= 12, "Downloaded recovery audio has no PCM data chunk")
      const sourceData = sourceAudio.subarray(sourceDataOffset, sourceDataOffset + sourceAudio.readUInt32LE(sourceDataOffset - 4))
      const channels = sourceAudio.readUInt16LE(22)
      const sampleRate = sourceAudio.readUInt32LE(24)
      const bitsPerSample = sourceAudio.readUInt16LE(34)
      assert.equal(sourceAudio.readUInt16LE(20), 1, "Recovery harness requires real PCM WAV audio")
      assert.ok(channels === 1 || channels === 2, "Recovery harness requires mono or stereo reference audio")
      assert.equal(bitsPerSample, 16, "Recovery harness requires 16-bit reference audio")
      assert.equal(sourceData.length % (channels * bitsPerSample / 8), 0, "Recovery PCM data must align to complete channel frames")
      const repetitions = 7
      const silence = Buffer.alloc(Math.round(sampleRate * 0.35) * channels * bitsPerSample / 8)
      const sections = []
      for (let index = 0; index < repetitions; index += 1) sections.push(sourceData, ...(index + 1 < repetitions ? [silence] : []))
      const nonceSilence = Buffer.alloc(320)
      for (let index = 0; index < nonceSilence.length / 2; index += 1) nonceSilence.writeInt16LE((recoveryNonce.charCodeAt(index % recoveryNonce.length) % 3) - 1, index * 2)
      sections.push(nonceSilence)
      const pcm = Buffer.concat(sections)
      const header = Buffer.alloc(44)
      header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8)
      header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22)
      header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28)
      header.writeUInt16LE(channels * bitsPerSample / 8, 32); header.writeUInt16LE(bitsPerSample, 34)
      header.write("data", 36); header.writeUInt32LE(pcm.length, 40)
      sourceAudio = Buffer.concat([header, pcm])
    }
    await writeFile(audioPath, sourceAudio)
    const encoded = sourceAudio.toString("base64")
    await command("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, session)
    modelNetworkBlockedAt = Date.now()
    await command("Network.setBlockedURLs", { urls: ["*huggingface.co/*", "*hf.co/*", "*cdn.jsdelivr.net/*", "*cdnjs.cloudflare.com/*"] }, session)
    const runRecoveryScenario = async (audioBase64, artifact) => {
      const recoveryFilename = `recovery-${recoveryNonce}.wav`
      await evaluate(`(()=>{if(!document.querySelector('.analysis-page')){const button=[...document.querySelectorAll('button')].find(item=>item.textContent.includes('영상 분석'));if(!button)throw Error('Production navigation to Analysis is missing');button.click()}})()`)
      await waitFor("!!document.querySelector('.analysis-page')", "Analysis screen before recovery")
      const staleJob = await evaluate(`(async()=>{const deadline=Date.now()+120000;while(Date.now()<deadline){const id=localStorage.getItem('madnolia.analysisJobId');if(!id)return null;try{const ws=await (await navigator.storage.getDirectory()).getDirectoryHandle('runtime-smoke'),jobs=await ws.getDirectoryHandle('jobs'),handle=await jobs.getFileHandle('analysis-'+id+'.json'),job=JSON.parse(await (await handle.getFile()).text());if(!['running','pausing','paused','stopping'].includes(job.status)){const button=document.querySelector('[data-testid="dismiss-analysis-job"]');if(!button)throw Error('Terminal harness job has no production dismiss action: '+JSON.stringify(job));button.click();return {id,status:job.status}}}catch(error){if(error.name!=='NotFoundError')throw error}await new Promise(resolve=>setTimeout(resolve,500))}throw Error('Harness profile job did not become dismissible: '+JSON.stringify({id:localStorage.getItem('madnolia.analysisJobId'),body:document.body.innerText.slice(-1000),task:document.querySelector('.global-task-dialog')?.innerText??null}))})()`, 125_000)
      if (staleJob) {
        await waitFor("!localStorage.getItem('madnolia.analysisJobId') && !document.querySelector('.global-task-dialog')", "dismissal of prior harness-owned saved job", 300)
        log("recovery-stale-job-dismissed", staleJob)
      }
      await evaluate(`(async()=>{const input=document.querySelector('#analysis-video-file');const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(${JSON.stringify(audioBase64)}),c=>c.charCodeAt(0))],${JSON.stringify(recoveryFilename)},{type:'audio/wav'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));const deadline=Date.now()+120000;while(Date.now()<deadline){const select=document.querySelector('#analysis-video');const option=[...select?.options??[]].find(item=>item.textContent.includes(${JSON.stringify(recoveryFilename)}));if(option){const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;setter.call(select,option.value);select.dispatchEvent(new Event('change',{bubbles:true}));return select.value}await new Promise(resolve=>setTimeout(resolve,100))}throw Error('Recovery audio upload did not finish: '+JSON.stringify({file:input?.files?.[0]?.name,options:[...document.querySelector('#analysis-video')?.options??[]].map(item=>item.textContent),alerts:[...document.querySelectorAll('[role=alert]')].map(item=>item.textContent)}))})()`, 130_000)
      const preparedSettings = await evaluate(`(()=>{const root=document.querySelector('.analysis-page');const selects=[...root.querySelectorAll('.analysis-settings select')];const values=[${JSON.stringify(smokeAsrModel)},${JSON.stringify(smokeDevice)},${JSON.stringify(smokePrecision)},${JSON.stringify(smokeAlignment)},''];for(let i=0;i<values.length;i++){if(!selects[i])throw Error('Missing saved analysis setting control '+i);const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;setter.call(selects[i],values[i]);selects[i].dispatchEvent(new Event('input',{bubbles:true}));selects[i].dispatchEvent(new Event('change',{bubbles:true}))}const acoustic=root.querySelector('.analysis-checkbox input');if(acoustic.checked!==${smokeAcousticUnits})acoustic.click();const nickname=root.querySelector('#analysis-nickname');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(nickname,'Recovery checkpoint');nickname.dispatchEvent(new Event('input',{bubbles:true}));nickname.dispatchEvent(new Event('change',{bubbles:true}));return {model:selects[0].value,device:selects[1].value,precision:selects[2].value,alignment:selects[3].value,acoustic:acoustic.checked}})()`)
      const checkpointPathsBefore = await evaluate(`(async()=>{const ws=await (await navigator.storage.getDirectory()).getDirectoryHandle('runtime-smoke');let checkpoints;try{checkpoints=await ws.getDirectoryHandle('asr-checkpoints')}catch(error){if(error.name==='NotFoundError')return [];throw error}const walk=async(dir,prefix='')=>{const paths=[];for await(const [name,entry] of dir.entries()){if(entry.kind==='directory')paths.push(...await walk(entry,prefix+name+'/'));else paths.push(prefix+name)}return paths};return walk(checkpoints)})()`)
      const idleBeforeUnload = await evaluate(`(()=>{if(document.querySelector('.global-task-dialog'))throw Error('Harness profile has an active task before analysis start');const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);if(event.defaultPrevented)throw Error('Idle analysis prevented beforeunload');return true})()`)
      assert.equal(idleBeforeUnload, true)
      const started = await evaluate(`(async()=>{const deadline=Date.now()+120000;const expected={model:${JSON.stringify(smokeAsrModel)},device:${JSON.stringify(smokeDevice)},precision:${JSON.stringify(smokePrecision)},alignment:${JSON.stringify(smokeAlignment)},acoustic:${smokeAcousticUnits},filename:${JSON.stringify(recoveryFilename)}};const snapshot=()=>{const root=document.querySelector('.analysis-page'),selects=[...root?.querySelectorAll('.analysis-settings select')??[]],button=root?.querySelector('[data-testid="start-analysis"]'),fileInput=root?.querySelector('#analysis-video-file'),select=root?.querySelector('#analysis-video'),task=document.querySelector('.global-task-dialog');return {jobId:localStorage.getItem('madnolia.analysisJobId'),settings:{filename:select?.selectedOptions?.[0]?.textContent?.trim(),model:selects[0]?.value,device:selects[1]?.value,precision:selects[2]?.value,alignment:selects[3]?.value,acoustic:root?.querySelector('.analysis-checkbox input')?.checked},hardware:root?.querySelector('p')?.innerText??null,button:button?{disabled:button.disabled,text:button.textContent}:null,upload:{file:fileInput?.files?.[0]?.name,selected:select?.value},globalTask:task?.innerText??null,body:document.body.innerText.slice(-1800)}};while(Date.now()<deadline){const state=snapshot(),button=document.querySelector('[data-testid="start-analysis"]'),settings=state.settings;if(button&&!button.disabled&&!state.globalTask&&state.upload.selected===expected.filename&&settings.filename===expected.filename&&settings.model===expected.model&&settings.device===expected.device&&settings.precision===expected.precision&&settings.alignment===expected.alignment&&settings.acoustic===expected.acoustic){button.click();return {clicked:true,state}}await new Promise(resolve=>setTimeout(resolve,200))}throw Error('Analysis start UI did not become enabled after upload/settings settled: '+JSON.stringify(snapshot()))})()`, 130_000)
      assert.equal(started.clicked, true)
      const initial = await evaluate(`(async()=>{const deadline=Date.now()+120000;while(Date.now()<deadline){const id=localStorage.getItem('madnolia.analysisJobId');if(id){try{const ws=await (await navigator.storage.getDirectory()).getDirectoryHandle('runtime-smoke');const jobs=await ws.getDirectoryHandle('jobs');const value=JSON.parse(await (await (await jobs.getFileHandle('analysis-'+id+'.json')).getFile()).text());return {id,recordId:value.record_id,status:value.status,settings:value.settings}}catch(error){if(error.name!=='NotFoundError')throw error}}await new Promise(resolve=>setTimeout(resolve,100))}const button=document.querySelector('[data-testid="start-analysis"]');throw Error('The production UI did not persist a durable analysis job: '+JSON.stringify({jobId:localStorage.getItem('madnolia.analysisJobId'),buttonDisabled:button?.disabled,settings:[...document.querySelectorAll('.analysis-settings select')].map(select=>select.value),globalTask:document.querySelector('.global-task-dialog')?.innerText??null,body:document.body.innerText.slice(-1200)}))})()`)
      assert.equal(initial.settings.nickname, "Recovery checkpoint")
      const firstSaved = await evaluate(`(async()=>{const ws=await (await navigator.storage.getDirectory()).getDirectoryHandle('runtime-smoke');const deadline=Date.now()+300000;let checkpoints=null;const walk=async(dir,prefix='')=>{const files=[];for await(const [name,entry] of dir.entries()){if(entry.kind==='directory')files.push(...await walk(entry,prefix+name+'/'));else if(name.endsWith('.json'))files.push({path:prefix+name,text:await (await entry.getFile()).text()})}return files};while(Date.now()<deadline){const jobId=localStorage.getItem('madnolia.analysisJobId');if(jobId){try{const job=JSON.parse(await (await (await ws.getDirectoryHandle('jobs')).getFileHandle('analysis-'+jobId+'.json').then(handle=>handle.getFile())).text());if(['failed','stopped','complete'].includes(job.status))throw Error('Analysis ended '+job.status+' before a recovery checkpoint: '+job.error)}catch(error){if(error.name!=='NotFoundError')throw error}}try{checkpoints=await ws.getDirectoryHandle('asr-checkpoints')}catch(error){if(error.name!=='NotFoundError')throw error}if(checkpoints){const saved=(await walk(checkpoints)).filter(file=>file.path.endsWith('.json'));const first=saved.filter(file=>!${JSON.stringify(checkpointPathsBefore)}.includes(file.path)&&file.path.includes('/000001-')).at(-1);if(first){const item=JSON.parse(first.text);const rawWords=item.words;if(!Array.isArray(rawWords)||!rawWords.length)throw Error('First durable recovery checkpoint has no saved ASR words');const job=JSON.parse(await (await (await ws.getDirectoryHandle('jobs')).getFileHandle('analysis-'+jobId+'.json').then(handle=>handle.getFile())).text());if(!document.querySelector('.global-task-dialog'))throw Error('Analysis task overlay was idle while the worker was active');const beforeUnload=new Event('beforeunload',{cancelable:true});const defaultPrevented=!window.dispatchEvent(beforeUnload)||beforeUnload.defaultPrevented;if(!defaultPrevented)throw Error('Active analysis did not prevent the beforeunload event');if(!['running','pausing','paused'].includes(job.status))throw Error('Analysis became terminal before interruption: '+job.status);return {count:saved.length,wordCount:rawWords.length,firstWindow:item.window,contextHash:item.context_hash,recordId:job.record_id,stage:job.stage,defaultPrevented,taskActive:true}}}await new Promise(resolve=>setTimeout(resolve,250))}throw Error('No actual ASR window checkpoint was persisted within five minutes: '+JSON.stringify({jobId:localStorage.getItem('madnolia.analysisJobId'),task:document.querySelector('.global-task-dialog')?.innerText??null,body:document.body.innerText.slice(-1500)}))})()`, 310_000)
      assert.equal(firstSaved.recordId, initial.recordId)
      log("recovery-checkpoint-saved", { ...firstSaved, jobId: initial.id })
      await command("Page.reload", {}, session)
      await waitFor("document.readyState==='complete' && (!!document.querySelector('.browser-workspace-shell') || !!document.querySelector('.browser-workspace-gate'))", "workspace reconnect prompt after interrupted analysis", 300)
      if (await evaluate("!!document.querySelector('.browser-workspace-gate')")) {
        await evaluate(`(()=>{const button=document.querySelector('[data-testid="reconnect-workspace"]');if(!button)throw Error('Saved workspace reconnect action is missing');button.click()})()`)
        await waitFor("!!document.querySelector('.browser-workspace-shell')", "saved workspace reconnection", 300)
      }
      await waitFor("!!document.querySelector('[data-testid=\"resume-analysis-job\"]')", "explicit interrupted-job recovery UI", 300)
      await waitFor(`document.querySelector('#analysis-video')?.value===${JSON.stringify(initial.settings.filename)}`, "saved analysis filename restoration", 300)
      const restoredSettings = await evaluate(`(()=>{const page=document.querySelector('.analysis-page');const values=[...page.querySelectorAll('.analysis-settings select')].map(select=>select.value);return {filename:page.querySelector('#analysis-video').value,nickname:page.querySelector('#analysis-nickname').value,model:values[0],device:values[1],precision:values[2]}})()`)
      assert.deepEqual(restoredSettings, { filename: initial.settings.filename, nickname: "Recovery checkpoint", model: smokeAsrModel, device: smokeDevice, precision: smokePrecision })
      await waitFor("document.querySelector('.browser-workspace-shell')?.innerText.includes('runtime-smoke')", "workspace folder restoration after reload")
      await evaluate(`(()=>{const toggle=document.querySelector('.browser-workspace-controls button');if(!document.querySelector('.browser-models-panel'))toggle.click()})()`)
      await waitFor("!!document.querySelector('.browser-models-panel')", "saved model folder controls after reload")
      const modelFolderStatus = await evaluate("document.querySelector('.browser-model-folder')?.innerText ?? ''")
      if (!modelFolderStatus.includes("연결된 폴더: runtime-model-folder")) {
        const reconnectAfterReload = await clickWithPointer('.browser-model-folder .browser-workspace-actions button', "Saved model folder reconnect after reload")
        assert.ok(reconnectAfterReload.some(event => event.trusted && event.target.includes("폴더")), "Model folder reconnection did not use a trusted production UI click")
      }
      await waitFor("document.querySelector('.browser-model-folder')?.innerText.includes('runtime-model-folder')", "model folder reconnection")
      const resetModelFolderClicks = await clickWithPointer('.browser-model-folder .browser-workspace-actions button:last-child', "Model folder reset before retry error")
      assert.ok(resetModelFolderClicks.some(event => event.trusted && event.target.includes("연결 초기화")), "Model folder reset did not use a trusted production UI click")
      await waitFor("document.querySelector('.browser-model-folder')?.innerText.includes('별도로 모델 폴더를 연결하세요')", "model folder disconnection for retry error")
      const failedResumeClicks = await clickWithPointer('[data-testid="resume-analysis-job"]', "Saved-analysis retry with disconnected model folder")
      assert.ok(failedResumeClicks.some(event => event.trusted && event.target.includes("저장 분석 이어하기")), "Retry error check did not use a trusted production UI click")
      await waitFor("(()=>{const button=document.querySelector('[data-testid=\"resume-analysis-job\"]'),alert=document.querySelector('[role=\"alert\"]');return !!button&&!button.disabled&&!!alert?.textContent.includes('Connect the model folder')})()", "saved-analysis retry error and enabled action", 300)
      const retryError = await evaluate(`(async()=>{const id=localStorage.getItem('madnolia.analysisJobId'),ws=await (await navigator.storage.getDirectory()).getDirectoryHandle('runtime-smoke'),jobs=await ws.getDirectoryHandle('jobs'),job=JSON.parse(await (await (await jobs.getFileHandle('analysis-'+${JSON.stringify(initial.id)}+'.json')).getFile()).text()),button=document.querySelector('[data-testid="resume-analysis-job"]'),alert=document.querySelector('[role="alert"]');return {buttonDisabled:button.disabled,error:alert.textContent,jobId:id,recordId:job.record_id,status:job.status}})()`)
      assert.equal(retryError.buttonDisabled, false)
      assert.equal(retryError.jobId, initial.id)
      assert.equal(retryError.recordId, initial.recordId)
      assert.equal(retryError.status, "failed")
      const reconnectAfterError = await clickWithPointer('.browser-model-folder .browser-workspace-actions button', "Model folder reconnect after retry error")
      assert.ok(reconnectAfterError.some(event => event.trusted && event.target.includes("모델 폴더 연결")), "Model folder retry reconnection did not use a trusted production UI click")
      await waitFor("document.querySelector('.browser-model-folder')?.innerText.includes('runtime-model-folder')", "model folder reconnection after retry error")
      const recovered = await evaluate(`(async()=>{const root=document.querySelector('.analysis-page');const deadline=Date.now()+120000;while(Date.now()<deadline){const button=root.querySelector('[data-testid="resume-analysis-job"]');if(button&&!button.disabled)return {button:button.textContent,jobId:localStorage.getItem('madnolia.analysisJobId')};await new Promise(resolve=>setTimeout(resolve,200))}throw Error('Interrupted job did not expose an enabled explicit resume action: '+root.innerText)})()`)
      assert.equal(recovered.jobId, initial.id)
      const interrupted = await evaluate(`(async()=>{const {handleBrowserRequest:router}=await import('/madnolia/assets/${routerPath}');const response=await router('/api/analysis-jobs/${initial.id}');return await response.json()})()`)
      assert.equal(interrupted.status, "failed")
      assert.equal(interrupted.stage, BROWSER_ANALYSIS_INTERRUPTED_STAGE)
      assert.deepEqual(interrupted.settings, initial.settings)
      assert.equal(interrupted.record_id, initial.recordId)
      log("recovery-explicit-action-ready", { jobId: initial.id, status: interrupted.status, stage: interrupted.stage, model: interrupted.settings.model_name, precision: interrupted.settings.precision, device: interrupted.settings.device, filename: interrupted.settings.filename, nickname: interrupted.settings.nickname, checkpointCount: firstSaved.count })
      const resumeClicks = await clickWithPointer('[data-testid="resume-analysis-job"]', "Explicit saved-analysis resume")
      assert.ok(resumeClicks.some(event => event.trusted && event.target.includes("저장 분석 이어하기")), "Recovery did not use a trusted production UI click")
      const resumedProgress = []
      const resumed = await (async () => {
        const startedAt = Date.now()
        let prior = ""
        while (Date.now() - startedAt < 1_200_000) {
          const state = await evaluate(`(async()=>{const {handleBrowserRequest:router}=await import('/madnolia/assets/${routerPath}');const response=await router('/api/analysis-jobs/${initial.id}');return await response.json()})()`)
          const key = `${state.status}:${state.stage}:${state.percent}`
          if (key !== prior) { resumedProgress.push(state); log("recovery-resume-progress", { jobId: state.job_id, status: state.status, stage: state.stage, percent: state.percent, recordId: state.record_id }); prior = key }
          if (state.status === "complete") return state
          if (state.status === "failed" || state.status === "stopped") {
            const ui = await evaluate("JSON.stringify({task:document.querySelector('.global-task-dialog')?.innerText??null,alerts:[...document.querySelectorAll('[role=alert]')].map(item=>item.innerText),resumeDisabled:document.querySelector('[data-testid=\"resume-analysis-job\"]')?.disabled,errors:window.__runtimeSmokeErrors??[]})")
            if (ui.includes("저장 분석 재개")) { await new Promise(resolve => setTimeout(resolve, 500)); continue }
            throw new Error(`Resumed job ended ${state.status}: ${state.error}; UI=${ui}`)
          }
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
        throw new Error("Explicitly resumed analysis timed out")
      })()
      assert.equal(resumed.record_id, initial.recordId)
      const resumedWindowProgress = resumedProgress.map(state => state.stage.match(/(\d+) checkpoint windows reused; (\d+) completed this run/u)).filter(Boolean)
      assert.ok(resumedWindowProgress.some(match => Number(match[1]) > 0 && Number(match[2]) > 0), "Resume did not skip saved windows and run remaining windows")
      const final = await evaluate(`(async()=>{const {handleBrowserRequest:router}=await import('/madnolia/assets/${routerPath}');const response=await router('/api/analyses');const items=await response.json();const matches=items.filter(item=>item.analysis_id===${JSON.stringify(initial.recordId)});const jobResponse=await router('/api/analysis-jobs/${initial.id}');const completed=await jobResponse.json();const ws=await (await navigator.storage.getDirectory()).getDirectoryHandle('runtime-smoke');const record=JSON.parse(await (await (await ws.getDirectoryHandle('analyses')).getDirectoryHandle(${JSON.stringify(initial.recordId)}).then(dir=>dir.getFileHandle('analysis.json')).then(handle=>handle.getFile())).text());return {count:matches.length,analysisId:matches[0]?.analysis_id,nickname:matches[0]?.nickname,words:record.overview.words.length,recordId:completed.record_id}})()`)
      assert.equal(final.count, 1, "Recovery must not create duplicate completed analyses")
      assert.equal(final.recordId, final.analysisId)
      assert.equal(final.nickname, "Recovery checkpoint")
      assert.ok(final.words > firstSaved.wordCount, JSON.stringify(final))
      assert.ok(blockedWorkerSessions.size > 0, "The recovery inference worker did not inherit blocked model hosts")
      assert.deepEqual(failures.filter(failure => failure.startsWith("Worker network block failed:")), [])
      const successfulModelHostResponses = networkResponses.filter(item => item.at >= modelNetworkBlockedAt && /https:\/\/(?:[^/]+\.)?(?:huggingface\.co|hf\.co|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)\//u.test(item.url) && item.status < 400)
      assert.deepEqual(successfulModelHostResponses, [])
      assert.deepEqual(noApiNetwork(), [])
      return { settings: preparedSettings, jobId: initial.id, recordId: initial.recordId, checkpointCountBeforeReload: firstSaved.count, checkpointWordsBeforeReload: firstSaved.wordCount, interruptedCompletedWindows: interrupted.completed_windows, resumedProgress: resumedWindowProgress, completedWords: final.words, duplicateAnalysisCount: final.count, modelHostsBlocked: true, beforeUnloadPrevented: firstSaved.defaultPrevented, artifact }
    }
    if (recoveryMode) {
      const result = await runRecoveryScenario(encoded, audioPath)
      log("analysis-recovery-complete", result)
    } else {
    const start = await evaluate(`(async()=>{
      const {handleBrowserRequest:localRouter}=await import('/madnolia/assets/${routerPath}');if(typeof localRouter!=='function')throw Error('Production local router is unavailable before analysis');
      const bytes=Uint8Array.from(atob(${JSON.stringify(encoded)}),c=>c.charCodeAt(0));
      const input=document.querySelector('#analysis-video-file');if(!input)throw Error('Production media upload control is unavailable');const transfer=new DataTransfer();transfer.items.add(new File([bytes],'jfk.wav',{type:'audio/wav'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
      const deadline=Date.now()+120000;while(Date.now()<deadline){const filename=document.querySelector('#analysis-video')?.value;if(filename){const settings={filename,nickname:'Runtime JFK',model_name:${JSON.stringify(smokeAsrModel)},asr_language:${JSON.stringify(smokeLanguage)},backend:'transformers-js',device:${JSON.stringify(smokeDevice)},alignment_mode:${JSON.stringify(smokeAlignment)},precision:${JSON.stringify(smokePrecision)},candidate_models:[],acoustic_units:${smokeAcousticUnits}};
      const started=await localRouter('/api/analyses',{method:'POST',body:JSON.stringify(settings)});const job=await started.json();if(!started.ok)throw Error(JSON.stringify(job));return {job_id:job.job_id,filename};
      }await new Promise(resolve=>setTimeout(resolve,250))}throw Error('Production media upload did not finish')
    })()`, 130_000)
    log("asr-started", start)
    const runJob = async (jobId, timeoutMs) => {
      const began = Date.now()
      let last = ""
      while (Date.now() - began < timeoutMs) {
        const state = await evaluate(`(async()=>{const {handleBrowserRequest:localRouter}=await import('/madnolia/assets/${routerPath}');const r=await localRouter('/api/analysis-jobs/${jobId}');return await r.json()})()`)
        const key = `${state.status}:${state.stage}:${state.percent}:${state.download_percent}`
        if (key !== last) { log("asr-progress", { run: jobId, status: state.status, stage: state.stage, percent: state.percent, download_percent: state.download_percent }); last = key }
        if (state.status === "complete") return { ...state, smokeDurationMs: Date.now() - began }
        if (state.status === "failed") throw new Error(`ASR job ${jobId} failed: ${state.error}`)
        await new Promise((resolveWait) => setTimeout(resolveWait, 1500))
      }
      throw new Error(`ASR job ${jobId} timed out after ${timeoutMs}ms`)
    }
    const first = await runJob(start.job_id, 900_000)
    const transcript = await evaluate(`(async()=>{const {handleBrowserRequest:localRouter}=await import('/madnolia/assets/${routerPath}');const r=await localRouter('/api/analyses');const a=await r.json();return a.find(x=>x.analysis_id===${JSON.stringify(first.analysis_id)})?.nickname})()`)
    assert.equal(transcript, "Runtime JFK")
    const recordResult = await evaluate(`(async()=>{const root=await navigator.storage.getDirectory();const ws=await root.getDirectoryHandle('runtime-smoke');const dir=await ws.getDirectoryHandle('analyses').then(d=>d.getDirectoryHandle(${JSON.stringify(first.analysis_id)}));const f=await dir.getFileHandle('analysis.json');const record=JSON.parse(await (await f.getFile()).text());const audioPath=record.audio_path.split('/');let audioDir=ws;for(const part of audioPath.slice(0,-1))audioDir=await audioDir.getDirectoryHandle(part);const audio=await audioDir.getFileHandle(audioPath.at(-1)).then(h=>h.getFile());let units=null;if(record.acoustic_units_path){const unitPath=record.acoustic_units_path.split('/');let unitDir=ws;for(const part of unitPath.slice(0,-1))unitDir=await unitDir.getDirectoryHandle(part);units=JSON.parse(await (await unitDir.getFileHandle(unitPath.at(-1))).getFile().then(f=>f.text()))}const words=record.overview.words;return {transcript:record.overview.transcript,words:words.length,invalidWordTimestamps:words.filter(w=>!Number.isFinite(w.start_ms)||!Number.isFinite(w.end_ms)||w.end_ms<=w.start_ms).length,firstWord:words[0]??null,lastWord:words.at(-1)??null,phones:record.phones.length,ctcPhones:record.phones.filter(p=>p.alignment_method==='CTC_FORCED'&&p.alignment_status==='ALIGNED').length,centroidCount:units?.centroids.length??0,dimensions:units?.dimensions??0,audioPath:record.audio_path,audioBytes:audio.size,audioType:audio.type,inferenceMetadata:record.inference_metadata,candidateMetadata:record.overview.transcript_candidates}})()`)
    assert.ok(recordResult.transcript.length > 0 && recordResult.words > 0 && recordResult.phones > 0 && recordResult.audioBytes > 44, JSON.stringify(recordResult))
    assert.equal(recordResult.invalidWordTimestamps, 0, JSON.stringify(recordResult))
    if (smokeAlignment === "ctc") assert.ok(recordResult.ctcPhones > 0, JSON.stringify(recordResult))
    if (smokeAcousticUnits) assert.ok(recordResult.centroidCount > 0 && recordResult.dimensions === 768, JSON.stringify(recordResult))
    assert.equal(recordResult.inferenceMetadata.precision, smokePrecision)
    assert.equal(recordResult.inferenceMetadata.asr_language, smokeLanguage)
    assert.equal(recordResult.inferenceMetadata.asr_task, "transcribe")
    assert.equal(recordResult.inferenceMetadata.asr_models[0].model_name, smokeArtifact)
    assert.equal(recordResult.inferenceMetadata.asr_models[0].model_revision, smokeRevision)
    assert.equal(recordResult.inferenceMetadata.asr_models[0].device, smokeDevice)
    assert.equal(recordResult.inferenceMetadata.asr_models[0].dtype, smokeDtype)
    assert.equal(recordResult.inferenceMetadata.alignment.enabled, smokeAlignment === "ctc")
    assert.equal(recordResult.inferenceMetadata.acoustic_units.enabled, smokeAcousticUnits)
    assert.equal(recordResult.candidateMetadata[0].model_name, smokeArtifact)
    assert.equal(recordResult.candidateMetadata[0].model_revision, recordResult.inferenceMetadata.asr_models[0].model_revision)
    assert.equal(recordResult.candidateMetadata[0].model_dtype, recordResult.inferenceMetadata.asr_models[0].dtype)
    assert.match(recordResult.transcript.toLowerCase(), /president|jfk|kennedy|fellow/)
    const second = await evaluate(`(async()=>{const {handleBrowserRequest:localRouter}=await import('/madnolia/assets/${routerPath}');const form=new FormData();const ws=await navigator.storage.getDirectory();const dir=await ws.getDirectoryHandle('runtime-smoke');const media=await dir.getDirectoryHandle('media');const idx=JSON.parse(await (await (await media.getFileHandle('index.json')).getFile()).text());const name=Object.keys(idx)[0];const relative=idx[name].path.split('/');let folder=dir;for(const part of relative.slice(0,-1))folder=await folder.getDirectoryHandle(part);const file=await folder.getFileHandle(relative.at(-1)).then(h=>h.getFile());form.append('file',new File([file], 'jfk-offline.wav',{type:'audio/wav'}));const up=await localRouter('/api/videos',{method:'POST',body:form});const u=await up.json();if(!up.ok)throw Error(JSON.stringify(u));const r=await localRouter('/api/analyses',{method:'POST',body:JSON.stringify({filename:u.filename,nickname:'Runtime JFK offline',model_name:${JSON.stringify(smokeAsrModel)},asr_language:${JSON.stringify(smokeLanguage)},backend:'transformers-js',device:${JSON.stringify(smokeDevice)},alignment_mode:${JSON.stringify(smokeAlignment)},precision:${JSON.stringify(smokePrecision)},candidate_models:[],acoustic_units:${smokeAcousticUnits}})});const v=await r.json();if(!r.ok)throw Error(JSON.stringify(v));return v.job_id})()`)
    const secondState = await runJob(second, 900_000)
    assert.ok(secondState.analysis_id)
    assert.ok(blockedWorkerSessions.size > 0, "The browser did not attach any inference worker for external-host blocking")
    log("model-host-blocked-workers", { sessions: blockedWorkerSessions.size, inference: [first.job_id, secondState.job_id] })
    const externalModelResponses = networkResponses.filter((item) => item.at >= modelNetworkBlockedAt && /https:\/\/(?:[^/]+\.)?(?:huggingface\.co|hf\.co|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)\//u.test(item.url) && item.status < 400)
    assert.deepEqual(externalModelResponses, [], "Model inference must not receive successful responses from external model hosts after blocking")
    assert.deepEqual(failures.filter((failure) => failure.startsWith("Worker network block failed:")), [], "Every inference worker must inherit external model host blocking")
    assert.deepEqual(noApiNetwork(), [])
    log("asr-complete", { selectedModel: smokeAsrModel, artifactModel: smokeArtifact, revision: smokeRevision, device: smokeDevice, precision: smokePrecision, dtype: smokeDtype, coldRunMs: first.smokeDurationMs, cachedOfflineRunMs: secondState.smokeDurationMs, transcript: recordResult.transcript, wordCount: recordResult.words, firstWord: recordResult.firstWord, lastWord: recordResult.lastWord, phones: recordResult.phones, ctcPhones: recordResult.ctcPhones, hubertCentroids: recordResult.centroidCount, savedAudio: recordResult.audioPath, offlineJob: secondState.job_id, artifact: audioPath })
    }
  } else if (!phoneticsOnly && !reprocessMode) {
    const fixture = await evaluate(`(async()=>{
      const wavBytes=Uint8Array.from(atob(${JSON.stringify(makeFixtureWav().toString("base64"))}),c=>c.charCodeAt(0));const wav=new Blob([wavBytes],{type:'audio/wav'});
      const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;const ctx=canvas.getContext('2d');
      const stream=canvas.captureStream(12);const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});const chunks=[];
      recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};recorder.start(100);
      const started=performance.now();while(performance.now()-started<5700){ctx.fillStyle='#16324f';ctx.fillRect(0,0,160,90);ctx.fillStyle='#f25f5c';ctx.fillRect((performance.now()-started)%130,20,30,30);await new Promise(r=>setTimeout(r,80))}
      await new Promise(r=>{recorder.onstop=r;recorder.stop()});stream.getTracks().forEach(t=>t.stop());
      const video=new Blob(chunks,{type:'video/webm'});if(video.size<1000)throw Error('MediaRecorder produced an empty fixture video');
      const root=await navigator.storage.getDirectory();const ws=await root.getDirectoryHandle('runtime-smoke');
      const write=async(path,blob)=>{const parts=path.split('/');let d=ws;for(const p of parts.slice(0,-1))d=await d.getDirectoryHandle(p,{create:true});const h=await d.getFileHandle(parts.at(-1),{create:true});const w=await h.createWritable();await w.write(blob);await w.close()};
      const mediaPath='media/runtime-source.webm',audioPath='analyses/runtime-analysis/audio.wav';await write(mediaPath,video);await write(audioPath,wav);
      const videoUrl=URL.createObjectURL(video);const videoElement=document.createElement('video');videoElement.src=videoUrl;await new Promise((ok,bad)=>{videoElement.onloadedmetadata=ok;videoElement.onerror=()=>bad(Error('Fixture video metadata decode failed'))});URL.revokeObjectURL(videoUrl);
      const duration=videoElement.duration,rate=16_000,now=new Date().toISOString(),analysisId='runtime-analysis',sourceId='runtime-source';
      const source={source_id:sourceId,path:mediaPath,duration_ms:duration*1000,audio_sample_rate:rate,audio_channels:1,video_width:videoElement.videoWidth,video_height:videoElement.videoHeight,video_fps:12};
      const overview={source_id:sourceId,transcript:'',audio_regions:[],sentences:[],words:[],transcript_candidates:[],word_count:0,phone_count:0};
      const summary={analysis_id:analysisId,created_at:now,model_name:'runtime-fixture',nickname:'Runtime fixture',source};
      const record={summary,source,overview,phones:[],acoustic_features:[],audio_path:audioPath,media_path:mediaPath};
      const manifest={project_id:'runtime-project',name:'Runtime smoke',analysis_ids:[analysisId],source_analyses:{[sourceId]:analysisId},created_at:now,model_name:'runtime-fixture',inference_backend:'transformers-js',inference_device:'browser',sources:[source]};
      const project={detail:{manifest,analyses:[overview]},analysis_ids:[analysisId]};
      const request={name:'Runtime media',target_text:'',target_pronunciation:'',crossfade_ms:0,tempo_bpm:120,beats_per_bar:4,beat_division:4,grid_offset_units:0,pitch_notes:[],segments:[{segment_id:'runtime-segment',candidate_id:'runtime-candidate',target_start_index:0,target_end_index:1,source_id:sourceId,source_start_ms:0,source_end_ms:5500,timeline_start_ms:0,timeline_end_ms:6200,match_status:'EXACT',target_ipa:[],matched_ipa:[],gap_before_ms:0,stretch_percent:112.73,lane:0,phone_units:[],edit_regions:[{region_id:'runtime-region',source_start_ms:0,source_end_ms:5500,output_duration_ms:6200,relative_pitch_cents:25,source_f0_hz:null,pitch_points:[{position:0,midi:57},{position:1,midi:62}]}],volume_envelope:[]}],mode:'PROFESSIONAL',schema_version:1,parent_composition_id:null,parent_composition_updated_at:null};
      await write('analyses/runtime-analysis/analysis.json',new Blob([JSON.stringify(record)],{type:'application/json'}));await write('projects/runtime-project/project.json',new Blob([JSON.stringify(project)],{type:'application/json'}));
      const result=await window.__runtimeRouter('/api/projects/runtime-project/compositions',{method:'POST',body:JSON.stringify(request)});const composition=await result.json();if(!result.ok)throw Error(JSON.stringify(composition));
      const saved=await window.__runtimeRouter('/api/projects/runtime-project/compositions/'+composition.composition_id);const reread=await saved.json();
      const pitch=await window.__runtimeRouter('/api/projects/runtime-project/compositions/pitch-analysis',{method:'POST',body:JSON.stringify(request)});const pitchValue=await pitch.json();if(!pitch.ok)throw Error(JSON.stringify(pitchValue));
      const tune=await window.__runtimeRouter('/api/projects/runtime-project/compositions/autotune',{method:'POST',body:JSON.stringify({composition:request,strength_percent:100,speed_ms:40})});const tuneValue=await tune.json();if(!tune.ok)throw Error(JSON.stringify(tuneValue));
      const preview=await window.__runtimeRouter('/api/projects/runtime-project/compositions/preview',{method:'POST',body:JSON.stringify(request)});if(!preview.ok)throw Error(await preview.text());const previewBytes=new Uint8Array(await preview.arrayBuffer());
      const exportStart=await window.__runtimeRouter('/api/collages/'+composition.composition_id+'/export-jobs/MP4',{method:'POST'});const exportJob=await exportStart.json();if(!exportStart.ok)throw Error(JSON.stringify(exportJob));
      let job;for(let tries=0;tries<180;tries++){const response=await window.__runtimeRouter('/api/export-jobs/'+exportJob.job_id);job=await response.json();if(job.status==='complete'||job.status==='failed')break;await new Promise(r=>setTimeout(r,500))}
      if(job.status!=='complete')throw Error('MP4 export job failed: '+JSON.stringify(job));
      const downloaded=await window.__runtimeRouter('/api/export-jobs/'+exportJob.job_id+'/download');if(!downloaded.ok)throw Error('MP4 download failed');const mp4=new Uint8Array(await downloaded.arrayBuffer());
      const inspect=async(bytes,type)=>{const u=URL.createObjectURL(new Blob([bytes],{type}));const el=document.createElement(type==='video/mp4'?'video':'audio');el.preload='metadata';el.src=u;await new Promise((ok,bad)=>{el.onloadedmetadata=ok;el.onerror=()=>bad(Error(type+' decode failed'))});const value={duration:el.duration,width:el.videoWidth,height:el.videoHeight};el.removeAttribute('src');el.load();URL.revokeObjectURL(u);return value};
      const audioBytes=previewBytes;if(audioBytes.length!==44+Math.round(6200*rate/1000)*2)throw Error('WORLD preview duration does not match the stretched timeline: '+audioBytes.length);const dataView=new DataView(audioBytes.buffer,audioBytes.byteOffset,audioBytes.byteLength);let energy=0,peak=0,finite=true;for(let p=44;p+1<audioBytes.length;p+=2){const x=dataView.getInt16(p,true)/32768;finite&&=Number.isFinite(x);energy+=x*x;peak=Math.max(peak,Math.abs(x))};const estimateHz=centerMs=>{const frameLength=1600,start=Math.max(44,44+Math.round((centerMs-50)*rate/1000)*2),minLag=40,maxLag=160;let mean=0;for(let i=0;i<frameLength;i++)mean+=dataView.getInt16(start+i*2,true)/32768;mean/=frameLength;let bestLag=0,best=-Infinity;for(let lag=minLag;lag<=maxLag;lag++){let dot=0,left=0,right=0;for(let i=0;i+lag<frameLength;i++){const a=dataView.getInt16(start+i*2,true)/32768-mean,b=dataView.getInt16(start+(i+lag)*2,true)/32768-mean;dot+=a*b;left+=a*a;right+=b*b}const score=dot/Math.max(1e-12,Math.sqrt(left*right));if(score>best){best=score;bestLag=lag}}return {hz:rate/bestLag,periodicity:best}};const firstPitch=estimateHz(500),lastPitch=estimateHz(5700);
      const mp4Text=String.fromCharCode(...mp4.slice(0,Math.min(64,mp4.length)));const codecs={avc:mp4Text.includes('ftyp')&&new TextDecoder('latin1').decode(mp4).includes('avc1'),aac:new TextDecoder('latin1').decode(mp4).includes('mp4a')};
      const videoMetadata=await inspect(mp4,'video/mp4');const mp4View=new DataView(mp4.buffer,mp4.byteOffset,mp4.byteLength);const boxes=(start,end)=>{const result=[];for(let offset=start;offset+8<=end;){const size32=mp4View.getUint32(offset),type=String.fromCharCode(mp4[offset+4],mp4[offset+5],mp4[offset+6],mp4[offset+7]);let size=size32,headerSize=8;if(size32===1){if(offset+16>end)break;size=Number(mp4View.getBigUint64(offset+8));headerSize=16}else if(size32===0)size=end-offset;if(size<headerSize||offset+size>end)break;result.push({type,start:offset,payload:offset+headerSize,end:offset+size});offset+=size}return result};const moov=boxes(0,mp4.length).find(box=>box.type==='moov');const frameRates=[];if(moov)for(const trak of boxes(moov.payload,moov.end).filter(box=>box.type==='trak')){const mdia=boxes(trak.payload,trak.end).find(box=>box.type==='mdia');if(!mdia)continue;const children=boxes(mdia.payload,mdia.end),hdlr=children.find(box=>box.type==='hdlr'),mdhd=children.find(box=>box.type==='mdhd'),minf=children.find(box=>box.type==='minf');if(!hdlr||!mdhd||!minf||hdlr.payload+12>hdlr.end)continue;const handler=String.fromCharCode(mp4[hdlr.payload+8],mp4[hdlr.payload+9],mp4[hdlr.payload+10],mp4[hdlr.payload+11]);if(handler!=='vide')continue;const stbl=boxes(minf.payload,minf.end).find(box=>box.type==='stbl'),stts=stbl&&boxes(stbl.payload,stbl.end).find(box=>box.type==='stts');if(!stts)continue;const version=mp4[mdhd.payload],timescaleOffset=mdhd.payload+(version===1?20:12),durationOffset=mdhd.payload+(version===1?24:16);if(timescaleOffset+4>mdhd.end||durationOffset+(version===1?8:4)>mdhd.end)continue;const timescale=mp4View.getUint32(timescaleOffset),duration=version===1?Number(mp4View.getBigUint64(durationOffset)):mp4View.getUint32(durationOffset);if(stts.payload+8>stts.end)continue;const count=mp4View.getUint32(stts.payload+4);let samples=0,totalDuration=0;for(let entry=0;entry<count;entry++){const entryOffset=stts.payload+8+entry*8;if(entryOffset+8>stts.end)break;const sampleCount=mp4View.getUint32(entryOffset);samples+=sampleCount;totalDuration+=sampleCount*mp4View.getUint32(entryOffset+4)}if(timescale&&duration&&totalDuration)frameRates.push(samples*timescale/totalDuration)}
      const textExports={};for(const target of ['EDL','FCPXML']){const started=await window.__runtimeRouter('/api/collages/'+composition.composition_id+'/export-jobs/'+target,{method:'POST'});const textJob=await started.json();if(!started.ok)throw Error(JSON.stringify(textJob));let textState;for(let i=0;i<180;i++){const response=await window.__runtimeRouter('/api/export-jobs/'+textJob.job_id);textState=await response.json();if(textState.status==='complete'||textState.status==='failed')break;await new Promise(resolve=>setTimeout(resolve,100))}if(textState.status!=='complete')throw Error(target+' export failed: '+JSON.stringify(textState));const download=await window.__runtimeRouter('/api/export-jobs/'+textJob.job_id+'/download');if(!download.ok)throw Error(target+' download failed');textExports[target]=await download.text()}
      const base64=bytes=>{let value='';for(let i=0;i<bytes.length;i+=0x8000)value+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(value)};
      return {compositionId:composition.composition_id,compositionSaved:reread.composition_id===composition.composition_id,pitchSegments:pitchValue.segments.length,autotuneSegments:tuneValue.segments.length,wav:{riff:new TextDecoder().decode(audioBytes.slice(0,4)),length:audioBytes.length,finite,peak,rms:Math.sqrt(energy/Math.max(1,(audioBytes.length-44)/2)),firstPitch,lastPitch,metadata:await inspect(audioBytes,'audio/wav')},mp4:{length:mp4.length,codecs,metadata:videoMetadata,frameRates,progress:job.percent,status:job.status,stage:job.stage},textExports,artifacts:{wav:base64(audioBytes),mp4:base64(mp4)}};
    })()`, 120_000)
    assert.equal(fixture.compositionSaved, true)
    assert.ok(fixture.pitchSegments && fixture.autotuneSegments)
    assert.equal(fixture.wav.riff, "RIFF")
    assert.equal(fixture.wav.finite, true)
    assert.ok(fixture.wav.peak > 0.02 && fixture.wav.rms > 0.01)
    assert.ok(fixture.wav.firstPitch.periodicity > 0.4 && fixture.wav.firstPitch.hz > 210 && fixture.wav.firstPitch.hz < 250, JSON.stringify(fixture.wav.firstPitch))
    assert.ok(fixture.wav.lastPitch.periodicity > 0.4 && fixture.wav.lastPitch.hz > 260 && fixture.wav.lastPitch.hz < 320, JSON.stringify(fixture.wav.lastPitch))
    assert.ok(fixture.wav.metadata.duration > 6.1 && fixture.wav.metadata.duration < 6.3)
    assert.equal(fixture.mp4.status, "complete")
    assert.equal(fixture.mp4.progress, 100)
    assert.ok(fixture.mp4.codecs.avc && fixture.mp4.codecs.aac, "MP4 should contain H.264 video and AAC audio")
    assert.ok(fixture.mp4.metadata.duration > 5 && fixture.mp4.metadata.duration < 6.5, "Exported MP4 should decode in the browser")
    assert.equal(fixture.mp4.metadata.width, 160, "Exported MP4 should preserve the source width")
    assert.equal(fixture.mp4.metadata.height, 90, "Exported MP4 should preserve the source height")
    assert.ok(fixture.mp4.frameRates.some((fps) => Math.abs(fps - 12) < 0.1), `Exported MP4 frame rate should be 12 fps: ${JSON.stringify(fixture.mp4.frameRates)}`)
    assert.match(fixture.textExports.EDL, /TITLE: Runtime media[\s\S]*FCM: NON-DROP FRAME/u)
    assert.match(fixture.textExports.FCPXML, /frameDuration="1\/12s" width="160" height="90"/u)
    assert.deepEqual(noApiNetwork(), [], "Local API routes must not make HTTP requests")
    const artifactDir = join(artifactRoot, "media")
    await mkdir(artifactDir, { recursive: true })
    await writeFile(join(artifactDir, "composition-preview.wav"), Buffer.from(fixture.artifacts.wav, "base64"))
    await writeFile(join(artifactDir, "composition.mp4"), Buffer.from(fixture.artifacts.mp4, "base64"))
    log("media-complete", { composition: fixture.compositionId, pitchSegments: fixture.pitchSegments, autotuneSegments: fixture.autotuneSegments, wav: { bytes: fixture.wav.length, peak: fixture.wav.peak, rms: fixture.wav.rms, duration: fixture.wav.metadata.duration }, mp4: fixture.mp4, artifacts: artifactDir })
  }
  assert.deepEqual(noApiNetwork(), [], "Local API routes must not make HTTP requests")
  const localAssetFailures = failures.filter((failure) => failure.includes(`http://127.0.0.1:${address.port}/madnolia/`))
  assert.deepEqual(localAssetFailures, [], `Production runtime asset request failed: ${localAssetFailures.join(", ")}`)
  const externalAppAssets = requests.filter((url) => (url.protocol === "http:" || url.protocol === "https:") && url.origin === `http://127.0.0.1:${address.port}` && !url.pathname.startsWith("/madnolia/") && !url.pathname.endsWith("/favicon.ico"))
  assert.deepEqual(externalAppAssets, [], "All app assets must honor /madnolia/")
  await command("Browser.close")
  browserClosed = true
} catch (error) {
  log("failed", { error: error instanceof Error ? error.stack ?? error.message : String(error) })
  throw error
} finally {
  if (!browserClosed && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ id: 999999999, method: "Browser.close", params: {} }))
    browserClosed = true
  }
  socket?.close()
  if (!browserClosed) browser.kill()
  if (browser.exitCode === null) await Promise.race([once(browser, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 5_000))])
  await new Promise((resolveClose) => server.close(resolveClose))
  const resolved = resolve(profilePath)
  if (!resolved.startsWith(expectedPrefix) || resolved === resolve(tmpdir())) throw new Error(`Refusing to remove unexpected browser profile: ${resolved}`)
  if (!keepProfile && !requestedProfile) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try { await rm(resolved, { recursive: true, force: true }); break }
      catch (error) { if (attempt === 7) throw error; await new Promise((resolveWait) => setTimeout(resolveWait, 250)) }
    }
  }
}
log("passed", { mode: recoveryMode ? "recovery" : reprocessMode ? "reprocess" : asrMode ? "asr" : phoneticsOnly ? "phonetics" : "media", apiNetworkRequests: 0, localAssetFailures: failures.filter((failure) => failure.includes("/madnolia/")).length, externalFailures: failures.length - failures.filter((failure) => failure.includes("/madnolia/")).length })
