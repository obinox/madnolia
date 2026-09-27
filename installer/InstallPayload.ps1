param(
    [Parameter(Mandatory = $true)][string]$DownloadDirectory,
    [Parameter(Mandatory = $true)][string]$Destination
)

$ErrorActionPreference = 'Stop'
try {
    $manifest = Get-Content -LiteralPath (Join-Path $DownloadDirectory 'payload.json') -Raw | ConvertFrom-Json
    $archivePath = Join-Path $DownloadDirectory 'application.zip'
    $archiveStream = [System.IO.File]::Create($archivePath)
    try {
        foreach ($part in $manifest.parts) {
            if ($part.name -notmatch '^Madnolia-windows-x64\.part\d{3}$') { throw 'Invalid payload name' }
            $partPath = Join-Path $DownloadDirectory $part.name
            $sha256 = [System.Security.Cryptography.SHA256]::Create()
            try {
                $partStream = [System.IO.File]::OpenRead($partPath)
                try {
                    $actualHash = [BitConverter]::ToString($sha256.ComputeHash($partStream)).Replace('-', '').ToLowerInvariant()
                } finally { $partStream.Dispose() }
            } finally {
                $sha256.Dispose()
            }
            if ($actualHash -ne $part.sha256) {
                throw "Checksum mismatch: $($part.name)"
            }
            $partStream = [System.IO.File]::OpenRead($partPath)
            try { $partStream.CopyTo($archiveStream) } finally { $partStream.Dispose() }
        }
    } finally { $archiveStream.Dispose() }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $destinationRoot = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
    $runtimePath = [System.IO.Path]::GetFullPath((Join-Path $destinationRoot 'runtime'))
    $stagingPath = [System.IO.Path]::GetFullPath((Join-Path $destinationRoot 'runtime.pending'))
    $backupPath = [System.IO.Path]::GetFullPath((Join-Path $destinationRoot 'runtime.previous'))
    foreach ($path in @($runtimePath, $stagingPath, $backupPath)) {
        if (-not $path.StartsWith($destinationRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Unsafe application directory'
        }
    }
    foreach ($process in Get-Process Madnolia, MadnoliaLauncher -ErrorAction SilentlyContinue) {
        if ($process.Path -and $process.Path.StartsWith($runtimePath + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Madnolia is running. Close Madnolia and try again.'
        }
    }
    if ((Test-Path -LiteralPath $backupPath) -and -not (Test-Path -LiteralPath $runtimePath)) {
        Move-Item -LiteralPath $backupPath -Destination $runtimePath
    }
    if (Test-Path -LiteralPath $stagingPath) { Remove-Item -LiteralPath $stagingPath -Recurse -Force }
    $stagingRoot = $stagingPath + '\'
    $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        foreach ($entry in $archive.Entries) {
            $entryPath = [System.IO.Path]::GetFullPath((Join-Path $stagingRoot $entry.FullName))
            if (-not $entryPath.StartsWith($stagingRoot, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Archive contains an unsafe path'
            }
        }
    } finally { $archive.Dispose() }
    [System.IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $stagingPath)
    foreach ($required in @('Madnolia.exe', 'MadnoliaLauncher.exe', 'web\dist\index.html')) {
        if (-not (Test-Path -LiteralPath (Join-Path $stagingPath $required) -PathType Leaf)) {
            throw "Application file missing: $required"
        }
    }
    [System.IO.File]::WriteAllText((Join-Path $stagingPath 'installed.marker'), $manifest.version)
    if (Test-Path -LiteralPath $backupPath) { Remove-Item -LiteralPath $backupPath -Recurse -Force }
    if (Test-Path -LiteralPath $runtimePath) { Move-Item -LiteralPath $runtimePath -Destination $backupPath }
    try {
        Move-Item -LiteralPath $stagingPath -Destination $runtimePath
    } catch {
        if (Test-Path -LiteralPath $backupPath) { Move-Item -LiteralPath $backupPath -Destination $runtimePath }
        throw
    }
    if (Test-Path -LiteralPath $backupPath) { Remove-Item -LiteralPath $backupPath -Recurse -Force -ErrorAction SilentlyContinue }
    exit 0
} catch {
    $errorDetails = $_ | Out-String
    $errorDetails | Set-Content -LiteralPath (Join-Path $DownloadDirectory 'install-error.txt') -Encoding UTF8
    [Console]::Error.WriteLine($errorDetails)
    exit 1
}
