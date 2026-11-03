import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import test from "node:test"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try { return nextResolve(`${specifier}.ts`, context) } catch {}
    }
    return nextResolve(specifier, context)
  },
})

const { browserVideoBaseInputArgs, browserVideoEncoderArgs, browserVideoScalePadFilter, edlText, fcpxmlText, sourceAnalysisRecordId } = await import("../src/browser/exportsFormats.ts")
const { backfillAnalysisRecordVideoMetadata, getOrProbeSourceVideoMetadata, mergeProbedVideoMetadata, probeOptionalSourceVideoMetadata, resolveBrowserVideoOutputSpec } = await import("../src/browser/videoMetadata.ts")

const composition = {
  composition_id: "c1", corpus_project_id: "p1", name: "Cafe & <cut>", crossfade_ms: 0,
  segments: [{
    segment_id: "seg&1", source_id: "src 1", timeline_start_ms: 200, timeline_end_ms: 1200,
    source_start_ms: 1000, source_end_ms: 3000, crossfade_ms: 0, edit_regions: [],
    phone_units: [],
  }],
}
const source = {
  sourceId: "src 1", audio: { samples: new Float32Array(), sampleRate: 48000 }, media: new File(["media"], "音声 clip.mov"),
  mediaPath: "C:\\private\\folder\\音声 clip.mov",
  source: { source_id: "src 1", path: "C:\\private\\folder\\音声 clip.mov", duration_ms: 10000, video_fps: 25, video_width: 1920, video_height: 1080 },
}
const sources = new Map([["src 1", source]])

test("FCPXML uses media-rep, a portable relink URI, XML escaping, and a retime map", () => {
  const xml = fcpxmlText(composition, sources, resolveBrowserVideoOutputSpec(source.source))
  assert.match(xml, /<asset\b[^>]*>/)
  assert.match(xml, /<media-rep kind="original-media" src="madnolia-relink:\/\/src%201\/%E9%9F%B3%E5%A3%B0%20clip\.mov"\/>/)
  assert.match(xml, /<asset-clip\b[^>]*><timeMap><timept[^>]+\/><timept[^>]+\/><\/timeMap><\/asset-clip>/)
  assert.match(xml, /name="Cafe &amp; &lt;cut&gt;"/)
  assert.match(xml, /name="seg&amp;1"/)
  assert.doesNotMatch(xml, /file:\/\/|C:\\\\private/)
  assert.match(xml, /version="1\.10"/)
})

test("EDL uses one project frame rate and records source speed for stretched clips", () => {
  const edl = edlText(composition, sources, resolveBrowserVideoOutputSpec(source.source))
  assert.match(edl, /FCM: NON-DROP FRAME/)
  assert.match(edl, /001\s+音声 CLIP\s+V\s+C\s+00:00:01:00 00:00:03:00 00:00:00:05 00:00:01:05/)
  assert.match(edl, /\* SOURCE SPEED: 0\.500000x/)
  assert.match(edl, /\* FROM CLIP NAME: 音声 clip\.mov/)
})

test("one resolved source specification drives MP4 input, canvas, and edit metadata", () => {
  const spec = resolveBrowserVideoOutputSpec({ video_width: 1920, video_height: 1080, video_fps: 24 })
  assert.deepEqual(spec, { width: 1920, height: 1080, fps: 24, sourceWidth: 1920, sourceHeight: 1080, sourceFps: 24 })
  assert.deepEqual(browserVideoBaseInputArgs(spec, 10), ["-f", "lavfi", "-i", "color=c=black:s=1920x1080:r=24:d=10"])
  assert.equal(browserVideoScalePadFilter(spec), "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2")
  assert.deepEqual(browserVideoEncoderArgs(spec), ["-r", "24", "-c:v", "libx264", "-threads:v", "1", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p"])
  assert.match(fcpxmlText(composition, sources, spec), /frameDuration="1\/24s" width="1920" height="1080"/)
  assert.match(edlText(composition, sources, spec), /00:00:01:00 00:00:03:00/)
})

test("odd source dimensions pad to even output without scaling to the padded size", () => {
  const spec = resolveBrowserVideoOutputSpec({ video_width: 1919, video_height: 1079, video_fps: 24 })
  assert.deepEqual(spec, { width: 1920, height: 1080, fps: 24, sourceWidth: 1919, sourceHeight: 1079, sourceFps: 24 })
  assert.equal(browserVideoScalePadFilter(spec), "scale=1919:1079:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2")
})

test("source analysis mapping takes precedence over analysis order and fallback matches source id", () => {
  const records = new Map([
    ["a2", { source: { source_id: "src 1" } }],
    ["a1", { source: { source_id: "other" } }],
  ])
  assert.equal(sourceAnalysisRecordId("src 1", { "src 1": "a1" }, ["a1", "a2"], records), "a1")
  assert.equal(sourceAnalysisRecordId("src 1", {}, ["a1", "a2"], records), "a2")
  assert.equal(sourceAnalysisRecordId("missing", {}, ["a1", "a2"], records), null)
})

test("source fps precision is retained while the output fps follows Python rounding", () => {
  assert.equal(resolveBrowserVideoOutputSpec({ video_width: 1920, video_height: 1080, video_fps: 60 }).fps, 60)
  assert.equal(resolveBrowserVideoOutputSpec({ video_width: 1920, video_height: 1080, video_fps: 29.97 }).fps, 30)
  assert.equal(resolveBrowserVideoOutputSpec({ video_width: 1920, video_height: 1080, video_fps: 24.5 }).fps, 24)
  assert.equal(resolveBrowserVideoOutputSpec({ video_width: 1920, video_height: 1080, video_fps: 23.5 }).fps, 24)
  assert.equal(resolveBrowserVideoOutputSpec({ video_width: 1919, video_height: 1079, video_fps: 23.976 }).sourceFps, 23.976)
  assert.deepEqual(resolveBrowserVideoOutputSpec({ video_width: 1919, video_height: 1079, video_fps: 23.976 }), {
    width: 1920, height: 1080, fps: 24, sourceWidth: 1919, sourceHeight: 1079, sourceFps: 23.976,
  })
})

test("metadata parser accepts rational FPS and rejects ambiguous or invalid stream logs", async () => {
  const { parseFfmpegVideoMetadata } = await import("../src/browser/videoMetadata.ts")
  assert.deepEqual(parseFfmpegVideoMetadata("Stream #0:0(eng): Video: h264, yuv420p, 1920x1080, 24000/1001 fps, 24 tbr"), {
    width: 1920, height: 1080, fps: 24000 / 1001,
  })
  assert.equal(parseFfmpegVideoMetadata("Stream #0:0: Video: h264, 1920x1080, 30 tbr"), null)
  assert.equal(parseFfmpegVideoMetadata("Stream #0:0: Video: h264, 0x1080, 0 fps"), null)
})

test("legacy missing fps is probed and backfilled without changing known source metadata", async () => {
  const probed = await getOrProbeSourceVideoMetadata(new File(["source"], "source.mp4"), {
    runProbe: async () => "Stream #0:0: Video: h264, yuv420p, 1920x1080, 24000/1001 fps, 24 tbr",
  })
  assert.deepEqual(probed, { width: 1920, height: 1080, fps: 24000 / 1001 })
  const backfilled = mergeProbedVideoMetadata({ video_width: 1920, video_height: 1080, video_fps: null }, probed)
  assert.deepEqual(backfilled, { video_width: 1920, video_height: 1080, video_fps: 24000 / 1001 })
  assert.equal(resolveBrowserVideoOutputSpec(backfilled).fps, 24)
  assert.deepEqual(mergeProbedVideoMetadata({ video_width: 1280, video_height: 720, video_fps: 60 }, probed), {
    video_width: 1280, video_height: 720, video_fps: 60,
  })
})

test("metadata backfill keeps analysis source and summary source consistent", () => {
  const record = {
    source: { source_id: "src 1", video_width: 1920, video_height: 1080, video_fps: null },
    summary: { source: { source_id: "src 1", video_width: 1920, video_height: 1080, video_fps: null } },
  }
  backfillAnalysisRecordVideoMetadata(record, { width: 1920, height: 1080, fps: 25 })
  assert.deepEqual(record.summary.source, record.source)
  assert.equal(record.summary.source.video_fps, 25)
})

test("unknown source metadata uses the original browser export fallback", () => {
  const spec = resolveBrowserVideoOutputSpec({ video_width: null, video_height: null, video_fps: null })
  assert.equal(spec.width, 1280)
  assert.equal(spec.height, 720)
  assert.equal(spec.fps, 30)
})

test("optional metadata probing falls back for missing media and skips audio-only text exports", async () => {
  let probes = 0
  const runProbe = async () => {
    probes += 1
    return "Stream #0:0: Video: h264, 1280x720, 30 fps"
  }
  assert.equal(await probeOptionalSourceVideoMetadata(null, { runProbe }, true), null)
  assert.equal(await probeOptionalSourceVideoMetadata(new File(["audio"], "voice.wav", { type: "audio/wav" }), { runProbe }, true), null)
  assert.equal(probes, 0)
  assert.deepEqual(resolveBrowserVideoOutputSpec(null), {
    width: 1280, height: 720, fps: 30, sourceWidth: null, sourceHeight: null, sourceFps: null,
  })
  await assert.rejects(
    probeOptionalSourceVideoMetadata(new File(["broken"], "video.mp4"), { runProbe: async () => { throw new Error("ffmpeg failed") } }, true),
    /ffmpeg failed/,
  )
})

test("empty EDL and FCPXML compositions fail with a clear message", () => {
  const empty = { ...composition, segments: [] }
  const spec = resolveBrowserVideoOutputSpec(null)
  assert.throws(() => edlText(empty, sources, spec), /at least one video clip/)
  assert.throws(() => fcpxmlText(empty, sources, spec), /at least one video clip/)
})
