<# Add new showcase names to the public feed (sandbox).
Usage:
  .\scripts\add-showcase-names.ps1 -Names "Adaeze Obi", "Kwame Asante" -Region "Nigeria"
  .\scripts\add-showcase-names.ps1        # asks you to type names
What it does:
  1. Appends the names to supabase/data/showcase-names.json (skips duplicates)
  2. Regenerates supabase/data/showcase-seed.sql
  3. Pushes the seed to the sandbox (existing rows are skipped, nothing duplicated)
  4. Puts the new names at the top of the feed so you see them immediately
  5. Prints the current top of the feed as proof
Real users appear automatically when they transact — this is only for showcase names.
#>
param(
  [string[]]$Names = @(),
  [string]$Region = "Community",
  [string[]]$Entries = @(),
  [switch]$BumpExisting
)

$ErrorActionPreference = "Stop"
$root = Split-Path (Split-Path $MyInvocation.MyCommand.Path -Parent) -Parent
Set-Location $root
. (Join-Path $root 'scripts\sandbox-lib.ps1')

if ((-not $Names -or $Names.Count -eq 0) -and (-not $Entries -or $Entries.Count -eq 0)) {
  $typed = Read-Host "Type the new names, separated by commas"
  $Names = @($typed)
}
# Normalize: handles arrays, comma-separated strings, and -File literal '@("a", "b")' forms
$clean = @()
foreach ($x in $Names) {
  foreach ($part in ($x -split '[,;]')) {
    $p = ($part -replace '^[\s@"''(]+|[\s@"'')]+$', '').Trim()
    if ($p -ne "") { $clean += $p }
  }
}
$Names = $clean
if (((-not $Names) -or ($Names.Count -eq 0)) -and ((-not $Entries) -or ($Entries.Count -eq 0))) { Write-Output "No names given. Nothing to do."; exit 0 }

$jsonPath = "supabase/data/showcase-names.json"
$raw = [System.IO.File]::ReadAllText((Join-Path $root $jsonPath)).TrimStart([char]0xFEFF)
$list = $raw | ConvertFrom-Json
$have = @{}; foreach ($e in $list) { $have[$e.name.ToLower()] = $true }
$added = @()
# "Name|Region" entries carry their own region (used by the name generator)
foreach ($entry in $Entries) {
  $parts = $entry -split "\|", 2
  $n = $parts[0].Trim(); $r = if ($parts.Count -gt 1 -and $parts[1].Trim() -ne "") { $parts[1].Trim() } else { $Region }
  if ($n -eq "" -or $have.ContainsKey($n.ToLower())) {
    if ($n -ne "") { Write-Output "Skipped (already in list): $n" }
    continue
  }
  $list += [pscustomobject]@{ name = $n; region = $r }
  $have[$n.ToLower()] = $true
  $added += $n
}
foreach ($n in $Names) {
  $n = $n.Trim()
  if ($n -eq "" -or $have.ContainsKey($n.ToLower())) {
    if ($n -ne "") { Write-Output "Skipped (already in list): $n" }
    continue
  }
  $list += [pscustomobject]@{ name = $n; region = $Region }
  $have[$n.ToLower()] = $true
  $added += $n
}
if ($added.Count -eq 0) {
  if ($BumpExisting -and $Names.Count -gt 0) { $added = @($Names) }
  else { Write-Output "Nothing new to add."; exit 0 }
}

$list | ConvertTo-Json -Depth 3 | ForEach-Object { [System.IO.File]::WriteAllText((Join-Path $root $jsonPath), $_ + "`n", [System.Text.UTF8Encoding]::new($false)) }
Write-Output "Added to showcase-names.json: $($added -join ', ')"

node supabase/data/gen-showcase-seed.js

Invoke-SandboxSql (Get-Content "supabase/data/showcase-seed.sql" -Raw)
Write-Output "Seed pushed to sandbox."

$quoted = ($added | ForEach-Object { "'" + ($_.Replace("'", "''")) + "'" }) -join ","
Invoke-SandboxSql "update public.activity_showcase set occurred_at = now() where display_name in ($quoted);"
Write-Output "New names moved to the top of the feed."

$feed = Get-SandboxFeed 5
Write-Output "--- top of feed now ---"
$feed | ForEach-Object { "$($_.display_name) | live=$($_.is_live) | $($_.direction) $($_.amount) $($_.asset)" }
