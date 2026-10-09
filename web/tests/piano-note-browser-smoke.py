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
            await wait_for("document.querySelector('[aria-label=\"음절 목표 음표 MIDI\"]')!==null")
            await evaluate("(() => {const e=document.querySelector('[aria-label=\"음절 목표 음표 MIDI\"]'),s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(e,'60');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()")
            await wait_for("document.querySelectorAll('.piano-syllable-note')[0].getAttribute('aria-label').includes('C4')")
            deadline = time.monotonic() + 8
            while len(analysis_requests) < 2 and time.monotonic() < deadline:
                await evaluate("true")
                await asyncio.sleep(.05)
            if len(analysis_requests) < 2:
                raise AssertionError(f"Pitch analysis did not refresh after note edit: {request_log}")
            await wait_for("document.querySelector('.piano-roll-analysis')===null")
            second_after_first = await evaluate("document.querySelectorAll('.piano-syllable-note')[1].getAttribute('aria-label')")
            assert "E4" in second_after_first, f"Editing the first note changed the second syllable: {second_after_first}"
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await wait_for("document.querySelectorAll('.piano-syllable-note')[0].getAttribute('aria-label').includes('A♯3')")
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "y", "code": "KeyY", "windowsVirtualKeyCode": 89, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "y", "code": "KeyY", "windowsVirtualKeyCode": 89, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await wait_for("document.querySelectorAll('.piano-syllable-note')[0].getAttribute('aria-label').includes('C4')")
            await evaluate("document.querySelector('.piano-syllable-controls button').click()")
            await wait_for("document.querySelectorAll('.piano-syllable-note')[0].getAttribute('aria-label').includes('A\u266f3')")
            await evaluate("(() => {const e=document.querySelector('[aria-label=\"음절 목표 음표 MIDI\"]'),s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(e,'60');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()")
            await wait_for("document.querySelectorAll('.piano-syllable-note')[0].getAttribute('aria-label').includes('C4')")

            await evaluate("document.querySelectorAll('.piano-syllable-note')[1].click()")
            await evaluate("(() => {const e=document.querySelector('.piano-syllable-controls input'),s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(e,'64');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()")
            await wait_for("document.querySelectorAll('.piano-syllable-note')[1].getAttribute('aria-label').includes('E4')")
            await evaluate("document.querySelectorAll('.piano-syllable-note')[0].click()")
            await evaluate("(() => {const e=document.querySelector('.piano-syllable-controls input'),s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(e,'61');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()")
            analysis_count = len(analysis_requests)
            deadline = time.monotonic() + 8
            while len(analysis_requests) <= analysis_count and time.monotonic() < deadline:
                await evaluate("true")
                await asyncio.sleep(.05)
            assert len(analysis_requests) > analysis_count, "Pitch analysis did not start for the first note edit"
            analysis_count = len(analysis_requests)
            analysis_delay_ms = 1200
            await evaluate("(() => {const e=document.querySelector('.piano-syllable-controls input'),s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(e,'60');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()")
            deadline = time.monotonic() + 8
            while len(analysis_requests) <= analysis_count and time.monotonic() < deadline:
                await evaluate("true")
                await asyncio.sleep(.05)
            assert len(analysis_requests) > analysis_count, "Delayed pitch analysis did not start for the first note edit"
            await evaluate("document.querySelectorAll('.piano-syllable-note')[1].click()")
            note = await evaluate("(() => {const e=document.querySelectorAll('.piano-syllable-note')[1],r=e.getBoundingClientRect(),h=parseFloat(getComputedStyle(document.querySelector('.piano-roll-pitch-content')).getPropertyValue('--semitone-height'));return {x:r.left+r.width/2,y:r.top+r.height/2,h,top:parseFloat(e.style.top)}})()")
            await evaluate("window.__draftWriteCount=0")
            initial_top = note["top"]
            fractional_y = note["y"] - note["h"] / 4
            await command("Input.dispatchMouseEvent", {"type": "mousePressed", "x": note["x"], "y": note["y"], "button": "left"})
            await command("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": note["x"], "y": fractional_y, "button": "left", "buttons": 1, "modifiers": 2})
            fractional_top = await evaluate("parseFloat(document.querySelectorAll('.piano-syllable-note')[1].style.top)")
            assert abs(fractional_top - (note["top"] - note["h"] / 4)) < .1, f"Ctrl-drag did not retain a quarter-semitone target: {fractional_top}, {note}"
            await command("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": note["x"], "y": fractional_y, "button": "left", "modifiers": 2})
            await wait_for("window.__draftWriteCount===1")
            note = await evaluate("(() => {const e=document.querySelectorAll('.piano-syllable-note')[1],r=e.getBoundingClientRect(),h=parseFloat(getComputedStyle(document.querySelector('.piano-roll-pitch-content')).getPropertyValue('--semitone-height'));return {x:r.left+r.width/2,y:r.top+r.height/2,h,top:parseFloat(e.style.top)}})()")
            assert abs(note["top"] - (initial_top - note["h"] / 4)) < .1, f"Fractional MIDI was not retained after pointer release: {note}"
            await evaluate("window.__draftWriteCount=0")
            await command("Input.dispatchMouseEvent", {"type": "mousePressed", "x": note["x"], "y": note["y"], "button": "left"})
            await command("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": note["x"], "y": note["y"] - note["h"] / 4, "button": "left", "buttons": 1, "modifiers": 2})
            fine_move_top = await evaluate("parseFloat(document.querySelectorAll('.piano-syllable-note')[1].style.top)")
            assert abs(fine_move_top - (note["top"] - note["h"] / 4)) < .1, f"Ctrl fine movement was not fractional: {fine_move_top}, {note}"
            snapped_y = note["y"] - note["h"] * .75
            await command("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": note["x"], "y": snapped_y, "button": "left", "buttons": 1})
            snapped_top = await evaluate("parseFloat(document.querySelectorAll('.piano-syllable-note')[1].style.top)")
            expected_snap_top = round(note["top"] / note["h"] - .75) * note["h"]
            assert abs(snapped_top - expected_snap_top) < .1, f"Releasing Ctrl did not snap the next move to a MIDI row: {snapped_top}, expected {expected_snap_top}"
            await command("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": note["x"], "y": snapped_y, "button": "left"})
            await wait_for("document.querySelectorAll('.piano-syllable-note')[1].getAttribute('aria-label').includes('F4')")
            await wait_for("window.__draftWriteCount===1")
            note = await evaluate("(() => {const e=document.querySelectorAll('.piano-syllable-note')[1],r=e.getBoundingClientRect(),h=parseFloat(getComputedStyle(document.querySelector('.piano-roll-pitch-content')).getPropertyValue('--semitone-height'));return {x:r.left+r.width/2,y:r.top+r.height/2,h}})()")
            await evaluate("window.__draftWriteCount=0")
            await command("Input.dispatchMouseEvent", {"type": "mousePressed", "x": note["x"], "y": note["y"], "button": "left"})
            await command("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": note["x"], "y": note["y"] - note["h"], "button": "left", "buttons": 1})
            await wait_for("document.querySelectorAll('.piano-syllable-note')[1].getAttribute('aria-label').includes('F\\u266f4')")
            await asyncio.sleep(.4)
            assert await evaluate("window.__draftWriteCount") == 0, "A pitch drag wrote its draft before the gesture ended"
            assert await evaluate("document.querySelectorAll('.global-task-dialog').length") == 0, "A pitch drag opened a blocking global task"
            assert not preview_requests and not saved_requests, "A pitch drag triggered save or preview work"
            assert await evaluate("document.querySelector('.professional-actions .primary-action').disabled"), "Save remained enabled during a pitch drag"
            key_result = await evaluate("(() => {const e=new KeyboardEvent('keydown',{key:'s',code:'KeyS',ctrlKey:true,bubbles:true,cancelable:true});window.dispatchEvent(e);return e.defaultPrevented})()")
            assert key_result, "Ctrl+S was not blocked during a pitch drag"
            assert await evaluate("(() => {const e=new KeyboardEvent('keydown',{key:' ',code:'Space',shiftKey:true,bubbles:true,cancelable:true});window.dispatchEvent(e);return e.defaultPrevented})()"), "Shift+Space preview was not blocked during a pitch drag"
            await evaluate("window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true}))")
            await wait_for("window.__draftWriteCount===1")
            assert len(analysis_requests) >= 2, "Pitch analysis did not start for the first note edit"
            await wait_for("document.querySelector('.piano-roll-analysis')===null", timeout=8)
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await wait_for("document.querySelectorAll('.piano-syllable-note')[1].getAttribute('aria-label').includes('F4')")
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "y", "code": "KeyY", "windowsVirtualKeyCode": 89, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "y", "code": "KeyY", "windowsVirtualKeyCode": 89, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await wait_for("document.querySelectorAll('.piano-syllable-note')[1].getAttribute('aria-label').includes('F\u266f4')")


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
            assert any(region.get("pitch_points") for region in corrected_segment["edit_regions"]), "Corrected audition omitted note pitch points"
            assert all(not region.get("pitch_points") for region in original["segments"][0]["edit_regions"]), "Original audition retained note pitch points"

            await evaluate("document.querySelector('.professional-actions .primary-action').click()")
            await wait_for("document.body.innerText.includes('saved')")
            assert len(saved_requests) == 1, f"Expected exactly one saved composition: {request_log}"
            saved = saved_requests[0]
            assert len(saved.get("pitch_notes", [])) == 1, f"Saving omitted the independent target note: {saved.get('pitch_notes')}"
            saved_segment = saved["segments"][0]
            assert len(saved_segment["edit_regions"]) == 6, f"Saved payload lost legacy-derived phone regions: {saved_segment['edit_regions']}"
            regions = saved_segment["edit_regions"]
            first_regions = [region for region in regions if region["source_start_ms"] >= 100 and region["source_end_ms"] <= 550]
            second_regions = [region for region in regions if region["source_start_ms"] >= 550 and region["source_end_ms"] <= 1000]
            assert first_regions and all([point["midi"] for point in region["pitch_points"]] == [60, 60] for region in first_regions), f"First Korean syllable did not save as absolute C4: {first_regions}"
            assert second_regions and all([point["midi"] for point in region["pitch_points"]] == [66, 66] for region in second_regions), f"Dragging second note did not save snapped F#4: {second_regions}"
            assert [(region["source_start_ms"], region["source_end_ms"], region["output_duration_ms"]) for region in regions] == [(100 + 150 * index, 250 + 150 * index, 150) for index in range(6)], f"Pitch edits changed source timing: {regions}"
            assert saved_segment["volume_envelope"] == [{"position": 0, "gain": 0.8}, {"position": 1, "gain": 1.15}], "Pitch edits changed the original volume envelope"
            assert not any(phone.get("target_pitch_midi") is not None for phone in saved_segment["phone_units"]), "Syllable pitches were stored as unrelated per-phone targets"
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
            analysis_delay_ms = 1000
            await evaluate("(() => {const e=document.querySelector('.piano-syllable-controls input'),set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(e,'60');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()")
            await wait_for("document.querySelectorAll('.piano-syllable-note')[0].getAttribute('aria-label').includes('C4')")
            edited_regions = await visible_regions()
            assert [(item["start"], item["end"]) for item in edited_regions] == [(550, 600), (600, 650)], f"Syllable editing changed visible uncovered region coverage: {edited_regions}"
            assert all(abs(left["left"] - right["left"]) < 1 and abs(left["width"] - right["width"]) < 1 for left, right in zip(initial_regions, edited_regions, strict=True)), f"Syllable editing shifted residual regions: {initial_regions}, {edited_regions}"
            await wait_for("document.querySelector('.piano-roll-analysis')===null")
            residual_screenshot = await command("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": True, "fromSurface": True})
            (ARTIFACT_DIR / "piano-roll-residual-regions-smoke.png").write_bytes(base64.b64decode(residual_screenshot["data"]))

            async def draft_regions() -> list[dict]:
                return await evaluate("(() => {const key=Object.keys(localStorage).find(item=>item.startsWith('madnolia.professionalDraft.smoke.')&&item.includes('parent%3Aparent-residual'));const draft=JSON.parse(localStorage.getItem(key));return draft.state.segments.find(segment=>segment.segment_id==='segment_residual').edit_regions.map(region=>({start:region.source_start_ms,end:region.source_end_ms,points:(region.pitch_points||[]).map(point=>point.midi)}))})()")

            await wait_for("Object.keys(localStorage).some(key=>key.includes('parent%3Aparent-residual'))")
            current_regions = await draft_regions()
            assert [(region["start"], region["end"]) for region in current_regions] == [(100, 550), (550, 600), (600, 650), (650, 1000)], f"Syllable editing did not preserve the clipped source ranges: {current_regions}"
            assert all(point == 60 for region in current_regions if (region["start"], region["end"]) == (100, 550) for point in region["points"]), f"First syllable target did not stay within its source range: {current_regions}"
            assert all(not region["points"] for region in current_regions if (region["start"], region["end"]) != (100, 550)), f"Syllable target changed neighboring regions: {current_regions}"

            first_residual_selector = '.piano-region-note[data-source-start-ms="550"][data-source-end-ms="600"]'
            second_residual_selector = '.piano-region-note[data-source-start-ms="600"][data-source-end-ms="650"]'
            await evaluate(f"document.querySelector({json.dumps(first_residual_selector)}).click()")
            residual_input = await evaluate("({value:document.querySelector('[aria-label=\"?? ?? MIDI\"]')?.value,loopDisabled:document.querySelectorAll('.piano-roll-transport button')[1].disabled})")
            assert residual_input["loopDisabled"] is False, "Selecting an uncovered residual did not set its loop range"

            async def drag_region(selector: str, delta: float, ctrl: bool = False) -> tuple[dict, float]:
                point = await evaluate(f"(() => {{const e=document.querySelector({json.dumps(selector)}),r=e.getBoundingClientRect(),h=parseFloat(getComputedStyle(document.querySelector('.piano-roll-pitch-content')).getPropertyValue('--semitone-height'));return {{x:r.left+r.width/2,y:r.top+r.height/2,h}}}})()")
                await command("Input.dispatchMouseEvent", {"type": "mousePressed", "x": point["x"], "y": point["y"], "button": "left"})
                modifiers = 2 if ctrl else 0
                await command("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": point["x"], "y": point["y"] - point["h"] * delta, "button": "left", "buttons": 1, "modifiers": modifiers})
                result = await evaluate(f"parseFloat(document.querySelector({json.dumps(selector)}).style.top)")
                return point, result

            await evaluate("window.__draftWriteCount=0")
            first_drag, _ = await drag_region(first_residual_selector, 1, ctrl=False)
            await wait_for("document.querySelector('.piano-roll-drag-badge')!==null")
            badge_one = await evaluate("document.querySelector('.piano-roll-drag-badge').textContent")
            await command("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": first_drag["x"], "y": first_drag["y"] - first_drag["h"] * 1.25, "button": "left", "buttons": 1, "modifiers": 2})
            badge_two = await evaluate("document.querySelector('.piano-roll-drag-badge')?.textContent||''")
            assert badge_two and badge_two != badge_one, f"Pitch badge did not update during a residual drag: {badge_one}, {badge_two}"
            assert "+" in badge_two, f"Positive micro-pitch badge omitted its cent sign: {badge_two}"
            badge_screenshot = await command("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": True, "fromSurface": True})
            (ARTIFACT_DIR / "piano-roll-drag-badge-smoke.png").write_bytes(base64.b64decode(badge_screenshot["data"]))
            await command("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": first_drag["x"], "y": first_drag["y"] - first_drag["h"] * 1.25, "button": "left", "modifiers": 2})
            await wait_for("document.querySelector('.piano-roll-drag-badge')===null")
            await wait_for("window.__draftWriteCount===1")
            first_residual_edit = await draft_regions()
            changed_first = next(region for region in first_residual_edit if (region["start"], region["end"]) == (550, 600))
            assert changed_first["points"] and all(not region["points"] for region in first_residual_edit if (region["start"], region["end"]) in {(600, 650), (650, 1000)}), f"First residual drag changed another source interval: {first_residual_edit}"

            await evaluate("window.__draftWriteCount=0")
            second_drag, _ = await drag_region(second_residual_selector, 1, ctrl=False)
            await command("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": second_drag["x"], "y": second_drag["y"] - second_drag["h"], "button": "left"})
            await wait_for("window.__draftWriteCount===1")
            second_residual_edit = await draft_regions()
            assert next(region for region in second_residual_edit if (region["start"], region["end"]) == (550, 600))["points"] == changed_first["points"], f"Editing the second residual changed the first residual: {second_residual_edit}"
            assert next(region for region in second_residual_edit if (region["start"], region["end"]) == (600, 650))["points"], f"Second residual drag did not edit its own interval: {second_residual_edit}"
            assert all(point == 60 for region in second_residual_edit if (region["start"], region["end"]) == (100, 550) for point in region["points"]), f"Repeated residual drags changed the first syllable: {second_residual_edit}"

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

            hold_view, _ = await drag_region(first_residual_selector, 1, ctrl=False)
            hold_scroll = await evaluate("document.querySelector('.piano-roll-pitch-scroll').scrollTop")
            held_top = await evaluate(f"parseFloat(document.querySelector({json.dumps(first_residual_selector)}).style.top)")
            scroll_pixels = max(1, round(hold_view["h"]))
            await evaluate(f"document.querySelector('.piano-roll-pitch-scroll').scrollTop={hold_scroll + scroll_pixels}")
            await wait_for(f"document.querySelector('.piano-roll-pitch-scroll').scrollTop>={hold_scroll + scroll_pixels}")
            badge_after_scroll = await evaluate("document.querySelector('.piano-roll-drag-badge')?.textContent||''")
            assert badge_after_scroll, "Pitch badge disappeared during a held-drag scroll"
            await wait_for(f"parseFloat(document.querySelector({json.dumps(first_residual_selector)}).style.top)!=={held_top}")
            scrolled_top = await evaluate(f"parseFloat(document.querySelector({json.dumps(first_residual_selector)}).style.top)")
            scrolled_scroll = await evaluate("document.querySelector('.piano-roll-pitch-scroll').scrollTop")
            assert scrolled_top != held_top, f"Held pitch drag did not follow the content scroll without pointer movement: top={held_top}/{scrolled_top}, scroll={hold_scroll}/{scrolled_scroll}, pixels={scroll_pixels}"
            await evaluate(f"document.querySelector('.piano-roll-pitch-scroll').scrollTop={hold_scroll}")
            await wait_for(f"parseFloat(document.querySelector({json.dumps(first_residual_selector)}).style.top)==={held_top}")
            returned_top = await evaluate(f"parseFloat(document.querySelector({json.dumps(first_residual_selector)}).style.top)")
            assert abs(returned_top - held_top) < .01, f"Held pitch drag did not return to its original position after a scroll roundtrip: {held_top}, {returned_top}"
            await evaluate(f"document.querySelector('.piano-roll-pitch-scroll').scrollTop={hold_scroll + scroll_pixels}")
            await evaluate("window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true}))")
            await wait_for("document.querySelector('.piano-roll-drag-badge')===null")
            await wait_for("window.__draftWriteCount===1")
            held_regions = await draft_regions()
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "z", "code": "KeyZ", "windowsVirtualKeyCode": 90, "modifiers": 2})
            await command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})
            await wait_for("document.querySelector('.piano-roll-drag-badge')===null")
            await wait_for("window.__draftWriteCount===2")
            undone_regions = await draft_regions()
            assert next(region for region in undone_regions if (region["start"], region["end"]) == (550, 600))["points"] == next(region for region in second_residual_edit if (region["start"], region["end"]) == (550, 600))["points"], f"One undo did not restore the residual pitch gesture: {held_regions}, {undone_regions}"
            assert next(region for region in undone_regions if (region["start"], region["end"]) == (600, 650))["points"] == next(region for region in second_residual_edit if (region["start"], region["end"]) == (600, 650))["points"], f"One undo changed the other residual range: {undone_regions}"
            assert all(point == 60 for region in undone_regions if (region["start"], region["end"]) == (100, 550) for point in region["points"]), f"One undo removed the prior syllable edit: {undone_regions}"
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
