import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { registerHooks } from "node:module"
import { resolve } from "node:path"
import test from "node:test"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/iu.test(specifier)) {
      try { return nextResolve(`${specifier}.ts`, context) } catch {}
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".ts")) {
      return nextLoad(url, context)
    }
    return nextLoad(url, context)
  },
})

const { hubertLinspaceSeeds } = await import("../src/browser/hubertClustering.ts")
const fixture = JSON.parse(await readFile(new URL("./fixtures/hubert-linspace-reference.json", import.meta.url), "utf8"))

test("HuBERT centroid seed indices match NumPy linspace for over 64 vectors", () => {
  const { vector_count: vectorCount, cluster_count: clusterCount } = fixture
  const actual = hubertLinspaceSeeds(vectorCount, clusterCount)
  assert.equal(fixture.source, "legacy/python:src/madnolia/acoustic_units.py")
  assert.equal(fixture.source_commit, "f9ff39cd4d60d3c4dcd2e79c3f1b7bb919a416cd")
  assert.deepEqual(actual, fixture.indices)
  const virtualenvPython = process.platform === "win32" ? resolve("../.venv/Scripts/python.exe") : resolve("../.venv/bin/python")
  const candidates = [...new Set([process.env.PYTHON_EXE, virtualenvPython, "python", "python3"].filter(Boolean))]
  for (const python of candidates) {
    const oracle = spawnSync(python, ["-c", "import json,numpy as np,sys; print(json.dumps(np.linspace(0,int(sys.argv[1])-1,num=int(sys.argv[2]),dtype=int).tolist()))", String(vectorCount), String(clusterCount)], { encoding: "utf8" })
    if (oracle.status === 0) {
      assert.deepEqual(actual, JSON.parse(oracle.stdout))
      break
    }
  }
})
