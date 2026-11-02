param([int]$Port = 3000)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
$taskNext = Join-Path $taskRoot 'node_modules\next\dist\bin\next'
if (-not (Test-Path -LiteralPath $taskNext)) { throw 'Dependencies missing. Run pnpm install --frozen-lockfile first.' }
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Invalid port.' }
& node $taskNext dev --hostname 127.0.0.1 --port $Port
