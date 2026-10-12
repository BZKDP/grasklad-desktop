param(
  [switch]$StageOnly,
  [switch]$AllowDisconnected,
  [string]$RunId = "installer"
)

# Installs and repairs only the Xprinter XP-365B printer.
# ASCII-only source is intentional for Windows PowerShell 5.1 compatibility.
$ErrorActionPreference = "Stop"
$model = "Xprinter XP-365B"
$infPath = Join-Path $PSScriptRoot "Xprinter.inf"
$stateDir = Join-Path $env:ProgramData "GRA-sklad"
$logPath = Join-Path $stateDir "printer-install.log"
$resultPath = Join-Path $stateDir "printer-install-result.json"

New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
"" | Out-File -FilePath $logPath -Encoding utf8

function Log([string]$message) {
  "$(Get-Date -Format o)  $message" | Out-File -FilePath $logPath -Append -Encoding utf8
}

function Save-Result([bool]$ok, [string]$reason, [string]$queue, [string]$port, [string]$errorMessage) {
  $result = [ordered]@{
    runId = $RunId
    ok = $ok
    reason = $reason
    queue = $queue
    port = $port
    error = $errorMessage
  }
  $result | ConvertTo-Json -Compress | Out-File -FilePath $resultPath -Encoding utf8
}

function Get-PresentXprinterIds {
  $ids = @()
  try {
    $ids = @(Get-PnpDevice -PresentOnly -ErrorAction Stop |
      Where-Object {
        $label = ([string]$_.FriendlyName + ' ' + [string]$_.Name + ' ' + [string]$_.Manufacturer)
        $_.InstanceId -match '^USB\\VID_1FC9&PID_2016' -or
        $_.InstanceId -match '^USBPRINT\\.*XP[-_ ]?365B' -or
        (($_.Class -eq 'Printer' -or $_.InstanceId -match '^USBPRINT\\') -and $label -match 'XP[-_ ]?365B')
      } |
      ForEach-Object { $_.InstanceId })
  } catch {
    Log "Get-PnpDevice failed: $($_.Exception.Message)"
  }

  if (-not $ids.Count) {
    try {
      $ids = @(Get-CimInstance Win32_PnPEntity -ErrorAction Stop |
        Where-Object {
          $label = ([string]$_.Name + ' ' + [string]$_.Description + ' ' + [string]$_.Manufacturer)
          ($_.PNPDeviceID -match '^USB\\VID_1FC9&PID_2016' -or
           $_.PNPDeviceID -match '^USBPRINT\\.*XP[-_ ]?365B' -or
           (($_.PNPClass -eq 'Printer' -or $_.PNPDeviceID -match '^USBPRINT\\') -and $label -match 'XP[-_ ]?365B')) -and
          $_.Status -eq 'OK'
        } |
        ForEach-Object { $_.PNPDeviceID })
    } catch {
      Log "Win32_PnPEntity fallback failed: $($_.Exception.Message)"
    }
  }
  return @($ids | Where-Object { $_ } | Select-Object -Unique)
}

function Get-PnpUtilPath {
  $candidates = @(
    (Join-Path $env:WINDIR "Sysnative\pnputil.exe"),
    (Join-Path $env:WINDIR "System32\pnputil.exe")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  $command = Get-Command pnputil.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  throw "pnputil.exe was not found"
}

function Get-ActiveXprinterPorts([string[]]$presentIds) {
  $rows = @()
  $root = "HKLM:\SYSTEM\CurrentControlSet\Control\Print\Monitors\USB Monitor\Ports"
  if (-not (Test-Path $root)) { return @() }

  foreach ($key in Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue) {
    try {
      $props = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop
      $deviceId = [string]$props.'Device Id'
      $deviceIdUpper = $deviceId.ToUpperInvariant()
      $matchesPresentDevice = @($presentIds | Where-Object {
        $presentIdUpper = ([string]$_).ToUpperInvariant()
        $presentIdUpper -eq $deviceIdUpper -or
        $presentIdUpper.StartsWith($deviceIdUpper + '\') -or
        $deviceIdUpper.StartsWith($presentIdUpper + '\')
      }).Count -gt 0
      if ($matchesPresentDevice) {
        $rows += [pscustomobject]@{
          Name = $key.PSChildName
          DeviceId = $deviceId
          IppStartTime = [int64]($props.IppStartTime)
        }
      }
    } catch {
      Log "Cannot inspect USB port $($key.PSChildName): $($_.Exception.Message)"
    }
  }
  return @($rows | Sort-Object IppStartTime -Descending)
}

try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) { throw "Administrator privileges are required" }
  if (-not (Test-Path -LiteralPath $infPath)) { throw "Xprinter.inf was not found at $infPath" }

  $spooler = Get-Service -Name Spooler -ErrorAction SilentlyContinue
  if (-not $spooler) { throw "Windows Print Spooler service was not found" }
  if ($spooler.Status -ne "Running") {
    Log "starting Windows Print Spooler"
    Start-Service -Name Spooler -ErrorAction Stop
    $spooler.WaitForStatus("Running", [TimeSpan]::FromSeconds(15))
  }

  $pnputil = Get-PnpUtilPath
  Log "start runId=$RunId stageOnly=$StageOnly allowDisconnected=$AllowDisconnected inf=$infPath pnputil=$pnputil"
  $pnputilOutput = & $pnputil /add-driver $infPath /install 2>&1
  $pnputilExit = $LASTEXITCODE
  $pnputilOutput | ForEach-Object { Log "pnputil: $_" }
  Log "pnputil exit=$pnputilExit"
  if ($pnputilExit -notin @(0, 259, 3010)) {
    throw "pnputil failed with exit code $pnputilExit"
  }

  if ($StageOnly) {
    Save-Result $true "staged" "" "" ""
    Log "done: driver package staged"
    exit 0
  }

  try {
    & $pnputil /scan-devices 2>&1 | ForEach-Object { Log "scan: $_" }
  } catch {
    Log "device scan failed: $($_.Exception.Message)"
  }

  $presentIds = @()
  $ports = @()
  for ($attempt = 0; $attempt -lt 15; $attempt++) {
    $presentIds = @(Get-PresentXprinterIds)
    $ports = @(Get-ActiveXprinterPorts $presentIds)
    if ($presentIds.Count -and $ports.Count) { break }
    Start-Sleep -Seconds 1
  }
  if (-not $ports.Count) {
    $healthyQueues = @(Get-CimInstance Win32_Printer -ErrorAction SilentlyContinue |
      Where-Object {
        $_.DriverName -eq $model -and
        $_.PortName -match '^USB\d+$' -and
        -not $_.WorkOffline -and
        [int]$_.PrinterStatus -ne 7 -and
        [int]$_.ExtendedPrinterStatus -notin @(6, 7, 8, 9, 11)
      })
    $healthyPorts = @($healthyQueues | Select-Object -ExpandProperty PortName -Unique)
    if ($healthyPorts.Count -eq 1) {
      $ports = @([pscustomobject]@{ Name = $healthyPorts[0]; DeviceId = "queue-fallback"; IppStartTime = 0 })
      if (-not $presentIds.Count) { $presentIds = @("queue:$($healthyQueues[0].Name)") }
      Log "using healthy native queue fallback on $($healthyPorts[0])"
    }
  }
  Log "presentIds=$($presentIds -join ',') activePorts=$($ports.Name -join ',')"
  if (-not $presentIds.Count -and $AllowDisconnected) {
    Save-Result $true "staged-disconnected" "" "" ""
    Log "done: driver package staged; printer is not connected"
    exit 0
  }
  if (-not $presentIds.Count) { throw "The Xprinter XP-365B USB device is not connected" }
  if (-not $ports.Count) { throw "Windows did not create an active USB printer port" }

  $driver = Get-PrinterDriver -Name $model -ErrorAction SilentlyContinue
  if (-not $driver) {
    Log "registering printer driver $model"
    Add-PrinterDriver -Name $model -ErrorAction Stop
    $driver = Get-PrinterDriver -Name $model -ErrorAction SilentlyContinue
  }
  if (-not $driver) { throw "The Xprinter printer driver was not registered" }

  $activeNames = @($ports | ForEach-Object { $_.Name })
  $queue = Get-Printer -ErrorAction SilentlyContinue |
    Where-Object { $activeNames -contains $_.PortName -and $_.DriverName -eq $model } |
    Sort-Object @{ Expression = { if ($_.Name -eq $model) { 0 } else { 1 } } }, Name |
    Select-Object -First 1

  if (-not $queue) {
    $portName = $ports[0].Name
    $canonical = Get-Printer -Name $model -ErrorAction SilentlyContinue
    if ($canonical) {
      Log "rebinding queue '$model' to $portName"
      Set-Printer -Name $model -DriverName $model -PortName $portName -ErrorAction Stop
    } else {
      Log "creating queue '$model' on $portName"
      Add-Printer -Name $model -DriverName $model -PortName $portName -ErrorAction Stop
    }
    $queue = Get-Printer -Name $model -ErrorAction SilentlyContinue
  }
  if (-not $queue) { throw "The Xprinter print queue was not created" }

  $queueName = [string]$queue.Name
  $queuePort = [string]$queue.PortName
  try {
    $escaped = $queueName.Replace("'", "''")
    $cimQueue = Get-CimInstance Win32_Printer -Filter "Name='$escaped'" -ErrorAction Stop
    if ($cimQueue -and $cimQueue.WorkOffline) {
      Log "clearing WorkOffline for '$queueName'"
      Set-CimInstance -InputObject $cimQueue -Property @{ WorkOffline = $false } -ErrorAction Stop | Out-Null
    }
  } catch {
    Log "cannot clear WorkOffline: $($_.Exception.Message)"
    throw
  }

  $finalQueue = Get-Printer -Name $queueName -ErrorAction SilentlyContinue
  if (-not $finalQueue) { throw "The repaired print queue disappeared" }
  if ($activeNames -notcontains $finalQueue.PortName) { throw "The print queue is not bound to an active USB port" }
  if ($finalQueue.DriverName -ne $model) { throw "The print queue uses the wrong driver" }

  Save-Result $true "ready" $finalQueue.Name $finalQueue.PortName ""
  Log "done: queue=$($finalQueue.Name) port=$($finalQueue.PortName)"
  exit 0
} catch {
  $message = [string]$_.Exception.Message
  Log "ERROR: $message"
  Save-Result $false "error" "" "" $message
  exit 1
}
