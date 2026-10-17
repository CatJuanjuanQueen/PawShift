param([string]$Name = '')
$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Get-ArchiveHash([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    $hash = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hash.Dispose() }
}
$package = Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Unsupported package version' }
$now = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, 'China Standard Time')
if (-not $Name) { $Name = 'PawShift-' + $version + '-' + $now.ToString('yyyyMMdd-HHmmss') }
if ($Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$') { throw 'Use a simple archive directory name' }
$archiveParent = Join-Path $taskRoot 'archives'
$finalRoot = [System.IO.Path]::GetFullPath((Join-Path $archiveParent $Name))
if ((Split-Path -Parent $finalRoot) -ne $archiveParent) { throw 'Archive must stay inside the project archives directory' }
$archiveRoot = Join-Path $taskRoot ('.build/archive-staging/' + $Name)
$zipPath = $finalRoot + '.zip'
if ((Test-Path -LiteralPath $finalRoot) -or (Test-Path -LiteralPath $zipPath) -or (Test-Path -LiteralPath $archiveRoot)) { throw 'Archive already exists; choose a new name' }

$releaseRelative = 'release-webview2/PawShift-' + $version
$releaseSource = Join-Path $taskRoot $releaseRelative
if (-not (Test-Path -LiteralPath (Join-Path $releaseSource 'PawShift.exe'))) { throw 'Build the current release first: npm run package:dir' }
$folders = @('src', 'ui', 'native', 'scripts', 'test', 'docs', '.github')
$files = @('.gitignore', '.gitattributes', '.editorconfig', '.prettierrc.json', '.prettierignore', 'CONTRIBUTING.md', 'LICENSE', 'NOTICE', 'package.json', 'package-lock.json', 'tsconfig.json')
$launcher = -join @([char]0x542F, [char]0x52A8, 'PawShift.cmd')
$files += $launcher
$sources = @($folders) + @($files) + @($releaseRelative)
foreach ($relative in $sources) {
    $sourcePath = Join-Path $taskRoot $relative
    if (-not (Test-Path -LiteralPath $sourcePath)) { throw "Missing archive input: $relative" }
    $items = @(Get-Item -LiteralPath $sourcePath -Force)
    if (Test-Path -LiteralPath $sourcePath -PathType Container) { $items += @(Get-ChildItem -LiteralPath $sourcePath -Recurse -Force) }
    if ($items | Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint }) { throw "Reparse points are not included: $relative" }
    if ($items | Where-Object { -not $_.PSIsContainer -and ($_.Name -match '(?i)(\.db($|[-.])|\.sqlite($|[-.])|^\.env($|\.)|^auth\.json$)') }) { throw "Personal or environment data found in archive inputs: $relative" }
}

New-Item -ItemType Directory -Path $archiveRoot -Force | Out-Null
New-Item -ItemType Directory -Path $archiveParent -Force | Out-Null
foreach ($relative in $folders) { Copy-Item -LiteralPath (Join-Path $taskRoot $relative) -Destination $archiveRoot -Recurse -Force }
foreach ($relative in $files) { Copy-Item -LiteralPath (Join-Path $taskRoot $relative) -Destination $archiveRoot -Force }
New-Item -ItemType Directory -Path (Join-Path $archiveRoot 'release-webview2') | Out-Null
Copy-Item -LiteralPath $releaseSource -Destination (Join-Path $archiveRoot 'release-webview2') -Recurse -Force
$projectReadme = Join-Path $taskRoot 'docs/PROJECT-README.MD'
if (-not (Test-Path -LiteralPath $projectReadme)) { $projectReadme = Join-Path $taskRoot 'README.MD' }
Copy-Item -LiteralPath $projectReadme -Destination (Join-Path $archiveRoot 'docs/PROJECT-README.MD') -Force

$baselinePath = Join-Path $archiveRoot 'docs/verification.json'
$baselineSummary = $null
$unitTests = $nativeTests = $desktopChecks = 'not recorded'
if (Test-Path -LiteralPath $baselinePath) {
    $baseline = Get-Content -LiteralPath $baselinePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$baseline.version -ne $version) { throw 'Verification report version does not match the current package' }
    $unitTests = [string]$baseline.unitTests.passed
    $nativeTests = [string]$baseline.nativeBridge.cases
    $desktopChecks = [string]$baseline.desktopLegacyResume.checks.Count
    $baselineSummary = [ordered]@{ report = 'docs/verification.json'; checkedAt = $baseline.checkedAt; unitTestsPassed = $baseline.unitTests.passed; nativeCases = $baseline.nativeBridge.cases; desktopChecks = $baseline.desktopLegacyResume.checks.Count }
}
$readme = Get-Content -LiteralPath (Join-Path $archiveRoot 'docs/ARCHIVE-README.MD') -Raw -Encoding UTF8
$readme = $readme.Replace('{{VERSION}}', $version).Replace('{{ARCHIVED_AT}}', $now.ToString('yyyy-MM-dd HH:mm:ss')).Replace('{{ARCHIVE_NAME}}', $Name)
$readme = $readme.Replace('{{UNIT_TESTS}}', $unitTests).Replace('{{NATIVE_TESTS}}', $nativeTests).Replace('{{DESKTOP_CHECKS}}', $desktopChecks)
if ($readme -match '\{\{[A-Z_]+\}\}') { throw 'Unresolved README placeholder' }
[System.IO.File]::WriteAllText((Join-Path $archiveRoot 'README.MD'), $readme, $utf8)

$records = @(foreach ($file in Get-ChildItem -LiteralPath $archiveRoot -Recurse -File -Force | Sort-Object FullName) {
    $relative = $file.FullName.Substring($archiveRoot.Length + 1).Replace('\', '/')
    [ordered]@{ path = $relative; bytes = $file.Length; sha256 = Get-ArchiveHash $file.FullName }
})
$manifest = [ordered]@{
    archive = $Name; version = $version; archivedAt = $now.ToString('yyyy-MM-ddTHH:mm:ss') + '+08:00'
    included = @($sources) + @('README.MD', 'docs/PROJECT-README.MD')
    excluded = @('node_modules/', 'dist/', '.build/', 'backups/', 'archives/', 'old release versions and duplicate release ZIPs', 'personal databases, credentials and AGENT sessions')
    baseline = $baselineSummary
    files = $records
}
[System.IO.File]::WriteAllText((Join-Path $archiveRoot 'MANIFEST.json'), ($manifest | ConvertTo-Json -Depth 10), $utf8)
$sums = @(foreach ($file in Get-ChildItem -LiteralPath $archiveRoot -Recurse -File -Force | Sort-Object FullName) {
    (Get-ArchiveHash $file.FullName) + '  ' + $file.FullName.Substring($archiveRoot.Length + 1).Replace('\', '/')
})
[System.IO.File]::WriteAllText((Join-Path $archiveRoot 'SHA256SUMS.txt'), (($sums -join "`n") + "`n"), $utf8)

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($archiveRoot, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $true)
$expected = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([System.StringComparer]::Ordinal)
foreach ($file in Get-ChildItem -LiteralPath $archiveRoot -Recurse -File -Force) {
    $key = $Name + '/' + $file.FullName.Substring($archiveRoot.Length + 1).Replace('\', '/')
    $expected.Add($key, (Get-ArchiveHash $file.FullName))
}
$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
$verified = 0
try {
    foreach ($entry in $zip.Entries) {
        $key = $entry.FullName.Replace('\', '/')
        if ($key.EndsWith('/')) { continue }
        if (-not $expected.ContainsKey($key)) { throw "Unexpected ZIP entry: $key" }
        $stream = $entry.Open()
        $hash = [System.Security.Cryptography.SHA256]::Create()
        try { $actual = ([System.BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
        finally { $stream.Dispose(); $hash.Dispose() }
        if ($actual -ne $expected[$key]) { throw "ZIP content mismatch: $key" }
        $expected.Remove($key) | Out-Null
        $verified++
    }
    if ($expected.Count) { throw 'Some files are missing from the ZIP' }
}
finally { $zip.Dispose() }
$zipHash = Get-ArchiveHash $zipPath
[System.IO.File]::WriteAllText(($zipPath + '.sha256'), ($zipHash + '  ' + (Split-Path -Leaf $zipPath) + "`n"), $utf8)
Move-Item -LiteralPath $archiveRoot -Destination $finalRoot
$report = [ordered]@{ passed = $true; version = $version; archive = $zipPath; readme = Join-Path $finalRoot 'README.MD'; verifiedFiles = $verified; bytes = (Get-Item -LiteralPath $zipPath).Length; sha256 = $zipHash; checkedAt = [DateTime]::UtcNow.ToString('o') }
[System.IO.File]::WriteAllText(($zipPath + '.verification.json'), ($report | ConvertTo-Json -Depth 4), $utf8)
$report | ConvertTo-Json -Compress
