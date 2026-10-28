# ruff: noqa: ASYNC210, ASYNC220
import asyncio
import base64
import copy
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
from websockets.exceptions import ConnectionClosed

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "web"
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
ARTIFACT_DIR = WEB / "tests" / "artifacts"
ARTIFACT = ARTIFACT_DIR / "world-syllable-notes-smoke.png"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def fixtures() -> dict[str, tuple[int, str, bytes]]:
    source = {"source_id": "source", "path": "source.wav", "duration_ms": 4000,
              "audio_sample_rate": 16000, "audio_channels": 1, "video_width": 640,
              "video_height": 360, "video_fps": 30}
    phone_specs = [
        ("ko.consonant.g", "g", 100, 250),
        ("ko.vowel.a", "a", 250, 400),
        ("ko.coda.b", "b", 400, 550),
        ("ko.consonant.n", "n", 550, 700),
        ("ko.vowel.i", "i", 700, 850),
        ("ko.coda.d", "d", 850, 1000),
    ]
    phone_units = [{
        "phone_unit_id": f"phone_{index}", "operation": "MATCH", "target_index": 0,
        "target_phone_id": phone_id, "target_ipa": ipa, "source_occurrence_id": f"occ_{index}",
        "source_phone_id": phone_id, "source_ipa": ipa, "source_start_ms": start,
        "source_end_ms": end, "output_duration_ms": end - start, "source_f0_hz": None,
        "voiced_probability": 0.0, "target_pitch_midi": None, "formant_shift_semitones": 0,
        "transition_to_next_ms": 0, "transition_strength_percent": 100, "transition_center_ms": 0,
        "pitch_points": [], "pitch_owner_ref": None,
    } for index, (phone_id, ipa, start, end) in enumerate(phone_specs)]
    segment = {
        "segment_id": "segment_0", "candidate_id": "candidate_0", "target_start_index": 0,
        "target_end_index": 1, "source_id": "source", "source_start_ms": 100,
        "source_end_ms": 1000, "timeline_start_ms": 0, "timeline_end_ms": 900,
        "match_status": "EXACT", "target_ipa": ["ka", "ni"], "matched_ipa": ["ka", "ni"],
        "gap_before_ms": 0, "stretch_percent": 100, "lane": 0, "phone_units": phone_units,
        "edit_regions": [], "volume_envelope": [{"position": 0, "gain": 0.8}, {"position": 1, "gain": 1.15}],
    }
    detail = {"manifest": {"project_id": "smoke", "name": "Smoke", "analysis_ids": [],
        "source_analyses": {}, "created_at": "2026-01-01T00:00:00Z", "model_name": "test",
        "inference_backend": "test", "inference_device": "CPU", "sources": [source]},
        "analyses": [{"source_id": "source", "transcript": "", "audio_regions": [], "sentences": [],
                      "words": [], "transcript_candidates": [], "word_count": 0, "phone_count": 6}]}
    parent = {"composition_id": "parent", "corpus_project_id": "smoke", "name": "Parent",
        "target_text": "가니", "target_pronunciation": "ka ni", "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z", "crossfade_ms": 8, "segments": [segment],
        "mode": "SIMPLE", "schema_version": 1, "parent_composition_id": None,
        "parent_composition_updated_at": None}
    residual_phone_units = copy.deepcopy(phone_units)
    for phone, bounds in zip(residual_phone_units[3:], [(650, 800), (800, 900), (900, 1000)], strict=True):
        phone["source_start_ms"], phone["source_end_ms"] = bounds
        phone["output_duration_ms"] = bounds[1] - bounds[0]
    residual_segment = {
        **segment,
        "segment_id": "segment_residual",
        "phone_units": residual_phone_units,
        "edit_regions": [
            {"region_id": "crossing", "source_start_ms": 100, "source_end_ms": 600,
             "output_duration_ms": 500, "relative_pitch_cents": 0, "source_f0_hz": None},
            {"region_id": "uncovered", "source_start_ms": 600, "source_end_ms": 650,
             "output_duration_ms": 50, "relative_pitch_cents": 0, "source_f0_hz": None},
            {"region_id": "second_syllable", "source_start_ms": 650, "source_end_ms": 1000,
             "output_duration_ms": 350, "relative_pitch_cents": 0, "source_f0_hz": None},
        ],
    }
    residual_parent = {
        **parent,
        "composition_id": "parent-residual",
        "name": "Residual boundary fixture",
        "segments": [residual_segment],
    }
    audio_buffer = BytesIO()
    with wave.open(audio_buffer, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\0\0" * 64000)
    body = lambda value: json.dumps(value, ensure_ascii=False).encode()
    return {
        "/api/projects": (200, "application/json", body([{"project_id": "smoke", "name": "Smoke",
            "created_at": "2026-01-01T00:00:00Z", "model_name": "test", "inference_backend": "test",
            "inference_device": "CPU", "source_count": 1, "total_duration_ms": 4000}])),
        "/api/projects/smoke": (200, "application/json", body(detail)),
        "/api/projects/smoke/compositions": (200, "application/json", body([parent, residual_parent])),
        "/api/projects/smoke/audio/source": (200, "audio/wav", audio_buffer.getvalue()),
        "/api/projects/smoke/compositions/preview": (200, "audio/wav", audio_buffer.getvalue()),
        "/api/projects/smoke/timeline": (200, "application/json", b'{"start_ms":0,"end_ms":4000,"audio_regions":[],"words":[],"phones":[],"acoustic_features":[]}'),
        "/api/projects/smoke/waveform": (200, "application/json", b'{"start_ms":0,"end_ms":4000,"peaks":[0.1,0.4,0.8,0.2]}'),
        "/api/videos": (200, "application/json", b"[]"),
        "/api/analysis-hardware": (200, "application/json", b'{"backend":"faster-whisper","device":"CPU","gpu_vendor":null}'),
    }


def analysis_reply(request: dict) -> dict:
    result = []
    for segment in request.get("segments", []):
        regions = segment.get("edit_regions", [])
        total = max(1, sum(region["output_duration_ms"] for region in regions))
        cursor = 0
        output_regions = []
        for region in regions:
            duration = region["output_duration_ms"]
            points = region.get("pitch_points") or []
            original_midi = 58 if region["source_start_ms"] < 550 else 64
            midi = points[len(points) // 2]["midi"] if points else original_midi
            output_regions.append({
                "region_id": region["region_id"], "source_start_ms": region["source_start_ms"],
                "source_end_ms": region["source_end_ms"], "output_start_ms": cursor,
                "output_end_ms": cursor + duration,
                "original": [{"position": (cursor + p * duration) / total, "hz": 440 * 2 ** ((original_midi - 69) / 12)} for p in (0, .5, 1)],
                "corrected": [{"position": (cursor + p * duration) / total, "hz": 440 * 2 ** ((midi - 69) / 12)} for p in (0, .5, 1)],
            })
            cursor += duration
        result.append({"segment_id": segment["segment_id"], "phones": [], "regions": output_regions})
    return {"segments": result}


async def run_smoke() -> None:
    if not CHROME.is_file():
        raise RuntimeError(f"Chrome was not found at {CHROME}")
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    port, debug_port = free_port(), free_port()
    temp_root = Path(tempfile.mkdtemp(prefix="madnolia-world-note-smoke-"))
    vite = subprocess.Popen(["node", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", str(port), "--configLoader", "native"], cwd=WEB, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    chrome = None
    request_log: list[dict] = []
    analysis_requests: list[dict] = []
    preview_requests: list[dict] = []
    saved_requests: list[dict] = []
    runtime_errors: list[str] = []
    analysis_delay_ms = 0
    deferred_fulfillments: set[asyncio.Task] = set()
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1).close()
                break
            except OSError:
                await asyncio.sleep(.1)
        with (temp_root / "chrome.log").open("wb") as log:
            chrome = subprocess.Popen([str(CHROME), "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-crash-reporter", "--disable-breakpad",
                "--window-size=1440,900", f"--remote-debugging-port={debug_port}",
                f"--user-data-dir={temp_root / 'chrome-profile'}", "--remote-allow-origins=*",
                "--no-first-run", "--disable-extensions", "--disable-background-networking", "about:blank"], stdout=log, stderr=subprocess.STDOUT)
        version = None
        for _ in range(40):
            try:
                version = json.load(urllib.request.urlopen(f"http://127.0.0.1:{debug_port}/json/version", timeout=1))
                break
            except OSError:
                if chrome.poll() is not None:
                    break
                await asyncio.sleep(.1)
        if version is None:
            chrome_log = temp_root / "chrome.log"
            raise RuntimeError(f"Chrome DevTools did not start: {chrome_log.read_text(encoding='utf-8', errors='replace')[-2500:]}")
        page = next(item for item in json.load(urllib.request.urlopen(f"http://127.0.0.1:{debug_port}/json/list", timeout=2)) if item.get("type") == "page")
        fixtures_by_path = fixtures()
        responses: dict[int, dict] = {}
        next_id = 0
        async with connect(page["webSocketDebuggerUrl"], max_size=16 * 1024 * 1024) as ws:
            async def fulfill(request_id: str, status: int, mime: str, payload: bytes) -> None:
                nonlocal next_id
                next_id += 1
                await ws.send(json.dumps({"id": next_id, "method": "Fetch.fulfillRequest", "params": {
                    "requestId": request_id, "responseCode": status,
                    "responseHeaders": [{"name": "Content-Type", "value": mime}, {"name": "Access-Control-Allow-Origin", "value": "*"}],
                    "body": base64.b64encode(payload).decode()}}))

            async def fulfill_after(delay_ms: int, request_id: str, status: int, mime: str, payload: bytes) -> None:
                await asyncio.sleep(delay_ms / 1000)
                try:
                    await fulfill(request_id, status, mime, payload)
                except ConnectionClosed:
                    return

            async def command(method: str, params: dict | None = None) -> dict:
                nonlocal next_id, analysis_delay_ms
                next_id += 1
                current = next_id
                await ws.send(json.dumps({"id": current, "method": method, "params": params or {}}))
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline:
                    if current in responses:
                        response = responses.pop(current)
                        if "error" in response:
                            raise RuntimeError(f"CDP {method} failed: {response['error']}")
                        return response.get("result", {})
                    message = json.loads(await asyncio.wait_for(ws.recv(), deadline - time.monotonic()))
                    if message.get("id") is not None:
                        responses[message["id"]] = message
                        continue
                    if message.get("method") == "Runtime.exceptionThrown":
                        runtime_errors.append(message["params"].get("exceptionDetails", {}).get("text", "runtime exception"))
                    if message.get("method") != "Fetch.requestPaused":
                        continue
                    paused = message["params"]
                    request = paused["request"]
                    path = "/" + request["url"].split("/", 3)[-1].split("?", 1)[0]
                    body = json.loads(request.get("postData", "{}")) if request.get("postData") else {}
                    if request.get("method") == "POST" and path == "/api/projects/smoke/compositions/pitch-analysis":
                        analysis_requests.append(body)
                        status, mime, payload = 200, "application/json", json.dumps(analysis_reply(body)).encode()
                    elif request.get("method") == "POST" and path == "/api/projects/smoke/compositions/preview":
                        preview_requests.append(body)
                        status, mime, payload = fixtures_by_path[path]
                    elif request.get("method") == "POST" and path == "/api/collages":
                        saved_requests.append(body.get("composition", body))
                        composition = saved_requests[-1]
                        status, mime, payload = 201, "application/json", json.dumps({"composition_id": "saved", "corpus_project_id": "smoke", **composition}).encode()
                    else:
                        status, mime, payload = fixtures_by_path.get(path, (404, "application/json", b'{"detail":"not stubbed"}'))
                    request_log.append({"method": request.get("method"), "path": path, "status": status})
                    delay_ms = analysis_delay_ms if path == "/api/projects/smoke/compositions/pitch-analysis" else 0
                    if delay_ms:
                        analysis_delay_ms = 0
                        task = asyncio.create_task(fulfill_after(delay_ms, paused["requestId"], status, mime, payload))
                        deferred_fulfillments.add(task)
                        task.add_done_callback(deferred_fulfillments.discard)
                    else:
                        await fulfill(paused["requestId"], status, mime, payload)
                raise TimeoutError(f"{method} timed out")

            async def evaluate(expression: str):
                result = await command("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True})
                if result.get("exceptionDetails"):
                    detail = result["exceptionDetails"]
                    raise RuntimeError(detail.get("exception", {}).get("description") or detail.get("text", "evaluation failed"))
                return result.get("result", {}).get("value")

            async def wait_for(expression: str, timeout: float = 12) -> None:
                deadline = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    if await evaluate(expression):
                        return
                    await asyncio.sleep(.1)
                raise AssertionError(f"Timed out: {expression}; requests={request_log}; console={runtime_errors}")

            await command("Fetch.enable", {"patterns": [{"urlPattern": f"http://127.0.0.1:{port}/api/*"}]})
            await command("Page.enable")
            await command("Runtime.enable")
            await command("Page.addScriptToEvaluateOnNewDocument", {"source": "(() => { const setItem = Storage.prototype.setItem; window.__draftWriteCount = 0; Storage.prototype.setItem = function(key, value) { if (String(key).startsWith('madnolia.professionalDraft.')) window.__draftWriteCount += 1; return setItem.call(this, key, value); }; })()"})
            await command("Emulation.setDeviceMetricsOverride", {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})
            await command("Page.navigate", {"url": f"http://127.0.0.1:{port}/#/professional/smoke"})
            await wait_for("document.querySelectorAll('.professional-audio-fragment').length===1")
            await wait_for("document.querySelector('.professional-footer > button')!==null")
            await evaluate("document.querySelector('.professional-footer > button').click()")
            await wait_for("getComputedStyle(document.querySelector('.piano-roll-editor')).display==='flex'")
            await wait_for("document.querySelectorAll('.piano-syllable-note').length===2")
            assert await evaluate("document.querySelectorAll('.piano-pitch-point, .piano-roll-chart circle, .piano-roll-chart svg').length") == 0, "Pitch point controls are still visible in the bar-only editor"
            assert await evaluate("(() => {const e=new MouseEvent('contextmenu',{bubbles:true,cancelable:true});document.querySelector('.piano-roll-chart').dispatchEvent(e);return e.defaultPrevented})()"), "Right-click on the pitch chart was not consumed"
            await wait_for("document.querySelector('.piano-roll-analysis')===null")
            await wait_for("document.querySelectorAll('.global-task-dialog').length===0")
            await evaluate("(() => {const inputs=[...document.querySelectorAll('.piano-roll-grid-controls input[type=number]')],set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;for(const [input,value] of [[inputs[0],'137'],[inputs.at(-1),'7']]){set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))}return true})()")
            await wait_for("document.querySelector('.piano-roll-grid-controls input[type=number]').value==='137'")
            await wait_for("[...document.querySelectorAll('.piano-roll-grid-controls input[type=number]')].at(-1).value==='7'")

            await evaluate("(() => {const chart=document.querySelector('.piano-roll-chart'),scroll=document.querySelector('.piano-roll-pitch-scroll'),scale=.12,sem=Number.parseFloat(getComputedStyle(chart).getPropertyValue('--semitone-height'))||16,midi=70;scroll.scrollTop=500;const x=chart.getBoundingClientRect().left+Math.max(30,100*scale),y=scroll.getBoundingClientRect().top+(108-midi+.5)*sem-scroll.scrollTop;chart.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,pointerId:1,clientX:x,clientY:y}));window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,button:0,pointerId:1,clientX:x+100,clientY:y}));window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,button:0,pointerId:1,clientX:x+100,clientY:y}));return {x,y,scrollTop:scroll.scrollTop}})()")
            await wait_for("document.querySelectorAll('.piano-target-note').length===1")
            snapped_note = await evaluate("(() => {const note=document.querySelector('.piano-target-note'),bpm=Number(document.querySelector('.piano-roll-grid-controls input[type=number]').value),offset=Number([...document.querySelectorAll('.piano-roll-grid-controls input[type=number]')].at(-1).value)*60000/bpm/24,division=Number(document.querySelector('.piano-roll-grid-controls select').value),grid=60000/bpm*4/division;return {start:Number(note.dataset.startMs),end:Number(note.dataset.endMs),grid,offset}})()")
            assert snapped_note["start"] == round((snapped_note["start"] - snapped_note["offset"]) / snapped_note["grid"])*snapped_note["grid"] + snapped_note["offset"] or abs((snapped_note["start"] - snapped_note["offset"]) / snapped_note["grid"] - round((snapped_note["start"] - snapped_note["offset"]) / snapped_note["grid"])) < .01, f"BPM 137 with offset did not snap the note start to grid: {snapped_note}"
            assert abs((snapped_note["end"] - snapped_note["offset"]) / snapped_note["grid"] - round((snapped_note["end"] - snapped_note["offset"]) / snapped_note["grid"])) < .01 and all(isinstance(snapped_note[key], int) for key in ("start", "end")), f"Non-integer BPM produced a fractional or unsnapped note end: {snapped_note}"
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await wait_for("document.querySelectorAll('.piano-target-note').length===0")
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "y", "code": "KeyY", "windowsVirtualKeyCode": 89, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "y", "code": "KeyY", "windowsVirtualKeyCode": 89, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await wait_for("document.querySelectorAll('.piano-target-note').length===1")
            await evaluate("(() => {const chart=document.querySelector('.piano-roll-chart'),scroll=document.querySelector('.piano-roll-pitch-scroll'),sem=Number.parseFloat(getComputedStyle(chart).getPropertyValue('--semitone-height'))||16,midi=70,x=chart.getBoundingClientRect().left+50,y=scroll.getBoundingClientRect().top+(108-midi+.5)*sem-scroll.scrollTop;chart.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,altKey:true,pointerId:2,clientX:x,clientY:y}));window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,button:0,altKey:true,pointerId:2,clientX:x+15,clientY:y}));window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,button:0,altKey:true,pointerId:2,clientX:x+15,clientY:y}));return true})()")
            await wait_for("document.querySelectorAll('.piano-target-note').length===2")
            alt_note = await evaluate("(() => {const note=document.querySelectorAll('.piano-target-note')[1],bpm=Number(document.querySelector('.piano-roll-grid-controls input[type=number]').value),offset=Number([...document.querySelectorAll('.piano-roll-grid-controls input[type=number]')].at(-1).value)*60000/bpm/24,division=Number(document.querySelector('.piano-roll-grid-controls select').value),grid=60000/bpm*4/division;return {start:Number(note.dataset.startMs),end:Number(note.dataset.endMs),grid,offset}})()")
            assert alt_note["end"] - alt_note["start"] >= 20 and (abs((alt_note["start"] - alt_note["offset"]) / alt_note["grid"] - round((alt_note["start"] - alt_note["offset"]) / alt_note["grid"])) > .01 or abs((alt_note["end"] - alt_note["offset"]) / alt_note["grid"] - round((alt_note["end"] - alt_note["offset"]) / alt_note["grid"])) > .01), f"Alt-drawn note was not freely positioned with a valid minimum length: {alt_note}"
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await wait_for("document.querySelectorAll('.piano-target-note').length===1")
            await evaluate("document.querySelector('.piano-target-note').click()")
            await wait_for("window.__draftWriteCount>=1")
            target_note = await evaluate("(() => {const note=document.querySelector('.piano-target-note'),circle=note.querySelector('circle'),box=circle.getBoundingClientRect();return {label:note.getAttribute('aria-label'),knotWidth:box.width,knotHeight:box.height,knotHit:document.elementFromPoint(box.left+box.width/2,box.top+box.height/2)===circle}})()")
            assert "A♯4" in target_note["label"], f"A note drawn on MIDI 70 was rendered at a different pitch: {target_note}"
            assert target_note["knotWidth"] >= 8 and target_note["knotHeight"] >= 8, f"Pitch knot is too small: {target_note}"
            await evaluate("(() => {const note=document.querySelector('.piano-target-note'),box=note.getBoundingClientRect();note.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:box.left+box.width/2,clientY:box.top+box.height/2}));return true})()")
            await wait_for("document.querySelectorAll('.piano-target-note circle').length===3")
            target_note["knotHit"] = await evaluate("(() => [...document.querySelectorAll('.piano-target-note circle')].map((circle,index,nodes)=>{const box=circle.getBoundingClientRect(),x=index===0?box.left+2:index===nodes.length-1?box.right-2:box.left+box.width/2;return document.elementFromPoint(x,box.top+box.height/2)===circle}))()")
            assert all(target_note["knotHit"]), f"Endpoint or midpoint pitch knot is obscured: {target_note}"
            await evaluate("(() => {const note=document.querySelector('.piano-target-note'),scroll=document.querySelector('.piano-roll-pitch-scroll'),box=note.getBoundingClientRect(),view=scroll.getBoundingClientRect();scroll.scrollTop=Math.max(0,Math.min(scroll.scrollHeight-scroll.clientHeight,scroll.scrollTop+box.top-view.top-(scroll.clientHeight-box.height)/2));return true})()")
            target_screenshot = await command("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": True, "fromSurface": True})
            target_artifact = ARTIFACT_DIR / "piano-target-note-smoke.png"
            target_artifact.write_bytes(base64.b64decode(target_screenshot["data"]))
            delete_geometry = await evaluate("(() => {const panel=document.querySelector('.piano-roll-controls').getBoundingClientRect(),button=document.querySelector('.piano-note-delete'),box=button.getBoundingClientRect();return {visible:box.top>=panel.top&&box.bottom<=panel.bottom&&box.left>=panel.left&&box.right<=panel.right,hit:document.elementFromPoint(box.left+box.width/2,box.top+box.height/2)===button}})()")
            assert delete_geometry["visible"] and delete_geometry["hit"], f"Selected-note delete button is clipped or not hit-testable: {delete_geometry}"
            await evaluate("document.querySelector('.piano-note-delete').click()")
            await wait_for("document.querySelectorAll('.piano-target-note').length===0")
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await wait_for("document.querySelectorAll('.piano-target-note').length===1")
            await evaluate("document.querySelector('.piano-target-note').click()")

            await evaluate("(() => {const chart=document.querySelector('.piano-roll-chart'),scroll=document.querySelector('.piano-roll-pitch-scroll'),sem=Number.parseFloat(getComputedStyle(chart).getPropertyValue('--semitone-height'))||16,time=1300,midi=74,id=3,x=chart.getBoundingClientRect().left+time*.12,y=scroll.getBoundingClientRect().top+(108-midi+.5)*sem-scroll.scrollTop;chart.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,pointerId:id,clientX:x,clientY:y}));window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,button:0,pointerId:id,clientX:x+360,clientY:y}));window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,button:0,pointerId:id,clientX:x+360,clientY:y}));return true})()")
            await wait_for("document.querySelectorAll('.piano-target-note').length===2")
            await evaluate("(() => {const chart=document.querySelector('.piano-roll-chart'),scroll=document.querySelector('.piano-roll-pitch-scroll'),sem=Number.parseFloat(getComputedStyle(chart).getPropertyValue('--semitone-height'))||16,time=2600,midi=82,id=4,x=chart.getBoundingClientRect().left+time*.12,y=scroll.getBoundingClientRect().top+(108-midi+.5)*sem-scroll.scrollTop;chart.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,pointerId:id,clientX:x,clientY:y}));window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,button:0,pointerId:id,clientX:x+360,clientY:y}));window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,button:0,pointerId:id,clientX:x+360,clientY:y}));return true})()")
            await wait_for("document.querySelectorAll('.piano-target-note').length===3")
            drawn_notes = await evaluate("[...document.querySelectorAll('.piano-target-note')].map(note=>({start:note.dataset.startMs,end:note.dataset.endMs,label:note.getAttribute('aria-label')}))")
            assert len(drawn_notes) == 3, f"Could not draw the two extra target notes: {drawn_notes}"
            await evaluate("document.querySelectorAll('.piano-target-note')[0].click()")
            ctrl_target = await evaluate("(() => {const box=document.querySelectorAll('.piano-target-note')[1].getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2}})()")
            await command("Input.dispatchMouseEvent", {"type": "mousePressed", "x": ctrl_target["x"], "y": ctrl_target["y"], "button": "left", "clickCount": 1, "modifiers": 2})
            await command("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": ctrl_target["x"], "y": ctrl_target["y"], "button": "left", "clickCount": 1, "modifiers": 2})
            selected_after_ctrl = await evaluate("[...document.querySelectorAll('.piano-target-note')].map(note=>({id:note.dataset.noteId,selected:note.classList.contains('selected')}))")
            assert sum(note["selected"] for note in selected_after_ctrl) == 2, f"Ctrl-click did not add a drawn target note to selection: {selected_after_ctrl}"
            before_ctrl_drag = await evaluate("[...document.querySelectorAll('.piano-target-note')].map(note=>({id:note.dataset.noteId,start:Number(note.dataset.startMs),end:Number(note.dataset.endMs),top:parseFloat(note.style.top)}))")
            await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":ctrl_target["x"],"y":ctrl_target["y"],"button":"left","modifiers":2})
            await command("Input.dispatchMouseEvent", {"type":"mouseMoved","x":ctrl_target["x"]+64,"y":ctrl_target["y"]-16,"button":"left","buttons":1,"modifiers":2})
            await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":ctrl_target["x"]+64,"y":ctrl_target["y"]-16,"button":"left","modifiers":2})
            after_ctrl_drag = await evaluate("[...document.querySelectorAll('.piano-target-note')].map(note=>({id:note.dataset.noteId,start:Number(note.dataset.startMs),end:Number(note.dataset.endMs),top:parseFloat(note.style.top)}))")
            assert [note["start"] for note in after_ctrl_drag] == [note["start"] for note in before_ctrl_drag] and [note["end"] for note in after_ctrl_drag] == [note["end"] for note in before_ctrl_drag], f"Ctrl+drag changed selected target note time or duration: {before_ctrl_drag} -> {after_ctrl_drag}"
            assert all(after["top"] == before["top"]-16 for before, after in zip(before_ctrl_drag[:2], after_ctrl_drag[:2], strict=True)), f"Ctrl+drag did not move the selected group by a semitone: {before_ctrl_drag} -> {after_ctrl_drag}"
            assert after_ctrl_drag[2] == before_ctrl_drag[2], f"Ctrl+drag moved an unselected target note: {before_ctrl_drag} -> {after_ctrl_drag}"
            assert await evaluate("document.querySelectorAll('.piano-target-note.selected').length") == 2, "Ctrl+drag caused the click handler to replace the group selection"
            await command("Input.dispatchKeyEvent", {"type":"keyDown","key":"Control","code":"ControlLeft","windowsVirtualKeyCode":17})
            await command("Input.dispatchKeyEvent", {"type":"keyDown","key":"z","code":"KeyZ","windowsVirtualKeyCode":90,"modifiers":2})
            await command("Input.dispatchKeyEvent", {"type":"keyUp","key":"z","code":"KeyZ","windowsVirtualKeyCode":90,"modifiers":2})
            await command("Input.dispatchKeyEvent", {"type":"keyUp","key":"Control","code":"ControlLeft","windowsVirtualKeyCode":17})
            await wait_for("parseFloat(document.querySelectorAll('.piano-target-note')[1].style.top)==="+str(before_ctrl_drag[1]["top"]))
            await evaluate("(() => {const notes=[...document.querySelectorAll('.piano-target-note')];notes[1].dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}));return true})()")
            assert await evaluate("document.querySelectorAll('.piano-target-note.selected').length") == 1, "Ctrl-click did not toggle a selected target note off"
            return_origin = await evaluate("(() => {const n=document.querySelector('.piano-target-note.selected'),r=n.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,top:parseFloat(n.style.top)}})()")
            await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":return_origin["x"],"y":return_origin["y"],"button":"left","modifiers":2})
            await command("Input.dispatchMouseEvent", {"type":"mouseMoved","x":return_origin["x"],"y":return_origin["y"]-16,"button":"left","buttons":1,"modifiers":2})
            await command("Input.dispatchMouseEvent", {"type":"mouseMoved","x":return_origin["x"],"y":return_origin["y"],"button":"left","buttons":1,"modifiers":2})
            await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":return_origin["x"],"y":return_origin["y"],"button":"left","modifiers":2})
            return_origin_top = await evaluate("parseFloat(document.querySelector('.piano-target-note.selected').style.top)")
            assert return_origin_top == return_origin["top"], f"Returning a Ctrl pitch drag to its origin did not restore the original pitch: {return_origin} -> {return_origin_top}"
            await evaluate("document.querySelector('.piano-target-note.selected').focus()")
            fractional_point = await evaluate("(() => {const note=document.querySelector('.piano-target-note.selected'),circle=note.querySelector('circle'),r=circle.getBoundingClientRect(),h=parseFloat(getComputedStyle(document.querySelector('.piano-roll-pitch-content')).getPropertyValue('--semitone-height'));return {x:r.left+r.width/2,y:r.top+r.height/2,h}})()")
            await evaluate("(() => {const circle=document.querySelector('.piano-target-note.selected circle'),id=32,x="+str(fractional_point["x"])+",y="+str(fractional_point["y"])+";circle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,pointerId:id,clientX:x,clientY:y}));window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,button:0,pointerId:id,clientX:x,clientY:y-"+str(fractional_point["h"]*.304)+"}));window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,button:0,pointerId:id,clientX:x,clientY:y-"+str(fractional_point["h"]*.304)+"}));return true})()")
            first_midi_expression = "(() => {const note=document.querySelector('.piano-target-note.selected'),h=parseFloat(getComputedStyle(document.querySelector('.piano-roll-pitch-content')).getPropertyValue('--semitone-height')),top=parseFloat(note.style.top),y=Number(note.querySelector('polyline').getAttribute('points').split(/[ ,]/)[1]);return 108.5-top/h-y/h})()"
            async def control_shortcut(key: str, code: str, virtual_key: int):
                await command("Input.dispatchKeyEvent", {"type":"keyDown","key":"Control","code":"ControlLeft","windowsVirtualKeyCode":17})
                await command("Input.dispatchKeyEvent", {"type":"keyDown","key":key,"code":code,"windowsVirtualKeyCode":virtual_key,"modifiers":2})
                await command("Input.dispatchKeyEvent", {"type":"keyUp","key":key,"code":code,"windowsVirtualKeyCode":virtual_key,"modifiers":2})
                await command("Input.dispatchKeyEvent", {"type":"keyUp","key":"Control","code":"ControlLeft","windowsVirtualKeyCode":17})
            fractional_midi = await evaluate(first_midi_expression)
            assert abs(fractional_midi-70.30) < 1e-9, f"Target-note curve drag did not quantize to cents: {fractional_midi}"
            fractional_horizontal = await evaluate("(() => {const n=document.querySelector('.piano-target-note.selected'),r=n.getBoundingClientRect();return {x:r.left+r.width*.8,y:r.top+r.height/2,start:Number(n.dataset.startMs)}})()")
            await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":fractional_horizontal["x"],"y":fractional_horizontal["y"],"button":"left"})
            await command("Input.dispatchMouseEvent", {"type":"mouseMoved","x":fractional_horizontal["x"]+48,"y":fractional_horizontal["y"],"button":"left","buttons":1})
            await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":fractional_horizontal["x"]+48,"y":fractional_horizontal["y"],"button":"left"})
            assert abs(await evaluate(first_midi_expression)-70.30) < 1e-9, "Horizontal-only note drag changed a fractional pitch anchor"
            assert await evaluate("Number(document.querySelector('.piano-target-note.selected').dataset.startMs)") > fractional_horizontal["start"], "Horizontal-only note drag did not move note time"
            await control_shortcut("z", "KeyZ", 90)
            await wait_for("Math.abs(("+first_midi_expression+")-70.3)<1e-9")
            await wait_for("Number(document.querySelector('.piano-target-note.selected').dataset.startMs)==="+str(fractional_horizontal["start"]))
            fractional_horizontal = await evaluate("(() => {const n=document.querySelector('.piano-target-note.selected'),r=n.getBoundingClientRect();return {x:r.left+r.width*.8,y:r.top+r.height/2,start:Number(n.dataset.startMs)}})()")
            await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":fractional_horizontal["x"],"y":fractional_horizontal["y"],"button":"left","modifiers":2})
            await command("Input.dispatchMouseEvent", {"type":"mouseMoved","x":fractional_horizontal["x"]+48,"y":fractional_horizontal["y"],"button":"left","buttons":1,"modifiers":2})
            await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":fractional_horizontal["x"]+48,"y":fractional_horizontal["y"],"button":"left","modifiers":2})
            ctrl_horizontal_midi = await evaluate(first_midi_expression)
            ctrl_horizontal_start = await evaluate("Number(document.querySelector('.piano-target-note.selected').dataset.startMs)")
            assert abs(ctrl_horizontal_midi-70.30) < 1e-9 and ctrl_horizontal_start == fractional_horizontal["start"], f"Ctrl horizontal-only drag changed pitch or time: pitch={ctrl_horizontal_midi}, start={ctrl_horizontal_start}, initial={fractional_horizontal}"
            note_time_before_keys = await evaluate("(() => {const n=document.querySelector('.piano-target-note.selected');return [n.dataset.startMs,n.dataset.endMs]})()")
            await command("Input.dispatchKeyEvent", {"type":"rawKeyDown","key":"ArrowUp","code":"ArrowUp"})
            await command("Input.dispatchKeyEvent", {"type":"keyUp","key":"ArrowUp","code":"ArrowUp"})
            assert await evaluate(first_midi_expression) == 71, "ArrowUp did not move fractional MIDI 70.3 to 71"
            assert await evaluate("(() => {const n=document.querySelector('.piano-target-note.selected');return [n.dataset.startMs,n.dataset.endMs]})()") == note_time_before_keys, "ArrowUp changed note time or duration"
            await control_shortcut("z", "KeyZ", 90)
            await wait_for("Math.abs(("+first_midi_expression+")-70.3)<1e-9")
            await command("Input.dispatchKeyEvent", {"type":"rawKeyDown","key":"ArrowDown","code":"ArrowDown"})
            await command("Input.dispatchKeyEvent", {"type":"keyUp","key":"ArrowDown","code":"ArrowDown"})
            assert await evaluate(first_midi_expression) == 70, "ArrowDown did not move fractional MIDI 70.3 to 70"
            reset_fractional = await evaluate("(() => {const c=document.querySelector('.piano-target-note.selected circle'),r=c.getBoundingClientRect(),scroll=document.querySelector('.piano-roll-pitch-scroll'),rect=scroll.getBoundingClientRect(),sem=Number.parseFloat(getComputedStyle(document.querySelector('.piano-roll-chart')).getPropertyValue('--semitone-height'))||16;return {x:r.left+r.width/2,startY:r.top+r.height/2,targetY:rect.top+(108.5-70.3)*sem-scroll.scrollTop}})()")
            await evaluate("(() => {const c=document.querySelector('.piano-target-note.selected circle'),id=33,x="+str(reset_fractional["x"])+",startY="+str(reset_fractional["startY"])+",targetY="+str(reset_fractional["targetY"])+";c.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,pointerId:id,clientX:x,clientY:startY}));window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,button:0,pointerId:id,clientX:x,clientY:targetY}));window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,button:0,pointerId:id,clientX:x,clientY:targetY}));return true})()")
            assert abs(await evaluate(first_midi_expression)-70.3) < 1e-9, "Could not restore the fractional pitch anchor before cent-key tests"
            await command("Input.dispatchKeyEvent", {"type":"rawKeyDown","key":"ArrowUp","code":"ArrowUp","modifiers":1})
            await command("Input.dispatchKeyEvent", {"type":"keyUp","key":"ArrowUp","code":"ArrowUp","modifiers":1})
            one_cent_up = await evaluate(first_midi_expression)
            assert abs(one_cent_up-70.31) < 1e-9, f"Alt+ArrowUp did not change pitch by exactly one cent: {one_cent_up}"
            await command("Input.dispatchKeyEvent", {"type":"rawKeyDown","key":"ArrowDown","code":"ArrowDown","modifiers":1})
            await command("Input.dispatchKeyEvent", {"type":"keyUp","key":"ArrowDown","code":"ArrowDown","modifiers":1})
            assert abs(await evaluate(first_midi_expression)-70.30) < 1e-9, "Alt+ArrowDown did not return the pitch by one cent"
            input_guard = await evaluate("(() => {const input=document.querySelector('.piano-roll-grid-controls input[type=number]'),e=new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true});input.focus();input.dispatchEvent(e);return {prevented:e.defaultPrevented,value:"+first_midi_expression+"}})()")
            assert not input_guard["prevented"] and abs(input_guard["value"]-70.30) < 1e-9, f"Pitch arrows were not guarded in editable inputs: {input_guard}"
            await evaluate("document.querySelector('.piano-target-note.selected').focus()")
            composing_guard = await evaluate("(() => {const e=new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true,isComposing:true});window.dispatchEvent(e);return {prevented:e.defaultPrevented,value:"+first_midi_expression+"}})()")
            assert not composing_guard["prevented"] and abs(composing_guard["value"]-70.30) < 1e-9, f"Pitch arrows were not guarded during IME composition: {composing_guard}"
            await evaluate("(() => {const scale=document.querySelector('.piano-roll-toolbar input[type=range]'),set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(scale,'.3');scale.dispatchEvent(new Event('input',{bubbles:true}));scale.dispatchEvent(new Event('change',{bubbles:true}));return true})()")
            await wait_for("document.querySelector('.piano-roll-toolbar input[type=range]').value==='0.3'")
            await evaluate("(() => {const time=document.querySelector('.piano-roll-horizontal-scroll');time.scrollLeft=100;time.dispatchEvent(new Event('scroll'));return true})()")
            await wait_for("document.querySelector('.piano-roll-horizontal-scroll').scrollLeft>0")
            box_scroll = await evaluate("document.querySelector('.piano-roll-horizontal-scroll').scrollLeft")
            assert box_scroll > 0, f"The selection-box fixture did not establish horizontal scrolling: {box_scroll}"
            await evaluate("(() => {const chart=document.querySelector('.piano-roll-chart'),scroll=document.querySelector('.piano-roll-pitch-scroll'),rect=scroll.getBoundingClientRect(),sem=Number.parseFloat(getComputedStyle(chart).getPropertyValue('--semitone-height'))||16;const x=chart.getBoundingClientRect().left+5,y=rect.top+(108-77+.5)*sem-scroll.scrollTop;chart.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,shiftKey:true,pointerId:5,clientX:x,clientY:y}));window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,button:0,shiftKey:true,pointerId:5,clientX:x+505,clientY:y+9*sem}));window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,button:0,shiftKey:true,pointerId:5,clientX:x+505,clientY:y+9*sem}));return true})()")
            await wait_for("document.querySelectorAll('.piano-note-selection-box').length===0")
            box_selection = await evaluate("({scroll:document.querySelector('.piano-roll-horizontal-scroll').scrollLeft,selected:[...document.querySelectorAll('.piano-target-note')].map(note=>({selected:note.classList.contains('selected'),rect:(()=>{const r=note.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}})()}))})")
            assert sum(note["selected"] for note in box_selection["selected"]) == 2, f"Horizontally scrolled Shift-drag box did not select the two enclosed target notes: {box_selection}"
            await evaluate("(() => {const scale=document.querySelector('.piano-roll-toolbar input[type=range]'),set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(scale,'.12');scale.dispatchEvent(new Event('input',{bubbles:true}));scale.dispatchEvent(new Event('change',{bubbles:true}));return true})()")
            await wait_for("document.querySelector('.piano-roll-toolbar input[type=range]').value==='0.12'")
            before_group_move = await evaluate("[...document.querySelectorAll('.piano-target-note')].map(note=>({id:note.dataset.noteId,left:parseFloat(note.style.left),top:parseFloat(note.style.top),start:Number(note.dataset.startMs),end:Number(note.dataset.endMs)}))")
            await evaluate("(() => {const note=document.querySelector('.piano-target-note.selected'),box=note.getBoundingClientRect(),x=box.left+box.width/2,y=box.top+box.height/2;note.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,pointerId:6,clientX:x,clientY:y}));window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,button:0,pointerId:6,clientX:x+48,clientY:y-16}));window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,button:0,pointerId:6,clientX:x+48,clientY:y-16}));return true})()")
            after_group_move = await evaluate("[...document.querySelectorAll('.piano-target-note')].map(note=>({id:note.dataset.noteId,left:parseFloat(note.style.left),top:parseFloat(note.style.top),start:Number(note.dataset.startMs),end:Number(note.dataset.endMs)}))")
            time_deltas = [after_group_move[index]["start"] - before_group_move[index]["start"] for index in (0, 1)]
            assert time_deltas[0] > 0 and time_deltas[0] == time_deltas[1] and time_deltas[0] == round(time_deltas[0]), f"Group drag did not preserve a shared snapped integer time delta: {before_group_move}, {after_group_move}"
            assert after_group_move[2] == before_group_move[2], f"Group drag moved an unselected target note: {before_group_move}, {after_group_move}"
            assert all(after_group_move[index]["top"] < before_group_move[index]["top"] for index in (0, 1)), f"Group drag did not apply shared pitch movement: {before_group_move}, {after_group_move}"
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await asyncio.sleep(.2)
            undone_group_move = await evaluate("[...document.querySelectorAll('.piano-target-note')].map(note=>({id:note.dataset.noteId,left:parseFloat(note.style.left),top:parseFloat(note.style.top),start:Number(note.dataset.startMs),end:Number(note.dataset.endMs)}))")
            assert all(undone_group_move[index]["start"] == before_group_move[index]["start"] for index in (0, 1)) and undone_group_move[2] == before_group_move[2], f"One undo did not restore the group movement: {before_group_move}, {undone_group_move}"
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "y", "code": "KeyY", "windowsVirtualKeyCode": 89, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "y", "code": "KeyY", "windowsVirtualKeyCode": 89, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await asyncio.sleep(.2)
            redone_group_move = await evaluate("[...document.querySelectorAll('.piano-target-note')].map(note=>({id:note.dataset.noteId,start:Number(note.dataset.startMs),end:Number(note.dataset.endMs)}))")
            assert all(redone_group_move[index]["start"] == after_group_move[index]["start"] for index in (0, 1)), f"Redo did not restore the group movement: {after_group_move}, {redone_group_move}"
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await wait_for(f"Number(document.querySelectorAll('.piano-target-note')[0].dataset.startMs)==={before_group_move[0]['start']}&&Number(document.querySelectorAll('.piano-target-note')[1].dataset.startMs)==={before_group_move[1]['start']}")
            await evaluate("(() => {const note=document.querySelectorAll('.piano-target-note')[2],box=note.getBoundingClientRect();note.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,shiftKey:true,pointerId:7,clientX:box.left+box.width/2,clientY:box.top+box.height/2}));window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,button:0,shiftKey:true,pointerId:7,clientX:box.left+box.width/2+15,clientY:box.top+box.height/2}));window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,button:0,shiftKey:true,pointerId:7,clientX:box.left+box.width/2+15,clientY:box.top+box.height/2}));return true})()")
            assert await evaluate("document.querySelectorAll('.piano-note-selection-box').length") == 0, "Shift-drag on an occupied target note started a selection box"
            await evaluate("document.querySelectorAll('.piano-target-note.selected')[0].dispatchEvent(new KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true}))")
            await wait_for("document.querySelectorAll('.piano-target-note').length===2")
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await wait_for("document.querySelectorAll('.piano-target-note').length===3")
            await evaluate("document.querySelectorAll('.piano-target-note')[0].click()")
            await evaluate("document.querySelectorAll('.piano-target-note')[1].dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))")
            await evaluate("document.querySelectorAll('.piano-target-note')[2].dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))")
            await evaluate("document.querySelector('.piano-target-note.selected').dispatchEvent(new KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true}))")
            await wait_for("document.querySelectorAll('.piano-target-note').length===0")
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await wait_for("document.querySelectorAll('.piano-target-note').length===3")
            await evaluate("document.querySelectorAll('.piano-target-note')[0].click()")
            await evaluate("document.querySelectorAll('.piano-target-note')[0].dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true}))")
            await wait_for("document.querySelectorAll('.piano-target-note').length===2")
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await wait_for("document.querySelectorAll('.piano-target-note').length===3")
            await evaluate("document.querySelectorAll('.piano-target-note')[0].click()")
            await evaluate("document.querySelectorAll('.piano-target-note')[1].dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))")
            await evaluate("document.querySelectorAll('.piano-target-note')[2].dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))")
            await evaluate("document.querySelector('.piano-target-note.selected').dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true}))")
            await wait_for("document.querySelectorAll('.piano-target-note').length===0")
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await wait_for("document.querySelectorAll('.piano-target-note').length===3")
            await evaluate("document.querySelectorAll('.piano-target-note')[0].click()")
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "y", "code": "KeyY", "windowsVirtualKeyCode": 89, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "y", "code": "KeyY", "windowsVirtualKeyCode": 89, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await wait_for("document.querySelectorAll('.piano-target-note').length===0")
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await wait_for("document.querySelectorAll('.piano-target-note').length===3")
            await evaluate("document.querySelectorAll('.piano-target-note')[0].click()")
            await evaluate("document.querySelector('.piano-note-delete').click()")
            await wait_for("document.querySelectorAll('.piano-target-note').length===2")
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await wait_for("document.querySelectorAll('.piano-target-note').length===3")
            await evaluate("document.querySelectorAll('.piano-target-note')[0].click()")
            await evaluate("document.querySelectorAll('.piano-target-note')[1].dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))")
            await evaluate("document.querySelectorAll('.piano-target-note')[2].dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))")
            await evaluate("document.querySelector('.piano-note-delete').click()")
            await wait_for("document.querySelectorAll('.piano-target-note').length===0")
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await wait_for("document.querySelectorAll('.piano-target-note').length===3")
            await evaluate("document.querySelector('.piano-target-note').click()")
            await evaluate("document.querySelectorAll('.piano-target-note')[1].dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))")
            await evaluate("document.querySelectorAll('.piano-target-note')[2].dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))")
            await evaluate("document.querySelectorAll('.piano-target-note')[0].dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))")
            assert await evaluate("document.querySelectorAll('.piano-target-note.selected').length") == 2, "Cleanup did not leave only the two added notes selected"
            await evaluate("document.querySelector('.piano-note-delete').click()")
            await wait_for("document.querySelectorAll('.piano-target-note').length===1")
            remaining_note = await evaluate("(() => {const note=document.querySelector('.piano-target-note');return {label:note.getAttribute('aria-label'),start:Number(note.dataset.startMs),end:Number(note.dataset.endMs)}})()")
            assert "A\u266f4" in remaining_note["label"] and remaining_note["start"] == snapped_note["start"] and remaining_note["end"] == snapped_note["end"], f"Removing the added notes changed the original target note: {remaining_note}, {snapped_note}"

            assert analysis_requests, "Opening the correction editor did not request pitch analysis"
            initial = analysis_requests[0]["segments"][0]
            assert len(initial["phone_units"]) == 6, f"Expected six Korean phones: {initial}"
            assert [phone["target_phone_id"] for phone in initial["phone_units"]] == ["ko.consonant.g", "ko.vowel.a", "ko.coda.b", "ko.consonant.n", "ko.vowel.i", "ko.coda.d"]
            assert len(initial["edit_regions"]) == 6, f"Legacy empty edit regions were not derived from phone boundaries: {initial['edit_regions']}"
            assert all(not region.get("pitch_points") for region in initial["edit_regions"]), "Initial editor load implicitly applied a pitch correction"
            first = await evaluate("(() => {const e=document.querySelectorAll('.piano-syllable-note')[0];return {label:e.getAttribute('aria-label'),text:e.textContent}})()")
            second = await evaluate("(() => {const e=document.querySelectorAll('.piano-syllable-note')[1];return {label:e.getAttribute('aria-label'),text:e.textContent}})()")
            assert "a" in first["label"] and "i" in second["label"], f"Korean phone order did not produce two vowel-anchored syllables: {first}, {second}"
            assert "A\u266f3" in first["label"] and "E4" in second["label"], f"Loaded notes did not show distinct original measurements: {first}, {second}"

            await evaluate("document.querySelectorAll('.piano-syllable-note')[0].click()")
            await wait_for("document.querySelector('.piano-syllable-controls output')!==null")
            assert await evaluate("document.querySelector('.piano-syllable-controls input, .piano-syllable-controls button')===null"), "Measured syllable pitch still exposes editing controls"
            baseline = await evaluate("(() => {const e=document.querySelectorAll('.piano-syllable-note')[0];return {label:e.getAttribute('aria-label'),top:e.style.top}})()")
            assert "A\u266f3" in baseline["label"], f"Selected syllable did not retain its measured source pitch: {baseline}"
            await evaluate("window.__draftWriteCount=0")
            note_box = await evaluate("(() => {const e=document.querySelectorAll('.piano-syllable-note')[0],r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()")
            await command("Input.dispatchMouseEvent", {"type": "mousePressed", "x": note_box["x"], "y": note_box["y"], "button": "left"})
            await command("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": note_box["x"], "y": note_box["y"]-30, "button": "left", "buttons": 1})
            await command("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": note_box["x"], "y": note_box["y"]-30, "button": "left"})
            unchanged = await evaluate("(() => {const e=document.querySelectorAll('.piano-syllable-note')[0];return {label:e.getAttribute('aria-label'),top:e.style.top}})()")
            assert unchanged == baseline, f"Dragging a measured syllable changed its display: {baseline} -> {unchanged}"
            assert await evaluate("window.__draftWriteCount") == 0, "Dragging measured pitch wrote a draft"
            assert len(analysis_requests) == 1, "Dragging measured pitch re-ran pitch analysis"

            zoom_before = await evaluate("({heights:[...document.querySelectorAll('.piano-syllable-note')].map(e=>e.getBoundingClientRect().height),widths:[...document.querySelectorAll('.piano-syllable-note')].map(e=>e.getBoundingClientRect().width),scrollTop:document.querySelector('.piano-roll-pitch-scroll').scrollTop})")
            await evaluate("(() => {const e=document.querySelectorAll('.piano-roll-toolbar input[type=range]')[1],s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(e,'7');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()")
            await wait_for("document.querySelectorAll('.piano-roll-toolbar input[type=range]')[1].value==='7'")
            zoom_after = await evaluate("({heights:[...document.querySelectorAll('.piano-syllable-note')].map(e=>e.getBoundingClientRect().height),widths:[...document.querySelectorAll('.piano-syllable-note')].map(e=>e.getBoundingClientRect().width)})")
            assert all(abs(height - 5) < .1 for height in zoom_after["heights"]), f"Minimum pitch zoom did not shrink bars to their rows: {zoom_after}"
            assert all(after < before for before, after in zip(zoom_before["heights"], zoom_after["heights"], strict=True)), "Pitch zoom left bar height unchanged"
            assert zoom_before["widths"] == zoom_after["widths"], "Pitch zoom changed note timing widths"
            await evaluate("(() => {const e=document.querySelectorAll('.piano-roll-toolbar input[type=range]')[1],s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(e,'16');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()")
            await wait_for("document.querySelectorAll('.piano-roll-toolbar input[type=range]')[1].value==='16'")
            await evaluate(f"document.querySelector('.piano-roll-pitch-scroll').scrollTop={zoom_before['scrollTop']}")

            transport = await evaluate("[...document.querySelectorAll('.piano-roll-transport button')].map(e=>e.textContent)")
            assert len(transport) >= 4, f"Pitch audition controls are missing: {transport}"
            old_audio = await evaluate("document.querySelector('audio')?.src||''")
            await evaluate("document.querySelectorAll('.piano-roll-transport button')[2].click();document.querySelector('.piano-roll-transport button').click()")
            await wait_for("document.querySelector('audio')?.src && document.querySelector('audio').src!==" + json.dumps(old_audio))
            await wait_for("document.querySelectorAll('.global-task-dialog').length===0")
            corrected_preview = preview_requests[-1]
            corrected = corrected_preview.get("composition", corrected_preview)
            assert corrected.get("pitch_notes"), "Corrected audition omitted independent target notes"
            corrected_segment = corrected["segments"][0]
            await evaluate("document.querySelectorAll('.piano-roll-transport button')[3].click();document.querySelector('.piano-roll-transport button').click()")
            await wait_for("document.querySelectorAll('.global-task-dialog').length===0")
            original_preview = preview_requests[-1]
            original = original_preview.get("composition", original_preview)
            assert original.get("pitch_notes") == [], "Original audition retained independent target notes"
            assert all(not region.get("pitch_points") for region in corrected_segment["edit_regions"]), "Corrected audition applied target notes to measured source regions"
            assert all(not region.get("pitch_points") for region in original["segments"][0]["edit_regions"]), "Original audition retained note pitch points"

            await evaluate("document.querySelector('.professional-actions .primary-action').click()")
            await wait_for("document.body.innerText.includes('saved')")
            assert len(saved_requests) == 1, f"Expected exactly one saved composition: {request_log}"
            saved = saved_requests[0]
            assert len(saved.get("pitch_notes", [])) == 1, f"Saving omitted the independent target note: {saved.get('pitch_notes')}"
            saved_segment = saved["segments"][0]
            assert len(saved_segment["edit_regions"]) == 6, f"Saved payload lost legacy-derived phone regions: {saved_segment['edit_regions']}"
            regions = saved_segment["edit_regions"]
            assert all(not region.get("pitch_points") for region in regions), f"Saving target notes changed measured source pitches: {regions}"
            assert [(region["source_start_ms"], region["source_end_ms"], region["output_duration_ms"]) for region in regions] == [(100 + 150 * index, 250 + 150 * index, 150) for index in range(6)], f"Target note edits changed source timing: {regions}"
            assert saved_segment["volume_envelope"] == [{"position": 0, "gain": 0.8}, {"position": 1, "gain": 1.15}], "Target note edits changed the original volume envelope"
            assert not any(phone.get("target_pitch_midi") is not None for phone in saved_segment["phone_units"]), "Measured pitches were stored as phone targets"
            screenshot = await command("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": True, "fromSurface": True})
            ARTIFACT.write_bytes(base64.b64decode(screenshot["data"]))
            await command("Page.reload")
            await wait_for("document.querySelector('.professional-page')!==null")
            await wait_for("document.querySelectorAll('.piano-target-note').length===1")
            restored_note = await evaluate("(() => {const note=document.querySelector('.piano-target-note');return {label:note.getAttribute('aria-label'),start:Number(note.dataset.startMs),end:Number(note.dataset.endMs)}})()")
            assert "A\u266f4" in restored_note["label"] and restored_note["start"] == saved["pitch_notes"][0]["start_ms"] and restored_note["end"] == saved["pitch_notes"][0]["end_ms"], f"Saved target note did not survive draft reload: {restored_note}"

            await evaluate("(() => {const s=document.querySelectorAll('.professional-file-controls select')[0],set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(s,'parent-residual');s.dispatchEvent(new Event('change',{bubbles:true}))})()")
            await wait_for("document.querySelector('.dependency-bar').innerText.includes('Residual boundary fixture')")
            await command("Emulation.setDeviceMetricsOverride", {"width": 1200, "height": 900, "deviceScaleFactor": 1, "mobile": False})
            await evaluate("document.querySelector('.professional-footer > button').click()")
            await wait_for("getComputedStyle(document.querySelector('.piano-roll-editor')).display==='flex'")
            await wait_for("document.querySelectorAll('.piano-syllable-note').length===2")

            async def visible_regions() -> list[dict]:
                return await evaluate("[...document.querySelectorAll('.piano-region-note')].map(e=>({start:Number(e.dataset.sourceStartMs),end:Number(e.dataset.sourceEndMs),left:parseFloat(e.style.left),width:parseFloat(e.style.width)})).sort((a,b)=>a.start-b.start)")

            initial_regions = await visible_regions()
            assert [(item["start"], item["end"]) for item in initial_regions] == [(550, 600), (600, 650)], f"Uncovered region tails were not visible before editing a syllable: {initial_regions}"
            first_syllable_width = await evaluate("parseFloat(document.querySelectorAll('.piano-syllable-note')[0].style.width)")
            time_scale = first_syllable_width / 450
            expected_edges = [(450 * time_scale, 50 * time_scale), (500 * time_scale, 50 * time_scale)]
            assert all(abs(region["left"] - left) < 1 and abs(region["width"] - max(9, width)) < 1 for region, (left, width) in zip(initial_regions, expected_edges, strict=True)), f"Initial residual regions did not cover their source-time spans: {initial_regions}"
            await evaluate("document.querySelectorAll('.piano-syllable-note')[0].click()")
            assert await evaluate("document.querySelector('.piano-syllable-controls input, .piano-syllable-controls button')===null"), "Residual fixture exposed measured pitch editing controls"
            first_residual_selector = '.piano-region-note[data-source-start-ms="550"][data-source-end-ms="600"]'
            second_residual_selector = '.piano-region-note[data-source-start-ms="600"][data-source-end-ms="650"]'
            await evaluate(f"document.querySelector({json.dumps(first_residual_selector)}).click()")
            loop_enabled = await evaluate("document.querySelectorAll('.piano-roll-transport button')[1].disabled===false")
            assert loop_enabled, "Selecting an uncovered residual did not set its loop range"
            before_readonly = await visible_regions()
            analysis_count_before_drag = len(analysis_requests)
            await evaluate("window.__draftWriteCount=0")
            drag_box = await evaluate(f"(() => {{const e=document.querySelector({json.dumps(first_residual_selector)}),r=e.getBoundingClientRect();return {{x:r.left+r.width/2,y:r.top+r.height/2,top:e.style.top}}}})()")
            await command("Input.dispatchMouseEvent", {"type": "mousePressed", "x": drag_box["x"], "y": drag_box["y"], "button": "left"})
            await command("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": drag_box["x"], "y": drag_box["y"]-30, "button": "left", "buttons": 1, "modifiers": 2})
            await command("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": drag_box["x"], "y": drag_box["y"]-30, "button": "left", "modifiers": 2})
            after_readonly = await visible_regions()
            assert after_readonly == before_readonly, f"Dragging a measured region changed its display: {before_readonly} -> {after_readonly}"
            assert await evaluate("window.__draftWriteCount") == 0, "Dragging a measured region wrote a draft"
            assert len(analysis_requests) == analysis_count_before_drag, "Dragging a measured region re-ran pitch analysis"
            await wait_for("document.querySelector('.piano-roll-analysis')===null")
            residual_screenshot = await command("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": True, "fromSurface": True})
            (ARTIFACT_DIR / "piano-roll-residual-regions-smoke.png").write_bytes(base64.b64decode(residual_screenshot["data"]))

            await evaluate("(() => {const scale=document.querySelector('.piano-roll-toolbar input[type=range]'),set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(scale,scale.max);scale.dispatchEvent(new Event('input',{bubbles:true}));scale.dispatchEvent(new Event('change',{bubbles:true}));const bpm=document.querySelector('.piano-roll-grid-controls input[type=number]');bpm.focus();set.call(bpm,'400');bpm.dispatchEvent(new Event('input',{bubbles:true}));bpm.dispatchEvent(new Event('change',{bubbles:true}));bpm.blur()})()")
            await wait_for("document.querySelector('.piano-roll-horizontal-scroll').scrollWidth>document.querySelector('.piano-roll-horizontal-scroll').clientWidth")
            await wait_for("document.querySelector('.piano-roll-bpm-grid').style.backgroundSize.startsWith('900px')")
            chart_geometry = await evaluate("(() => {const main=document.querySelector('.piano-roll-horizontal-scroll'),pitch=document.querySelector('.piano-roll-pitch-scroll'),volume=document.querySelector('.piano-volume-scroll'),chart=document.querySelector('.piano-roll-chart'),white=document.querySelector('.piano-pitch-gridline.white-key'),black=document.querySelector('.piano-pitch-gridline.black-key'),grid=document.querySelector('.piano-roll-bpm-grid');return {mainOverflow:getComputedStyle(main).overflowX,mainScrollWidth:main.scrollWidth,mainClientWidth:main.clientWidth,hasSeparateRuler:Boolean(document.querySelector('.piano-roll-pitch-time')),sizes:grid.style.backgroundSize,image:grid.style.backgroundImage,whiteWidth:white.getBoundingClientRect().width,chartWidth:chart.getBoundingClientRect().width,whiteColor:getComputedStyle(white).backgroundColor,blackWidth:black.getBoundingClientRect().width,blackColor:getComputedStyle(black).backgroundColor,pitchScrollLeft:pitch.scrollLeft,volumeScrollLeft:volume.scrollLeft}})()")
            assert not chart_geometry["hasSeparateRuler"] and chart_geometry["mainScrollWidth"] > chart_geometry["mainClientWidth"], f"The ruler still scrolls separately or the chart does not overflow: {chart_geometry}"
            assert "rgb(104, 169, 255)" in chart_geometry["image"] and "rgb(181, 140, 255)" in chart_geometry["image"], f"Half/quarter grid colors changed: {chart_geometry}"
            grid_widths = [float(item.split("px")[0]) for item in chart_geometry["sizes"].split(",")[:3]]
            assert abs(grid_widths[1] - grid_widths[0] / 2) < .1 and abs(grid_widths[2] - grid_widths[0] / 4) < .1, f"Half/quarter grid widths changed: {chart_geometry}"
            assert abs(chart_geometry["whiteWidth"] - chart_geometry["chartWidth"]) < 1 and abs(chart_geometry["blackWidth"] - chart_geometry["chartWidth"]) < 1, f"Pitch row backgrounds do not span the chart: {chart_geometry}"
            assert chart_geometry["whiteColor"] != "rgba(0, 0, 0, 0)" and chart_geometry["blackColor"] != "rgba(0, 0, 0, 0)", f"Pitch row backgrounds are missing: {chart_geometry}"
            before_scroll = await evaluate("(() => {const main=document.querySelector('.piano-roll-horizontal-viewport'),scroll=document.querySelector('.piano-roll-horizontal-scroll'),note=document.querySelector('.piano-region-note[data-source-start-ms=\"550\"]'),tick=[...document.querySelectorAll('.piano-roll-ruler > span')].find(e=>e.textContent==='2'),grid=document.querySelector('.piano-roll-bpm-grid'),keyboard=document.querySelector('.piano-roll-keyboard'),toolbar=document.querySelector('.piano-roll-toolbar'),controls=document.querySelector('.piano-roll-controls'),label=document.querySelector('.piano-roll-ruler-label');return {scroll:scroll.scrollLeft,note:note.getBoundingClientRect().left,tick:tick.getBoundingClientRect().left,grid:grid.getBoundingClientRect().left,key:keyboard.getBoundingClientRect().left,label:label.getBoundingClientRect().left,main:main.getBoundingClientRect().left,toolbar:toolbar.getBoundingClientRect().left,toolbarTop:toolbar.getBoundingClientRect().top,controls:controls.getBoundingClientRect().left,controlsTop:controls.getBoundingClientRect().top}})()")
            await evaluate("(() => {const scroll=document.querySelector('.piano-roll-horizontal-scroll');scroll.scrollLeft=Math.min(100,scroll.scrollWidth-scroll.clientWidth);scroll.dispatchEvent(new Event('scroll'))})()")
            await wait_for("document.querySelector('.piano-volume-scroll').scrollLeft===document.querySelector('.piano-roll-horizontal-scroll').scrollLeft")
            aligned_scroll = await evaluate("(() => {const main=document.querySelector('.piano-roll-horizontal-viewport'),scroll=document.querySelector('.piano-roll-horizontal-scroll'),pitch=document.querySelector('.piano-roll-pitch-scroll'),content=document.querySelector('.piano-roll-chart-content'),note=document.querySelector('.piano-region-note[data-source-start-ms=\"550\"]'),tick=[...document.querySelectorAll('.piano-roll-ruler > span')].find(e=>e.textContent==='2'),grid=document.querySelector('.piano-roll-bpm-grid'),keyboard=document.querySelector('.piano-roll-keyboard'),toolbar=document.querySelector('.piano-roll-toolbar'),controls=document.querySelector('.piano-roll-controls'),label=document.querySelector('.piano-roll-ruler-label'),chart=document.querySelector('.piano-roll-chart'),chartRect=chart.getBoundingClientRect(),mainRect=main.getBoundingClientRect(),pitchRect=pitch.getBoundingClientRect(),hitX=pitchRect.left+pitch.clientWidth-2,hitY=pitchRect.top+8,hit=document.elementFromPoint(hitX,hitY);return {main:scroll.scrollLeft,volume:document.querySelector('.piano-volume-scroll').scrollLeft,pitchLeft:pitch.scrollLeft,pitchWidth:pitch.clientWidth,pitchScrollWidth:pitch.scrollWidth,pitchOverflow:getComputedStyle(pitch).overflowX,pitchTop:pitchRect.top,pitchBottom:pitchRect.bottom,pitchLeftEdge:pitchRect.left,pitchRightEdge:pitchRect.right,contentLeft:content.getBoundingClientRect().left,contentRight:content.getBoundingClientRect().right,note:note.getBoundingClientRect().left,tick:tick.getBoundingClientRect().left,grid:grid.getBoundingClientRect().left,key:keyboard.getBoundingClientRect().left,label:label.getBoundingClientRect().left,mainLeft:mainRect.left,toolbar:toolbar.getBoundingClientRect().left,toolbarTop:toolbar.getBoundingClientRect().top,controls:controls.getBoundingClientRect().left,controlsTop:controls.getBoundingClientRect().top,controlsVisible:controls.getBoundingClientRect().right>0&&controls.getBoundingClientRect().left<innerWidth,chartRight:chartRect.right,chartTop:chartRect.top,chartBottom:chartRect.bottom,mainRight:mainRect.right,chartHit:Boolean(hit?.closest('.piano-roll-chart')),hitTag:hit?.tagName,hitClass:hit?.className?.baseVal||hit?.className,hitX,hitY}})()")
            assert abs(aligned_scroll["main"] - aligned_scroll["volume"]) < 1, f"Volume timing did not follow the unified ruler: {aligned_scroll}"
            delta = aligned_scroll["main"] - before_scroll["scroll"]
            assert abs((aligned_scroll["note"] - before_scroll["note"]) + delta) < 1 and abs((aligned_scroll["tick"] - before_scroll["tick"]) + delta) < 1, f"Pitch notes and ruler ticks did not move together: {before_scroll}, {aligned_scroll}"
            assert abs((aligned_scroll["grid"] - before_scroll["grid"]) + delta) < 1, f"Pitch grid did not move with the ruler: {before_scroll}, {aligned_scroll}"
            assert abs(aligned_scroll["key"] - aligned_scroll["mainLeft"]) < 2 and abs(aligned_scroll["label"] - aligned_scroll["mainLeft"]) < 2, f"Keyboard or ruler label scrolled away from the pinned left edge: {aligned_scroll}"
            assert abs(aligned_scroll["toolbar"] - before_scroll["toolbar"]) < 1 and abs(aligned_scroll["toolbarTop"] - before_scroll["toolbarTop"]) < 1, f"Toolbar moved during chart scrolling: {before_scroll}, {aligned_scroll}"
            assert abs(aligned_scroll["controls"] - before_scroll["controls"]) < 1 and abs(aligned_scroll["controlsTop"] - before_scroll["controlsTop"]) < 1 and aligned_scroll["controlsVisible"], f"Pitch controls moved or disappeared during chart scrolling: {before_scroll}, {aligned_scroll}"
            assert aligned_scroll["chartRight"] >= aligned_scroll["mainRight"] - 1, f"Blank chart space appeared at the right edge: {aligned_scroll}"
            assert aligned_scroll["chartHit"], f"Chart content was clipped before the visible right edge: {aligned_scroll}"

            assert await evaluate("document.querySelector('.piano-roll-drag-badge')===null"), "Measured display left an edit badge active"
            assert not runtime_errors, f"Browser runtime errors: {runtime_errors}"
            print(json.dumps({"status": "passed", "syllable_count": 2, "phone_count": 6,
                "legacy_regions_derived": len(regions), "saved_notes_midi": [60, 66],
                "analysis_requests": len(analysis_requests), "auditions": ["corrected", "original"],
                "screenshot": str(ARTIFACT)}, ensure_ascii=False))
    except Exception:
        ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
        (ARTIFACT_DIR / "world-syllable-notes-smoke-failure.json").write_text(json.dumps({
            "requests": request_log, "runtime_errors": runtime_errors,
            "analysis_requests": analysis_requests, "preview_requests": preview_requests,
            "saved_requests": saved_requests,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        raise
    finally:
        for task in deferred_fulfillments:
            task.cancel()
        if deferred_fulfillments:
            await asyncio.gather(*deferred_fulfillments, return_exceptions=True)
        if chrome is not None:
            chrome.terminate()
            try:
                chrome.wait(timeout=5)
            except subprocess.TimeoutExpired:
                chrome.kill()
        vite.terminate()
        try:
            vite.wait(timeout=5)
        except subprocess.TimeoutExpired:
            vite.kill()
        resolved = temp_root.resolve()
        if resolved.parent == Path(tempfile.gettempdir()).resolve() and resolved.name.startswith("madnolia-world-note-smoke-"):
            shutil.rmtree(resolved, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(asyncio.wait_for(run_smoke(), timeout=90))
