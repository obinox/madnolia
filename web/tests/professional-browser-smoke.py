# ruff: noqa: ASYNC210, ASYNC220
import asyncio
import base64
import json
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
import wave
from io import BytesIO
from pathlib import Path

from websockets.asyncio.client import connect

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "web"
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
ARTIFACT = WEB / "tests" / "artifacts" / "professional-editor-smoke.png"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def fixtures() -> dict[str, tuple[int, str, bytes]]:
    source = {"source_id": "source", "path": "source.mp4", "duration_ms": 15000,
              "audio_sample_rate": 16000, "audio_channels": 1, "video_width": 640,
              "video_height": 360, "video_fps": 30}
    segments = []
    for index in range(12):
        base = 100 + index * 1000
        units = [{
            "phone_unit_id": f"phone_{base}", "operation": "MATCH", "target_index": index,
            "target_phone_id": "a", "target_ipa": "a", "source_occurrence_id": f"occ_{base}",
            "source_phone_id": "a", "source_ipa": "a", "source_start_ms": base,
            "source_end_ms": base + 500, "output_duration_ms": 500, "source_f0_hz": None,
            "voiced_probability": 0, "target_pitch_midi": None, "formant_shift_semitones": 0,
            "transition_to_next_ms": 80, "transition_strength_percent": 100, "transition_center_ms": 0,
        }, {
            "phone_unit_id": f"phone_{base + 500}", "operation": "MATCH", "target_index": index,
            "target_phone_id": "b", "target_ipa": "b", "source_occurrence_id": f"occ_{base + 500}",
            "source_phone_id": "b", "source_ipa": "b", "source_start_ms": base + 500,
            "source_end_ms": base + 1000, "output_duration_ms": 500, "source_f0_hz": None,
            "voiced_probability": 0, "target_pitch_midi": None, "formant_shift_semitones": 0,
            "transition_to_next_ms": 80, "transition_strength_percent": 100, "transition_center_ms": 0,
        }]
        segments.append({"segment_id": f"segment_{index}", "candidate_id": f"candidate_{index}",
            "target_start_index": index, "target_end_index": index + 1, "source_id": "source",
            "source_start_ms": base, "source_end_ms": base + 1000, "timeline_start_ms": index * 1000,
            "timeline_end_ms": (index + 1) * 1000, "match_status": "EXACT", "target_ipa": ["a", "b"],
            "matched_ipa": ["a", "b"], "gap_before_ms": 0, "stretch_percent": 100, "lane": 0,
            "phone_units": units, "edit_regions": [], "volume_envelope": []})
    detail = {"manifest": {"project_id": "smoke", "name": "Smoke", "analysis_ids": [],
        "source_analyses": {}, "created_at": "2026-01-01T00:00:00Z", "model_name": "test",
        "inference_backend": "test", "inference_device": "CPU", "sources": [source]},
        "analyses": [{"source_id": "source", "transcript": "", "audio_regions": [], "sentences": [],
                      "words": [], "transcript_candidates": [], "word_count": 0, "phone_count": 0}]}
    parent = {"composition_id": "parent", "corpus_project_id": "smoke", "name": "Parent",
        "target_text": "ab", "target_pronunciation": "ab", "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z", "crossfade_ms": 8, "segments": segments,
        "mode": "SIMPLE", "schema_version": 1, "parent_composition_id": None,
        "parent_composition_updated_at": None}
    audio_buffer = BytesIO()
    with wave.open(audio_buffer, "wb") as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(16000); audio.writeframes(b"\0\0" * 240000)
    return {
        "/api/projects": (200, "application/json", json.dumps([{"project_id": "smoke", "name": "Smoke",
            "created_at": "2026-01-01T00:00:00Z", "model_name": "test", "inference_backend": "test",
            "inference_device": "CPU", "source_count": 1, "total_duration_ms": 15000}]).encode()),
        "/api/projects/smoke": (200, "application/json", json.dumps(detail).encode()),
        "/api/projects/smoke/compositions": (200, "application/json", json.dumps([parent]).encode()),
        "/api/projects/smoke/audio/source": (200, "audio/wav", audio_buffer.getvalue()),
        "/api/projects/smoke/compositions/preview": (200, "audio/wav", audio_buffer.getvalue()),
        "/api/projects/smoke/timeline": (200, "application/json", b'{"start_ms":0,"end_ms":15000,"audio_regions":[],"words":[],"phones":[],"acoustic_features":[]}'),
        "/api/projects/smoke/waveform": (200, "application/json", b'{"start_ms":0,"end_ms":15000,"peaks":[0.1,0.4,0.8,0.2]}'),
        "/api/videos": (200, "application/json", b"[]"),
        "/api/analysis-hardware": (200, "application/json", b'{"backend":"faster-whisper","device":"CPU","gpu_vendor":null}'),
    }


async def run_smoke() -> None:
    if not CHROME.is_file():
        raise RuntimeError(f"Chrome was not found at {CHROME}")
    ARTIFACT.parent.mkdir(parents=True, exist_ok=True)
    port, debug_port = free_port(), free_port()
    temp_root = Path(tempfile.mkdtemp(prefix="madnolia-professional-smoke-"))
    vite = subprocess.Popen(["node", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", str(port), "--configLoader", "native"], cwd=WEB, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    chrome = None
    request_log: list[dict] = []
    saved_requests: list[dict] = []
    runtime_errors: list[str] = []
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1).close(); break
            except OSError:
                await asyncio.sleep(.1)
        chrome_log = temp_root / "chrome.log"
        with chrome_log.open("wb") as log:
            chrome = subprocess.Popen([str(CHROME), "--headless=new", "--no-sandbox", "--disable-gpu",
                "--window-size=1440,760", f"--remote-debugging-port={debug_port}",
                f"--user-data-dir={temp_root / 'chrome-profile'}", "--remote-allow-origins=*",
                "--no-first-run", "--disable-extensions", "--disable-background-networking", "about:blank"], stdout=log, stderr=subprocess.STDOUT)
        version = None
        for _ in range(40):
            try:
                version = json.load(urllib.request.urlopen(f"http://127.0.0.1:{debug_port}/json/version", timeout=1)); break
            except OSError:
                if chrome.poll() is not None: break
                await asyncio.sleep(.1)
        if version is None:
            raise RuntimeError(f"Chrome DevTools did not start: {chrome_log.read_text(encoding='utf-8', errors='replace')[-2000:]}")
        page = next(item for item in json.load(urllib.request.urlopen(f"http://127.0.0.1:{debug_port}/json/list", timeout=2)) if item.get("type") == "page")
        fixtures_by_path = fixtures()
        parent_fixture = json.loads(fixtures_by_path["/api/projects/smoke/compositions"][2])[0]
        responses: dict[int, dict] = {}
        next_id = 0
        async with connect(page["webSocketDebuggerUrl"], max_size=16 * 1024 * 1024) as ws:
            async def command(method: str, params: dict | None = None) -> dict:
                nonlocal next_id
                next_id += 1; current = next_id
                params = dict(params or {})
                if method == "Input.dispatchMouseEvent" and params.get("type") == "mouseWheel":
                    params.setdefault("deltaX", 0); params.setdefault("deltaY", 0)
                await ws.send(json.dumps({"id": current, "method": method, "params": params}))
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    if current in responses:
                        response = responses.pop(current)
                        if "error" in response: raise RuntimeError(f"CDP {method} failed: {response['error']}")
                        return response.get("result", {})
                    message = json.loads(await asyncio.wait_for(ws.recv(), deadline - time.monotonic()))
                    if message.get("id") is not None: responses[message["id"]] = message
                    elif message.get("method") == "Runtime.exceptionThrown": runtime_errors.append(message["params"].get("exceptionDetails", {}).get("text", "runtime exception"))
                    elif message.get("method") == "Fetch.requestPaused":
                        paused = message["params"]; request = paused["request"]
                        path = "/" + request["url"].split("/", 3)[-1].split("?", 1)[0]
                        if request.get("method") == "POST" and path == "/api/collages":
                            envelope = json.loads(request.get("postData", "{}")); body = envelope["composition"]; saved_requests.append(body)
                            reply = {"composition_id": "saved", "corpus_project_id": envelope["project_id"], "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:01Z", **body}
                            status, mime, payload = 201, "application/json", json.dumps(reply).encode()
                        elif request.get("method") == "GET" and path == "/api/projects/smoke/compositions" and saved_requests:
                            saved = saved_requests[-1]
                            reply = {"composition_id": "saved", "corpus_project_id": "smoke", "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:01Z", **saved}
                            status, mime, payload = 200, "application/json", json.dumps([parent_fixture, reply]).encode()
                        else:
                            status, mime, payload = fixtures_by_path.get(path, (404, "application/json", b'{"detail":"not stubbed"}'))
                        request_log.append({"path": path, "status": status})
                        next_id += 1
                        await ws.send(json.dumps({"id": next_id, "method": "Fetch.fulfillRequest", "params": {"requestId": paused["requestId"], "responseCode": status, "responseHeaders": [{"name": "Content-Type", "value": mime}, {"name": "Access-Control-Allow-Origin", "value": "*"}], "body": base64.b64encode(payload).decode()}}))
                raise TimeoutError(f"{method} timed out")

            async def evaluate(expression: str):
                result = await command("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True})
                if result.get("exceptionDetails"): raise RuntimeError(result["exceptionDetails"].get("text", "browser evaluation failed"))
                return result.get("result", {}).get("value")

            async def scroll_to_fragment(selector: str):
                target = "document.querySelector(" + json.dumps(selector) + ")"
                await evaluate("(() => {const e=" + target + ",s=document.querySelector('.professional-timeline-scroll');e.scrollIntoView({block:'center',inline:'nearest'});const r=s.getBoundingClientRect(),label=e.closest('.professional-audio-lane,.professional-curve-lane').querySelector(':scope > strong'),left=r.left+label.getBoundingClientRect().width,right=r.right,center=e.getBoundingClientRect().left+e.getBoundingClientRect().width/2;s.scrollLeft+=center-(left+right)/2})()")
                await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
                hit = await evaluate("(() => {const e=" + target + ",r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y),s=document.querySelector('.professional-timeline-scroll'),sr=s.getBoundingClientRect(),label=e.closest('.professional-audio-lane,.professional-curve-lane').querySelector(':scope > strong'),usableLeft=sr.left+label.getBoundingClientRect().width;return {visible:!!h&&e.contains(h)&&x>=usableLeft&&x<sr.right&&y>=sr.top&&y<sr.bottom,x,y,hit:h?.tagName,selector:" + json.dumps(selector) + "}})()")
                assert hit["visible"], f"Target is obscured or outside the timeline viewport: {hit}"

            async def wait_for(expression: str, timeout: float = 10):
                deadline = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    if await evaluate(expression): return
                    await asyncio.sleep(.1)
                diagnostic = await evaluate("({url:location.href,body:document.body?.innerText||'',wheelEvents:window.__wheelDiagnostics||[]})")
                raise AssertionError(f"Timed out: {expression}; state={diagnostic}; requests={request_log}; console={runtime_errors}")

            try:
                await command("Fetch.enable", {"patterns": [{"urlPattern": f"http://127.0.0.1:{port}/api/*"}]})
                await command("Page.enable"); await command("Runtime.enable")
                await command("Page.navigate", {"url": f"http://127.0.0.1:{port}/#/professional/smoke"})
                await wait_for("document.querySelectorAll('.professional-audio-fragment').length===12")
                await wait_for("document.querySelectorAll('.professional-curve-lane.pitch ellipse').length===24 && document.querySelectorAll('.professional-curve-lane.volume ellipse').length===24 && document.querySelectorAll('.professional-curve ellipse').length===48")
                first_pitch_curve = ".professional-curve-lane.pitch .professional-curve-fragment:first-of-type .professional-curve"
                await wait_for(f"document.querySelector('{first_pitch_curve}').querySelectorAll('ellipse').length===2")
                await wait_for("document.querySelector('.professional-waveform polygon')?.getAttribute('points').trim().split(/\\s+/).length>800")
                await evaluate("window.__wheelDiagnostics=[];document.addEventListener('wheel',e=>{const n=document.querySelector('.professional-timeline-scroll');const r=n.getBoundingClientRect();window.__wheelDiagnostics.push({shiftKey:e.shiftKey,deltaX:e.deltaX,deltaY:e.deltaY,target:e.target?.className?.baseVal||e.target?.className||e.target?.tagName,scrollWidth:n.scrollWidth,clientWidth:n.clientWidth,scrollLeft:n.scrollLeft,bounds:{left:r.left,top:r.top,width:r.width,height:r.height}})},{capture:true,passive:true})")
                initial = await evaluate("(() => {const e=document.querySelector('.professional-timeline-scroll');e.style.height='180px';e.style.flex='0 0 180px';return {width:e.scrollWidth,client:e.clientWidth,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight}})()")
                widths = await evaluate("[...document.querySelectorAll('.professional-audio-fragment')].map(e=>[Number(e.style.width.replace('px','')),Number(e.style.left.replace('px',''))])")
                timeline_origin = await evaluate("parseFloat(document.querySelector('.professional-time-ruler').style.left)")
                assert all(abs(width - 0.12 * 1000) < 1 for width, _ in widths), f"Fragments have an unexpected artificial width: {widths}"
                label_layout = await evaluate("(() => {const e=document.querySelector('.professional-fragment-label'),s=getComputedStyle(e),r=e.getBoundingClientRect(),f=e.parentElement,b=f.querySelector('.professional-fragment-body').getBoundingClientRect(),w=f.querySelector('.professional-waveform'),p=w.querySelector('polygon'),h=f.querySelector('.professional-edge-handle.right').getBoundingClientRect();return {height:r.height,lineHeight:s.lineHeight,color:s.color,background:s.backgroundColor,bodyTop:b.top,bodyHeight:b.height,guidesTop:f.querySelector('.professional-guides i').getBoundingClientRect().top,polygonPoints:p.getAttribute('points').trim().split(/\\s+/).length,handleHeight:h.height}})()")
                assert label_layout["height"] >= 22 and float(label_layout["lineHeight"].replace("px", "")) >= 16 and label_layout["color"] != "rgba(0, 0, 0, 0)", f"IPA label can clip or fade glyphs: {label_layout}"
                assert label_layout["guidesTop"] >= label_layout["bodyTop"] - 1, f"Fragment guides overlap the IPA label: {label_layout}"
                assert label_layout["bodyHeight"] >= 44 and label_layout["polygonPoints"] > 800 and label_layout["handleHeight"] >= 30, f"Waveform, label, or edge handle geometry is too small: {label_layout}"
                wheel = await evaluate("(() => {const n=document.querySelector('.professional-timeline-scroll'),c=document.querySelector('.professional-timeline-content'),r=n.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,selector:'.professional-timeline-content'}})()")
                await command("Input.dispatchMouseEvent", {"type":"mouseMoved","x":wheel["x"],"y":wheel["y"]})
                await wait_for("document.elementFromPoint("+str(wheel["x"])+","+str(wheel["y"])+").closest('.professional-timeline-content')!==null")
                before_plain_wheel = await evaluate("(() => {const e=document.querySelector('.professional-timeline-scroll');return {top:e.scrollTop,width:parseFloat(document.querySelector('.professional-audio-fragment').style.width)}})()")
                await command("Input.dispatchMouseEvent", {"type":"mouseWheel","x":wheel["x"],"y":wheel["y"],"deltaY":120})
                await wait_for("document.querySelector('.professional-timeline-scroll').scrollTop>"+str(before_plain_wheel["top"]))
                plain_wheel = await evaluate("(() => ({top:document.querySelector('.professional-timeline-scroll').scrollTop,width:parseFloat(document.querySelector('.professional-audio-fragment').style.width)}))()")
                assert plain_wheel["width"] == before_plain_wheel["width"], f"Plain vertical wheel changed zoom: {before_plain_wheel} to {plain_wheel}"
                await evaluate("(() => {const e=document.querySelector('.professional-timeline-scroll');e.scrollTop=0})()")
                before_zoom = widths[0][0]
                await command("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": wheel["x"], "y": wheel["y"], "deltaY": -700, "modifiers": 2})
                await wait_for("parseFloat(document.querySelector('.professional-audio-fragment').style.width)>"+str(before_zoom))
                await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
                anchor = await evaluate("(() => {const e=document.querySelector('.professional-timeline-scroll');const r=e.getBoundingClientRect();const scale=parseFloat(document.querySelector('.professional-audio-fragment').style.width)/1000;const x="+str(wheel["x"])+";return {x,y:r.top+8,time:(e.scrollLeft+x-r.left-"+str(timeline_origin)+")/scale}})()")
                await command("Input.dispatchMouseEvent", {"type":"mouseMoved","x":anchor["x"],"y":anchor["y"]})
                await wait_for("document.elementFromPoint("+str(anchor["x"])+","+str(anchor["y"])+").closest('.professional-timeline-content')!==null")
                zoomed_width = await evaluate("parseFloat(document.querySelector('.professional-audio-fragment').style.width)")
                await command("Input.dispatchMouseEvent", {"type":"mouseWheel","x":anchor["x"],"y":anchor["y"],"deltaY":250,"modifiers":2})
                await wait_for("parseFloat(document.querySelector('.professional-audio-fragment').style.width)<"+str(zoomed_width))
                await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
                anchored = await evaluate("(() => {const e=document.querySelector('.professional-timeline-scroll');const r=e.getBoundingClientRect();const scale=parseFloat(document.querySelector('.professional-audio-fragment').style.width)/1000;return {time:(e.scrollLeft+"+str(anchor["x"])+"-r.left-"+str(timeline_origin)+")/scale,scale,scrollLeft:e.scrollLeft}})()")
                anchor_error_px = abs(anchored["time"]-anchor["time"]) * anchored["scale"]
                assert anchor_error_px <= 0.6, f"Zoom cursor anchor moved {anchor_error_px:.3f}px (limit 0.6px): time {anchor['time']} -> {anchored['time']}ms, final scale {anchored['scale']}px/ms, scrollLeft {anchored['scrollLeft']}px"
                await evaluate("(() => {const e=document.querySelector('.professional-timeline-scroll');e.scrollLeft=0})()")
                wheel = await evaluate("(() => {const r=document.querySelector('.professional-timeline-scroll').getBoundingClientRect();return {x:r.left+r.width*.5,y:r.top+r.height*.5}})()")
                await command("Input.dispatchMouseEvent", {"type":"mouseMoved","x":wheel["x"],"y":wheel["y"]})
                await wait_for("document.elementFromPoint("+str(wheel["x"])+","+str(wheel["y"])+").closest('.professional-timeline-content')!==null")
                await command("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": wheel["x"], "y": wheel["y"], "deltaY": 500, "modifiers": 8})
                await wait_for("document.querySelector('.professional-timeline-scroll').scrollLeft>0")
                await evaluate("(() => {const e=document.querySelector('.professional-timeline-scroll');e.scrollLeft=0})()")
                wheel = await evaluate("(() => {const r=document.querySelector('.professional-timeline-scroll').getBoundingClientRect();return {x:r.left+r.width*.5,y:r.top+r.height*.5}})()")
                await command("Input.dispatchMouseEvent", {"type":"mouseMoved","x":wheel["x"],"y":wheel["y"]})
                await wait_for("document.elementFromPoint("+str(wheel["x"])+","+str(wheel["y"])+").closest('.professional-timeline-content')!==null")
                horizontal_width = await evaluate("parseFloat(document.querySelector('.professional-audio-fragment').style.width)")
                await command("Input.dispatchMouseEvent", {"type":"mouseWheel","x":wheel["x"],"y":wheel["y"],"deltaX":120,"deltaY":0})
                await wait_for("document.querySelector('.professional-timeline-scroll').scrollLeft>0")
                unchanged_width = await evaluate("parseFloat(document.querySelector('.professional-audio-fragment').style.width)")
                assert unchanged_width == horizontal_width, f"Horizontal wheel changed timeline zoom: {horizontal_width} to {unchanged_width}"
                await evaluate("(() => {const e=document.querySelector('.professional-timeline-scroll');e.scrollLeft=0})()")
                labels = await evaluate("(() => ({tempo:document.querySelector('[aria-label=\\\"BPM\\\"]')!==null,division:document.querySelectorAll('.professional-timeline-tools select').length===1,bars:[...document.querySelectorAll('.professional-time-ruler span')].every(x=>/^\\d+$/.test(x.textContent))}))()")
                assert labels["tempo"] and labels["division"] and labels["bars"], f"Tempo, subdivision, or bar labels are inaccurate: {labels}"
                joined_handles = await evaluate("(() => {const a=document.querySelectorAll('.professional-audio-fragment')[2],b=document.querySelectorAll('.professional-audio-fragment')[3],rear=a.querySelector('.professional-edge-handle.right').getBoundingClientRect(),front=b.querySelector('.professional-edge-handle.left').getBoundingClientRect();return {rear:{x:rear.left+rear.width/2,y:rear.top+rear.height/2},front:{x:front.left+front.width/2,y:front.top+front.height/2}}})()")
                hit_targets = await evaluate("(() => {const a=document.elementFromPoint("+str(joined_handles["rear"]["x"])+","+str(joined_handles["rear"]["y"])+"),b=document.elementFromPoint("+str(joined_handles["front"]["x"])+","+str(joined_handles["front"]["y"])+");return {rear:a?.classList.contains('right'),front:b?.classList.contains('left')}})()")
                assert hit_targets == {"rear": True, "front": True}, f"Joined fragment handles mask each other: {joined_handles} {hit_targets}"
                lane_alignment = await evaluate("(() => {const a=[...document.querySelectorAll('.professional-audio-fragment')].slice(0,2);const c=[...document.querySelectorAll('.professional-curve-fragment')].slice(0,2);const ruler=document.querySelector('.professional-time-ruler'),grid=document.querySelector('.professional-grid-layer');return {audio:a.map(x=>[x.getBoundingClientRect().left,x.dataset.lane]),curve:c.map(x=>[x.getBoundingClientRect().left,x.dataset.lane]),ruler:ruler.getBoundingClientRect().left,gridLeft:grid.getBoundingClientRect().left,gridPosition:getComputedStyle(grid).backgroundPositionX,labels:[...ruler.children].map(x=>x.getBoundingClientRect().left)}})()")
                assert lane_alignment["audio"] == lane_alignment["curve"], f"Audio and curve lane positions differ: {lane_alignment}"
                ruler_origin = await evaluate("(() => {const r=document.querySelector('.professional-time-ruler');return r.parentElement.getBoundingClientRect().left+parseFloat(r.style.left)})()")
                assert abs(lane_alignment["gridLeft"]-ruler_origin)<1 and abs(lane_alignment["labels"][0]-ruler_origin)<1, f"Grid or ruler origin is obscured: {lane_alignment}"
                marker = await evaluate("(() => {const r=document.querySelector('.professional-guides i').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()")
                await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":marker["x"],"y":marker["y"],"button":"right"})
                await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":marker["x"],"y":marker["y"],"button":"right"})
                await wait_for("document.querySelector('.professional-guides i.user-guide')!==null")
                marker = await evaluate("(() => {const r=document.querySelector('.professional-guides i').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()")
                await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":marker["x"],"y":marker["y"],"button":"right"})
                await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":marker["x"],"y":marker["y"],"button":"right"})
                await wait_for("document.querySelector('.professional-guides i.user-guide')===null")
                split_count = await evaluate("document.querySelector('.professional-audio-fragment').querySelectorAll('.professional-guides i').length")
                interval_right = await evaluate("(() => {const r=document.querySelector('.professional-fragment-body').getBoundingClientRect();return {x:r.left+r.width*.25,y:r.top+r.height/2}})()")
                guides_before_split = await evaluate("document.querySelector('.professional-audio-fragment').querySelectorAll('.professional-guides i').length")
                await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":interval_right["x"],"y":interval_right["y"],"button":"right"})
                await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":interval_right["x"],"y":interval_right["y"],"button":"right"})
                await wait_for("document.querySelector('.professional-audio-fragment').querySelectorAll('.professional-guides i.user-guide').length===1")
                assert await evaluate("document.querySelector('.professional-audio-fragment').querySelectorAll('.professional-guides i').length") == guides_before_split + 1, "Right-clicking an interval did not add its source split"
                marker = await evaluate("(() => {const r=document.querySelector('.professional-guides i.user-guide').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()")
                await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":marker["x"],"y":marker["y"],"button":"right"})
                await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":marker["x"],"y":marker["y"],"button":"right"})
                await wait_for("document.querySelector('.professional-audio-fragment').querySelectorAll('.professional-guides i.user-guide').length===0")
                assert await evaluate("document.querySelector('.professional-audio-fragment').querySelectorAll('.professional-guides i').length") == guides_before_split, "Removing a user split did not restore the source interval"
                playhead_before_click = await evaluate("document.querySelector('.professional-timeline-content').dataset.playheadMs")
                click_interval = await evaluate("(() => {const r=document.querySelector('.professional-fragment-body').getBoundingClientRect();return {x:r.left+r.width*.75,y:r.top+r.height/2}})()")
                await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":click_interval["x"],"y":click_interval["y"],"button":"left"})
                await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":click_interval["x"],"y":click_interval["y"],"button":"left"})
                await wait_for("document.querySelector('.professional-range-selection')?.dataset.sourceStartMs==='600'")
                assert await evaluate("document.querySelector('.professional-audio-fragment').querySelectorAll('.professional-guides i').length") == split_count, "Selecting an interval added a split"
                drag_interval = await evaluate("(() => {const r=document.querySelector('.professional-fragment-body').getBoundingClientRect();return {x1:r.left+r.width*.65,x2:r.left+r.width*.85,y:r.top+r.height/2}})()")
                await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":drag_interval["x1"],"y":drag_interval["y"],"button":"left"})
                await command("Input.dispatchMouseEvent", {"type":"mouseMoved","x":drag_interval["x2"],"y":drag_interval["y"],"button":"left","buttons":1})
                await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":drag_interval["x2"],"y":drag_interval["y"],"button":"left"})
                assert await evaluate("document.querySelector('.professional-audio-fragment').querySelectorAll('.professional-guides i').length") == split_count and await evaluate("document.querySelector('.professional-range-selection')?.dataset.sourceStartMs==='600' && document.querySelector('.professional-range-selection')?.dataset.sourceEndMs==='1100'"), "Dragging the interval created a range or source split"
                assert await evaluate("document.querySelector('.professional-timeline-content').dataset.playheadMs") == playhead_before_click, "Selecting audio sought the playhead"

                async def drag_boundary(modifiers: int = 0, dx: float = 12):
                    boundary = await evaluate("(() => {const e=document.querySelector('.professional-guides i'),r=e.getBoundingClientRect(),s=document.querySelector('.professional-range-selection');return {x:r.left+r.width/2,y:r.top+r.height/2,selected:s?{start:s.dataset.sourceStartMs,end:s.dataset.sourceEndMs}:null,hit:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===e}})()")
                    assert boundary["hit"], f"Guide did not receive the drag: {boundary}"
                    await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":boundary["x"],"y":boundary["y"],"button":"left","modifiers":modifiers})
                    await command("Input.dispatchMouseEvent", {"type":"mouseMoved","x":boundary["x"]+dx,"y":boundary["y"],"button":"left","buttons":1,"modifiers":modifiers})
                    await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":boundary["x"]+dx,"y":boundary["y"],"button":"left","modifiers":modifiers})
                    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
                    return boundary

                initial = await evaluate("(() => {const f=document.querySelector('.professional-audio-fragment');return {left:f.style.left,width:f.style.width,next:document.querySelectorAll('.professional-audio-fragment')[1].style.left}})()")
                await drag_boundary()
                await wait_for("Number(document.querySelector('.professional-curve-lane.pitch .professional-guide-line').dataset.regionDurationMs)>500")
                normal = await evaluate("(() => {const f=document.querySelector('.professional-audio-fragment'),g=document.querySelector('.professional-curve-lane.pitch .professional-guide-line');return {left:f.style.left,width:f.style.width,next:document.querySelectorAll('.professional-audio-fragment')[1].style.left,first:Number(g.dataset.regionDurationMs)}})()")
                assert normal["left"] == initial["left"] and normal["width"] == initial["width"] and normal["next"] == initial["next"] and normal["first"] > 500, f"NORMAL boundary resize changed the syllable total or another syllable: {initial} {normal}"

                click_ctrl_front = await evaluate("(() => {const r=document.querySelector('.professional-fragment-body').getBoundingClientRect();return {x:r.left+r.width*.75,y:r.top+r.height/2}})()")
                await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":click_ctrl_front["x"],"y":click_ctrl_front["y"],"button":"left"})
                await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":click_ctrl_front["x"],"y":click_ctrl_front["y"],"button":"left"})
                await wait_for("document.querySelector('.professional-range-selection')?.dataset.sourceStartMs==='600'")
                ctrl_before = await evaluate("(() => {const f=document.querySelector('.professional-audio-fragment');return {left:parseFloat(f.style.left),width:parseFloat(f.style.width),next:document.querySelectorAll('.professional-audio-fragment')[1].style.left}})()")
                ctrl_front_selection = await drag_boundary(2)
                await wait_for("parseFloat(document.querySelector('.professional-audio-fragment').style.left)>"+str(ctrl_before["left"]))
                ctrl_after = await evaluate("(() => {const f=document.querySelector('.professional-audio-fragment');return {left:parseFloat(f.style.left),width:parseFloat(f.style.width),next:document.querySelectorAll('.professional-audio-fragment')[1].style.left}})()")
                assert ctrl_after["left"] > ctrl_before["left"] and ctrl_after["width"] < ctrl_before["width"] and ctrl_after["next"] == ctrl_before["next"], f"CTRL front did not move prefix boundaries and preserve the suffix: selected={ctrl_front_selection['selected']} ctrl={ctrl_before} after={ctrl_after}"

                click_first = await evaluate("(() => {const r=document.querySelector('.professional-fragment-body').getBoundingClientRect();return {x:r.left+r.width*.25,y:r.top+r.height/2}})()")
                await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":click_first["x"],"y":click_first["y"],"button":"left"})
                await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":click_first["x"],"y":click_first["y"],"button":"left"})
                ctrl_rear_before = await evaluate("(() => {const f=document.querySelector('.professional-audio-fragment');return {left:parseFloat(f.style.left),width:parseFloat(f.style.width),next:document.querySelectorAll('.professional-audio-fragment')[1].style.left}})()")
                ctrl_rear_selection = await drag_boundary(2)
                await wait_for("parseFloat(document.querySelector('.professional-audio-fragment').style.width)>"+str(ctrl_rear_before["width"]))
                ctrl_rear_after = await evaluate("(() => {const f=document.querySelector('.professional-audio-fragment');return {left:parseFloat(f.style.left),width:parseFloat(f.style.width),next:document.querySelectorAll('.professional-audio-fragment')[1].style.left}})()")
                assert ctrl_rear_after["left"] == ctrl_rear_before["left"] and ctrl_rear_after["width"] > ctrl_rear_before["width"] and ctrl_rear_after["next"] == ctrl_rear_before["next"], f"CTRL rear did not move only the suffix boundary: selected={ctrl_rear_selection['selected']} ctrl={ctrl_rear_before} after={ctrl_rear_after}"
                shift_before = await evaluate("(() => {const f=document.querySelector('.professional-audio-fragment');return {left:parseFloat(f.style.left),width:parseFloat(f.style.width),next:document.querySelectorAll('.professional-audio-fragment')[1].style.left}})()")
                shift_selection = await drag_boundary(8)
                await wait_for("parseFloat(document.querySelector('.professional-audio-fragment').style.left)>"+str(shift_before["left"]))
                shift_after = await evaluate("(() => {const f=document.querySelector('.professional-audio-fragment');return {left:parseFloat(f.style.left),width:parseFloat(f.style.width),next:document.querySelectorAll('.professional-audio-fragment')[1].style.left}})()")
                assert shift_after["left"] > shift_before["left"] and shift_after["width"] == shift_before["width"] and shift_after["next"] == shift_before["next"], f"SHIFT did not move the syllable as a unit: selected={shift_selection['selected']} {shift_before} {shift_after}"

                await scroll_to_fragment('.professional-audio-fragment:first-of-type')
                suffix_before = await evaluate("[...document.querySelectorAll('.professional-audio-fragment')].map(e=>[parseFloat(e.style.left),parseFloat(e.style.width)])")
                grabbedIndex = 1
                suffix_drag = await evaluate("(() => {const e=document.querySelectorAll('.professional-fragment-body')[1],r=e.getBoundingClientRect();return {x:r.left+r.width*.35,y:r.top+r.height/2}})()")
                await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":suffix_drag["x"],"y":suffix_drag["y"],"button":"left","modifiers":10})
                await command("Input.dispatchMouseEvent", {"type":"mouseMoved","x":suffix_drag["x"]+15,"y":suffix_drag["y"],"button":"left","buttons":1,"modifiers":10})
                await command("Input.dispatchMouseEvent", {"type":"mouseMoved","x":suffix_drag["x"]+30,"y":suffix_drag["y"],"button":"left","buttons":1,"modifiers":10})
                await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":suffix_drag["x"]+30,"y":suffix_drag["y"],"button":"left","modifiers":10})
                await wait_for("parseFloat(document.querySelectorAll('.professional-audio-fragment')[1].style.left)>"+str(suffix_before[grabbedIndex][0]))
                suffix_after = await evaluate("[...document.querySelectorAll('.professional-audio-fragment')].map(e=>[parseFloat(e.style.left),parseFloat(e.style.width)])")
                moved_delta = suffix_after[grabbedIndex][0]-suffix_before[grabbedIndex][0]
                assert all(abs((after[0]-before[0])-moved_delta)<1 for before,after in zip(suffix_before,suffix_after) if before[0]>suffix_before[grabbedIndex][0]), f"Ctrl+Shift did not move the strict suffix equally: {suffix_before} {suffix_after}"
                assert all(abs(after[0]-before[0])<1 for index,(before,after) in enumerate(zip(suffix_before,suffix_after)) if index != grabbedIndex and before[0]<=suffix_before[grabbedIndex][0]), f"Ctrl+Shift moved an earlier or same-start syllable: {suffix_before} {suffix_after}"
                assert abs(moved_delta)>0, f"Ctrl+Shift did not move the grabbed syllable: {suffix_before} {suffix_after}"
                assert [width for _,width in suffix_after] == [width for _,width in suffix_before], f"Ctrl+Shift changed syllable durations: {suffix_before} {suffix_after}"
                await command("Input.dispatchKeyEvent", {"type":"rawKeyDown","key":"z","code":"KeyZ","modifiers":2})
                await command("Input.dispatchKeyEvent", {"type":"keyUp","key":"z","code":"KeyZ","modifiers":2})
                await wait_for("[...document.querySelectorAll('.professional-audio-fragment')].every((e,i)=>Math.abs(parseFloat(e.style.left)-"+str([start for start,_ in suffix_before])+"[i])<1)")
                suffix_undo = await evaluate("[...document.querySelectorAll('.professional-audio-fragment')].map(e=>[parseFloat(e.style.left),parseFloat(e.style.width)])")
                assert [start for start,_ in suffix_undo] == [start for start,_ in suffix_before], "Ctrl+Z did not undo all pointer moves as one gesture"
                assert [width for _,width in suffix_undo] == [width for _,width in suffix_before], "Ctrl+Z changed syllable durations"
                await command("Input.dispatchKeyEvent", {"type":"rawKeyDown","key":"y","code":"KeyY","modifiers":2})
                await command("Input.dispatchKeyEvent", {"type":"keyUp","key":"y","code":"KeyY","modifiers":2})
                await wait_for("[...document.querySelectorAll('.professional-audio-fragment')].every((e,i)=>Math.abs(parseFloat(e.style.left)-"+str([start for start,_ in suffix_after])+"[i])<1)")
                suffix_redo = await evaluate("[...document.querySelectorAll('.professional-audio-fragment')].map(e=>[parseFloat(e.style.left),parseFloat(e.style.width)])")
                assert [start for start,_ in suffix_redo] == [start for start,_ in suffix_after], "Ctrl+Y did not redo all pointer moves"
                assert [width for _,width in suffix_redo] == [width for _,width in suffix_before], "Ctrl+Y changed syllable durations"
                await command("Input.dispatchKeyEvent", {"type":"rawKeyDown","key":"z","code":"KeyZ","modifiers":2})
                await command("Input.dispatchKeyEvent", {"type":"keyUp","key":"z","code":"KeyZ","modifiers":2})
                await wait_for("[...document.querySelectorAll('.professional-audio-fragment')].every((e,i)=>Math.abs(parseFloat(e.style.left)-"+str([start for start,_ in suffix_before])+"[i])<1)")
                await evaluate("(() => {const e=document.querySelector('[aria-label=\"BPM\"]'),setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,'137');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));e.blur()})()")
                await command("Input.dispatchKeyEvent", {"type":"rawKeyDown","key":"y","code":"KeyY","modifiers":2})
                await command("Input.dispatchKeyEvent", {"type":"keyUp","key":"y","code":"KeyY","modifiers":2})
                assert await evaluate("document.querySelector('[aria-label=\"BPM\"]').value==='137'")
                assert await evaluate("[...document.querySelectorAll('.professional-audio-fragment')].map(e=>parseFloat(e.style.left))") == [start for start,_ in suffix_before], "A new tempo edit did not invalidate redo"
                await evaluate("document.querySelector('[aria-label=\"BPM\"]').focus()")
                await command("Input.dispatchKeyEvent", {"type":"rawKeyDown","key":"z","code":"KeyZ","modifiers":2})
                await command("Input.dispatchKeyEvent", {"type":"keyUp","key":"z","code":"KeyZ","modifiers":2})
                assert await evaluate("parseFloat(document.querySelector('.professional-audio-fragment').style.left)") == suffix_before[0][0], "Ctrl+Z in a number input changed the composition"
                await evaluate("document.activeElement.blur()")

                await scroll_to_fragment('.professional-audio-fragment:last-of-type')
                await evaluate("(() => {const e=document.querySelector('.professional-timeline-scroll');e.scrollLeft=Math.min(e.scrollWidth-e.clientWidth,e.scrollLeft+100)})()")
                await command("Input.dispatchKeyEvent", {"type":"rawKeyDown","key":" ","code":"Space"})
                await command("Input.dispatchKeyEvent", {"type":"keyUp","key":" ","code":"Space"})
                await wait_for("document.querySelector('.professional-preview')?.paused===false")
                await evaluate("document.querySelector('.professional-preview').currentTime=2")
                await command("Input.dispatchKeyEvent", {"type":"rawKeyDown","key":" ","code":"Space"})
                await command("Input.dispatchKeyEvent", {"type":"keyUp","key":" ","code":"Space"})
                await wait_for("document.querySelector('.professional-preview')?.paused===true")
                await command("Input.dispatchKeyEvent", {"type":"rawKeyDown","key":" ","code":"Space","modifiers":8})
                await command("Input.dispatchKeyEvent", {"type":"keyUp","key":" ","code":"Space","modifiers":8})
                await wait_for("document.querySelector('.professional-preview')?.paused===false && document.querySelector('.professional-preview').currentTime<0.5")
                await command("Input.dispatchKeyEvent", {"type":"rawKeyDown","key":" ","code":"Space","autoRepeat":True})
                await command("Input.dispatchKeyEvent", {"type":"keyUp","key":" ","code":"Space"})
                assert await evaluate("document.querySelector('.professional-preview').paused===false"), "Repeated Space keydown paused playback"
                await evaluate("document.querySelector('.professional-timeline-tools input[type=number]').focus()")
                await command("Input.dispatchKeyEvent", {"type":"rawKeyDown","key":" ","code":"Space"})
                await command("Input.dispatchKeyEvent", {"type":"keyUp","key":" ","code":"Space"})
                assert await evaluate("document.querySelector('.professional-preview').paused===false"), "Space in a number input toggled playback"
                await evaluate("document.activeElement.blur()")
                empty = await evaluate("(() => {const e=document.querySelector('.professional-audio-lane'),r=e.getBoundingClientRect(),s=parseFloat(document.querySelector('.professional-audio-fragment').style.width)/1000;const f=document.querySelector('.professional-audio-fragment:last-of-type').getBoundingClientRect();return {x:f.right+40,y:r.top+r.height/2}})()")
                await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":empty["x"],"y":empty["y"],"button":"left"})
                await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":empty["x"],"y":empty["y"],"button":"left"})
                await wait_for("document.querySelector('.professional-preview')?.paused===true && Number(document.querySelector('.professional-timeline-content').dataset.playheadMs)>11000")
                await evaluate("(() => {const e=document.querySelector('.professional-timeline-tools input[type=number]');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,'137');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));const s=document.querySelector('.professional-timeline-tools select');s.value='24';s.dispatchEvent(new Event('change',{bubbles:true}))})()")
                audio_positions_before_offset = await evaluate("[...document.querySelectorAll('.professional-audio-fragment')].map(e=>e.style.left)")
                await evaluate("(() => {const e=document.querySelector('[aria-label=\\\"마디 오프셋 (1/96)\\\"]');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,'12');e.dispatchEvent(new Event('input',{bubbles:true}))})()")
                await wait_for("document.querySelector('.professional-timeline-tools select').value==='24'")
                assert await evaluate("[...document.querySelectorAll('.professional-audio-fragment')].map(e=>e.style.left)") == audio_positions_before_offset, "Grid offset moved audio fragments"
                await evaluate("(() => {const e=document.querySelectorAll('.professional-timeline-tools input[type=number]')[2];const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,'192');e.dispatchEvent(new Event('input',{bubbles:true}))})()")
                await wait_for("document.querySelectorAll('.professional-timeline-tools input[type=number]')[2].value==='192'")
                positive_grid = await evaluate("(() => {const e=document.querySelector('.professional-grid-layer'),r=e.getBoundingClientRect(),o=document.querySelector('.professional-timeline-content'),origin=parseFloat(document.querySelector('.professional-time-ruler').style.left),scale=parseFloat(document.querySelector('.professional-audio-fragment').style.width)/1000,offset=Number(document.querySelectorAll('.professional-timeline-tools input[type=number]')[2].value)*(60000/Number(document.querySelector('[aria-label=\"BPM\"]').value))/24;const bars=[...document.querySelectorAll('.professional-time-ruler span')];return {gridLeft:parseFloat(e.style.left)-origin,gridWidth:r.width,gridPosition:getComputedStyle(e).backgroundPositionX,offsetPx:offset*scale,labels:bars.map(x=>({text:x.textContent,left:x.style.left}))}})()")
                assert positive_grid["gridWidth"] > 0 and abs(positive_grid["gridLeft"]-positive_grid["offsetPx"]) < 1 and all(value.strip().startswith("0px") for value in positive_grid["gridPosition"].split(",")) and all(float(label["left"].replace("px", "")) >= positive_grid["offsetPx"] for label in positive_grid["labels"]), f"Positive offset drew grid or ruler marks before its origin: {positive_grid}"
                assert positive_grid["labels"] and positive_grid["labels"][0]["text"] == "1", f"Positive offset did not start ruler numbering at bar 1: {positive_grid}"
                await evaluate("(() => {const e=document.querySelectorAll('.professional-timeline-tools input[type=number]')[2];const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,'-12');e.dispatchEvent(new Event('input',{bubbles:true}))})()")
                await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
                negative_grid = await evaluate("(() => {const e=document.querySelector('.professional-grid-layer'),s=getComputedStyle(e),offset=Number(document.querySelectorAll('.professional-timeline-tools input[type=number]')[2].value),bpm=Number(document.querySelector('[aria-label=\"BPM\"]').value),scale=parseFloat(document.querySelector('.professional-audio-fragment').style.width)/1000,offsetMs=offset*(60000/bpm)/24,origin=parseFloat(document.querySelector('.professional-time-ruler').style.left);return {left:parseFloat(e.style.left),origin,position:s.backgroundPositionX,phase:parseFloat(s.backgroundPositionX.split(',')[0]),expectedPhase:Math.min(0,offsetMs)*scale,offset,bpm,scale,audio:[...document.querySelectorAll('.professional-audio-fragment')].map(x=>x.style.left)}})()")
                assert negative_grid["offset"] == -12 and abs(negative_grid["phase"]-negative_grid["expectedPhase"]) < 1 and abs(negative_grid["left"]-negative_grid["origin"]) < 1, f"Negative grid phase or origin is incorrect: {negative_grid}"
                assert negative_grid["audio"] == audio_positions_before_offset, f"Grid offset moved audio fragments: {negative_grid}"
                await evaluate("(() => {const e=document.querySelectorAll('.professional-timeline-tools input[type=number]')[2];const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,'12');e.dispatchEvent(new Event('input',{bubbles:true}))})()")
                await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
                await scroll_to_fragment('.professional-curve-lane.pitch .professional-curve-fragment:first-of-type .professional-curve')
                pitch = await evaluate("(() => {const e=document.querySelector('.professional-curve.pitch');const r=e.getBoundingClientRect();return {x:r.left+r.width*.5,y:r.top+r.height*.3}})()")
                await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":pitch["x"],"y":pitch["y"],"button":"right"})
                await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":pitch["x"],"y":pitch["y"],"button":"right"})
                await wait_for("document.querySelector('.professional-curve-lane.pitch .professional-curve-fragment:first-of-type .professional-curve').querySelectorAll('ellipse').length===3")
                await scroll_to_fragment('.professional-curve-lane.pitch .professional-curve-fragment:first-of-type .professional-curve')
                endpoint = await evaluate("(() => {const r=document.querySelector('.professional-curve-fragment .professional-curve.pitch ellipse:first-of-type').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
                await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":endpoint["x"],"y":endpoint["y"],"button":"right"})
                await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":endpoint["x"],"y":endpoint["y"],"button":"right"})
                await wait_for("document.querySelector('.professional-curve-lane.pitch .professional-curve-fragment:first-of-type .professional-curve').querySelectorAll('ellipse').length===3")
                await scroll_to_fragment('.professional-curve-lane.pitch .professional-curve-fragment:first-of-type .professional-curve')
                point = await evaluate("(() => {const r=document.querySelector('.professional-curve-fragment .professional-curve.pitch ellipse:nth-of-type(2)').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
                await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":point["x"],"y":point["y"],"button":"left"})
                await command("Input.dispatchMouseEvent", {"type":"mouseMoved","x":point["x"],"y":point["y"],"button":"left","buttons":1})
                await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":point["x"],"y":point["y"],"button":"left"})
                same_point = await evaluate("(() => {const r=document.querySelector('.professional-curve-fragment .professional-curve.pitch ellipse:nth-of-type(2)').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
                assert abs(same_point["x"]-point["x"])<1 and abs(same_point["y"]-point["y"])<1, f"Same-position drag jumped: {point} {same_point}"
                fine = await evaluate("(() => {const e=document.querySelector('.professional-selection-tools input[type=number]');return {value:Number(e.value),disabled:e.disabled}})()")
                assert not fine["disabled"], "Selected pitch point did not enable fine adjustment"
                await evaluate("(() => {const e=document.querySelector('.professional-selection-tools input[type=number]');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,String(Number(e.value)+1));e.dispatchEvent(new Event('input',{bubbles:true}))})()")
                await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":point["x"],"y":point["y"],"button":"left"})
                await command("Input.dispatchMouseEvent", {"type":"mouseMoved","x":point["x"]+25,"y":point["y"]-10,"button":"left","buttons":1})
                await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":point["x"]+25,"y":point["y"]-10,"button":"left"})
                await scroll_to_fragment('.professional-curve-lane.pitch .professional-curve-fragment:first-of-type .professional-curve')
                moved_pitch = await evaluate("(() => {const r=document.querySelector('.professional-curve-lane.pitch .professional-curve-fragment:first-of-type .professional-curve ellipse:nth-of-type(2)').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
                await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":moved_pitch["x"],"y":moved_pitch["y"],"button":"right"})
                await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":moved_pitch["x"],"y":moved_pitch["y"],"button":"right"})
                await wait_for("document.querySelector('.professional-curve-lane.pitch .professional-curve-fragment:first-of-type .professional-curve').querySelectorAll('ellipse').length===2")
                await wait_for("document.querySelector('.professional-selection-tools input[type=number]').disabled")
                await scroll_to_fragment('.professional-curve-lane.pitch .professional-curve-fragment:first-of-type .professional-curve')
                pitch_again = await evaluate("(() => {const r=document.querySelector('.professional-curve.pitch').getBoundingClientRect();return {x:r.left+r.width*.6,y:r.top+r.height*.3}})()")
                await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":pitch_again["x"],"y":pitch_again["y"],"button":"right"})
                await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":pitch_again["x"],"y":pitch_again["y"],"button":"right"})
                await wait_for("document.querySelector('.professional-curve-lane.pitch .professional-curve-fragment:first-of-type .professional-curve').querySelectorAll('ellipse').length===3")
                await scroll_to_fragment('.professional-curve-lane.volume .professional-curve-fragment:first-of-type .professional-curve')
                volume = await evaluate("(() => {const e=document.querySelector('.professional-curve-lane.volume .professional-curve-fragment:first-of-type .professional-curve');const r=e.getBoundingClientRect();return {x:r.left+r.width*.5,y:r.top+r.height*.3}})()")
                await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":volume["x"],"y":volume["y"],"button":"right"})
                await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":volume["x"],"y":volume["y"],"button":"right"})
                await wait_for("document.querySelector('.professional-curve-lane.volume .professional-curve-fragment:first-of-type .professional-curve').querySelectorAll('ellipse').length===3")
                await scroll_to_fragment('.professional-curve-lane.volume .professional-curve-fragment:first-of-type .professional-curve')
                vol_point = await evaluate("(() => {const r=document.querySelector('.professional-curve-lane.volume .professional-curve-fragment:first-of-type .professional-curve ellipse:nth-of-type(2)').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
                await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":vol_point["x"],"y":vol_point["y"],"button":"right"})
                await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":vol_point["x"],"y":vol_point["y"],"button":"right"})
                await wait_for("document.querySelector('.professional-curve-lane.volume .professional-curve-fragment:first-of-type .professional-curve').querySelectorAll('ellipse').length===2")
                expected_region_durations = await evaluate("(() => {const audio=[...document.querySelectorAll('.professional-audio-fragment')],curve=document.querySelector('.professional-curve-lane.pitch .professional-curve-fragment'),durations=[...curve.querySelectorAll('.professional-guide-line')].map(e=>Number(e.dataset.regionDurationMs)),total=Math.round(parseFloat(audio[0].style.width)/parseFloat(audio[1].style.width)*1000);durations.push(total-durations.reduce((sum,value)=>sum+value,0));return durations})()")
                await scroll_to_fragment('.professional-audio-fragment:first-of-type')
                await command("Runtime.evaluate", {"expression":"document.querySelector('.professional-actions .primary-action').click()"})
                await wait_for("document.body.innerText.includes('saved')", timeout=5)
                assert len(saved_requests) == 1, f"Save request was not captured: {request_log}"
                saved = saved_requests[0]
                assert saved["tempo_bpm"] == 137 and saved["beat_division"] == 24 and saved["grid_offset_units"] == 12, f"Beat display settings did not persist: {saved}"
                assert saved["segments"][0]["timeline_start_ms"] > 0 and saved["segments"][0]["gap_before_ms"] > 0, f"First fragment movement was not saved: {saved['segments'][0]}"
                saved_durations = [region["output_duration_ms"] for region in saved["segments"][0]["edit_regions"]]
                assert saved_durations == expected_region_durations, f"Edited region durations were not saved: expected {expected_region_durations}, got {saved_durations}"
                assert len(saved["segments"][0]["pitch_envelope"]) == 3, "Pitch curve points were not saved"
                assert len(saved["segments"][0]["volume_envelope"]) == 2, "Volume point removal was not saved"
                assert saved["segments"][0]["pitch_envelope"][1]["cents"] % 1 == 0, "Pitch cents are not integral"
                saved_width = await evaluate("document.querySelector('.professional-audio-fragment').style.width")
                footer = await evaluate("(() => {const e=document.querySelector('.professional-actions .primary-action');const r=e.getBoundingClientRect();return {visible:r.width>0&&r.height>0&&r.bottom<=innerHeight,disabled:e.disabled}})()")
                assert footer["visible"] and not footer["disabled"], f"Save control is unreachable: {footer}"
                await evaluate("(() => {const s=document.querySelectorAll('.professional-file-controls select')[0];s.value='parent';s.dispatchEvent(new Event('change',{bubbles:true}))})()")
                await wait_for("document.querySelector('.professional-timeline-tools input[type=number]').value==='120'")
                draft = await evaluate("(() => ({composition:document.querySelectorAll('.professional-file-controls select')[1].value,tempo:document.querySelector('.professional-timeline-tools input[type=number]').value,pitchPoints:document.querySelector('.professional-curve-lane.pitch .professional-curve-fragment:first-of-type .professional-curve').querySelectorAll('ellipse').length}))()")
                assert draft["composition"] == "" and draft["tempo"] == "120" and draft["pitchPoints"] == 2, f"Parent selection did not reset the draft: {draft}"
                await evaluate("(() => {const s=document.querySelectorAll('.professional-file-controls select')[1];s.value='saved';s.dispatchEvent(new Event('change',{bubbles:true}))})()")
                await wait_for("document.querySelector('.professional-timeline-tools input[type=number]').value==='137' && document.querySelector('.professional-timeline-tools select').value==='24' && document.querySelector('[aria-label=\\\"마디 오프셋 (1/96)\\\"]').value==='12' && document.querySelector('.professional-curve-lane.pitch .professional-curve-fragment:first-of-type .professional-curve').querySelectorAll('ellipse').length===3")
                reopened = await evaluate("(() => {const audio=[...document.querySelectorAll('.professional-audio-fragment')],f=audio[0],curve=document.querySelector('.professional-curve-lane.pitch .professional-curve-fragment'),durations=[...curve.querySelectorAll('.professional-guide-line')].map(e=>Number(e.dataset.regionDurationMs)),total=Math.round(parseFloat(audio[0].style.width)/parseFloat(audio[1].style.width)*1000);durations.push(total-durations.reduce((sum,value)=>sum+value,0));return {pitch:document.querySelector('.professional-curve-fragment .professional-curve.pitch').getAttribute('aria-label'),width:f.style.width,regions:f.querySelectorAll('.professional-guides i').length,durations}})()")
                assert float(reopened["width"].replace("px","")) > 0 and reopened["regions"] >= 1, f"Reopened editor lost duration or guide state: {reopened}"
                assert abs(float(reopened["width"].replace("px", "")) - float(saved_width.replace("px", ""))) < 0.1, f"Reopened editor lost saved duration: {saved_width} -> {reopened}"
                assert reopened["durations"] == expected_region_durations, f"Reopened editor lost individual region durations: expected {expected_region_durations}, got {reopened['durations']}"
                screenshot = await command("Page.captureScreenshot", {"format":"png","captureBeyondViewport":True,"fromSurface":True})
                ARTIFACT.write_bytes(base64.b64decode(screenshot["data"]))
                print(json.dumps({"status":"passed","initial_scroll_width":initial["width"],"save_fields":["tempo_bpm","beat_division","grid_offset_units","pitch_envelope","volume_envelope"],"screenshot":str(ARTIFACT)},ensure_ascii=False))
            except Exception:
                details = await evaluate("({url:location.href,body:document.body?.innerText||''})")
                print(json.dumps({"failure":details,"requests":request_log,"runtime_errors":runtime_errors},ensure_ascii=False))
                dom = await evaluate("document.documentElement.outerHTML")
                (ARTIFACT.parent / "professional-editor-smoke-failure.html").write_text(dom or "DOM unavailable",encoding="utf-8")
                shot = await command("Page.captureScreenshot", {"format":"png","captureBeyondViewport":True,"fromSurface":True})
                (ARTIFACT.parent / "professional-editor-smoke-failure.png").write_bytes(base64.b64decode(shot["data"]))
                raise
    finally:
        if chrome is not None:
            chrome.terminate()
            try: chrome.wait(timeout=5)
            except subprocess.TimeoutExpired: chrome.kill()
        vite.terminate()
        try: vite.wait(timeout=5)
        except subprocess.TimeoutExpired: vite.kill()
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(asyncio.wait_for(run_smoke(), timeout=45))
