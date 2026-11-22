# Shared sandbox helpers. Dot-source from other scripts:
#   . (Join-Path $root 'scripts/sandbox-lib.ps1')
function Get-SandboxToken {
  if ($env:SUPABASE_ACCESS_TOKEN) { return $env:SUPABASE_ACCESS_TOKEN }
  if (Test-Path "supabase/.env.local") {
    $line = Get-Content "supabase/.env.local" | Where-Object { $_ -match "^SUPABASE_ACCESS_TOKEN=(.+)$" } | Select-Object -First 1
    if ($line -and $Matches[1]) { return $Matches[1].Trim() }
  }
  return $null
}

function Invoke-SandboxSql($sql) {
  $token = Get-SandboxToken
  if (-not $token) { throw "No sandbox token. Set SUPABASE_ACCESS_TOKEN or add it to supabase/.env.local." }
  $body = @{ query = $sql } | ConvertTo-Json -Depth 3
  Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/mdpdcpxvohbcdlhirtdp/database/query" -Method Post -Headers @{ Authorization = "Bearer $token" } -ContentType "application/json" -Body $body -TimeoutSec 120 | Out-Null
}

function Get-SandboxFeed($limit = 5) {
  $pub = "sb_publishable_hySEI1W9BQV0AKny0THJsg_mOp8YsDF"
  Invoke-RestMethod -Uri "https://mdpdcpxvohbcdlhirtdp.supabase.co/rest/v1/rpc/get_public_chain_activity" -Method Post -Headers @{ apikey = $pub; "Content-Type" = "application/json" } -Body ('{"p_limit":' + $limit + '}')
}
