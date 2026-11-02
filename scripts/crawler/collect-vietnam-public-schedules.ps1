param([Parameter(Mandatory=$true)][string]$ResearchDirectory,[Parameter(Mandatory=$true)][string]$PlanFile)
$ErrorActionPreference = 'Stop'
$flightResearchRoot = [System.IO.Path]::GetFullPath($ResearchDirectory)
$flightAllowedRoot = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) 'data/source-samples/crawler'))
if (-not $flightResearchRoot.StartsWith($flightAllowedRoot + [System.IO.Path]::DirectorySeparatorChar)) { throw 'Research path outside workspace' }
$flightResearchPlan = Get-Content -LiteralPath $PlanFile -Raw | ConvertFrom-Json
[System.IO.Directory]::CreateDirectory($flightResearchRoot) | Out-Null
$flightResults = [System.Collections.Generic.List[object]]::new()
foreach ($flightRequest in $flightResearchPlan.requests) {
  if ($flightRequest.id -notmatch '^[a-z0-9-]+$') { throw 'Invalid request ID' }
  $flightAddress = [Uri]$flightRequest.url
  if ($flightAddress.Scheme -ne 'https' -or $flightAddress.Host -ne 'integration-middleware-website.vietnamairlines.com' -or $flightAddress.AbsolutePath -ne '/api/v1/public/flight/schedule-table') { throw 'Unreviewed endpoint' }
  $flightBase = Join-Path $flightResearchRoot $flightRequest.id
  if (Test-Path -LiteralPath ($flightBase + '.receipt.json')) {
    $flightSaved = Get-Content -LiteralPath ($flightBase + '.receipt.json') -Raw | ConvertFrom-Json
    $flightCurrentHash = (Get-FileHash -LiteralPath ($flightBase + '.body') -Algorithm SHA256).Hash.ToLower()
    if ($flightCurrentHash -ne $flightSaved.sha256 -or $flightSaved.status -ne 200) { throw 'Saved evidence not valid; requires review' }
    $flightSavedPayload = Get-Content -LiteralPath ($flightBase + '.body') -Raw | ConvertFrom-Json
    if ($flightSavedPayload.success -ne $true -or $null -eq $flightSavedPayload.data.departureFlight.scheduleItems) { throw ('Saved incomplete payload requires review: ' + $flightRequest.id) }
    $flightResults.Add(@{id=$flightRequest.id; state='saved_success_reused'})
    continue
  }
  if (Test-Path -LiteralPath ($flightBase + '.started.json')) { throw ('Unfinished or failed request requires review: ' + $flightRequest.id) }
  @{id=$flightRequest.id; url=$flightRequest.url; startedAt=[DateTime]::UtcNow.ToString('o'); authenticated=$false; tls='Windows default certificate validation'} | ConvertTo-Json | Set-Content -LiteralPath ($flightBase + '.started.json') -Encoding utf8
  try {
    $flightResponse = Invoke-WebRequest -Uri $flightAddress -TimeoutSec 25 -MaximumRedirection 0 -SkipHttpErrorCheck
    $flightBytes = $flightResponse.RawContentStream.ToArray()
    [System.IO.File]::WriteAllBytes($flightBase + '.body', $flightBytes)
    $flightReceipt = @{id=$flightRequest.id; url=$flightRequest.url; status=[int]$flightResponse.StatusCode; bytes=$flightBytes.Length; sha256=(Get-FileHash -LiteralPath ($flightBase + '.body') -Algorithm SHA256).Hash.ToLower(); fetchedAt=[DateTime]::UtcNow.ToString('o'); authenticated=$false; tls='Windows default certificate validation'}
    $flightReceipt | ConvertTo-Json | Set-Content -LiteralPath ($flightBase + '.receipt.json') -Encoding utf8
    if ($flightReceipt.status -ne 200) { throw ('HTTP ' + $flightReceipt.status + '; no retry') }
    $flightPayload = [System.Text.Encoding]::UTF8.GetString($flightBytes) | ConvertFrom-Json
    if ($flightPayload.success -ne $true -or $null -eq $flightPayload.data.departureFlight.scheduleItems) { throw 'Schedule payload not valid' }
    $flightResults.Add(@{id=$flightRequest.id; state='saved_valid_response'; items=@($flightPayload.data.departureFlight.scheduleItems).Count})
    @{state='in_progress'; completed=$flightResults; updatedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $flightResearchRoot 'progress.json') -Encoding utf8
    Write-Output ($flightResults[-1] | ConvertTo-Json -Compress)
  } catch {
    @{id=$flightRequest.id; url=$flightRequest.url; state='pending'; error=$_.Exception.Message} | ConvertTo-Json | Set-Content -LiteralPath ($flightBase + '.pending.json') -Encoding utf8
    @{state='stopped_pending'; completed=$flightResults; pending=$flightRequest.id; updatedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $flightResearchRoot 'progress.json') -Encoding utf8
    throw
  }
  Start-Sleep -Milliseconds 500
}
@{state='completed'; completed=$flightResults; updatedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $flightResearchRoot 'progress.json') -Encoding utf8
