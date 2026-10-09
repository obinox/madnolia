# ruff: noqa: ASYNC210, ASYNC220
import argparse
import asyncio
import base64
import json
import math
import shutil
import sys
import socket
import subprocess
import tempfile
import time
import urllib.request
import wave
from io import BytesIO
from pathlib import Path

from websockets.asyncio.client import connect

sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")

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
        first_ipa = "m" if index == 0 else "a"
        second_ipa = "a" if index == 0 else "b"
        units = [{
            "phone_unit_id": f"phone_{base}", "operation": "MATCH", "target_index": index,
            "target_phone_id": first_ipa, "target_ipa": first_ipa, "source_occurrence_id": f"occ_{base}",
            "source_phone_id": first_ipa, "source_ipa": first_ipa, "source_start_ms": base,
            "source_end_ms": base + 500, "output_duration_ms": 500, "source_f0_hz": None,
            "voiced_probability": 0, "target_pitch_midi": None, "formant_shift_semitones": 0,
            "transition_to_next_ms": 80, "transition_strength_percent": 100, "transition_center_ms": 0,
            "pitch_points": [], "pitch_owner_ref": None,
        }, {
            "phone_unit_id": f"phone_{base + 500}", "operation": "MATCH", "target_index": index,
            "target_phone_id": second_ipa, "target_ipa": second_ipa, "source_occurrence_id": f"occ_{base + 500}",
            "source_phone_id": second_ipa, "source_ipa": second_ipa, "source_start_ms": base + 500,
            "source_end_ms": base + 1000, "output_duration_ms": 500, "source_f0_hz": None,
            "voiced_probability": 0, "target_pitch_midi": None, "formant_shift_semitones": 0,
            "transition_to_next_ms": 80, "transition_strength_percent": 100, "transition_center_ms": 0,
            "pitch_points": [], "pitch_owner_ref": None,
        }]
        segments.append({"segment_id": f"segment_{index}", "candidate_id": f"candidate_{index}",
            "target_start_index": index, "target_end_index": index + 1, "source_id": "source",
            "source_start_ms": base, "source_end_ms": base + 1000, "timeline_start_ms": index * 1000,
            "timeline_end_ms": (index + 1) * 1000, "match_status": "EXACT", "target_ipa": ["a", "b"],
            "matched_ipa": ["a", "b"], "gap_before_ms": 0, "stretch_percent": 100, "lane": 0,
            "phone_units": units, "edit_regions": [], "volume_envelope": []})
        segments[-1]["target_ipa"] = [first_ipa, second_ipa]
        segments[-1]["matched_ipa"] = [first_ipa, second_ipa]
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


def autotune_fixture_response(body: dict) -> dict:
    segments = body.get("composition", {}).get("segments", [])
    ordered_phones = [
        (segment, phone)
        for segment in segments
        for phone in segment.get("phone_units", [])
    ]
    phone_positions = {phone["phone_unit_id"]: index for index, (_, phone) in enumerate(ordered_phones)}
    voiced = [
        index
        for index, (_, phone) in enumerate(ordered_phones)
        if phone.get("target_ipa", "").lower() in {"a", "e", "i", "o", "u"}
    ]
    tuned_segments = []
    for segment in segments:
        tuned_phones = []
        for phone in segment.get("phone_units", []):
            index = phone_positions[phone["phone_unit_id"]]
            is_voiced = index in voiced
            owner_index = index
            if not is_voiced:
                following = next((candidate for candidate in voiced if candidate > index), None)
                owner_index = following if following is not None else next(
                    (candidate for candidate in reversed(voiced) if candidate < index), index
                )
            owner_segment, owner_phone = ordered_phones[owner_index]
            midi = owner_phone.get("target_pitch_midi")
            if midi is None:
                midi = 57 + int(owner_segment.get("target_start_index", 0)) % 7 + (2 if owner_phone.get("target_ipa") == "a" else 0)
            points = [{"position": 0, "midi": midi}, {"position": 1, "midi": midi}] if index == owner_index else []
            tuned_phones.append({
                **phone,
                "source_f0_hz": 220.0 + index,
                "pitch_points": points,
                "pitch_owner_ref": {
                    "segment_id": owner_segment["segment_id"],
                    "phone_unit_id": owner_phone["phone_unit_id"],
                },
            })
        tuned_regions = []
        for region_index, region in enumerate(segment.get("edit_regions", [])):
            midi = 60 + (region_index % 7)
            tuned_regions.append({
                **region,
                "source_f0_hz": 220.0 + region_index,
                "pitch_points": [{"position": 0, "midi": midi}, {"position": 1, "midi": midi}],
            })
        tuned_segments.append({"segment_id": segment["segment_id"], "phone_units": tuned_phones, "edit_regions": tuned_regions, "pitch_envelope": []})
    return {"segments": tuned_segments}


async def run_smoke(save_shortcuts: bool = False, piano_roll: bool = False, region_pitch: bool = False, region_first_drag: bool = False) -> None:
    if not CHROME.is_file():
        raise RuntimeError(f"Chrome was not found at {CHROME}")
    ARTIFACT.parent.mkdir(parents=True, exist_ok=True)
    port, debug_port = free_port(), free_port()
    temp_root = Path(tempfile.mkdtemp(prefix="madnolia-professional-smoke-"))
    vite = subprocess.Popen(["node", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", str(port), "--configLoader", "native"], cwd=WEB, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    chrome = None
    request_log: list[dict] = []
    saved_requests: list[dict] = []
    updated_requests: list[dict] = []
    pitch_analysis_requests: list[dict] = []
    pitch_analysis_responses: list[dict] = []
    pitch_edit_observed = False
    pitch_failure_sent = False
    autotune_requests: list[dict] = []
    autotune_responses: list[dict] = []
    preview_requests: list[dict] = []
    runtime_errors: list[str] = []
    deferred_fulfillments: set[asyncio.Task] = set()
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
        if region_first_drag:
            first_segment = next(segment for segment in parent_fixture["segments"] if segment["segment_id"] == "segment_0")
            first_segment["edit_regions"] = [{
                "region_id": "region_0",
                "source_start_ms": 100,
                "source_end_ms": 1100,
                "output_duration_ms": 1000,
                "relative_pitch_cents": 100,
                "pitch_points": [],
                "source_f0_hz": None,
            }]
            fixtures_by_path["/api/projects/smoke/compositions"] = (200, "application/json", json.dumps([parent_fixture]).encode())
        responses: dict[int, dict] = {}
        next_id = 0
        async with connect(page["webSocketDebuggerUrl"], max_size=16 * 1024 * 1024) as ws:
            async def command(method: str, params: dict | None = None) -> dict:
                nonlocal next_id, pitch_edit_observed, pitch_failure_sent
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
                        elif request.get("method") == "PUT" and path == "/api/collages/saved":
                            body = json.loads(request.get("postData", "{}")); updated_requests.append(body)
                            if saved_requests: saved_requests[-1] = body
                            reply = {"composition_id": "saved", "corpus_project_id": "smoke", "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:02Z", **body}
                            status, mime, payload = 200, "application/json", json.dumps(reply).encode()
                        elif request.get("method") == "POST" and path == "/api/projects/smoke/compositions/autotune":
                            body = json.loads(request.get("postData", "{}")); autotune_requests.append(body)
                            reply = autotune_fixture_response(body); autotune_responses.append(reply)
                            status, mime, payload = 200, "application/json", json.dumps(reply).encode()
                        elif request.get("method") == "POST" and path == "/api/projects/smoke/compositions/pitch-analysis":
                            body = json.loads(request.get("postData", "{}")); pitch_analysis_requests.append(body)
                            has_interior_pitch_point = any(
                                len(region.get("pitch_points", [])) > 2
                                for segment in body.get("segments", [])
                                for region in segment.get("edit_regions", [])
                            )
                            pitch_edit_observed = pitch_edit_observed or has_interior_pitch_point
                            measured_segments = []
                            for segment in body.get("segments", []):
                                phones = []
                                regions = segment.get("edit_regions", [])
                                total = max(1, sum(region["output_duration_ms"] for region in regions))
                                envelope = segment.get("pitch_envelope", [])
                                def corrected_midi_at(output_ms, base):
                                    if not envelope:
                                        return base
                                    position = output_ms / total
                                    for left, right in zip(envelope, envelope[1:]):
                                        if left["position"] <= position <= right["position"]:
                                            amount = (position - left["position"]) / max(1e-9, right["position"] - left["position"])
                                            return base + (left["cents"] + (right["cents"] - left["cents"]) * amount) / 100
                                    nearest = min(envelope, key=lambda point: abs(point["position"] - position))
                                    return base + nearest["cents"] / 100
                                def output_at(source_ms):
                                    cursor = 0.0
                                    for region in regions:
                                        if source_ms >= region["source_end_ms"]:
                                            cursor += region["output_duration_ms"]
                                        elif source_ms > region["source_start_ms"]:
                                            cursor += (source_ms - region["source_start_ms"]) * region["output_duration_ms"] / (region["source_end_ms"] - region["source_start_ms"])
                                            break
                                        else:
                                            break
                                    return cursor
                                for phone in segment.get("phone_units", []):
                                    start = output_at(phone["source_start_ms"])
                                    end = max(start + 1, output_at(phone["source_end_ms"]))
                                    voiced = phone.get("target_ipa") in {"a", "e", "i", "o", "u"}
                                    midi = 57 + (int(segment["target_start_index"]) % 7) + (2 if phone.get("target_ipa") == "a" else 0)
                                    corrected_midi = phone.get("target_pitch_midi") if phone.get("target_pitch_midi") is not None else midi
                                    def frame(output_ms, pitch_midi):
                                        hz = round(440 * 2 ** ((pitch_midi - 69) / 12), 3) if voiced else None
                                        return {"position": output_ms / total, "hz": hz}
                                    phones.append({"phone_unit_id": phone["phone_unit_id"], "source_start_ms": phone["source_start_ms"], "source_end_ms": phone["source_end_ms"], "output_start_ms": start, "output_end_ms": end, "original": [frame(start, midi), frame((start + end) / 2, midi), frame(end, midi)], "corrected": [frame(start, corrected_midi_at(start, corrected_midi)), frame((start + end) / 2, corrected_midi_at((start + end) / 2, corrected_midi)), frame(end, corrected_midi_at(end, corrected_midi))]})
                                measured_segments.append({"segment_id": segment["segment_id"], "phones": phones})
                            measured_regions = []
                            for segment in body.get("segments", []):
                                cursor = 0.0
                                total_output = max(1, sum(region["output_duration_ms"] for region in segment.get("edit_regions", [])))
                                regions = []
                                for region in segment.get("edit_regions", []):
                                    duration = max(1, region["output_duration_ms"])
                                    base_midi = 57 + int(region["source_start_ms"] // 1000) % 7
                                    pitch_points = region.get("pitch_points", [])
                                    def corrected_region_midi(position):
                                        if not pitch_points:
                                            return base_midi + region.get("relative_pitch_cents", 0) / 100
                                        right_index = next((i for i, point in enumerate(pitch_points) if point["position"] >= position), len(pitch_points) - 1)
                                        if right_index == 0:
                                            return pitch_points[0]["midi"]
                                        left, right = pitch_points[right_index - 1], pitch_points[right_index]
                                        amount = (position - left["position"]) / max(1e-9, right["position"] - left["position"])
                                        return left["midi"] + (right["midi"] - left["midi"]) * amount
                                    samples = [0, 0.5, 1]
                                    overlapping = [phone for phone in segment.get("phone_units", []) if phone.get("source_start_ms") is not None and phone.get("source_end_ms") is not None and phone["source_start_ms"] < region["source_end_ms"] and phone["source_end_ms"] > region["source_start_ms"]]
                                    voiced = any(phone.get("target_ipa", "").lower() in {"a", "e", "i", "o", "u"} for phone in overlapping)
                                    regions.append({
                                        "region_id": region["region_id"],
                                        "source_start_ms": region["source_start_ms"],
                                        "source_end_ms": region["source_end_ms"],
                                        "output_start_ms": cursor,
                                        "output_end_ms": cursor + duration,
                                        "original": [{"position": (cursor + position * duration) / total_output, "hz": round(220 * 2 ** ((base_midi - 57) / 12), 3) if voiced else None} for position in samples],
                                        "corrected": [{"position": (cursor + position * duration) / total_output, "hz": round(440 * 2 ** ((corrected_region_midi(position) - 69) / 12), 3) if voiced else None} for position in samples],
                                    })
                                    cursor += duration
                                measured_regions.append({"segment_id": segment["segment_id"], "regions": regions})
                            region_by_segment = {item["segment_id"]: item["regions"] for item in measured_regions}
                            analysis_reply = {"segments": [{**item, "regions": region_by_segment.get(item["segment_id"], [])} for item in measured_segments]}
                            pitch_analysis_responses.append(analysis_reply)
                            status, mime, payload = 200, "application/json", json.dumps(analysis_reply).encode()
                            if pitch_edit_observed and not has_interior_pitch_point and not pitch_failure_sent:
                                status, payload = 500, json.dumps({"detail": "smoke analysis failure"}).encode()
                                pitch_failure_sent = True
                        elif request.get("method") == "POST" and path == "/api/projects/smoke/compositions/preview":
                            preview_requests.append(json.loads(request.get("postData", "{}")))
                            status, mime, payload = fixtures_by_path[path]
                        elif request.get("method") == "GET" and path == "/api/projects/smoke/compositions" and saved_requests:
                            saved = saved_requests[-1]
                            reply = {"composition_id": "saved", "corpus_project_id": "smoke", "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:01Z", **saved}
                            status, mime, payload = 200, "application/json", json.dumps([parent_fixture, reply]).encode()
                        else:
                            status, mime, payload = fixtures_by_path.get(path, (404, "application/json", b'{"detail":"not stubbed"}'))
                        request_log.append({"path": path, "status": status})
                        task_paths = {"/api/projects/smoke/compositions/pitch-analysis", "/api/projects/smoke/compositions/autotune", "/api/projects/smoke/compositions/preview", "/api/collages", "/api/collages/saved"}
                        delay = 0.35 if (piano_roll or region_pitch or region_first_drag) and path in task_paths else 0
                        task = asyncio.create_task(fulfill_request(paused["requestId"], status, mime, payload, delay))
                        deferred_fulfillments.add(task)
                        task.add_done_callback(deferred_fulfillments.discard)
                raise TimeoutError(f"{method} timed out")

            async def fulfill_request(request_id: str, status: int, mime: str, payload: bytes, delay: float = 0) -> None:
                nonlocal next_id
                if delay:
                    await asyncio.sleep(delay)
                next_id += 1
                await ws.send(json.dumps({"id": next_id, "method": "Fetch.fulfillRequest", "params": {"requestId": request_id, "responseCode": status, "responseHeaders": [{"name": "Content-Type", "value": mime}, {"name": "Access-Control-Allow-Origin", "value": "*"}], "body": base64.b64encode(payload).decode()}}))

            async def evaluate(expression: str):
                result = await command("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True})
                if result.get("exceptionDetails"):
                    details = result["exceptionDetails"]
                    exception = details.get("exception", {})
                    raise RuntimeError(exception.get("description") or details.get("text", "browser evaluation failed"))
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

            async def wait_global_idle(timeout: float = 10):
                await wait_for("document.querySelector('.global-task-dialog')===null", timeout)

            try:
                await command("Fetch.enable", {"patterns": [{"urlPattern": f"http://127.0.0.1:{port}/api/*"}]})
                await command("Page.enable"); await command("Runtime.enable")
                await command("Emulation.setDeviceMetricsOverride", {"width":1440,"height":760,"deviceScaleFactor":1,"mobile":False})
                await command("Page.navigate", {"url": f"http://127.0.0.1:{port}/#/professional/smoke"})
                await wait_for("document.querySelectorAll('.professional-audio-fragment').length===12")
                await wait_global_idle()
                if piano_roll or region_pitch or region_first_drag:
                    timing_frame = await evaluate("(() => {const r=e=>{const b=e.getBoundingClientRect();return [b.top,b.bottom,b.left,b.right]};return {page:r(document.querySelector('.professional-page')),toolbar:r(document.querySelector('.professional-toolbar')),editor:r(document.querySelector('.professional-editor')),footer:r(document.querySelector('.professional-footer'))}})()")
                    if not region_first_drag:
                        await evaluate("(() => {const e=document.querySelector('.professional-audio-fragment'),r=e.getBoundingClientRect(),scale=r.width/1000,x=r.left+250*scale,y=r.top+r.height/2;e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:x,clientY:y,button:2}))})()")
                        await wait_for("document.querySelector('.professional-audio-fragment .professional-guides .user-guide')!==null")
                        timing_regions = await evaluate("(() => [...document.querySelectorAll('.professional-audio-fragment:first-of-type .professional-guides i')].map(e=>Number(e.dataset.sourceStartMs)))()")
                        assert timing_regions == [350, 600], f"User split did not preserve the phone boundary and requested split: {timing_regions}"
                    await evaluate("document.querySelector('.professional-footer > button').click()")
                    await wait_for("getComputedStyle(document.querySelector('.piano-roll-editor')).display==='flex'")
                    await wait_for("document.querySelector('.global-task-dialog')?.innerText.includes('피치 분석')")
                    await wait_for("document.querySelector('.piano-roll-analysis[role=status]')!==null")
                    initial_loading_frame = await evaluate("(() => {const r=e=>{const b=e.getBoundingClientRect();return [b.top,b.bottom,b.left,b.right]};const s=document.querySelector('.piano-roll-pitch-scroll');return {pitch:r(s),ruler:r(document.querySelector('.piano-roll-pitch-time')),scrollTop:s.scrollTop}})()")
                    await wait_for("document.querySelectorAll('.piano-region-note').length==="+str(23 if region_first_drag else 25))
                    await wait_for("document.querySelectorAll('.piano-region-contour-original').length>0 && document.querySelectorAll('.piano-region-contour-corrected').length>0")
                    await wait_for("document.querySelector('.piano-roll-analysis')===null")
                    await wait_global_idle()
                    ready_frame = await evaluate("(() => {const r=e=>{const b=e.getBoundingClientRect();return [b.top,b.bottom,b.left,b.right]};const s=document.querySelector('.piano-roll-pitch-scroll');return {pitch:r(s),ruler:r(document.querySelector('.piano-roll-pitch-time')),scrollTop:s.scrollTop}})()")
                    correction_frame = await evaluate("(() => {const r=e=>{const b=e.getBoundingClientRect();return [b.top,b.bottom,b.left,b.right]};return {page:r(document.querySelector('.professional-page')),toolbar:r(document.querySelector('.professional-toolbar')),editor:r(document.querySelector('.piano-roll-editor')),footer:r(document.querySelector('.professional-footer'))}})()")
                    assert all(max(abs(a-b) for a,b in zip(timing_frame[key],correction_frame[key])) <= 1 for key in timing_frame), f"Timing and correction viewport frames differ: {timing_frame} -> {correction_frame}"
                    assert all(max(abs(a-b) for a,b in zip(initial_loading_frame[key],ready_frame[key])) <= 1 for key in ("pitch", "ruler")), f"Initial analysis changed pitch geometry: {initial_loading_frame} -> {ready_frame}"
                    if region_first_drag:
                        initial_segment = next(segment for segment in pitch_analysis_requests[-1]["segments"] if segment["segment_id"] == "segment_0")
                        initial_region = next(region for region in initial_segment["edit_regions"] if region["region_id"] == "region_0")
                        measured_region = next(region for segment in pitch_analysis_responses[-1]["segments"] if segment["segment_id"] == "segment_0" for region in segment["regions"] if region["region_id"] == "region_0")
                        original_hz = next(point["hz"] for point in measured_region["original"] if point["hz"] is not None)
                        original_midi = 69 + 12 * math.log2(original_hz / 440)
                        assert abs(original_midi - round(original_midi)) < 0.01, f"Fixture original measurement was not a whole MIDI note: {original_hz} Hz -> {original_midi}"
                        note = await evaluate("(() => {const e=document.querySelector('.piano-region-note[data-segment-id=\"segment_0\"][data-region-id=\"region_0\"]'),r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,height:parseFloat(getComputedStyle(document.querySelector('.piano-roll-pitch-content')).getPropertyValue('--semitone-height'))}})()")
                        await wait_global_idle()
                        await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":note["x"],"y":note["y"],"button":"left"})
                        await command("Input.dispatchMouseEvent", {"type":"mouseMoved","x":note["x"]+8,"y":note["y"]-note["height"],"button":"left","buttons":1})
                        await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":note["x"]+8,"y":note["y"]-note["height"],"button":"left"})
                        await evaluate("document.querySelector('.professional-actions .primary-action').click()")
                        await wait_for("document.querySelector('.global-task-dialog')?.innerText.includes('저장')")
                        await wait_for("document.body.innerText.includes('saved')")
                        await wait_global_idle()
                        requested_segment = next(segment for segment in saved_requests[-1]["segments"] if segment["segment_id"] == "segment_0")
                        requested_region = next(region for region in requested_segment["edit_regions"] if region["region_id"] == "region_0")
                        expected_midi = round(original_midi) + 1
                        assert requested_region.get("pitch_points") == [{"position": 0, "midi": expected_midi}, {"position": 1, "midi": expected_midi}], f"First region drag did not apply exactly one semitone from measured MIDI {original_midi}: {requested_region}"
                        assert requested_region.get("relative_pitch_cents") == 100, f"First region drag changed relative cents: {requested_region}"
                        assert (requested_region["source_start_ms"], requested_region["source_end_ms"], requested_region["output_duration_ms"]) == (initial_region["source_start_ms"], initial_region["source_end_ms"], initial_region["output_duration_ms"]), f"First region drag changed source bounds or output duration: {initial_region} -> {requested_region}"
                        artifact = WEB / "tests" / "artifacts" / "region-first-drag-smoke.png"
                        screenshot = await command("Page.captureScreenshot", {"format":"png","captureBeyondViewport":True,"fromSurface":True})
                        artifact.write_bytes(base64.b64decode(screenshot["data"]))
                        print(json.dumps({"status":"passed","flag":"--region-first-drag","source_id":"source","segment_id":"segment_0","region_id":"region_0","original_measured_hz":original_hz,"original_measured_midi":original_midi,"requested_pitch_points":requested_region["pitch_points"],"relative_pitch_cents":requested_region["relative_pitch_cents"],"source_bounds":[requested_region["source_start_ms"],requested_region["source_end_ms"]],"output_duration_ms":requested_region["output_duration_ms"],"screenshot":str(artifact)},ensure_ascii=False))
                        return
                    measured = pitch_analysis_requests[-1]
                    first_segment = next(segment for segment in measured["segments"] if segment["segment_id"] == "segment_0")
                    region_bounds = [(region["source_start_ms"], region["source_end_ms"]) for region in first_segment["edit_regions"]]
                    assert region_bounds == [(100, 350), (350, 600), (600, 1100)], f"Pitch analysis changed region boundaries: {region_bounds}"
                    assert first_segment.get("user_guide_source_ms") == [350], f"User split was not sent for pitch analysis: {first_segment}"
                    assert all(len(segment.get("edit_regions", [])) == len(pitch_analysis_responses[-1]["segments"][index].get("regions", [])) for index, segment in enumerate(measured["segments"])), "Analysis response did not provide a contour for every region"
                    time_zoom = await evaluate("(() => {const e=document.querySelectorAll('.piano-roll-toolbar input[type=range]')[0];return {min:Number(e.min),max:Number(e.max),value:Number(e.value),label:e.parentElement.querySelector('small').textContent}})()")
                    assert time_zoom == {"min": 0.025, "max": 1.5, "value": 0.12, "label": "1.0×"}, f"\uC2DC\uAC04 \uD655\uB300 range or initial value changed: {time_zoom}"
                    await evaluate("(() => {const e=document.querySelectorAll('.piano-roll-toolbar input[type=range]')[0],s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(e,'1.5');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()")
                    await wait_for("document.querySelectorAll('.piano-roll-toolbar input[type=range]')[0].value==='1.5'")
                    assert await evaluate("document.querySelectorAll('.piano-roll-toolbar input[type=range]')[0].parentElement.querySelector('small').textContent==='12.5×'") , "Maximum time zoom multiplier was not shown"
                    await evaluate("(() => {const e=document.querySelectorAll('.piano-roll-toolbar input[type=range]')[0],s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(e,'0.025');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()")
                    await wait_for("document.querySelectorAll('.piano-roll-toolbar input[type=range]')[0].value==='0.025'")
                    assert await evaluate("document.querySelectorAll('.piano-roll-toolbar input[type=range]')[0].parentElement.querySelector('small').textContent==='0.2×'") , "Minimum time zoom multiplier was not shown"
                    await evaluate("(() => {const e=document.querySelectorAll('.piano-roll-toolbar input[type=range]')[0],s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(e,'0.12');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()")
                    const_pitch = await evaluate("(() => {const e=document.querySelectorAll('.piano-roll-toolbar input[type=range]')[1];return {min:Number(e.min),max:Number(e.max),value:Number(e.value),label:e.parentElement.querySelector('small').textContent}})()")
                    assert const_pitch["min"] == 7 and const_pitch["max"] == 28 and const_pitch["value"] == 16 and const_pitch["label"] == "1.0×", f"\uD53C\uCE58 \uD655\uB300 multiplier or range changed: {const_pitch}"
                    for value, expected_label in ((7, "0.4×"), (28, "1.8×"), (16, "1.0×")):
                        await evaluate("(() => {const e=document.querySelectorAll('.piano-roll-toolbar input[type=range]')[1],s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(e,'"+str(value)+"');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()")
                        await wait_for("document.querySelectorAll('.piano-roll-toolbar input[type=range]')[1].value==='"+str(value)+"'")
                        label = await evaluate("document.querySelectorAll('.piano-roll-toolbar input[type=range]')[1].parentElement.querySelector('small').textContent")
                        assert label == expected_label, f"\uD53C\uCE58 \uD655\uB300 multiplier was not formatted at {value}: {label}"
                        assert len(label) < 12 and label.endswith("×"), f"\uD53C\uCE58 \uD655\uB300 multiplier is not bounded: {label}"
                    await evaluate("document.querySelector('.professional-autotune button.primary-action').click()")
                    await wait_for("document.querySelector('.global-task-dialog')?.innerText.includes('자동 음정 보정')")
                    await wait_for("document.querySelectorAll('.piano-region-pitch-point').length===50")
                    await wait_for("document.querySelector('.piano-roll-analysis')===null")
                    await wait_global_idle()
                    protected_endpoints = await evaluate("document.querySelectorAll('.piano-region-pitch-point[data-endpoint=\"true\"]').length")
                    assert protected_endpoints == 50, f"Expected two protected pitch endpoints for each of 25 regions, got {protected_endpoints}"
                    endpoint_groups = await evaluate("[...document.querySelectorAll('.piano-region-pitch-group')].map(group=>group.querySelectorAll('.piano-region-pitch-point[data-endpoint=\"true\"]').length)")
                    assert len(endpoint_groups) == 25 and all(count == 2 for count in endpoint_groups), f"Each region must keep two protected endpoints: {endpoint_groups}"
                    await evaluate("(() => {const e=document.querySelector('.piano-region-pitch-point[data-endpoint=\"true\"]');e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))})()")
                    assert await evaluate("document.querySelectorAll('.piano-region-pitch-point').length===50"), "Right-click removed a protected region endpoint"
                    chart_point = await evaluate("(() => {const c=document.querySelector('.piano-roll-chart'),r=c.getBoundingClientRect();return {x:r.left+12,y:r.top+90}})()")
                    await wait_global_idle()
                    await evaluate("(() => {const c=document.querySelector('.piano-roll-chart'),r=c.getBoundingClientRect();c.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+12,clientY:r.top+90,button:2}))})()")
                    await wait_for("document.querySelectorAll('.piano-region-pitch-point').length===51")
                    await wait_for("document.querySelector('.global-task-dialog')?.innerText.includes('피치 분석')")
                    await wait_global_idle()
                    await evaluate("document.querySelector('.piano-roll-pitch-scroll').scrollTop=0")
                    new_point = await evaluate("(() => {const e=[...document.querySelectorAll('.piano-region-pitch-point')].find(point=>point.dataset.endpoint==='false'),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,cx:Number(e.getAttribute('cx')),cy:Number(e.getAttribute('cy')),region:e.dataset.regionId}})()")
                    assert new_point["region"], f"Inserted point did not belong to a region: {new_point}"
                    await wait_global_idle()
                    await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":new_point["x"],"y":new_point["y"],"button":"left"})
                    await command("Input.dispatchMouseEvent", {"type":"mouseMoved","x":new_point["x"],"y":new_point["y"]-18,"button":"left","buttons":1})
                    await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":new_point["x"],"y":new_point["y"]-18,"button":"left"})
                    await wait_for("document.querySelector('.global-task-dialog')?.innerText.includes('피치 분석')")
                    await wait_global_idle()
                    moved_point = await evaluate("(() => {const e=[...document.querySelectorAll('.piano-region-pitch-point')].find(point=>point.dataset.endpoint==='false');return {cx:Number(e.getAttribute('cx')),cy:Number(e.getAttribute('cy')),index:e.dataset.pointIndex}})()")
                    assert moved_point["cx"] == new_point["cx"] and moved_point["cy"] != new_point["cy"], f"Pitch drag changed time position or did not change pitch: {new_point} -> {moved_point}"
                    await wait_global_idle()
                    await evaluate("(() => {const e=[...document.querySelectorAll('.piano-region-pitch-point')].find(point=>point.dataset.endpoint==='false');e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))})()")
                    await wait_for("document.querySelector('.global-task-dialog')?.innerText.includes('피치 분석')")
                    await wait_for("document.querySelector('.piano-roll-analysis[role=alert]')!==null && document.querySelector('.global-task-dialog')===null")
                    await wait_for("document.querySelectorAll('.piano-region-pitch-point').length===50")
                    error_frame = await evaluate("(() => {const r=e=>{const b=e.getBoundingClientRect();return [b.top,b.bottom,b.left,b.right]};const s=document.querySelector('.piano-roll-pitch-scroll');return {pitch:r(s),ruler:r(document.querySelector('.piano-roll-pitch-time')),slot:r(document.querySelector('.piano-roll-analysis-slot')),scrollTop:s.scrollTop}})()")
                    await evaluate("document.querySelector('.piano-roll-analysis[role=alert] button').click()")
                    await wait_for("document.querySelector('.global-task-dialog')?.innerText.includes('피치 분석')")
                    await wait_for("document.querySelector('.piano-roll-analysis[role=status]')!==null")
                    await wait_for("document.querySelector('.piano-roll-analysis')===null")
                    await wait_global_idle()
                    retry_frame = await evaluate("(() => {const r=e=>{const b=e.getBoundingClientRect();return [b.top,b.bottom,b.left,b.right]};const s=document.querySelector('.piano-roll-pitch-scroll');return {pitch:r(s),ruler:r(document.querySelector('.piano-roll-pitch-time')),slot:r(document.querySelector('.piano-roll-analysis-slot')),scrollTop:s.scrollTop}})()")
                    assert all(max(abs(a-b) for a,b in zip(error_frame[key],retry_frame[key])) <= 1 for key in ("pitch", "ruler", "slot")) and abs(error_frame["scrollTop"]-retry_frame["scrollTop"]) <= 1, f"Analysis error/retry changed editor geometry or scroll: {error_frame} -> {retry_frame}"
                    await evaluate("window.__smokeTotalDurationMs="+str(max(segment["timeline_end_ms"] for segment in measured["segments"])) )
                    await evaluate("window.__smokeRegionDurations="+json.dumps({region["region_id"]: region["output_duration_ms"] for segment in measured["segments"] for region in segment["edit_regions"]}))
                    wheel_pitch = await evaluate("(() => {const e=document.querySelector('.piano-roll-pitch-scroll'),r=e.getBoundingClientRect(),h=parseFloat(getComputedStyle(document.querySelector('.piano-roll-pitch-content')).getPropertyValue('--semitone-height')),y=r.top+r.height*.4,midi=108-(e.scrollTop+y-r.top-h/2)/h,t=Number(document.querySelectorAll('.piano-roll-toolbar input[type=range]')[0].value);e.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:true,deltaY:-120,clientX:r.left+80,clientY:y}));return {midi,timeZoom:t}})()")
                    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
                    after_pitch_wheel = await evaluate("(() => {const e=document.querySelector('.piano-roll-pitch-scroll'),r=e.getBoundingClientRect(),h=parseFloat(getComputedStyle(document.querySelector('.piano-roll-pitch-content')).getPropertyValue('--semitone-height')),y=r.top+r.height*.4,midi=108-(e.scrollTop+y-r.top-h/2)/h,t=Number(document.querySelectorAll('.piano-roll-toolbar input[type=range]')[0].value);return {midi,timeZoom:t}})()")
                    assert abs(wheel_pitch["midi"]-after_pitch_wheel["midi"]) < .2 and wheel_pitch["timeZoom"] == after_pitch_wheel["timeZoom"], f"Ctrl-wheel did not anchor pitch zoom independently: {wheel_pitch} -> {after_pitch_wheel}"
                    before_time_wheel = await evaluate("(() => {const t=document.querySelector('.piano-roll-pitch-time'),r=t.getBoundingClientRect(),h=parseFloat(getComputedStyle(document.querySelector('.piano-roll-pitch-content')).getPropertyValue('--semitone-height')),x=r.left+r.width*.55,n=[...document.querySelectorAll('.piano-region-note')].map(e=>({width:e.getBoundingClientRect().width,duration:Number(window.__smokeRegionDurations?.[e.dataset.regionId])})).find(item=>item.duration&&item.width>20),scale=n.width/n.duration;return {time:(t.scrollLeft+x-r.left-60)/scale,height:h,x,scale}})()")
                    await evaluate("(() => {const e=document.querySelector('.piano-roll-pitch-time'),r=e.getBoundingClientRect();e.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:true,shiftKey:true,deltaY:-120,clientX:r.left+r.width*.55,clientY:r.top+r.height/2}))})()")
                    await wait_for("Number(document.querySelectorAll('.piano-roll-toolbar input[type=range]')[0].value)>"+str(wheel_pitch["timeZoom"]))
                    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
                    after_time_wheel = await evaluate("(() => {const t=document.querySelector('.piano-roll-pitch-time'),r=t.getBoundingClientRect(),h=parseFloat(getComputedStyle(document.querySelector('.piano-roll-pitch-content')).getPropertyValue('--semitone-height')),x=r.left+r.width*.55,n=[...document.querySelectorAll('.piano-region-note')].map(e=>({width:e.getBoundingClientRect().width,duration:Number(window.__smokeRegionDurations?.[e.dataset.regionId])})).find(item=>item.duration&&item.width>20),scale=n.width/n.duration;return {time:(t.scrollLeft+x-r.left-60)/scale,height:h,zoom:Number(document.querySelectorAll('.piano-roll-toolbar input[type=range]')[0].value),scrolls:[t.scrollLeft,document.querySelector('.piano-roll-pitch-scroll').scrollLeft,document.querySelector('.piano-volume-scroll').scrollLeft],scale}})()")
                    assert abs(before_time_wheel["time"]-after_time_wheel["time"]) < 25 and before_time_wheel["height"] == after_time_wheel["height"] and max(after_time_wheel["scrolls"])-min(after_time_wheel["scrolls"]) <= 1, f"Ctrl+Shift-wheel did not anchor synchronized time zoom: {before_time_wheel} -> {after_time_wheel}"
                    await evaluate("(() => {const e=document.querySelector('.piano-roll-pitch-scroll');e.scrollLeft=120;e.scrollTop=80})()")
                    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
                    scroll_sync = await evaluate("(() => ({xs:[document.querySelector('.piano-roll-pitch-time').scrollLeft,document.querySelector('.piano-roll-pitch-scroll').scrollLeft,document.querySelector('.piano-volume-scroll').scrollLeft],pitchTop:document.querySelector('.piano-roll-pitch-scroll').scrollTop,volumeTop:document.querySelector('.piano-volume-panel').getBoundingClientRect().top}))()")
                    assert max(scroll_sync["xs"])-min(scroll_sync["xs"]) <= 1 and scroll_sync["pitchTop"] > 0, f"Region editor axes did not scroll together: {scroll_sync}"
                    await evaluate("(() => {const e=document.querySelector('.piano-roll-pitch-scroll');e.scrollLeft=0;e.scrollTop=0})()")
                    chart_point = await evaluate("(() => {const c=document.querySelector('.piano-roll-chart'),r=c.getBoundingClientRect();return {x:r.left+12,y:r.top+90}})()")
                    await wait_global_idle()
                    await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":chart_point["x"],"y":chart_point["y"],"button":"right"})
                    await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":chart_point["x"],"y":chart_point["y"],"button":"right"})
                    await wait_for("document.querySelectorAll('.piano-region-pitch-point').length===51")
                    await wait_global_idle()
                    retained_region = await evaluate("(() => {const e=[...document.querySelectorAll('.piano-region-pitch-point')].find(point=>point.dataset.endpoint==='false');return {regionId:e.dataset.regionId,points:[...document.querySelectorAll('.piano-region-pitch-point')].filter(point=>point.dataset.regionId===e.dataset.regionId).map(point=>({position:Number(point.getAttribute('cx')),endpoint:point.dataset.endpoint,midi:Number(point.getAttribute('cy'))}))}})()")
                    retained_region_id = retained_region["regionId"]
                    old_preview_src = await evaluate("document.querySelector('audio')?.src||''")
                    await evaluate("document.querySelectorAll('.piano-roll-transport button')[3].click()")
                    await wait_for("document.querySelector('.global-task-dialog')?.innerText.includes('미리보기')")
                    await wait_for("document.querySelector('audio')?.src && document.querySelector('audio').src!=="+json.dumps(old_preview_src))
                    await wait_global_idle()
                    original_request = preview_requests[-1]
                    assert all(not region.get("pitch_points") and region.get("source_f0_hz") is None and region.get("relative_pitch_cents", 0) == 0 for segment in original_request["segments"] for region in segment["edit_regions"]), f"Original audition retained region pitch edits: {original_request}"
                    assert all(phone.get("target_pitch_midi") is None for segment in original_request["segments"] for phone in segment["phone_units"]), "Original audition retained phone pitch targets"
                    await evaluate("document.querySelector('.professional-actions .primary-action').click()")
                    await wait_for("document.querySelector('.global-task-dialog')?.innerText.includes('저장')")
                    await wait_for("document.body.innerText.includes('saved')")
                    await wait_global_idle()
                    saved_segment = next(segment for segment in saved_requests[-1]["segments"] if segment["segment_id"] == "segment_0")
                    saved_bounds = [(region["source_start_ms"], region["source_end_ms"]) for region in saved_segment["edit_regions"]]
                    assert saved_bounds == region_bounds and saved_segment.get("user_guide_source_ms") == [350], f"Save lost exact region boundaries or user split: {saved_segment}"
                    saved_curves = {region["region_id"]: region.get("pitch_points", []) for segment in saved_requests[-1]["segments"] for region in segment["edit_regions"]}
                    assert all(len(points) == (3 if region_id == retained_region_id else 2) and points[0]["position"] == 0 and points[-1]["position"] == 1 for region_id, points in saved_curves.items()), f"Saved region curves lost protected endpoints or the inserted interior point: {saved_curves}"
                    await evaluate("(() => {const e=document.querySelectorAll('.professional-file-controls select')[0];e.value='parent';e.dispatchEvent(new Event('change',{bubbles:true}))})()")
                    await wait_global_idle()
                    await wait_for("document.querySelectorAll('.professional-file-controls select')[1].value==='' ")
                    await evaluate("(() => {const e=document.querySelectorAll('.professional-file-controls select')[1];e.value='saved';e.dispatchEvent(new Event('change',{bubbles:true}))})()")
                    await evaluate("document.querySelector('.professional-footer > button').click()")
                    await wait_for("document.querySelector('.global-task-dialog')?.innerText.includes('피치 분석')")
                    await wait_for("document.querySelectorAll('.piano-region-pitch-point').length===51")
                    await wait_global_idle()
                    reopened = await evaluate("(() => {const s=[...document.querySelectorAll('.piano-region-note')].filter(e=>e.dataset.segmentId==='segment_0');return {notes:s.length,bounds:s.map(e=>e.dataset.regionId),points:document.querySelectorAll('.piano-region-pitch-point').length,endpoints:document.querySelectorAll('.piano-region-pitch-point[data-endpoint=\"true\"]').length}})()")
                    assert reopened["notes"] == 3 and reopened["points"] == 51 and reopened["endpoints"] == 50, f"Reopened editor lost region curves: {reopened}"
                    reopened_curve = await evaluate("[...document.querySelectorAll('.piano-region-pitch-group')].find(e=>e.dataset.regionId==="+json.dumps(retained_region_id)+")?.querySelectorAll('.piano-region-pitch-point').length??0")
                    assert reopened_curve == 3, f"Reopened editor lost the saved interior region point: {retained_region_id} -> {reopened_curve}"
                    artifact = WEB / "tests" / "artifacts" / "region-pitch-smoke.png"
                    screenshot = await command("Page.captureScreenshot", {"format":"png","captureBeyondViewport":True,"fromSurface":True})
                    artifact.write_bytes(base64.b64decode(screenshot["data"]))
                    print(json.dumps({"status":"passed","regions":25,"user_split_source_ms":350,"pitch_zoom":const_pitch,"time_zoom":time_zoom,"analysis_error_retry_geometry":True,"original_audition_clears_region_curves":True,"save_reopen":True,"screenshot":str(artifact)},ensure_ascii=False))
                    return
                if save_shortcuts:
                    await wait_for("document.querySelector('.professional-waveform polygon')?.getAttribute('points').trim().split(/\\s+/).length>800")
                    wheel = await evaluate("(() => {const r=document.querySelector('.professional-timeline-scroll').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()")
                    await command("Input.dispatchMouseEvent", {"type":"mouseMoved","x":wheel["x"],"y":wheel["y"]})
                    await command("Input.dispatchMouseEvent", {"type":"mouseWheel","x":wheel["x"],"y":wheel["y"],"deltaY":-700,"modifiers":10})
                    await wait_for("parseFloat(document.querySelector('.professional-audio-fragment').style.width)>120")
                    await evaluate("(() => {const e=document.querySelector('.professional-timeline-scroll');e.scrollLeft=Math.max(1,(e.scrollWidth-e.clientWidth)/2);window.__editorBeforeFirstSave=document.querySelector('.professional-editor')})()")
                    first_save_view = await evaluate("(() => ({width:document.querySelector('.professional-audio-fragment').style.width,scrollLeft:document.querySelector('.professional-timeline-scroll').scrollLeft}))()")
                    await evaluate("document.querySelector('.professional-actions .primary-action').click()")
                    await wait_for("document.querySelector('.assembly-message')?.textContent.includes('saved')")
                    assert len(saved_requests) == 1, f"Button save did not create one composition: {request_log}"
                    after_first_save = await evaluate("(() => ({sameEditor:window.__editorBeforeFirstSave===document.querySelector('.professional-editor'),width:document.querySelector('.professional-audio-fragment').style.width,scrollLeft:document.querySelector('.professional-timeline-scroll').scrollLeft}))()")
                    assert after_first_save["sameEditor"], "First save replaced the timeline editor DOM"
                    assert after_first_save["width"] == first_save_view["width"], f"First save reset timeline zoom: {first_save_view} -> {after_first_save}"
                    assert abs(after_first_save["scrollLeft"] - first_save_view["scrollLeft"]) <= 1, f"First save reset timeline scroll: {first_save_view} -> {after_first_save}"
                    await evaluate("(() => {const e=document.querySelector('.professional-name-field input'),setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;e.focus();setter.call(e,'Smoke saved twice');e.dispatchEvent(new Event('input',{bubbles:true}))})()")
                    await command("Input.dispatchKeyEvent", {"type":"rawKeyDown","key":"s","code":"KeyS","modifiers":2})
                    await command("Input.dispatchKeyEvent", {"type":"keyUp","key":"s","code":"KeyS","modifiers":2})
                    await wait_for("document.querySelector('.professional-name-field input').value==='Smoke saved twice' && document.querySelector('.assembly-message')?.textContent.includes('saved')")
                    assert len(updated_requests) == 1, f"Ctrl+S did not issue one update request: {request_log}"
                    assert updated_requests[0]["name"] == "Smoke saved twice", f"Ctrl+S did not save the focused name input: {updated_requests[0]}"
                    assert any(item["path"] == "/api/collages/saved" and item["status"] == 200 for item in request_log), f"Ctrl+S update endpoint was not captured: {request_log}"
                    await evaluate("window.__undoWasPrevented=null;window.addEventListener('keydown',e=>{if(e.ctrlKey&&e.key.toLowerCase()==='z')setTimeout(()=>window.__undoWasPrevented=e.defaultPrevented,0)},true)")
                    await scroll_to_fragment('.professional-audio-fragment:nth-of-type(2) .professional-fragment-label')
                    movement_before = await evaluate("(() => {const e=[...document.querySelectorAll('.professional-audio-fragment')];return e.slice(0,3).map(item=>[parseFloat(item.style.left),parseFloat(item.style.width)])})()")
                    syllable_top = await evaluate("(() => {const r=document.querySelectorAll('.professional-fragment-label')[1].getBoundingClientRect();return {x:r.left+r.width*.6,y:r.top+r.height/2}})()")
                    await command("Input.dispatchMouseEvent", {"type":"mousePressed","x":syllable_top["x"],"y":syllable_top["y"],"button":"left"})
                    await command("Input.dispatchMouseEvent", {"type":"mouseMoved","x":syllable_top["x"]+12,"y":syllable_top["y"],"button":"left","buttons":1})
                    await command("Input.dispatchMouseEvent", {"type":"mouseReleased","x":syllable_top["x"]+12,"y":syllable_top["y"],"button":"left"})
                    await wait_for("parseFloat(document.querySelectorAll('.professional-audio-fragment')[1].style.left)>"+str(movement_before[1][0]))
                    movement_after = await evaluate("(() => {const e=[...document.querySelectorAll('.professional-audio-fragment')];return e.slice(0,3).map(item=>[parseFloat(item.style.left),parseFloat(item.style.width)])})()")
                    assert movement_after[0] == movement_before[0] and movement_after[2] == movement_before[2] and movement_after[1][1] == movement_before[1][1], f"Dragging the syllable top label did not move only that syllable intact: {movement_before} -> {movement_after}"
                    await evaluate("document.querySelector('.professional-name-field input').focus()")
                    await command("Input.dispatchKeyEvent", {"type":"rawKeyDown","key":"z","code":"KeyZ","modifiers":2})
                    await command("Input.dispatchKeyEvent", {"type":"keyUp","key":"z","code":"KeyZ","modifiers":2})
                    await wait_for("Math.abs(parseFloat(document.querySelectorAll('.professional-audio-fragment')[1].style.left)-"+str(movement_before[1][0])+")<1")
                    await wait_for("window.__undoWasPrevented===true")
                    await command("Input.dispatchKeyEvent", {"type":"rawKeyDown","key":"y","code":"KeyY","modifiers":2})
                    await command("Input.dispatchKeyEvent", {"type":"keyUp","key":"y","code":"KeyY","modifiers":2})
                    await wait_for("Math.abs(parseFloat(document.querySelectorAll('.professional-audio-fragment')[1].style.left)-"+str(movement_after[1][0])+")<1")
                    await evaluate("document.querySelector('.professional-name-field input').focus()")
                    await evaluate("(() => {const e=document.querySelector('.professional-name-field input');e.setSelectionRange(0,e.value.length)})()")
                    for character in "Smoke typing undo":
                        key = "Space" if character == " " else "Key" + character.upper()
                        await command("Input.dispatchKeyEvent", {"type":"keyDown","key":character,"code":key})
                        await command("Input.dispatchKeyEvent", {"type":"char","key":character,"text":character,"unmodifiedText":character})
                        await command("Input.dispatchKeyEvent", {"type":"keyUp","key":character,"code":key})
                    await wait_for("document.querySelector('.professional-name-field input').value==='Smoke typing undo'")
                    await command("Input.dispatchKeyEvent", {"type":"rawKeyDown","key":"z","code":"KeyZ","modifiers":2})
                    await command("Input.dispatchKeyEvent", {"type":"keyUp","key":"z","code":"KeyZ","modifiers":2})
                    await wait_for("window.__undoWasPrevented===false")
                    assert await evaluate("Math.abs(parseFloat(document.querySelectorAll('.professional-audio-fragment')[1].style.left)-"+str(movement_after[1][0])+")<1"), "Typing undo reverted the previous syllable movement"
                    print(json.dumps({"status":"passed","first_save_preserved_zoom_scroll_dom":True,"focused_ctrl_s_update":True,"focused_movement_undo_redo":True,"typing_undo_native":True},ensure_ascii=False))
                    return
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
                await command("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": wheel["x"], "y": wheel["y"], "deltaY": -700, "modifiers": 10})
                await wait_for("parseFloat(document.querySelector('.professional-audio-fragment').style.width)>"+str(before_zoom))
                await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
                anchor = await evaluate("(() => {const e=document.querySelector('.professional-timeline-scroll');const r=e.getBoundingClientRect();const scale=parseFloat(document.querySelector('.professional-audio-fragment').style.width)/1000;const x="+str(wheel["x"])+";return {x,y:r.top+8,time:(e.scrollLeft+x-r.left-"+str(timeline_origin)+")/scale}})()")
                await command("Input.dispatchMouseEvent", {"type":"mouseMoved","x":anchor["x"],"y":anchor["y"]})
                await wait_for("document.elementFromPoint("+str(anchor["x"])+","+str(anchor["y"])+").closest('.professional-timeline-content')!==null")
                zoomed_width = await evaluate("parseFloat(document.querySelector('.professional-audio-fragment').style.width)")
                await command("Input.dispatchMouseEvent", {"type":"mouseWheel","x":anchor["x"],"y":anchor["y"],"deltaY":250,"modifiers":10})
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
                lane_alignment = await evaluate("(() => {const a=[...document.querySelectorAll('.professional-audio-fragment')].slice(0,2);const ruler=document.querySelector('.professional-time-ruler'),grid=document.querySelector('.professional-grid-layer');return {audio:a.map(x=>[x.getBoundingClientRect().left,x.dataset.lane]),ruler:ruler.getBoundingClientRect().left,gridLeft:grid.getBoundingClientRect().left,gridPosition:getComputedStyle(grid).backgroundPositionX,labels:[...ruler.children].map(x=>x.getBoundingClientRect().left)}})()")
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

                await evaluate("(() => {const s=document.querySelector('.professional-timeline-tools select');s.value='16';s.dispatchEvent(new Event('change',{bubbles:true}));const e=document.querySelector('[aria-label=\"마디 오프셋 (1/96)\"]'),p=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;p.call(e,'1');e.dispatchEvent(new Event('input',{bubbles:true}))})()")
                initial = await evaluate("(() => {const f=document.querySelector('.professional-audio-fragment');return {left:f.style.left,width:f.style.width,next:document.querySelectorAll('.professional-audio-fragment')[1].style.left}})()")
                await drag_boundary()
                await wait_for("Number(document.querySelector('.professional-guides i').style.left.replace('%',''))>50")
                normal = await evaluate("(() => {const f=document.querySelector('.professional-audio-fragment'),g=document.querySelector('.professional-guides i'),next=document.querySelectorAll('.professional-audio-fragment')[1],scale=parseFloat(f.style.width)/1000,total=Math.round(parseFloat(f.style.width)/parseFloat(next.style.width)*1000),start=(parseFloat(f.style.left)-96)/scale,first=start+Number(g.style.left.replace('%',''))*total/100,offset=Number(document.querySelector('[aria-label=\"마디 오프셋 (1/96)\"]').value)*(60000/Number(document.querySelector('[aria-label=\"BPM\"]').value))/24,grid=60000/Number(document.querySelector('[aria-label=\"BPM\"]').value)*4/Number(document.querySelector('.professional-timeline-tools select').value);return {left:f.style.left,width:f.style.width,next:next.style.left,first,offset,grid,phase:(first-offset)/grid}})()")
                assert normal["left"] == initial["left"] and normal["width"] == initial["width"] and normal["next"] == initial["next"] and abs(normal["phase"]-round(normal["phase"])) < 0.01, f"NORMAL boundary resize changed the syllable total, another syllable, or ignored the offset grid: {initial} {normal}"

                free_before = await evaluate("(() => {const f=document.querySelector('.professional-audio-fragment'),g=document.querySelector('.professional-guides i'),n=document.querySelectorAll('.professional-audio-fragment')[1],scale=parseFloat(f.style.width)/1000,total=Math.round(parseFloat(f.style.width)/parseFloat(n.style.width)*1000);return (parseFloat(f.style.left)-96)/scale+Number(g.style.left.replace('%',''))*total/100})()")
                await drag_boundary(1, 8)
                free_after = await evaluate("(() => {const f=document.querySelector('.professional-audio-fragment'),g=document.querySelector('.professional-guides i'),n=document.querySelectorAll('.professional-audio-fragment')[1],scale=parseFloat(f.style.width)/1000,total=Math.round(parseFloat(f.style.width)/parseFloat(n.style.width)*1000);return (parseFloat(f.style.left)-96)/scale+Number(g.style.left.replace('%',''))*total/100})()")
                free_delta = free_after-free_before
                free_scale = await evaluate("parseFloat(document.querySelector('.professional-audio-fragment').style.width)/1000")
                expected_free_delta = 8/free_scale
                assert abs(free_delta-expected_free_delta) < 2 and abs(free_delta/normal["grid"]-round(free_delta/normal["grid"])) > 0.1, f"Alt drag did not preserve the free pointer delta with grid offset enabled: {free_before} -> {free_after}, expected delta {expected_free_delta}"

                await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',ctrlKey:true,bubbles:true,cancelable:true}))")
                await wait_for("Math.abs((() => {const f=document.querySelector('.professional-audio-fragment'),g=document.querySelector('.professional-guides i'),n=document.querySelectorAll('.professional-audio-fragment')[1],scale=parseFloat(f.style.width)/1000,total=Math.round(parseFloat(f.style.width)/parseFloat(n.style.width)*1000);return (parseFloat(f.style.left)-96)/scale+Number(g.style.left.replace('%',''))*total/100})()-"+str(free_before)+")<1")
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
                await evaluate("(() => {const e=document.querySelectorAll('.professional-timeline-tools input[type=number]')[2];const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,'204');e.dispatchEvent(new Event('input',{bubbles:true}))})()")
                await wait_for("document.querySelectorAll('.professional-timeline-tools input[type=number]')[2].value==='204'")
                positive_grid = await evaluate("(() => {const e=document.querySelector('.professional-grid-layer'),before=e.querySelector('.professional-grid-before'),after=e.querySelector('.professional-grid-after'),r=e.getBoundingClientRect(),scale=parseFloat(document.querySelector('.professional-audio-fragment').style.width)/1000,offset=Number(document.querySelectorAll('.professional-timeline-tools input[type=number]')[2].value)*(60000/Number(document.querySelector('[aria-label=\"BPM\"]').value))/24,bars=[...document.querySelectorAll('.professional-time-ruler span')];return {left:parseFloat(e.style.left),width:r.width,beforeWidth:parseFloat(before.style.width),afterLeft:parseFloat(after.style.left),offsetPx:offset*scale,prePhase:parseFloat(getComputedStyle(before).backgroundPositionX.split(',')[0]),labels:bars.map(x=>({text:x.textContent,left:x.style.left}))}})()")
                assert abs(positive_grid["left"]-96) < 1 and positive_grid["width"] > 0 and abs(positive_grid["beforeWidth"]-positive_grid["offsetPx"]) < 1 and abs(positive_grid["afterLeft"]-positive_grid["offsetPx"]) < 1 and abs(positive_grid["prePhase"]-positive_grid["offsetPx"]) < 1, f"Positive offset did not preserve pre-origin grid phase: {positive_grid}"
                assert positive_grid["labels"] and positive_grid["labels"][0]["text"] == "1" and all(int(label["text"]) > 0 and float(label["left"].replace("px", "")) >= positive_grid["offsetPx"]-1 for label in positive_grid["labels"]), f"Positive offset added invalid ruler labels: {positive_grid}"
                await evaluate("document.querySelector('.professional-timeline-scroll').scrollLeft=0")
                await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
                grid_screenshot = await command("Page.captureScreenshot", {"format":"png","captureBeyondViewport":True,"fromSurface":True})
                (ARTIFACT.parent / "professional-grid-positive-offset.png").write_bytes(base64.b64decode(grid_screenshot["data"]))
                await evaluate("(() => {const e=document.querySelectorAll('.professional-timeline-tools input[type=number]')[2];const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,'999999');e.dispatchEvent(new Event('input',{bubbles:true}))})()")
                await wait_for("document.querySelectorAll('.professional-timeline-tools input[type=number]')[2].value==='999999'")
                oversized_offset = await evaluate("(() => {const e=document.querySelector('.professional-grid-layer'),before=e.querySelector('.professional-grid-before'),after=e.querySelector('.professional-grid-after');return {gridWidth:e.getBoundingClientRect().width,beforeWidth:parseFloat(before.style.width),afterLeft:parseFloat(after.style.left),afterWidth:parseFloat(after.style.width),contentWidth:e.parentElement.clientWidth-96}})()")
                assert abs(oversized_offset["gridWidth"]-oversized_offset["contentWidth"]) < 1 and abs(oversized_offset["beforeWidth"]-oversized_offset["gridWidth"]) < 1 and oversized_offset["afterLeft"] > oversized_offset["gridWidth"] and oversized_offset["afterWidth"] == 0, f"Offset beyond the timeline expanded the grid region: {oversized_offset}"
                await evaluate("(() => {const e=document.querySelectorAll('.professional-timeline-tools input[type=number]')[2];const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,'204');e.dispatchEvent(new Event('input',{bubbles:true}))})()")
                await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
                before_zoom_scale = await evaluate("parseFloat(document.querySelector('.professional-audio-fragment').style.width)/1000")
                await evaluate("(() => {const e=document.querySelector('.professional-timeline-scroll'),r=e.getBoundingClientRect();e.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:true,shiftKey:true,deltaY:-80,clientX:r.left+120}))})()")
                await wait_for("Math.abs(parseFloat(document.querySelector('.professional-audio-fragment').style.width)/1000-"+str(before_zoom_scale)+")>0.001")
                zoomed_grid = await evaluate("(() => {const b=document.querySelector('.professional-grid-before'),scale=parseFloat(document.querySelector('.professional-audio-fragment').style.width)/1000,offset=Number(document.querySelectorAll('.professional-timeline-tools input[type=number]')[2].value)*(60000/Number(document.querySelector('[aria-label=\"BPM\"]').value))/24;return {phase:parseFloat(getComputedStyle(b).backgroundPositionX),expected:offset*scale,scale}})()")
                assert abs(zoomed_grid["phase"]-zoomed_grid["expected"]) < 1, f"Grid phase changed after timeline zoom: {zoomed_grid}"
                audio_positions_after_zoom = await evaluate("[...document.querySelectorAll('.professional-audio-fragment')].map(e=>e.style.left)")
                await evaluate("(() => {const e=document.querySelectorAll('.professional-timeline-tools input[type=number]')[2];const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,'0');e.dispatchEvent(new Event('input',{bubbles:true}))})()")
                await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
                zero_grid = await evaluate("(() => {const e=document.querySelector('.professional-grid-layer'),b=e.querySelector('.professional-grid-before'),a=e.querySelector('.professional-grid-after');return {beforeWidth:parseFloat(b.style.width),afterLeft:parseFloat(a.style.left),audio:[...document.querySelectorAll('.professional-audio-fragment')].map(x=>x.style.left)}})()")
                assert zero_grid["beforeWidth"] == 0 and zero_grid["afterLeft"] == 0 and zero_grid["audio"] == audio_positions_after_zoom, f"Zero offset changed grid origin or audio positions: {zero_grid}"
                await evaluate("(() => {const e=document.querySelectorAll('.professional-timeline-tools input[type=number]')[2];const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,'-12');e.dispatchEvent(new Event('input',{bubbles:true}))})()")
                await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
                negative_grid = await evaluate("(() => {const e=document.querySelector('.professional-grid-after'),s=getComputedStyle(e),offset=Number(document.querySelectorAll('.professional-timeline-tools input[type=number]')[2].value),bpm=Number(document.querySelector('[aria-label=\"BPM\"]').value),scale=parseFloat(document.querySelector('.professional-audio-fragment').style.width)/1000,offsetMs=offset*(60000/bpm)/24;return {position:s.backgroundPositionX,phase:parseFloat(s.backgroundPositionX.split(',')[0]),expectedPhase:offsetMs*scale,offset,audio:[...document.querySelectorAll('.professional-audio-fragment')].map(x=>x.style.left),labels:[...document.querySelectorAll('.professional-time-ruler span')].map(x=>x.textContent)}})()")
                assert negative_grid["offset"] == -12 and abs(negative_grid["phase"]-negative_grid["expectedPhase"]) < 1 and all(int(label) > 0 for label in negative_grid["labels"]), f"Negative grid phase or ruler labels are incorrect: {negative_grid}"
                assert negative_grid["audio"] == audio_positions_after_zoom, f"Grid offset moved audio fragments: {negative_grid}"
                await evaluate("(() => {const e=document.querySelectorAll('.professional-timeline-tools input[type=number]')[2];const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,'12');e.dispatchEvent(new Event('input',{bubbles:true}))})()")
                await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
                await scroll_to_fragment('.professional-audio-fragment:first-of-type')
                await evaluate("(() => {const e=document.querySelector('.professional-timeline-scroll');e.scrollLeft=Math.max(0,(e.scrollWidth-e.clientWidth)/2)})()")
                await evaluate("window.__editorBeforeFirstSave=document.querySelector('.professional-editor');true")
                first_save_view = await evaluate("(() => ({width:document.querySelector('.professional-audio-fragment').style.width,scrollLeft:document.querySelector('.professional-timeline-scroll').scrollLeft}))()")
                await command("Runtime.evaluate", {"expression":"document.querySelector('.professional-actions .primary-action').click()"})
                await wait_for("document.body.innerText.includes('saved')", timeout=5)
                assert len(saved_requests) == 1, f"Save request was not captured: {request_log}"
                after_first_save = await evaluate("(() => ({sameEditor:window.__editorBeforeFirstSave===document.querySelector('.professional-editor'),width:document.querySelector('.professional-audio-fragment').style.width,scrollLeft:document.querySelector('.professional-timeline-scroll').scrollLeft}))()")
                assert after_first_save["sameEditor"], "First save replaced the timeline editor DOM"
                assert after_first_save["width"] == first_save_view["width"], f"First save reset timeline zoom: {first_save_view} -> {after_first_save}"
                assert abs(after_first_save["scrollLeft"] - first_save_view["scrollLeft"]) <= 1, f"First save reset timeline scroll: {first_save_view} -> {after_first_save}"
                saved = saved_requests[0]
                assert saved["tempo_bpm"] == 137 and saved["beat_division"] == 24 and saved["grid_offset_units"] == 12, f"Beat display settings did not persist: {saved}"
                assert saved["segments"][0]["timeline_start_ms"] > 0 and saved["segments"][0]["gap_before_ms"] > 0, f"First fragment movement was not saved: {saved['segments'][0]}"
                saved_regions = saved["segments"][0]["edit_regions"]
                saved_timeline_duration = saved["segments"][0]["timeline_end_ms"] - saved["segments"][0]["timeline_start_ms"]
                assert len(saved_regions) >= 2 and all(region["output_duration_ms"] > 0 for region in saved_regions), f"Edited timing regions were not saved: {saved_regions}"
                assert sum(region["output_duration_ms"] for region in saved_regions) == saved_timeline_duration, f"Saved timing regions do not cover the segment: {saved_regions} / {saved_timeline_duration}"
                saved_duration_ratio = await evaluate("(() => {const e=[...document.querySelectorAll('.professional-audio-fragment')];return parseFloat(e[0].style.width)/parseFloat(e[1].style.width)})()")
                footer = await evaluate("(() => {const e=document.querySelector('.professional-actions .primary-action');const r=e.getBoundingClientRect();return {visible:r.width>0&&r.height>0&&r.bottom<=innerHeight,disabled:e.disabled}})()")
                assert footer["visible"] and not footer["disabled"], f"Save control is unreachable: {footer}"
                await evaluate("(() => {const s=document.querySelectorAll('.professional-file-controls select')[0];s.value='parent';s.dispatchEvent(new Event('change',{bubbles:true}))})()")
                await wait_for("document.querySelector('.professional-timeline-tools input[type=number]').value==='120'")
                draft = await evaluate("(() => ({composition:document.querySelectorAll('.professional-file-controls select')[1].value,tempo:document.querySelector('.professional-timeline-tools input[type=number]').value,regions:document.querySelectorAll('.professional-audio-fragment')[0].querySelectorAll('.professional-guides i').length}))()")
                assert draft["composition"] == "" and draft["tempo"] == "120" and draft["regions"] >= 1, f"Parent selection did not reset the draft: {draft}"
                await evaluate("(() => {const s=document.querySelectorAll('.professional-file-controls select')[1];s.value='saved';s.dispatchEvent(new Event('change',{bubbles:true}))})()")
                await wait_for("document.querySelector('.professional-timeline-tools input[type=number]').value==='137' && document.querySelector('.professional-timeline-tools select').value==='24' && document.querySelector('[aria-label=\\\"마디 오프셋 (1/96)\\\"]').value==='12'")
                reopened = await evaluate("(() => {const f=document.querySelector('.professional-audio-fragment');return {width:f.style.width,regions:f.querySelectorAll('.professional-guides i').length}})()")
                assert float(reopened["width"].replace("px","")) > 0 and reopened["regions"] >= 1, f"Reopened editor lost duration or guide state: {reopened}"
                reopened_duration_ratio = await evaluate("(() => {const e=[...document.querySelectorAll('.professional-audio-fragment')];return parseFloat(e[0].style.width)/parseFloat(e[1].style.width)})()")
                assert abs(reopened_duration_ratio - saved_duration_ratio) < 0.001, f"Reopened editor lost saved duration ratio: {saved_duration_ratio} -> {reopened_duration_ratio}"
                assert reopened["regions"] >= 1, f"Reopened editor lost timing guide state: {reopened}"
                screenshot = await command("Page.captureScreenshot", {"format":"png","captureBeyondViewport":True,"fromSurface":True})
                ARTIFACT.write_bytes(base64.b64decode(screenshot["data"]))
                print(json.dumps({"status":"passed","initial_scroll_width":initial["width"],"save_fields":["tempo_bpm","beat_division","grid_offset_units","edit_regions"],"first_save_preserved_zoom_scroll_dom":True,"focused_ctrl_s_update":True,"screenshot":str(ARTIFACT)},ensure_ascii=False))
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
    parser = argparse.ArgumentParser()
    parser.add_argument("--save-shortcuts", action="store_true")
    parser.add_argument("--piano-roll", action="store_true")
    parser.add_argument("--region-pitch", action="store_true")
    parser.add_argument("--region-first-drag", action="store_true")
    args = parser.parse_args()
    asyncio.run(asyncio.wait_for(run_smoke(save_shortcuts=args.save_shortcuts, piano_roll=args.piano_roll, region_pitch=args.region_pitch, region_first_drag=args.region_first_drag), timeout=45))
