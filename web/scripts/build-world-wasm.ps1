param([string]$EmsdkRoot = "")

$ErrorActionPreference = "Stop"
$webRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repoRoot = (Resolve-Path (Join-Path $webRoot "..")).Path
if (-not $EmsdkRoot) {
  if ($env:EMSDK) { $EmsdkRoot = $env:EMSDK }
  else { $EmsdkRoot = Join-Path $webRoot ".cache\emsdk" }
}
$EmsdkRoot = (Resolve-Path $EmsdkRoot).Path
$emxx = Join-Path $EmsdkRoot "upstream\emscripten\em++.bat"
if (-not (Test-Path $emxx)) { throw "Emscripten not found at $EmsdkRoot. Set EMSDK or pass -EmsdkRoot." }

$env:EMSDK = $EmsdkRoot.Replace("\", "/")
$nodeExe = Get-ChildItem (Join-Path $EmsdkRoot "node") -Filter "node.exe" -Recurse | Select-Object -First 1
$pythonExe = Get-ChildItem (Join-Path $EmsdkRoot "python") -Filter "python.exe" -Recurse | Select-Object -First 1
if (-not $nodeExe -or -not $pythonExe) { throw "Could not locate Emscripten's bundled Node and Python runtimes." }
$env:EMSDK_NODE = $nodeExe.FullName
$env:EMSDK_PYTHON = $pythonExe.FullName
$env:TEMP = Join-Path $webRoot ".cache\tmp"
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force $env:TEMP | Out-Null
$env:PATH = "$EmsdkRoot;$EmsdkRoot\upstream\emscripten;$env:PATH"

$worldRoot = Join-Path $webRoot "third_party\world"
$outputRoot = Join-Path $webRoot "public\wasm"
New-Item -ItemType Directory -Force $outputRoot | Out-Null
$sources = Get-ChildItem (Join-Path $worldRoot "src") -Filter "*.cpp" | ForEach-Object { $_.FullName }
$sources += Join-Path $PSScriptRoot "..\src\world\world_wrapper.cpp"
$output = Join-Path $outputRoot "world.js"
$exports = "['_malloc','_free','_world_dimensions','_world_analyze_f0','_world_analyze','_world_synthesize']"
$runtimeExports = "['HEAP32','HEAPF64']"

& $emxx @sources -I (Join-Path $worldRoot "src") -O3 -std=c++11 -fno-exceptions -sWASM=1 -sMODULARIZE=1 -sEXPORT_ES6=1 '-sENVIRONMENT=web,worker,node' -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=134217728 -sMAXIMUM_MEMORY=1073741824 -sSTACK_SIZE=1048576 "-sEXPORTED_FUNCTIONS=$exports" "-sEXPORTED_RUNTIME_METHODS=$runtimeExports" -o $output
if ($LASTEXITCODE -ne 0) { throw "WORLD WASM compilation failed with exit code $LASTEXITCODE" }
Copy-Item -LiteralPath (Join-Path $worldRoot "LICENSE.txt") -Destination (Join-Path $outputRoot "WORLD-LICENSE.txt") -Force
