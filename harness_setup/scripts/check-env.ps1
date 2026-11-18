# GuseokMemo verification harness -- environment preflight
# Usage: powershell -File harness_setup/scripts/check-env.ps1
# Exit code 1 if any FAIL. Run before quality gates.
$ErrorActionPreference = "Continue"
$script:fail = 0
function Check($name, $ok, $info = "", $hint = "") {
  if ($ok) { Write-Host "  PASS $name $info" }
  else { Write-Host "  FAIL $name $info -- $hint"; $script:fail++ }
}

# project root = parent of harness_setup/
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))

# 1) Node.js -- dev/build 20+, CDP scripts (global WebSocket) need 22+
$nodeVer = $null
try { $nodeVer = [version]((node --version) -replace "^v", "") } catch {}
Check "node" ($null -ne $nodeVer -and $nodeVer.Major -ge 20) ($(if ($nodeVer) { "v$nodeVer" } else { "not found" }) + " (dev/build 20+, cdp-*.cjs needs 22+)")
if ($nodeVer -and $nodeVer.Major -lt 22) {
  Write-Host "  WARN node v$nodeVer -- plan_setup/cdp-*.cjs requires global WebSocket (Node 22+)"
}

# 2) Rust toolchain (actual requirement >= 1.90 -- TRD TD-11)
$rv = $null
try { $rv = (rustc --version) } catch {}
Check "rustc" ($null -ne $rv) $rv
if ($rv -match "(\d+)\.(\d+)") {
  $rustVer = [version]"$($Matches[1]).$($Matches[2]).0"
  if ($rustVer -lt [version]"1.90.0") {
    Write-Host "  WARN rustc $rustVer -- TRD TD-11 actual requirement is >=1.90"
  }
}
$cv = $null
try { $cv = (cargo --version) } catch {}
Check "cargo" ($null -ne $cv) $cv
cargo fmt --version *> $null
Check "rustfmt" ($LASTEXITCODE -eq 0) "" "rustup component add rustfmt"
cargo clippy --version *> $null
Check "clippy" ($LASTEXITCODE -eq 0) "" "rustup component add clippy"

# 3) WebView2 Evergreen Runtime -- EdgeUpdate client key
$wvGuid = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
$wvKey = @(
  "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$wvGuid",
  "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$wvGuid",
  "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$wvGuid"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
$wvVer = $null
if ($wvKey) { $wvVer = (Get-ItemProperty $wvKey -Name pv -ErrorAction SilentlyContinue).pv }
Check "webview2-runtime" ($null -ne $wvKey) $(if ($wvVer) { "v$wvVer" } else { "not found" })

# 4) project state
Check "node_modules" (Test-Path (Join-Path $root "node_modules")) "" "run: npm install"
Check "dist" (Test-Path (Join-Path $root "dist")) "" "run: npm run build (generate_context! precondition)"
Check "debug-exe" (Test-Path (Join-Path $root "src-tauri\target\debug\guseok-memo.exe")) "" "run: cargo build --manifest-path src-tauri/Cargo.toml"

# 5) e2e preconditions -- running instance, ports
$running = Get-Process -Name "guseok-memo" -ErrorAction SilentlyContinue
Check "no-running-instance" ($null -eq $running) "" "single-instance forwards args to the existing instance -- kill all first"
$p5183 = Get-NetTCPConnection -LocalPort 5183 -State Listen -ErrorAction SilentlyContinue
if ($p5183) { Write-Host "  INFO :5183 LISTEN -- e2e reuses it if this is vite; strictPort fails otherwise" }
$p9223 = Get-NetTCPConnection -LocalPort 9223 -State Listen -ErrorAction SilentlyContinue
Check "cdp-port-free" ($null -eq $p9223) "" "9223 busy = leftover debug session -- clean up first"

if ($script:fail -gt 0) { Write-Host "`nENV CHECK: $script:fail FAIL"; exit 1 }
Write-Host "`nENV CHECK: all pass"
exit 0
