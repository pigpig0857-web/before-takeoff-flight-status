param([switch]$Resume)
$ErrorActionPreference = 'Stop'
$nodeBinary = 'C:\Users\88697\AppData\Local\Author Software\nvm\installs\v24.20.0\node.exe'
$pythonBinary = 'C:\Users\88697\miniconda3\python.exe'
$progressFile = 'data/source-samples/crawler/ci-tpe-20261021/network/progress.json'
$logFile = 'data/source-samples/crawler/ci-tpe-20261021/network/collection.log'
$pauseFile = 'data/source-samples/crawler/ci-tpe-20261021/network/pause-request.json'
if ($Resume -and (Test-Path -LiteralPath $pauseFile)) {
    $pause = Get-Content -LiteralPath $pauseFile -Raw | ConvertFrom-Json
    $pause.active = $false
    $pause | Add-Member -NotePropertyName resumedAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
    $pause | ConvertTo-Json | Set-Content -LiteralPath $pauseFile -Encoding utf8
}
do {
    & $nodeBinary --use-system-ca scripts/crawler/collect-ci-network-oag-20261021.mjs 2>&1 | Tee-Object -FilePath $logFile -Append
    $collectionExit = $LASTEXITCODE
    & $pythonBinary -X utf8 scripts/crawler/parse-ci-network-oag-20261021.py 2>&1 | Tee-Object -FilePath $logFile -Append
    if ($LASTEXITCODE -ne 0) { throw 'Offline parsing failed; collection stopped with evidence retained.' }
    & $nodeBinary scripts/crawler/audit-ci-network-20261021.mjs 2>&1 | Tee-Object -FilePath $logFile -Append
    if ($LASTEXITCODE -ne 0) { throw 'Independent audit failed; collection stopped with evidence retained.' }
    $progress = Get-Content -LiteralPath $progressFile -Raw | ConvertFrom-Json
    if ($collectionExit -ne 0 -or $progress.state -eq 'source_stopped') { break }
} while ($progress.state -eq 'batch_saved')
