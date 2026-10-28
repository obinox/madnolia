import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { extname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const asrMode = process.argv.includes("--asr")
const failures = []
const requests = []
const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)))
const dist = join(webRoot, "dist")
const artifactRoot = resolve(webRoot, "..", ".runtime-audit", "web-only-migration")
await stat(join(dist, "index.html"))
const assetNames = await readdir(join(dist, "assets"))
const routerPath = assetNames.find((name) => /^router-[\w-]+\.js$/u.test(name))
assert.ok(routerPath, "Production router bundle was not found")

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
server.listen(0, "127.0.0.1")
await once(server, "listening")
const address = server.address()
const profile = await mkdtemp(join(tmpdir(), "madnolia-runtime-smoke-"))
const profilePath = resolve(profile)
const expectedPrefix = resolve(tmpdir()) + sep
assert.ok(profilePath.startsWith(expectedPrefix), "Temporary profile escaped the OS temp directory")
const browser = spawn(chromePath, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--remote-allow-origins=*", `--user-data-dir=${profilePath}`], { stdio: "ignore", windowsHide: true })
let socket
let browserClosed = false
const log = (step, details = {}) => process.stdout.write(`${JSON.stringify({ step, ...details })}\n`)
const makeFixtureWav = () => {
  const rate = 16_000
  const sampleCount = Math.round(rate * 1.6)
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
    Object.defineProperty(FileSystemDirectoryHandle.prototype, "queryPermission", { value: async () => "granted" });
    Object.defineProperty(FileSystemDirectoryHandle.prototype, "requestPermission", { value: async () => "granted" });
    Object.defineProperty(window, "showDirectoryPicker", { value: async () => (await navigator.storage.getDirectory()).getDirectoryHandle("runtime-smoke", { create: true }) });
  ` }, session)
  await command("Page.navigate", { url: `http://127.0.0.1:${address.port}/madnolia/` }, session)
  const evaluate = async (expression, timeout = 20_000) => {
    const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout }, session, timeout + 5_000)
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  const waitFor = async (expression, label, attempts = 100) => {
    for (let i = 0; i < attempts; i += 1) {
      if (await evaluate(expression)) return
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
    throw new Error(`Timed out waiting for ${label}`)
  }
  await waitFor("!!document.querySelector('.browser-workspace-gate')", "workspace chooser")
  await evaluate("document.querySelector('.browser-workspace-actions button:last-child').click()")
  await waitFor("!!document.querySelector('.app-header')", "workspace initialization")
  const imported = await evaluate(`(async()=>{const m=await import('/madnolia/assets/${routerPath}');window.__runtimeRouterExports=m;if(typeof m.handleBrowserRequest!=='function')throw Error('Production router does not export handleBrowserRequest');window.__runtimeRouter=m.handleBrowserRequest;return {exports:Object.keys(m),callableCount:1}})()`)
  assert.equal(imported.callableCount, 1)
  const noApiNetwork = () => requests.filter((url) => url.pathname.startsWith("/api/")).map((url) => url.href)
  const routerChecks = await evaluate(`(async()=>{
    const call=async(path,init={})=>{const r=await window.__runtimeRouter(path,init);if(!r)throw Error('Unmatched local route '+path);return r};
    const audioAssets=await import('/madnolia/assets/${assetNames.find((n)=>/^audio-[\w-]+\.js$/u.test(n))}');
    window.__runtimeAudio=audioAssets;
    return {audioExports:Object.keys(audioAssets)};
  })()`)
  log("production-bundles", { router: imported.exports, audio: routerChecks.audioExports })

  if (asrMode) {
    await mkdir(artifactRoot, { recursive: true })
    const audioPath = join(artifactRoot, "jfk.wav")
    const response = await fetch("https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav")
    assert.ok(response.ok, `JFK audio download failed: HTTP ${response.status}`)
    const jfk = new Uint8Array(await response.arrayBuffer())
    assert.ok(jfk.length > 44, "Downloaded JFK audio is empty")
    await writeFile(audioPath, jfk)
    const encoded = Buffer.from(jfk).toString("base64")
    const start = await evaluate(`(async()=>{
      const bytes=Uint8Array.from(atob(${JSON.stringify(encoded)}),c=>c.charCodeAt(0));
      const form=new FormData();form.append('file',new File([bytes],'jfk.wav',{type:'audio/wav'}));
      const uploaded=await window.__runtimeRouter('/api/videos',{method:'POST',body:form});const up=await uploaded.json();if(!uploaded.ok)throw Error(JSON.stringify(up));
      const settings={filename:up.filename,nickname:'Runtime JFK',model_name:'Xenova/whisper-tiny',backend:'transformers-js',device:'wasm',alignment_mode:'estimated',candidate_models:[],acoustic_units:true};
      const started=await window.__runtimeRouter('/api/analyses',{method:'POST',body:JSON.stringify(settings)});const job=await started.json();if(!started.ok)throw Error(JSON.stringify(job));return {job_id:job.job_id,filename:up.filename};
    })()`, 40_000)
    log("asr-started", start)
    const runJob = async (jobId, timeoutMs) => {
      const began = Date.now()
      let last = ""
      while (Date.now() - began < timeoutMs) {
        const state = await evaluate(`(async()=>{const r=await window.__runtimeRouter('/api/analysis-jobs/${jobId}');return await r.json()})()`)
        const key = `${state.status}:${state.stage}:${state.percent}:${state.download_percent}`
        if (key !== last) { log("asr-progress", { run: jobId, status: state.status, stage: state.stage, percent: state.percent, download_percent: state.download_percent }); last = key }
        if (state.status === "complete") return state
        if (state.status === "failed") throw new Error(`ASR job ${jobId} failed: ${state.error}`)
        await new Promise((resolveWait) => setTimeout(resolveWait, 1500))
      }
      throw new Error(`ASR job ${jobId} timed out after ${timeoutMs}ms`)
    }
    const first = await runJob(start.job_id, 240_000)
    const transcript = await evaluate(`(async()=>{const r=await window.__runtimeRouter('/api/analyses');const a=await r.json();return a.find(x=>x.analysis_id===${JSON.stringify(first.analysis_id)})?.nickname})()`)
    assert.equal(transcript, "Runtime JFK")
    const recordResult = await evaluate(`(async()=>{const root=await navigator.storage.getDirectory();const ws=await root.getDirectoryHandle('runtime-smoke');const dir=await ws.getDirectoryHandle('analyses').then(d=>d.getDirectoryHandle(${JSON.stringify(first.analysis_id)}));const f=await dir.getFileHandle('analysis.json');const record=JSON.parse(await (await f.getFile()).text());const audioPath=record.audio_path.split('/');let audioDir=ws;for(const part of audioPath.slice(0,-1))audioDir=await audioDir.getDirectoryHandle(part);const audio=await audioDir.getFileHandle(audioPath.at(-1)).then(h=>h.getFile());return {transcript:record.overview.transcript,words:record.overview.words.length,phones:record.phones.length,audioPath:record.audio_path,audioBytes:audio.size,audioType:audio.type}})()`)
    assert.ok(recordResult.transcript.length > 0 && recordResult.words > 0 && recordResult.phones > 0 && recordResult.audioBytes > 44, JSON.stringify(recordResult))
    assert.match(recordResult.transcript.toLowerCase(), /president|jfk|kennedy|fellow/)
    await command("Network.setBlockedURLs", { urls: ["*huggingface.co/*", "*hf.co/*", "*cdn.jsdelivr.net/*", "*cdnjs.cloudflare.com/*"] }, session)
    const second = await evaluate(`(async()=>{const form=new FormData();const ws=await navigator.storage.getDirectory();const dir=await ws.getDirectoryHandle('runtime-smoke');const media=await dir.getDirectoryHandle('media');const idx=JSON.parse(await (await (await media.getFileHandle('index.json')).getFile()).text());const name=Object.keys(idx)[0];const relative=idx[name].path.split('/');let folder=dir;for(const part of relative.slice(0,-1))folder=await folder.getDirectoryHandle(part);const file=await folder.getFileHandle(relative.at(-1)).then(h=>h.getFile());form.append('file',new File([file], 'jfk-offline.wav',{type:'audio/wav'}));const up=await window.__runtimeRouter('/api/videos',{method:'POST',body:form});const u=await up.json();if(!up.ok)throw Error(JSON.stringify(u));const r=await window.__runtimeRouter('/api/analyses',{method:'POST',body:JSON.stringify({filename:u.filename,nickname:'Runtime JFK offline',model_name:'Xenova/whisper-tiny',backend:'transformers-js',device:'wasm',alignment_mode:'estimated',candidate_models:[],acoustic_units:true})});const v=await r.json();if(!r.ok)throw Error(JSON.stringify(v));return v.job_id})()`)
    const secondState = await runJob(second, 240_000)
    assert.ok(secondState.analysis_id)
    assert.deepEqual(noApiNetwork(), [])
    log("asr-complete", { transcript: recordResult.transcript, words: recordResult.words, phones: recordResult.phones, savedAudio: recordResult.audioPath, offlineJob: secondState.job_id, artifact: audioPath })
  } else {
    const fixture = await evaluate(`(async()=>{
      const wavBytes=Uint8Array.from(atob(${JSON.stringify(makeFixtureWav().toString("base64"))}),c=>c.charCodeAt(0));const wav=new Blob([wavBytes],{type:'audio/wav'});
      const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;const ctx=canvas.getContext('2d');
      const stream=canvas.captureStream(12);const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});const chunks=[];
      recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};recorder.start(100);
      const started=performance.now();while(performance.now()-started<1500){ctx.fillStyle='#16324f';ctx.fillRect(0,0,160,90);ctx.fillStyle='#f25f5c';ctx.fillRect((performance.now()-started)%130,20,30,30);await new Promise(r=>setTimeout(r,80))}
      await new Promise(r=>{recorder.onstop=r;recorder.stop()});stream.getTracks().forEach(t=>t.stop());
      const video=new Blob(chunks,{type:'video/webm'});if(video.size<1000)throw Error('MediaRecorder produced an empty fixture video');
      const root=await navigator.storage.getDirectory();const ws=await root.getDirectoryHandle('runtime-smoke');
      const write=async(path,blob)=>{const parts=path.split('/');let d=ws;for(const p of parts.slice(0,-1))d=await d.getDirectoryHandle(p,{create:true});const h=await d.getFileHandle(parts.at(-1),{create:true});const w=await h.createWritable();await w.write(blob);await w.close()};
      const mediaPath='media/runtime-source.webm',audioPath='analyses/runtime-analysis/audio.wav';await write(mediaPath,video);await write(audioPath,wav);
      const videoUrl=URL.createObjectURL(video);const videoElement=document.createElement('video');videoElement.src=videoUrl;await new Promise((ok,bad)=>{videoElement.onloadedmetadata=ok;videoElement.onerror=()=>bad(Error('Fixture video metadata decode failed'))});URL.revokeObjectURL(videoUrl);
      const duration=1.6,rate=16_000,now=new Date().toISOString(),analysisId='runtime-analysis',sourceId='runtime-source';
      const source={source_id:sourceId,path:mediaPath,duration_ms:duration*1000,audio_sample_rate:rate,audio_channels:1,video_width:videoElement.videoWidth,video_height:videoElement.videoHeight,video_fps:12};
      const overview={source_id:sourceId,transcript:'',audio_regions:[],sentences:[],words:[],transcript_candidates:[],word_count:0,phone_count:0};
      const summary={analysis_id:analysisId,created_at:now,model_name:'runtime-fixture',nickname:'Runtime fixture',source};
      const record={summary,source,overview,phones:[],acoustic_features:[],audio_path:audioPath,media_path:mediaPath};
      const manifest={project_id:'runtime-project',name:'Runtime smoke',analysis_ids:[analysisId],source_analyses:{[sourceId]:analysisId},created_at:now,model_name:'runtime-fixture',inference_backend:'transformers-js',inference_device:'browser',sources:[source]};
      const project={detail:{manifest,analyses:[overview]},analysis_ids:[analysisId]};
      const request={name:'Runtime media',target_text:'',target_pronunciation:'',crossfade_ms:0,tempo_bpm:120,beats_per_bar:4,beat_division:4,grid_offset_units:0,pitch_notes:[],segments:[{segment_id:'runtime-segment',candidate_id:'runtime-candidate',target_start_index:0,target_end_index:1,source_id:sourceId,source_start_ms:0,source_end_ms:1200,timeline_start_ms:0,timeline_end_ms:1800,match_status:'EXACT',target_ipa:[],matched_ipa:[],gap_before_ms:0,stretch_percent:150,lane:0,phone_units:[],edit_regions:[{region_id:'runtime-region',source_start_ms:0,source_end_ms:1200,output_duration_ms:1800,relative_pitch_cents:0,source_f0_hz:null}],volume_envelope:[]}],mode:'PROFESSIONAL',schema_version:1,parent_composition_id:null,parent_composition_updated_at:null};
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
      const audioBytes=previewBytes;const dataView=new DataView(audioBytes.buffer,audioBytes.byteOffset,audioBytes.byteLength);let energy=0,peak=0,finite=true;for(let p=44;p+1<audioBytes.length;p+=2){const x=dataView.getInt16(p,true)/32768;finite&&=Number.isFinite(x);energy+=x*x;peak=Math.max(peak,Math.abs(x))};
      const mp4Text=String.fromCharCode(...mp4.slice(0,Math.min(64,mp4.length)));const codecs={avc:mp4Text.includes('ftyp')&&new TextDecoder('latin1').decode(mp4).includes('avc1'),aac:new TextDecoder('latin1').decode(mp4).includes('mp4a')};
      const videoMetadata=await inspect(mp4,'video/mp4');
      const base64=bytes=>{let value='';for(let i=0;i<bytes.length;i+=0x8000)value+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(value)};
      return {compositionId:composition.composition_id,compositionSaved:reread.composition_id===composition.composition_id,pitchSegments:pitchValue.segments.length,autotuneSegments:tuneValue.segments.length,wav:{riff:new TextDecoder().decode(audioBytes.slice(0,4)),length:audioBytes.length,finite,peak,rms:Math.sqrt(energy/Math.max(1,(audioBytes.length-44)/2)),metadata:await inspect(audioBytes,'audio/wav')},mp4:{length:mp4.length,codecs,metadata:videoMetadata,progress:job.percent,status:job.status,stage:job.stage},artifacts:{wav:base64(audioBytes),mp4:base64(mp4)}};
    })()`, 120_000)
    assert.equal(fixture.compositionSaved, true)
    assert.ok(fixture.pitchSegments && fixture.autotuneSegments)
    assert.equal(fixture.wav.riff, "RIFF")
    assert.equal(fixture.wav.finite, true)
    assert.ok(fixture.wav.peak > 0.02 && fixture.wav.rms > 0.01)
    assert.ok(fixture.wav.metadata.duration > 1.7 && fixture.wav.metadata.duration < 1.9)
    assert.equal(fixture.mp4.status, "complete")
    assert.equal(fixture.mp4.progress, 100)
    assert.ok(fixture.mp4.codecs.avc && fixture.mp4.codecs.aac, "MP4 should contain H.264 video and AAC audio")
    assert.ok(fixture.mp4.metadata.duration > 1.7 && fixture.mp4.metadata.width > 0 && fixture.mp4.metadata.height > 0, "Exported MP4 should decode in the browser")
    assert.deepEqual(noApiNetwork(), [], "Local API routes must not make HTTP requests")
    const artifactDir = join(artifactRoot, "media")
    await mkdir(artifactDir, { recursive: true })
    await writeFile(join(artifactDir, "composition-preview.wav"), Buffer.from(fixture.artifacts.wav, "base64"))
    await writeFile(join(artifactDir, "composition.mp4"), Buffer.from(fixture.artifacts.mp4, "base64"))
    log("media-complete", { composition: fixture.compositionId, pitchSegments: fixture.pitchSegments, autotuneSegments: fixture.autotuneSegments, wav: { bytes: fixture.wav.length, peak: fixture.wav.peak, rms: fixture.wav.rms, duration: fixture.wav.metadata.duration }, mp4: fixture.mp4, artifacts: artifactDir })
  }
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
  socket?.close()
  if (!browserClosed) browser.kill()
  if (browser.exitCode === null) await Promise.race([once(browser, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 5_000))])
  await new Promise((resolveClose) => server.close(resolveClose))
  const resolved = resolve(profilePath)
  if (!resolved.startsWith(expectedPrefix) || resolved === resolve(tmpdir())) throw new Error(`Refusing to remove unexpected browser profile: ${resolved}`)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { await rm(resolved, { recursive: true, force: true }); break }
    catch (error) { if (attempt === 7) throw error; await new Promise((resolveWait) => setTimeout(resolveWait, 250)) }
  }
}
log("passed", { mode: asrMode ? "asr" : "media", apiNetworkRequests: 0, localAssetFailures: failures.filter((failure) => failure.includes("/madnolia/")).length, externalFailures: failures.length - failures.filter((failure) => failure.includes("/madnolia/")).length })
