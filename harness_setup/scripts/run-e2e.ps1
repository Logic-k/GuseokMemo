# GuseokMemo e2e gate runner -- performs quality_gates/e2e.md in one command.
# Usage:
#   powershell -File harness_setup/scripts/run-e2e.ps1
#   powershell -File harness_setup/scripts/run-e2e.ps1 -Cdp "cdp-ime-check.cjs,cdp-ping.cjs"
#   powershell -File harness_setup/scripts/run-e2e.ps1 -WithAutostartQa
#   powershell -File harness_setup/scripts/run-e2e.ps1 -TimeoutSec 180
# Flow: vite :5183 check (start if down) -> debug exe --selftest (with CDP port 9223)
#       -> poll %TEMP%\guseok-qa.log for SUMMARY -> run given cdp-*.cjs
#       -> restore store snapshot, kill only processes started by this script.
param(
  [string]$Cdp = "",
  [switch]$WithAutostartQa,
  [int]$TimeoutSec = 120
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
$qa = Join-Path $env:TEMP "guseok-qa.log"
$appData = Join-Path $env:APPDATA "com.guseok.memo"
$backupDir = $null
$viteProc = $null
$appProc = $null
$ok = $false

function Stop-OwnedProcess($proc) {
  if ($proc -and -not $proc.HasExited) {
    try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch {}
  }
}

Push-Location $root
try {
  # 0) precondition -- no running instance (single-instance forwards args to it)
  if (Get-Process -Name "guseok-memo" -ErrorAction SilentlyContinue) {
    throw "guseok-memo.exe is already running -- close installed/prior test instances first"
  }
  $exe = Join-Path $root "src-tauri\target\debug\guseok-memo.exe"
  if (-not (Test-Path $exe)) { throw "debug exe missing -- run: cargo build --manifest-path src-tauri/Cargo.toml" }
  if (-not (Test-Path (Join-Path $root "dist"))) { throw "dist missing -- run: npm run build" }

  # 1) user store snapshot (PRD agreement: snapshot -> restore)
  $backupDir = Join-Path $env:TEMP ("guseok-store-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
  if (Test-Path $appData) {
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    foreach ($f in @("store.json", "store.bak.json", "config.json")) {
      $src = Join-Path $appData $f
      if (Test-Path $src) { Copy-Item $src (Join-Path $backupDir $f) }
    }
    Write-Host "store snapshot: $backupDir"
  }

  # 2) vite :5183 -- require a real 200 response (port LISTEN alone is not readiness)
  $viteUp = $false
  try { $r = Invoke-WebRequest -Uri "http://localhost:5183" -UseBasicParsing -TimeoutSec 3; $viteUp = ($r.StatusCode -eq 200) } catch {}
  if (-not $viteUp) {
    $viteProc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm run dev" -WorkingDirectory $root -PassThru -WindowStyle Hidden
    for ($i = 0; $i -lt 90 -and -not $viteUp; $i++) {
      Start-Sleep -Milliseconds 500
      try { $r = Invoke-WebRequest -Uri "http://localhost:5183" -UseBasicParsing -TimeoutSec 2; $viteUp = ($r.StatusCode -eq 200) } catch {}
    }
    if (-not $viteUp) { throw "vite :5183 readiness timeout (45s)" }
    Write-Host "vite: started by this script (pid $($viteProc.Id))"
  } else {
    Write-Host "vite: reusing existing :5183"
  }

  # 3) selftest exe -- also opens CDP port 9223
  # marker line lets us isolate this run's region in the append-only log
  $marker = "==== e2e-run " + (Get-Date -Format "yyyyMMdd-HHmmss") + " ===="
  Add-Content -Path $qa -Value $marker -Encoding UTF8
  $exeArgs = @("--selftest")
  if ($WithAutostartQa) { $exeArgs += "--qa-autostart" }
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9223"
  $appProc = Start-Process -FilePath $exe -ArgumentList $exeArgs -WorkingDirectory $root -PassThru
  Write-Host "app: started (pid $($appProc.Id)) args: $($exeArgs -join ' ')"

  # 4) poll SUMMARY -- inspect content after the marker (whole file if the log was recreated)
  $summary = $null
  $lastNew = ""
  $nudged = $false
  $nudgeAfter = 45   # startup toggle emit can be lost on slow boots -- rescue once via CDP
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline -and -not $summary) {
    Start-Sleep -Seconds 2
    if (Test-Path $qa) {
      $raw = Get-Content $qa -Raw -ErrorAction SilentlyContinue
      if ($raw) {
        $mk = $raw.LastIndexOf($marker)
        $lastNew = if ($mk -ge 0) { $raw.Substring($mk + $marker.Length) } else { $raw }
        if ($lastNew -match "SUMMARY (\d+)/(\d+) passed") {
          $summary = @{ pass = [int]$Matches[1]; total = [int]$Matches[2]; text = $lastNew }
          break
        }
      }
    }
    if ($appProc.HasExited) { throw "app exited early (code $($appProc.ExitCode)) before SUMMARY -- check app state" }
    if (-not $nudged -and (New-TimeSpan -Start $appProc.StartTime -End (Get-Date)).TotalSeconds -gt $nudgeAfter) {
      $nudged = $true
      Write-Host "no SUMMARY after ${nudgeAfter}s -- nudging panel open via CDP"
      try { & node (Join-Path $root "harness_setup\scripts\cdp-nudge.cjs") } catch { Write-Host "nudge failed: $_" }
    }
  }
  if (-not $summary) {
    Write-Host "--- last log region before timeout ---"
    if ($lastNew) { Write-Host $lastNew } else { Write-Host "(empty -- selftest produced no output; possible lost toggle emit or panel load stall)" }
    throw "selftest SUMMARY timeout (${TimeoutSec}s) -- check $qa and app state"
  }
  Write-Host "--- guseok-qa.log (new) ---"
  Write-Host $summary.text
  Write-Host "SELFTEST: $($summary.pass)/$($summary.total)"
  $failLines = ([regex]::Matches($summary.text, "FAIL ")).Count

  # 5) optional CDP scripts -- connect to the same instance on 9223
  $cdpFail = 0
  if ($Cdp) {
    foreach ($s in ($Cdp -split ",")) {
      $name = $s.Trim()
      $p = Join-Path $root ("plan_setup\" + $name)
      if (-not (Test-Path $p)) { Write-Host "cdp: $name not found -- FAIL"; $cdpFail++; continue }
      Write-Host "cdp: node plan_setup\$name"
      & node $p
      if ($LASTEXITCODE -ne 0) { $cdpFail++ }
    }
  }

  # 6) preserve evidence -- copy %TEMP% log to a durable path
  $evDir = Join-Path $root ".devil\loop\qa-logs"
  New-Item -ItemType Directory -Force -Path $evDir | Out-Null
  $ev = Join-Path $evDir ("guseok-qa-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")
  if (Test-Path $qa) { Copy-Item $qa $ev }
  Write-Host "evidence: $ev"

  $ok = ($summary.pass -eq $summary.total) -and ($failLines -eq 0) -and ($cdpFail -eq 0)
} finally {
  # cleanup -- kill only processes started by this script, by PID (never image-name taskkill)
  Stop-OwnedProcess $appProc
  if ($viteProc) {
    Stop-OwnedProcess $viteProc
    # child vite(node) of npm run dev -- only the :5183 LISTEN owner
    $owners = Get-NetTCPConnection -LocalPort 5183 -State Listen -ErrorAction SilentlyContinue | Select-Object -Expand OwningProcess -Unique
    foreach ($opid in $owners) {
      $p = Get-Process -Id $opid -ErrorAction SilentlyContinue
      if ($p -and $p.ProcessName -eq "node") { try { Stop-Process -Id $opid -Force -ErrorAction Stop } catch {} }
    }
  }
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $null
  # restore store -- undo test writes to real user data
  if ($backupDir -and (Test-Path $backupDir)) {
    Start-Sleep -Milliseconds 800   # let pending debounced saves flush
    foreach ($f in @("store.json", "store.bak.json", "config.json")) {
      $b = Join-Path $backupDir $f
      if (Test-Path $b) { Copy-Item $b (Join-Path $appData $f) -Force }
    }
    Remove-Item $backupDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "store restored from snapshot (backup removed)"
  }
  Pop-Location
}
if (-not $ok) { Write-Host "E2E: FAIL"; exit 1 }
Write-Host "E2E: PASS"
exit 0
