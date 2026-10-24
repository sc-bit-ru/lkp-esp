$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
$version = $manifest.version
$outDir = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$zip = Join-Path $outDir "lkp-esp-$version.zip"
if (Test-Path $zip) { Remove-Item $zip }
$files = @(
  'manifest.json',
  'lib.js',
  'hook.js',
  'bridge.js',
  'background.js',
  'popup.html',
  'popup.js',
  'options.html',
  'options.js',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png'
)
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [System.IO.File]::Open($zip, 'Create')
$archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($rel in $files) {
    $entry = $archive.CreateEntry($rel.Replace('\', '/'))
    $source = [System.IO.File]::OpenRead((Join-Path $root $rel))
    try {
      $output = $entry.Open()
      try { $source.CopyTo($output) } finally { $output.Dispose() }
    } finally { $source.Dispose() }
  }
} finally {
  $archive.Dispose()
  $stream.Dispose()
}
Write-Output $zip
