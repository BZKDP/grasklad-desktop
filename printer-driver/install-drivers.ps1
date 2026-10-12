# Installs all bundled drivers (Xprinter printer + CH340 for the ESP32 scanner).
# Resolves its own folder via $PSScriptRoot, so it works from any install path.
# Writes driver-install.log next to itself for diagnostics.
# NOTE: ASCII-only on purpose - Windows PowerShell 5.1 mis-decodes non-ASCII .ps1 without BOM.
$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'driver-install.log'
$pnputilCandidates = @(
  (Join-Path $env:WINDIR 'Sysnative\pnputil.exe'),
  (Join-Path $env:WINDIR 'System32\pnputil.exe')
)
$pnputil = $pnputilCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

function Log($msg) { "$(Get-Date -Format o)  $msg" | Out-File -FilePath $log -Append -Encoding utf8 }

"" | Out-File -FilePath $log -Encoding utf8   # reset log
Log "install-drivers start; dir=$PSScriptRoot"

$infs = Get-ChildItem -Path $PSScriptRoot -Recurse -Filter *.inf -ErrorAction SilentlyContinue
if (-not $infs) { Log "no INF files found"; exit 1 }
if (-not $pnputil) { Log "pnputil.exe not found"; exit 2 }

$fail = 0
foreach ($inf in $infs) {
  Log "--- pnputil /add-driver `"$($inf.FullName)`" /install"
  try {
    $out = & $pnputil /add-driver "$($inf.FullName)" /install 2>&1
    $out | ForEach-Object { Log "    $_" }
    # 0 = added, 259 = already present (nothing to do), 3010 = reboot required. All OK.
    if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 259 -or $LASTEXITCODE -eq 3010) {
      Log "    EXITCODE=$LASTEXITCODE (ok)"
    } else {
      $fail++; Log "    EXITCODE=$LASTEXITCODE (fail)"
    }
  } catch {
    $fail++; Log "    ERROR: $($_.Exception.Message)"
  }
}
Log "done; failed=$fail"
exit $fail
