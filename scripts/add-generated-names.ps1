<# Fetch fresh international names from a free API and add them to the public feed.
Usage:
  .\scripts\add-generated-names.ps1 -Count 25
  .\scripts\add-generated-names.ps1            # 25 names
Uses the free randomuser.me API (no key). Names are appended to
supabase/data/showcase-names.json alongside your existing 200+, then pushed to
the sandbox and placed at the top of the feed. Duplicates are skipped.
Real user transactions still appear automatically on their own.
#>
param([int]$Count = 25)

$ErrorActionPreference = "Stop"
$root = Split-Path (Split-Path $MyInvocation.MyCommand.Path -Parent) -Parent
Set-Location $root
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$out = node supabase/data/fetch-generated-names.js --count=$Count 2>&1
if ($LASTEXITCODE -ne 0) { Write-Output "Name fetch failed:"; $out | Write-Output; exit 1 }
$namesLine = @($out) | Where-Object { $_ -like "NAMES:*" } | Select-Object -First 1
$regionsLine = @($out) | Where-Object { $_ -like "REGIONS:*" } | Select-Object -First 1
$names = @(); $regions = @()
if ($namesLine) { $parsed = $namesLine.Substring(6) | ConvertFrom-Json; if ($parsed) { $names = @($parsed) } }
if ($regionsLine) { $parsed = $regionsLine.Substring(8) | ConvertFrom-Json; if ($parsed) { $regions = @($parsed) } }
if ($names.Count -eq 0) { Write-Output "No new names (everything fetched was already in the list). Try again for a fresh batch."; exit 0 }

$entries = @()
for ($i = 0; $i -lt $names.Count; $i++) {
  $r = if ($i -lt $regions.Count) { $regions[$i] } else { "International" }
  $entries += "$($names[$i])|$r"
}
Write-Output "Fetched $($names.Count) new names."
& (Join-Path $root 'scripts\add-showcase-names.ps1') -Entries $entries -BumpExisting
