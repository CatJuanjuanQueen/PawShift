param([string]$OutputDirectory = '')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
if (-not $OutputDirectory) {
    $releaseVersion = (Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    $OutputDirectory = 'release-webview2/PawShift-' + $releaseVersion
}
$sdkRoot = Join-Path $taskRoot '.build/webview2/sdk'
$sdkZip = Join-Path $taskRoot '.build/webview2/sdk.zip'
if (-not (Test-Path -LiteralPath (Join-Path $sdkRoot 'lib/net462/Microsoft.Web.WebView2.Core.dll'))) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $sdkZip) | Out-Null
    Invoke-WebRequest -Uri 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.3800.47/microsoft.web.webview2.1.0.3800.47.nupkg' -OutFile $sdkZip
    Expand-Archive -LiteralPath $sdkZip -DestinationPath $sdkRoot -Force
}
$outputRoot = [System.IO.Path]::GetFullPath((Join-Path $taskRoot $OutputDirectory))
$releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $taskRoot 'release-webview2'))
if (-not $outputRoot.StartsWith($releaseRoot + '\', [System.StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Parent $outputRoot) -ne $releaseRoot) { throw 'Output must be a named directory directly inside release-webview2' }
New-Item -ItemType Directory -Force -Path $outputRoot,(Join-Path $outputRoot 'media'),(Join-Path $outputRoot 'backend'),(Join-Path $outputRoot 'runtime') | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$core = Join-Path $sdkRoot 'lib/net462/Microsoft.Web.WebView2.Core.dll'
$forms = Join-Path $sdkRoot 'lib/net462/Microsoft.Web.WebView2.WinForms.dll'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ "/out:$outputRoot/PawShift.exe" "/win32icon:$taskRoot/ui/icon.ico" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/reference:$core" "/reference:$forms" (Join-Path $taskRoot 'native/PawShift.cs') (Join-Path $taskRoot 'native/HostArguments.cs')
if ($LASTEXITCODE -ne 0) { throw 'WebView2 host compilation failed' }
Copy-Item -LiteralPath $core,$forms,(Join-Path $sdkRoot 'runtimes/win-x64/native/WebView2Loader.dll') -Destination $outputRoot
Copy-Item -Path (Join-Path $taskRoot 'dist/media/*') -Destination (Join-Path $outputRoot 'media')
Copy-Item -LiteralPath (Join-Path $taskRoot 'ui/icon.ico') -Destination (Join-Path $outputRoot 'media')
$backendRoot = [System.IO.Path]::GetFullPath((Join-Path $outputRoot 'backend'))
$expectedBackend = [System.IO.Path]::GetFullPath((Join-Path $outputRoot 'backend'))
if ($backendRoot -ne $expectedBackend -or !$backendRoot.StartsWith([System.IO.Path]::GetFullPath($taskRoot) + '\')) { throw 'Unsafe backend output path' }
if (Test-Path -LiteralPath $backendRoot) { Remove-Item -LiteralPath $backendRoot -Recurse -Force }
New-Item -ItemType Directory -Path $backendRoot | Out-Null
Copy-Item -Path (Join-Path $taskRoot 'dist/src/*') -Destination $backendRoot -Recurse
Copy-Item -LiteralPath (Join-Path $taskRoot 'native/webview-bridge.js'),(Join-Path $taskRoot 'LICENSE'),(Join-Path $taskRoot 'NOTICE') -Destination $outputRoot
$nodeBinary = (Get-Command node.exe).Source
Copy-Item -LiteralPath $nodeBinary -Destination (Join-Path $outputRoot 'runtime/node.exe')
# The backend keeps using the existing SQLite schema and user-data directory.
@'
PawShift — WebView2 edition
Run PawShift.exe. Keep this folder's files together.
Requires Windows x64, .NET Framework 4.6.2+ and the system Evergreen WebView2 Runtime.
If WebView2 is missing: https://developer.microsoft.com/microsoft-edge/webview2/
User data: %APPDATA%\PawShift (compatible with the Electron edition).
Exit the old edition before starting this edition.
PawShift: PolyForm Noncommercial License 1.0.0. See LICENSE and NOTICE.
Commercial use requires separate permission from the rights holders.
Includes Microsoft WebView2 SDK redistributables and Node.js (MIT license).
Third-party components retain their own licenses and notices.
'@ | Set-Content -LiteralPath (Join-Path $outputRoot 'README.txt') -Encoding UTF8
$nodeLicense = Join-Path (Split-Path -Parent $nodeBinary) 'LICENSE'
if (-not (Test-Path -LiteralPath $nodeLicense)) {
    $nodeVersion = (& $nodeBinary --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v\d+\.\d+\.\d+$') { throw 'Cannot determine the bundled Node.js release version' }
    $nodeLicense = Join-Path $taskRoot ('.build/node-licenses/' + $nodeVersion + '/LICENSE')
    if (-not (Test-Path -LiteralPath $nodeLicense)) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $nodeLicense) | Out-Null
        Invoke-WebRequest -Uri ('https://raw.githubusercontent.com/nodejs/node/' + $nodeVersion + '/LICENSE') -OutFile $nodeLicense
    }
}
if ((Get-Content -LiteralPath $nodeLicense -Raw) -notmatch 'Copyright Node.js contributors') { throw 'Node.js license text is missing or invalid' }
Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $outputRoot 'runtime/LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $sdkRoot 'LICENSE.txt') -Destination (Join-Path $outputRoot 'WebView2-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $sdkRoot 'NOTICE.txt') -Destination (Join-Path $outputRoot 'WebView2-NOTICE.txt')
Compress-Archive -LiteralPath $outputRoot -DestinationPath (Join-Path $releaseRoot ((Split-Path -Leaf $outputRoot) + '-WebView2-x64.zip')) -Force
Write-Output "WebView2 build: $outputRoot/PawShift.exe"
