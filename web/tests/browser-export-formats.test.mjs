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

const { edlText, fcpxmlText } = await import("../src/browser/exportsFormats.ts")

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
  const xml = fcpxmlText(composition, sources, 30, 1280, 720)
  assert.match(xml, /<asset\b[^>]*>/)
  assert.match(xml, /<media-rep kind="original-media" src="madnolia-relink:\/\/src%201\/%E9%9F%B3%E5%A3%B0%20clip\.mov"\/>/)
  assert.match(xml, /<asset-clip\b[^>]*><timeMap><timept[^>]+\/><timept[^>]+\/><\/timeMap><\/asset-clip>/)
  assert.match(xml, /name="Cafe &amp; &lt;cut&gt;"/)
  assert.match(xml, /name="seg&amp;1"/)
  assert.doesNotMatch(xml, /file:\/\/|C:\\\\private/)
  assert.match(xml, /version="1\.10"/)
})

test("EDL uses one project frame rate and records source speed for stretched clips", () => {
  const edl = edlText(composition, sources, 30)
  assert.match(edl, /FCM: NON-DROP FRAME/)
  assert.match(edl, /001\s+音声 CLIP\s+V\s+C\s+00:00:01:00 00:00:03:00 00:00:00:05 00:00:01:05/)
  assert.match(edl, /\* SOURCE SPEED: 0\.500000x/)
  assert.match(edl, /\* FROM CLIP NAME: 音声 clip\.mov/)
})
