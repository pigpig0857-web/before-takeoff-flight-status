param([Parameter(Mandatory=$true)][string]$ResearchDirectory,[Parameter(Mandatory=$true)][string]$PlanFile)
$ErrorActionPreference = 'Stop'
$flightResearchRoot = [System.IO.Path]::GetFullPath($ResearchDirectory)
$flightAllowedRoot = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) 'data/source-samples/crawler'))
if (-not $flightResearchRoot.StartsWith($flightAllowedRoot + [System.IO.Path]::DirectorySeparatorChar)) { throw 'Research path outside workspace' }
$flightPlan = Get-Content -LiteralPath $PlanFile -Raw | ConvertFrom-Json
[System.IO.Directory]::CreateDirectory($flightResearchRoot) | Out-Null
# Fresh anonymous cookies remain in memory only; normal server redirects are followed.
$null = Invoke-WebRequest -Uri 'https://www.jejuair.net/en/prepare/flight/viewScheduleInfo.do' -SessionVariable flightAnonymousSession -MaximumRedirection 5 -TimeoutSec 25
$flightResults = [System.Collections.Generic.List[object]]::new()
foreach ($flightRequest in $flightPlan.requests) {
  if ($flightRequest.id -notmatch '^[a-z0-9-]+$') { throw 'Invalid evidence ID' }
  $flightUrl = [Uri]$flightRequest.url
  if ($flightUrl.Scheme -ne 'https' -or $flightUrl.Host -notin @('www.jejuair.net','sec.jejuair.net') -or $flightUrl.AbsolutePath -notin @('/en/prepare/flight/getFlightSchedule.json','/en/ibe/booking/selectArrivalStations.json')) { throw 'Unreviewed endpoint' }
  $flightBase = Join-Path $flightResearchRoot $flightRequest.id
  if (Test-Path -LiteralPath ($flightBase + '.receipt.json')) {
    $flightSaved = Get-Content -LiteralPath ($flightBase + '.receipt.json') -Raw | ConvertFrom-Json
    if ($flightSaved.status -ne 200 -or (Get-FileHash -LiteralPath ($flightBase + '.body') -Algorithm SHA256).Hash.ToLower() -ne $flightSaved.sha256) { throw 'Saved source requires review' }
    $flightResults.Add(@{id=$flightRequest.id;state='saved_success_reused'})
    continue
  }
  if (Test-Path -LiteralPath ($flightBase + '.started.json')) { throw ('Unfinished source requires review: ' + $flightRequest.id) }
  $flightRequest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath ($flightBase + '.started.json') -Encoding utf8
  $flightBody = @{}
  foreach ($flightProperty in $flightRequest.body.PSObject.Properties) { $flightBody[$flightProperty.Name]=$flightProperty.Value }
  try {
    $flightResponse = Invoke-WebRequest -Uri $flightUrl -WebSession $flightAnonymousSession -Method Post -ContentType 'application/x-www-form-urlencoded' -Headers @{tcode='0000000466';cname='PC'} -Body $flightBody -TimeoutSec 25 -MaximumRedirection 0 -SkipHttpErrorCheck
    $flightBytes=$flightResponse.RawContentStream.ToArray()
    [System.IO.File]::WriteAllBytes($flightBase+'.body',$flightBytes)
    $flightReceipt=@{url=$flightRequest.url;status=[int]$flightResponse.StatusCode;sha256=(Get-FileHash -LiteralPath ($flightBase+'.body') -Algorithm SHA256).Hash.ToLower();bytes=$flightBytes.Length;fetchedAt=[DateTime]::UtcNow.ToString('o');authenticated=$false;cookiesPersisted=$false;tls='Windows default certificate validation'}
    $flightReceipt | ConvertTo-Json | Set-Content -LiteralPath ($flightBase+'.receipt.json') -Encoding utf8
    if ($flightReceipt.status -ne 200) { throw ('HTTP '+$flightReceipt.status+'; no retry') }
    $flightPayload=[System.Text.Encoding]::UTF8.GetString($flightBytes)|ConvertFrom-Json
    if ($flightPayload.code -ne '0000') { throw ('Non-success payload '+$flightPayload.code) }
    if ($flightUrl.AbsolutePath.EndsWith('getFlightSchedule.json')) {
      if ($null -eq $flightPayload.data.dep) { throw 'Missing published departure flight array' }
      $flightResults.Add(@{id=$flightRequest.id;state='saved_valid_response';flights=@($flightPayload.data.dep).Count})
    } else {
      $flightResults.Add(@{id=$flightRequest.id;state='saved_valid_response';stations=@($flightPayload.data.data.stations).Count})
    }
    @{state='in_progress';completed=$flightResults;updatedAt=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $flightResearchRoot 'progress.json') -Encoding utf8
    Write-Output ($flightResults[-1]|ConvertTo-Json -Compress)
  } catch {
    @{id=$flightRequest.id;state='pending';error=$_.Exception.Message}|ConvertTo-Json|Set-Content -LiteralPath ($flightBase+'.pending.json') -Encoding utf8
    @{state='stopped_pending';completed=$flightResults;pending=$flightRequest.id;updatedAt=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $flightResearchRoot 'progress.json') -Encoding utf8
    throw
  }
  Start-Sleep -Milliseconds 500
}
@{state='completed';completed=$flightResults;updatedAt=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $flightResearchRoot 'progress.json') -Encoding utf8
