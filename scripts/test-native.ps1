$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskOutput = Join-Path $taskRoot '.build/native-tests'
New-Item -ItemType Directory -Force -Path $taskOutput | Out-Null
$taskCompiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$taskExecutable = Join-Path $taskOutput 'HostArgumentsTests.exe'
& $taskCompiler /nologo /target:exe /platform:x64 /reference:System.Web.Extensions.dll "/out:$taskExecutable" (Join-Path $taskRoot 'native/HostArguments.cs') (Join-Path $taskRoot 'test/HostArgumentsTests.cs')
if ($LASTEXITCODE -ne 0) { throw 'Native regression test compilation failed' }
$taskReport = & $taskExecutable
if ($LASTEXITCODE -ne 0) { throw 'Native regression test failed' }
$taskReport | Set-Content -LiteralPath (Join-Path $taskRoot 'docs/native-bridge-check.json') -Encoding utf8
Write-Output $taskReport
