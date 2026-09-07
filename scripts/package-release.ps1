param([string]$Name = 'us-command-astra-v2')
$ErrorActionPreference = 'Stop'
if ($Name -notmatch '^[a-z0-9-]+$') { throw 'Invalid release name' }
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$roots = @('astra','frontend/src','frontend/test','test','tests_astra','scripts','docs')
$paths = @(
  '.dockerignore','.env.example','.gitignore','.node-version','ASTRA_CONTRACT.md',
  'Dockerfile','README.md','astra-bridge.js','index.html','manifest.json','market-data.js',
  'package.json','package-lock.json','render.yaml','render-astra.yaml','run_astra.py',
  'requirements.txt','requirements-dev.txt','requirements-lock.txt','server.js','sw.js',
  'technical-signals.js','icon-192.png','icon-512.png','og.png','og-v12.png',
  'og-v14-technical-signals.png','frontend/index.html','frontend/package.json',
  'frontend/package-lock.json','frontend/vite.config.js'
)
foreach ($directory in $roots) {
  $absolute = [IO.Path]::GetFullPath((Join-Path $root $directory))
  if (-not $absolute.StartsWith($root + [IO.Path]::DirectorySeparatorChar)) { throw 'Invalid source root' }
  foreach ($file in Get-ChildItem -LiteralPath $absolute -Recurse -File) {
    $relative = [IO.Path]::GetRelativePath($root, $file.FullName).Replace('\','/')
    if ($relative -notmatch '(^|/)(__pycache__|node_modules|dist|\.pytest_cache)(/|$)' -and $file.Extension -ne '.pyc') {
      $paths += $relative
    }
  }
}
$paths = @($paths | Sort-Object -Unique)
$manifest = @()
foreach ($relative in $paths) {
  if ($relative -match '(^|/)(\.env$|\.git/|data/|artifacts/)|\.(sqlite3|db|log)(-|$)') { throw "Forbidden release path: $relative" }
  $full = [IO.Path]::GetFullPath((Join-Path $root $relative))
  if (-not $full.StartsWith($root + [IO.Path]::DirectorySeparatorChar)) { throw 'Escaping path' }
  $bytes = [IO.File]::ReadAllBytes($full)
  if ([IO.Path]::GetExtension($full) -ne '.png') {
    $text = [Text.Encoding]::UTF8.GetString($bytes)
    if ($text -match 'sk-(proj-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----') {
      throw "Potential credential found in $relative; release stopped"
    }
  }
  $prefix = [Text.Encoding]::UTF8.GetBytes("blob $($bytes.Length)" + [char]0)
  $blobBytes = New-Object byte[] ($prefix.Length + $bytes.Length)
  [Array]::Copy($prefix, 0, $blobBytes, 0, $prefix.Length)
  [Array]::Copy($bytes, 0, $blobBytes, $prefix.Length, $bytes.Length)
  $manifest += [ordered]@{path=$relative;bytes=$bytes.Length;
    sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLower();
    git_blob=[Convert]::ToHexString([Security.Cryptography.SHA1]::HashData($blobBytes)).ToLower()}
}
$out = Join-Path $root 'artifacts'
[IO.Directory]::CreateDirectory($out) | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$zipPath = Join-Path $out "$Name-$stamp.zip"
$stream = [IO.File]::Open($zipPath, [IO.FileMode]::CreateNew)
$archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($item in $manifest) {
    $entry = $archive.CreateEntry($item.path, [IO.Compression.CompressionLevel]::Optimal)
    $target = $entry.Open()
    try {
      $bytes = [IO.File]::ReadAllBytes((Join-Path $root $item.path))
      $target.Write($bytes, 0, $bytes.Length)
    } finally { $target.Dispose() }
  }
} finally { $archive.Dispose(); $stream.Dispose() }
$manifestPath = Join-Path $out 'release-manifest.json'
[IO.File]::WriteAllText($manifestPath, (ConvertTo-Json -Depth 4 -InputObject $manifest), [Text.UTF8Encoding]::new($false))
$check = [IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  if ($check.Entries.Count -ne $manifest.Count) { throw 'Archive count mismatch' }
  foreach ($item in $manifest) {
    $entry = $check.GetEntry($item.path)
    if (-not $entry -or $entry.Length -ne $item.bytes) { throw 'Archive size mismatch' }
    $input = $entry.Open()
    try { $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($input)).ToLower() }
    finally { $input.Dispose() }
    if ($hash -ne $item.sha256) { throw 'Archive checksum mismatch' }
  }
} finally { $check.Dispose() }
[ordered]@{zip=$zipPath;files=$manifest.Count;bytes=(Get-Item -LiteralPath $zipPath).Length;
  sha256=(Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLower();manifest=$manifestPath} | ConvertTo-Json
