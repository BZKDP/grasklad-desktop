"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const Jimp = require("jimp");

const PS = "powershell.exe";
const XPRINTER_MODEL = "Xprinter XP-365B";
const CHZ_PRINTER_RX = /tsc\s*te\s*200|tsc|xprinter|xp[-_\s]?365/i;
let printerSetupPromise = null;
let printerStatusPromise = null;
let chzPrinterStatusPromise = null;
let chzPrintChain = Promise.resolve();
let printerStatusCache = null;
let chzPrinterStatusCache = null;
const PRIMARY_PRINT_DEDUP_MS = 15000;
const PRINTER_READY_CACHE_MS = 15000;
const PRINTER_ERROR_CACHE_MS = 1500;

function createSingleFlightGate({ cooldownMs = PRIMARY_PRINT_DEDUP_MS, now = () => Date.now() } = {}) {
  let active = null;
  const recent = new Map();

  return {
    run(key, task, { force = false } = {}) {
      const normalizedKey = String(key || "");
      if (active) {
        if (active.key === normalizedKey) {
          return active.promise.then((result) => ({
            ...result,
            printed: 0,
            deduplicated: true,
            joinedActive: true,
          }));
        }
        const error = new Error("Предыдущее задание печати ещё выполняется. Дождитесь результата, повторно нажимать не нужно.");
        error.code = "PRINT_BUSY";
        return Promise.reject(error);
      }

      const previous = recent.get(normalizedKey);
      if (!force && previous && now() - previous.at < cooldownMs) {
        return Promise.resolve({
          ...previous.result,
          printed: 0,
          deduplicated: true,
          recent: true,
        });
      }

      const taskPromise = Promise.resolve().then(task);
      const trackedPromise = taskPromise.then((result) => {
        recent.set(normalizedKey, { at: now(), result });
        for (const [itemKey, item] of recent) {
          if (now() - item.at >= cooldownMs) recent.delete(itemKey);
        }
        if (active?.promise === trackedPromise) active = null;
        return result;
      }, (error) => {
        if (active?.promise === trackedPromise) active = null;
        throw error;
      });
      active = { key: normalizedKey, promise: trackedPromise };
      return trackedPromise;
    },
  };
}

const primaryPrintGate = createSingleFlightGate();

function printRequestKey(payload, role) {
  const hash = crypto.createHash("sha256");
  hash.update(String(role || "primary"));
  hash.update("\0" + String(payload?.url || ""));
  hash.update("\0" + String(payload?.base64 || payload?.dataUrl || ""));
  hash.update("\0" + String(payload?.copies || 1));
  hash.update("\0" + String(payload?.fitMode || ""));
  hash.update("\0" + String(payload?.layoutMode || ""));
  return hash.digest("hex").slice(0, 24);
}

function printerRuntimeLog(event, details = {}) {
  try {
    const dir = printerSetupStateDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "printer-runtime.log");
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) {
      fs.renameSync(file, file + ".1");
    }
    fs.appendFileSync(file, JSON.stringify({
      at: new Date().toISOString(),
      event: String(event || "printer"),
      ...details,
    }) + "\r\n", "utf8");
  } catch {}
}

function runPs(script, { input, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const utf8Script =
      `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); ` +
      `$OutputEncoding = [Console]::OutputEncoding; ` + script;
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", utf8Script];
    const child = execFile(PS, args, {
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      timeout: Math.max(1000, Number(timeoutMs) || 20000),
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || "").toString().trim()));
      resolve((stdout || "").toString());
    });
    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

async function listPrinters() {
  const out = await runPs("Get-Printer | Select-Object -ExpandProperty Name");
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

async function hasQueue(name) {
  const printers = await listPrinters().catch(() => []);
  return printers.some((p) => p.toLowerCase() === String(name).toLowerCase());
}

// Реальная готовность принтера: очередь есть И принтер не offline (физически подключён).
// (hasQueue недостаточно — очередь остаётся в системе даже когда принтер отключён от USB.)
async function printerReady(name) {
  const q = String(name).replace(/'/g, "''");
  const script =
    `$ErrorActionPreference='SilentlyContinue';` +
    `$p = Get-CimInstance Win32_Printer -Filter "Name='${q}'";` +
    `if (-not $p) { 'NOQUEUE'; return }` +
    `$off = [bool]$p.WorkOffline;` +
    `$st = [int]$p.PrinterStatus;` +      // 7 = Offline
    `$es = [int]$p.ExtendedPrinterStatus;` + // 7=Offline, 1=Other
    `if ($off -or $st -eq 7 -or $es -in @(7,11)) { 'OFFLINE' } ` +
    `elseif ($st -eq 6 -or $es -in @(6,8,9)) { 'ERROR' } else { 'READY' }`;
  try {
    const out = (await runPs(script)).trim();
    return { queue: name, exists: out !== "NOQUEUE", ready: out === "READY", state: out };
  } catch (e) {
    return { queue: name, exists: false, ready: false, state: "ERROR", error: String(e && e.message || e) };
  }
}

// Имена, по которым распознаём термопринтер этикеток, если очередь называется не «Xprinter XP-365B».
const THERMAL_RX = /xprinter|xp[-_\s]?365|xp[-_\s]?58|xp[-_\s]?420|xp[-_\s]?470|pos[-_\s]?58|pos[-_\s]?80|thermal|термо|label|58\s?mm|80\s?mm|receipt|gprinter|zjiang|hprt|bixolon/i;
// Явно НЕ наши очереди (виртуальные/офисные) — их не подхватываем.
const NON_THERMAL_RX = /onenote|pdf|xps|fax|microsoft|snagit|nitro|foxit|adobe|onedrive|pantum|hp\b|canon|epson\s|kyocera|brother/i;

// Подробный список очередей: имя, offline, статус, драйвер, порт.
async function listPrintersDetailed() {
  const script =
    `Get-CimInstance Win32_Printer | ForEach-Object { ` +
    `$_.Name + '|||' + [int]$_.WorkOffline + '|||' + [int]$_.PrinterStatus + '|||' + [int]$_.ExtendedPrinterStatus + '|||' + $_.DriverName + '|||' + $_.PortName }`;
  const out = await runPs(script, { timeoutMs: 8000 }).catch(() => "");
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [name, off, st, extendedStatus, driver, port] = l.split("|||");
    return {
      name,
      offline: off === "1",
      status: Number(st) || 0,
      extendedStatus: Number(extendedStatus) || 0,
      driver: driver || "",
      port: port || "",
    };
  });
}

// USB-порты, на которых реально сидит термопринтер (по описанию порта содержится имя устройства).
async function physicalXprinterState() {
  const script = `
$ErrorActionPreference='SilentlyContinue'
$ids = @()
try {
  $ids = @(Get-PnpDevice -PresentOnly -ErrorAction Stop | Where-Object {
    $label = ([string]$_.FriendlyName + ' ' + [string]$_.Name + ' ' + [string]$_.Manufacturer)
    $_.InstanceId -match '^USB\\\\VID_1FC9&PID_2016' -or
    $_.InstanceId -match '^USBPRINT\\\\.*XP[-_ ]?365B' -or
    (($_.Class -eq 'Printer' -or $_.InstanceId -match '^USBPRINT\\\\') -and $label -match 'XP[-_ ]?365B')
  } | ForEach-Object { $_.InstanceId })
} catch {}
if (-not $ids.Count) {
  try {
    $ids = @(Get-CimInstance Win32_PnPEntity -ErrorAction Stop | Where-Object {
      $label = ([string]$_.Name + ' ' + [string]$_.Description + ' ' + [string]$_.Manufacturer)
      ($_.PNPDeviceID -match '^USB\\\\VID_1FC9&PID_2016' -or
       $_.PNPDeviceID -match '^USBPRINT\\\\.*XP[-_ ]?365B' -or
       (($_.PNPClass -eq 'Printer' -or $_.PNPDeviceID -match '^USBPRINT\\\\') -and $label -match 'XP[-_ ]?365B')) -and
      $_.Status -eq 'OK'
    } | ForEach-Object { $_.PNPDeviceID })
  } catch {}
}
$ids = @($ids | Where-Object { $_ } | Select-Object -Unique)
$ports = @()
$root = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Print\\Monitors\\USB Monitor\\Ports'
if (Test-Path $root) {
  foreach ($key in Get-ChildItem -LiteralPath $root) {
    $props = Get-ItemProperty -LiteralPath $key.PSPath
    $deviceId = [string]$props.'Device Id'
    $deviceIdUpper = $deviceId.ToUpperInvariant()
    $matchesPresentDevice = @($ids | Where-Object {
      $presentIdUpper = ([string]$_).ToUpperInvariant()
      $presentIdUpper -eq $deviceIdUpper -or
      $presentIdUpper.StartsWith($deviceIdUpper + '\\') -or
      $deviceIdUpper.StartsWith($presentIdUpper + '\\')
    }).Count -gt 0
    if ($matchesPresentDevice) { $ports += $key.PSChildName }
  }
}
[pscustomobject]@{ present=[bool]$ids.Count; ids=@($ids); activePorts=@($ports | Select-Object -Unique) } | ConvertTo-Json -Compress
`;
  try {
    const raw = (await runPs(script, { timeoutMs: 8000 })).replace(/^\uFEFF/, "").trim();
    const parsed = JSON.parse(raw || "{}");
    return {
      present: !!parsed.present,
      ids: Array.isArray(parsed.ids) ? parsed.ids : (parsed.ids ? [parsed.ids] : []),
      activePorts: Array.isArray(parsed.activePorts) ? parsed.activePorts : (parsed.activePorts ? [parsed.activePorts] : []),
    };
  } catch (e) {
    return { present: false, ids: [], activePorts: [], error: String(e && e.message || e) };
  }
}

async function physicalChzPrinterState() {
  const script = `
$ErrorActionPreference='SilentlyContinue'
$ids = @()
try {
  $ids = @(Get-PnpDevice -PresentOnly -ErrorAction Stop | Where-Object {
    $label = ([string]$_.FriendlyName + ' ' + [string]$_.Name + ' ' + [string]$_.Manufacturer + ' ' + [string]$_.InstanceId)
    $_.InstanceId -match '^USB\\\\VID_1203&PID_0272' -or
    $_.InstanceId -match '^USB\\\\VID_1FC9&PID_2016' -or
    $_.InstanceId -match '^USBPRINT\\\\' -or
    $label -match 'TSC|TE200|XP[-_ ]?365B|Xprinter'
  } | ForEach-Object { $_.InstanceId })
} catch {}
if (-not $ids.Count) {
  try {
    $ids = @(Get-CimInstance Win32_PnPEntity -ErrorAction Stop | Where-Object {
      $label = ([string]$_.Name + ' ' + [string]$_.Description + ' ' + [string]$_.Manufacturer + ' ' + [string]$_.PNPDeviceID)
      ($_.PNPDeviceID -match '^USB\\\\VID_1203&PID_0272' -or
       $_.PNPDeviceID -match '^USB\\\\VID_1FC9&PID_2016' -or
       $_.PNPDeviceID -match '^USBPRINT\\\\' -or
       $label -match 'TSC|TE200|XP[-_ ]?365B|Xprinter') -and
      $_.Status -eq 'OK'
    } | ForEach-Object { $_.PNPDeviceID })
  } catch {}
}
$ids = @($ids | Where-Object { $_ } | Select-Object -Unique)
$ports = @()
$root = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Print\\Monitors\\USB Monitor\\Ports'
if (Test-Path $root) {
  foreach ($key in Get-ChildItem -LiteralPath $root) {
    $props = Get-ItemProperty -LiteralPath $key.PSPath
    $deviceId = [string]$props.'Device Id'
    $deviceIdUpper = $deviceId.ToUpperInvariant()
    $matchesPresentDevice = @($ids | Where-Object {
      $presentIdUpper = ([string]$_).ToUpperInvariant()
      $presentIdUpper -eq $deviceIdUpper -or
      $presentIdUpper.StartsWith($deviceIdUpper + '\\') -or
      $deviceIdUpper.StartsWith($presentIdUpper + '\\')
    }).Count -gt 0
    if ($matchesPresentDevice) { $ports += $key.PSChildName }
  }
}
[pscustomobject]@{ present=[bool]$ids.Count; ids=@($ids); activePorts=@($ports | Select-Object -Unique) } | ConvertTo-Json -Compress
`;
  try {
    const raw = (await runPs(script, { timeoutMs: 8000 })).replace(/^\uFEFF/, "").trim();
    const parsed = JSON.parse(raw || "{}");
    return {
      present: !!parsed.present,
      ids: Array.isArray(parsed.ids) ? parsed.ids : (parsed.ids ? [parsed.ids] : []),
      activePorts: Array.isArray(parsed.activePorts) ? parsed.activePorts : (parsed.activePorts ? [parsed.activePorts] : []),
    };
  } catch (e) {
    return { present: false, ids: [], activePorts: [], error: String(e && e.message || e) };
  }
}

function queueHasHardError(printer) {
  const status = Number(printer && printer.status || 0);
  const extendedStatus = Number(printer && printer.extendedStatus || 0);
  return [6, 7].includes(status) || [6, 7, 8, 9, 11].includes(extendedStatus);
}

function queueStatusFromDetails(printer) {
  if (!printer) return null;
  const status = Number(printer.status || 0);
  const extendedStatus = Number(printer.extendedStatus || 0);
  const offline = !!printer.offline || status === 7 || [7, 11].includes(extendedStatus);
  const state = offline ? "OFFLINE" : (queueHasHardError(printer) ? "ERROR" : "READY");
  return {
    queue: printer.name,
    exists: true,
    ready: state === "READY",
    state,
  };
}

function selectPrinterQueue(all, configured, activePorts, physicalPresent) {
  const names = all.map((p) => p.name);
  const active = new Set(Array.from(activePorts || [], (p) => String(p).toLowerCase()));
  const onActivePort = (p) => active.has(String(p.port || "").toLowerCase());
  const isThermal = (p) =>
    (/xprinter|xp[-_\s]?365/i.test(p.name) || /xprinter|xp[-_\s]?365/i.test(p.driver)) &&
    !NON_THERMAL_RX.test(p.name);
  const generic = (p) => /generic|text only/i.test(p.driver);
  const correctDriver = (p) => !generic(p) && /xprinter|xp.?365/i.test(p.driver);
  const hasError = queueHasHardError;
  const nativeQueues = all.filter((p) => isThermal(p) && correctDriver(p));
  const healthyNativeQueues = nativeQueues.filter(
    (p) => !p.offline && !hasError(p) && /^USB\d+$/i.test(String(p.port || ""))
  );
  const liveNativePorts = Array.from(
    new Set(healthyNativeQueues.map((p) => String(p.port).toLowerCase()))
  );
  const inferredPhysicalPresent = !physicalPresent && active.size === 0 && liveNativePorts.length === 1;
  const effectivePhysicalPresent = physicalPresent || inferredPhysicalPresent;
  if (effectivePhysicalPresent && active.size === 0 && liveNativePorts.length === 1) {
    active.add(liveNativePorts[0]);
  }
  const rank = (p) => {
    let score = 0;
    if (onActivePort(p)) score += 1000;
    if (!p.offline && !hasError(p)) score += 100;
    if (correctDriver(p)) score += 20;
    if (configured && p.name.toLowerCase() === String(configured).toLowerCase()) score += 10;
    if (!/\(.*\)|RAW/i.test(p.name)) score += 5;
    return score;
  };
  const candidates = nativeQueues.sort((a, b) => rank(b) - rank(a));
  const best = candidates.find(onActivePort) || candidates[0];
  const onLivePort = !!(effectivePhysicalPresent && best && onActivePort(best));
  const found = !!(onLivePort && correctDriver(best));

  if (found) {
    return {
      queue: best.name,
      queueDetails: best,
      printers: names,
      candidateQueues: candidates.map((p) => p.name),
      onLivePort,
      adopted: best.name.toLowerCase() !== String(configured || "").toLowerCase(),
      inferredPhysicalPresent,
      found,
    };
  }
  const configuredNative = candidates.find(
    (p) => configured && p.name.toLowerCase() === String(configured).toLowerCase()
  );
  if (configuredNative) {
    return {
      queue: configuredNative.name,
      queueDetails: configuredNative,
      printers: names,
      candidateQueues: candidates.map((p) => p.name),
      onLivePort: false,
      adopted: false,
      inferredPhysicalPresent,
      found: false,
    };
  }
  return {
    queue: (best && best.name) || configured || XPRINTER_MODEL,
    queueDetails: best || null,
    printers: names,
    candidateQueues: candidates.map((p) => p.name),
    onLivePort,
    adopted: false,
    inferredPhysicalPresent,
    found: false,
  };
}

async function resolvePrinterQueue(cfg) {
  const configured = process.env.LABEL_PRINTER || (cfg && cfg.printerQueue);
  const [all, physical] = await Promise.all([
    listPrintersDetailed().catch(() => []),
    physicalXprinterState(),
  ]);
  const selected = selectPrinterQueue(all, configured, physical.activePorts, physical.present);
  return {
    ...selected,
    physicalPresent: physical.present || selected.inferredPhysicalPresent,
    deviceIds: physical.ids,
    activePorts: physical.activePorts,
    detectionError: physical.error,
  };
}

async function resolveChzPrinterQueue(cfg) {
  const configured = process.env.CHZ_PRINTER || (cfg && cfg.chzPrinterQueue) || "";
  const [all, physical, chzPhysical] = await Promise.all([
    listPrintersDetailed().catch(() => []),
    physicalXprinterState(),
    physicalChzPrinterState(),
  ]);
  const primary = selectPrinterQueue(all, process.env.LABEL_PRINTER || (cfg && cfg.printerQueue), physical.activePorts, physical.present);
  const primaryName = String(primary.queue || "").toLowerCase();
  const candidates = all.filter((item) => String(item.name || "").toLowerCase() !== primaryName);
  const exact = configured
    ? candidates.find((item) => String(item.name || "").toLowerCase() === String(configured).toLowerCase())
    : null;
  const isChzThermal = (item) => {
    const label = `${item?.name || ""} ${item?.driver || ""}`;
    return CHZ_PRINTER_RX.test(label) && !NON_THERMAL_RX.test(label);
  };
  const chzActive = new Set(Array.from(chzPhysical.activePorts || [], (port) => String(port).toLowerCase()));
  const onChzPort = (item) => chzActive.has(String(item?.port || "").toLowerCase());
  const healthy = (item) => !!item && !item.offline && !queueHasHardError(item) && /^USB\d+$/i.test(String(item.port || ""));
  const readyChzQueue = (item) => healthy(item) && onChzPort(item);
  const isTsc = (item) => /tsc\s*te\s*200|tsc/i.test(`${item?.name || ""} ${item?.driver || ""}`);
  if (exact && isChzThermal(exact)) {
    return {
      queue: exact.name,
      queueDetails: exact,
      printers: all.map((p) => p.name),
      candidateQueues: candidates.filter(isChzThermal).map((p) => p.name),
      onLivePort: readyChzQueue(exact),
      adopted: false,
      found: readyChzQueue(exact),
      physicalPresent: readyChzQueue(exact),
      deviceIds: chzPhysical.ids,
      activePorts: chzPhysical.activePorts,
      primaryQueue: primary.queue || null,
      configured: true,
      ambiguous: false,
      detectionError: chzPhysical.error,
    };
  }
  const tscCandidates = candidates.filter((item) => isTsc(item) && readyChzQueue(item));
  if (!exact && tscCandidates.length === 1) {
    const tsc = tscCandidates[0];
    return {
      queue: tsc.name,
      queueDetails: tsc,
      printers: all.map((p) => p.name),
      candidateQueues: candidates.filter(isChzThermal).map((p) => p.name),
      onLivePort: true,
      adopted: true,
      found: true,
      physicalPresent: true,
      deviceIds: chzPhysical.ids,
      activePorts: chzPhysical.activePorts,
      primaryQueue: primary.queue || null,
      configured: false,
      ambiguous: false,
      detectionError: chzPhysical.error,
    };
  }
  const selected = selectPrinterQueue(exact ? [exact] : candidates, configured, physical.activePorts, physical.present);
  const liveCandidates = candidates.filter((item) => {
    const active = new Set(Array.from(physical.activePorts || [], (port) => String(port).toLowerCase()));
    return active.has(String(item.port || "").toLowerCase()) && !item.offline && !queueHasHardError(item) &&
      (/xprinter|xp[-_\s]?365/i.test(item.name) || /xprinter|xp.?365/i.test(item.driver));
  });
  const unambiguous = exact ? selected.onLivePort : liveCandidates.length === 1;
  return {
    ...selected,
    found: selected.found && unambiguous,
    physicalPresent: physical.present || selected.inferredPhysicalPresent,
    deviceIds: physical.ids,
    activePorts: physical.activePorts,
    primaryQueue: primary.queue || null,
    configured: !!configured,
    ambiguous: !exact && liveCandidates.length > 1,
    detectionError: physical.error,
  };
}

// Снять залипший флаг «Использовать принтер автономно» (WorkOffline) — частая причина
// ложного «не подключён» у локального USB-принтера.
async function clearWorkOffline(name) {
  const q = String(name).replace(/'/g, "''");
  try {
    const out = await runPs(
      `$ErrorActionPreference='Stop'; $p = Get-CimInstance Win32_Printer -Filter "Name='${q}'"; ` +
      `if (-not $p) { 'NOQUEUE'; return }; ` +
      `if ($p.WorkOffline) { Set-CimInstance -InputObject $p -Property @{WorkOffline=$false} | Out-Null }; 'OK'`
    );
    return { ok: /OK/.test(out), output: out.trim() };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// Статус принтера с автоподбором очереди (для карточки железа).
// Если очередь на живом порту, но показывает OFFLINE из-за WorkOffline — снимаем флаг и перечитываем.
async function readPrinterStatus(cfg) {
  const res = await resolvePrinterQueue(cfg);
  let r = queueStatusFromDetails(res.queueDetails) || await printerReady(res.queue);
  if (!r.ready && res.onLivePort && r.state === "OFFLINE") {
    await clearWorkOffline(res.queue);
    r = await printerReady(res.queue);
  }
  const ready = !!(r.ready && res.physicalPresent && res.onLivePort);
  return {
    ...r,
    ready,
    state: res.physicalPresent ? r.state : "DISCONNECTED",
    queue: res.queue,
    adopted: ready && res.adopted,
    foundByName: res.found,
    onLivePort: res.onLivePort,
    physicalPresent: res.physicalPresent,
    setupRequired: !!(res.physicalPresent && !ready),
    allPrinters: res.printers,
  };
}

async function printerStatus(cfg) {
  const cacheKey = String(process.env.LABEL_PRINTER || cfg?.printerQueue || "").trim().toLowerCase();
  const cacheTtl = printerStatusCache?.result?.ready ? PRINTER_READY_CACHE_MS : PRINTER_ERROR_CACHE_MS;
  if (printerStatusCache?.key === cacheKey && Date.now() - printerStatusCache.at < cacheTtl) {
    return { ...printerStatusCache.result, cached: true };
  }
  if (printerStatusPromise) return printerStatusPromise;
  printerStatusPromise = readPrinterStatus(cfg);
  try {
    const result = await printerStatusPromise;
    printerStatusCache = { key: cacheKey, at: Date.now(), result };
    return result;
  } finally {
    printerStatusPromise = null;
  }
}

async function readChzPrinterStatus(cfg) {
  if (cfg?.chzPrinterEnabled !== true) {
    return { queue: cfg?.chzPrinterQueue || "", exists: false, ready: false, state: "DISABLED", enabled: false };
  }
  const res = await resolveChzPrinterQueue(cfg);
  if (String(res.queue || "").toLowerCase() === String(res.primaryQueue || "").toLowerCase()) {
    return { queue: res.queue, exists: true, ready: false, state: "SAME_AS_PRIMARY", enabled: true, primaryQueue: res.primaryQueue };
  }
  let status = queueStatusFromDetails(res.queueDetails) || await printerReady(res.queue);
  if (!status.ready && res.onLivePort && status.state === "OFFLINE") {
    await clearWorkOffline(res.queue);
    status = await printerReady(res.queue);
  }
  const ready = !!(status.ready && res.found && res.onLivePort);
  return {
    ...status,
    ready,
    enabled: true,
    state: res.ambiguous ? "AMBIGUOUS" : (res.physicalPresent ? status.state : "DISCONNECTED"),
    queue: res.queue,
    adopted: ready && res.adopted,
    onLivePort: res.onLivePort,
    physicalPresent: res.physicalPresent,
    primaryQueue: res.primaryQueue,
    ambiguous: res.ambiguous,
    allPrinters: res.printers,
  };
}

async function chzPrinterStatus(cfg) {
  const cacheKey = [
    process.env.CHZ_PRINTER || cfg?.chzPrinterQueue || "",
    process.env.LABEL_PRINTER || cfg?.printerQueue || "",
    cfg?.chzPrinterEnabled === true ? "1" : "0",
  ].join("\\0").toLowerCase();
  const cacheTtl = chzPrinterStatusCache?.result?.ready ? PRINTER_READY_CACHE_MS : PRINTER_ERROR_CACHE_MS;
  if (chzPrinterStatusCache?.key === cacheKey && Date.now() - chzPrinterStatusCache.at < cacheTtl) {
    return { ...chzPrinterStatusCache.result, cached: true };
  }
  if (chzPrinterStatusPromise) return chzPrinterStatusPromise;
  chzPrinterStatusPromise = readChzPrinterStatus(cfg);
  try {
    const result = await chzPrinterStatusPromise;
    chzPrinterStatusCache = { key: cacheKey, at: Date.now(), result };
    return result;
  } finally {
    chzPrinterStatusPromise = null;
  }
}

// Папка с вшитыми драйверами (принтер + CH340 сканера).
function driverDir() {
  return process.resourcesPath
    ? path.join(process.resourcesPath, "printer-driver")
    : path.join(__dirname, "..", "printer-driver");
}

// Рекурсивно найти все *.inf в папке драйверов.
function findInfFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.toLowerCase().endsWith(".inf")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function readFileTail(p, n = 4000) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, "utf8").slice(-n) : ""; } catch { return ""; }
}
// Совместимость: лог рядом со скриптом (старый путь)
function readDriverLog(dir) {
  return readFileTail(path.join(dir || driverDir(), "driver-install.log"));
}

function printerSetupStateDir() {
  return path.join(process.env.ProgramData || "C:\\ProgramData", "GRA-sklad");
}

function readJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function installPrinterElevated() {
  const scriptPath = path.join(driverDir(), "install-printer.ps1");
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, error: "Xprinter setup script is missing: " + scriptPath };
  }

  const runId = crypto.randomBytes(12).toString("hex");
  const stateDir = printerSetupStateDir();
  const resultPath = path.join(stateDir, "printer-install-result.json");
  const logPath = path.join(stateDir, "printer-install.log");
  const argumentLine = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}" -RunId "${runId}"`;
  const command =
    `$ErrorActionPreference='Stop'; try { ` +
    `$p = Start-Process -FilePath ${psQuote(PS)} -ArgumentList ${psQuote(argumentLine)} -Verb RunAs -PassThru -Wait -WindowStyle Hidden; ` +
    `"EXIT=$($p.ExitCode)" } catch { "RUNAS_ERROR=$($_.Exception.Message)" }`;

  let output = "";
  try {
    output = (await runPs(command, { timeoutMs: 10 * 60 * 1000 })).trim();
  } catch (e) {
    output = "RUNPS_ERROR=" + String(e && e.message || e);
  }

  const declined = /RUNAS_ERROR|1223|operation was canceled|operation was cancelled|canceled by the user|отмен/i.test(output);
  const result = readJsonFile(resultPath);
  const log = readFileTail(logPath, 12000);
  if (declined) return { ok: false, declined: true, output, log };
  if (!result || result.runId !== runId) {
    return { ok: false, output, log, error: "Windows did not return a current Xprinter setup result" };
  }
  return { ...result, output, log };
}

// Установка ВСЕХ вшитых драйверов (принтер + CH340 сканера) через статический
// install-drivers.bat (тот же, что зовёт установщик). .bat не зависит от PowerShell
// ExecutionPolicy/кодировки. Успех определяется НЕ кодом возврата, а фактом завершения
// (метка [done]); финальную проверку по COM-порту делает main.js.
// Возвращает { ok, declined, done, log }.
async function installBundledDrivers({ elevated = true } = {}) {
  const dir = driverDir();
  const batPath = path.join(dir, "install-drivers.bat");
  if (!fs.existsSync(batPath)) {
    // запасной путь: если .bat не вшит — сгенерируем на лету
    const infs = findInfFiles(dir);
    if (!infs.length) return { ok: false, error: "Драйверы не найдены в " + dir };
  }
  const logPath = path.join(dir, "driver-install.log");
  try { fs.unlinkSync(logPath); } catch {}

  let out = "";
  try {
    if (elevated) {
      const cmd =
        `try { $p = Start-Process -FilePath "cmd.exe" -ArgumentList '/c','"${batPath}"' -Verb RunAs -PassThru -Wait -WindowStyle Hidden; ` +
        `"EXIT=$($p.ExitCode)" } catch { "RUNAS_ERROR=$($_.Exception.Message)" }`;
      out = (await runPs(cmd, { timeoutMs: 10 * 60 * 1000 })).trim();
    } else {
      out = (await runPs(`cmd /c "${batPath}"`)).trim();
    }
  } catch (e) {
    out = "RUNPS_ERROR=" + String(e.message || e);
  }

  const log = readFileTail(logPath);
  const declined = /RUNAS_ERROR|The operation was canceled|отменен|canceled by the user/i.test(out);
  const done = /\[done\]/i.test(log);
  return { ok: done && !declined, declined, done, out, log };
}

async function ensureDriverInstalled(cfg) {
  if (printerSetupPromise) return printerSetupPromise;

  printerSetupPromise = (async () => {
    const before = await printerStatus(cfg);
    if (before.ready) {
      return { ok: true, alreadyInstalled: true, queue: before.queue, adopted: before.adopted };
    }
    if (!before.physicalPresent) {
      return {
        ok: false,
        connected: false,
        skipped: true,
        queue: before.queue,
        error: "Xprinter XP-365B is not connected",
      };
    }

    const installed = await installPrinterElevated();
    if (!installed.ok) {
      return {
        ok: false,
        connected: true,
        declined: !!installed.declined,
        error: installed.declined
          ? "Windows administrator request was declined"
          : (installed.error || "Xprinter setup failed"),
        log: installed.log,
      };
    }

    let after = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      after = await printerStatus(cfg);
      if (after.ready) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!after || !after.ready) {
      return {
        ok: false,
        connected: true,
        queue: after && after.queue,
        error: "Xprinter setup completed, but the active print queue is not ready",
        log: installed.log,
      };
    }
    return { ok: true, installedNow: true, queue: after.queue, adopted: after.adopted, log: installed.log };
  })();

  try {
    return await printerSetupPromise;
  } finally {
    printerSetupPromise = null;
  }
}

// Скачать/декодировать PDF в буфер
async function resolvePdfBuffer(payload) {
  if (payload.base64) return Buffer.from(payload.base64, "base64");
  if (payload.dataUrl) {
    const m = /^data:.*?;base64,(.*)$/.exec(payload.dataUrl);
    if (m) return Buffer.from(m[1], "base64");
  }
  if (payload.url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let res;
    try {
      res = await fetch(payload.url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) throw new Error("Не удалось скачать этикетку: HTTP " + res.status);
    const ab = await res.arrayBuffer();
    if (ab.byteLength > 64 * 1024 * 1024) throw new Error("Файл этикеток слишком большой (более 64 МБ)");
    return Buffer.from(ab);
  }
  throw new Error("Нет данных этикетки (url/base64/dataUrl)");
}

// Рендер всех страниц PDF в PNG-буферы (pdf-to-img, ESM → dynamic import)
async function pdfToPngBuffers(pdfBuffer) {
  const { pdf } = await import("pdf-to-img");
  const doc = await pdf(pdfBuffer, { scale: 3 }); // scale для достаточного DPI
  const pages = [];
  for await (const page of doc) pages.push(page); // page = PNG Buffer
  return pages;
}

// Если пришёл готовый PNG (сервер уже отрендерил) — используем как есть
function isPng(buf) {
  return buf && buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

function normalizeCopies(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(100, Math.floor(parsed));
}

function chzTwoUpPagePairIndexes(pageCount, sheetIndex) {
  const count = Math.max(1, Math.floor(Number(pageCount) || 1));
  const left = (Math.max(0, Math.floor(Number(sheetIndex) || 0)) * 2) % count;
  return [left, count === 1 ? left : (left + 1) % count];
}

function decodePngDataUrl(value) {
  const match = /^data:image\/png;base64,(.+)$/i.exec(String(value || ""));
  return match ? Buffer.from(match[1], "base64") : null;
}

function containScale(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  if (![sourceWidth, sourceHeight, targetWidth, targetHeight].every((value) => Number(value) > 0)) return 0;
  return Math.min(Number(targetWidth) / Number(sourceWidth), Number(targetHeight) / Number(sourceHeight));
}

function shouldRotateForBestFit(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const normalScale = containScale(sourceWidth, sourceHeight, targetWidth, targetHeight);
  const rotatedScale = containScale(sourceHeight, sourceWidth, targetWidth, targetHeight);
  return rotatedScale > normalScale + 0.000001;
}

function findInkBounds(img, threshold = 245) {
  const width = Number(img?.bitmap?.width || 0);
  const height = Number(img?.bitmap?.height || 0);
  if (!width || !height) return null;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (width * y + x) << 2;
      const data = img.bitmap.data;
      if (data[index] < threshold || data[index + 1] < threshold || data[index + 2] < threshold) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < 0 || maxY < 0) return null;
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function trimOuterWhitespace(img) {
  const bounds = findInkBounds(img);
  if (!bounds) return img;
  const pad = Math.max(4, Math.round(Math.max(img.bitmap.width, img.bitmap.height) * 0.015));
  const x = Math.max(0, bounds.minX - pad);
  const y = Math.max(0, bounds.minY - pad);
  const right = Math.min(img.bitmap.width - 1, bounds.maxX + pad);
  const bottom = Math.min(img.bitmap.height - 1, bounds.maxY + pad);
  return img.crop(x, y, right - x + 1, bottom - y + 1);
}

async function prepareChzTwoUpTile(pngBuffer) {
  let image = await Jimp.read(pngBuffer);
  image = trimOuterWhitespace(image);
  image.contain(
    170,
    170,
    Jimp.HORIZONTAL_ALIGN_CENTER | Jimp.VERTICAL_ALIGN_MIDDLE,
  );
  return image;
}

async function buildChzTwoUpCanvas(leftPng, rightPng, captionPng = null) {
  const canvas = new Jimp(464, 320, 0xffffffff);
  const [left, right] = await Promise.all([
    prepareChzTwoUpTile(leftPng),
    prepareChzTwoUpTile(rightPng),
  ]);
  canvas.composite(left, 31, 18);
  canvas.composite(right, 263, 18);

  if (captionPng) {
    const caption = await Jimp.read(captionPng);
    caption.contain(
      232,
      38,
      Jimp.HORIZONTAL_ALIGN_CENTER | Jimp.VERTICAL_ALIGN_MIDDLE,
    );
    canvas.composite(caption, 0, 204);
    canvas.composite(caption.clone(), 232, 204);
  }

  const black = 0x000000ff;
  for (let x = 230; x <= 233; x++) {
    for (let y = 0; y < 14; y++) canvas.setPixelColor(black, x, y);
    for (let y = 306; y < 320; y++) canvas.setPixelColor(black, x, y);
  }
  return canvas;
}

async function prepareLabelCanvas(pngBuffer, cfg, options = {}) {
  const widthMm = Number(cfg.labelWidthMm || 58);
  const heightMm = Number(cfg.labelHeightMm || 40);
  const dpmm = 8;
  const W = Math.round(widthMm * dpmm);
  const H = Math.round(heightMm * dpmm);
  const packageMode = options.fitMode === "package";
  let img = await Jimp.read(pngBuffer);

  if (packageMode) {
    img = trimOuterWhitespace(img);
    if (shouldRotateForBestFit(img.bitmap.width, img.bitmap.height, W, H)) img.rotate(90);
  }

  const requestedScale = Number(cfg.labelScale);
  const inner = Number.isFinite(requestedScale)
    ? Math.max(0.5, Math.min(1, requestedScale))
    : (packageMode ? 0.98 : 0.9);
  const targetW = Math.round(W * inner);
  const targetH = Math.round(H * inner);
  img.contain(targetW, targetH, Jimp.HORIZONTAL_ALIGN_CENTER | Jimp.VERTICAL_ALIGN_MIDDLE);

  const canvas = new Jimp(W, H, 0xffffffff);
  const offX = Math.round((W - img.bitmap.width) / 2);
  const offY = Math.round((H - img.bitmap.height) / 2);
  canvas.composite(img, offX, offY);
  return canvas;
}

// Собрать TSPL для одной этикетки из PNG-буфера
async function pngToTspl(pngBuffer, cfg, options = {}) {
  const widthMm = Number(cfg.labelWidthMm || 58);
  const heightMm = Number(cfg.labelHeightMm || 40);
  const dpmm = 8; // 203 dpi ≈ 8 точек/мм
  const W = Math.round(widthMm * dpmm); // 464
  const H = Math.round(heightMm * dpmm); // 320
  const widthBytes = Math.ceil(W / 8);

  const canvas = await prepareLabelCanvas(pngBuffer, cfg, options);
  const threshold = Number.isFinite(Number(options.threshold))
    ? Math.max(1, Math.min(254, Number(options.threshold)))
    : 128;
  // «contain» с 10% полем (SCALE 0.9 из print_label_fit.py)

  // холст W×H белый, вставляем по центру
  canvas.grayscale();

  // Пакуем в 1-bit: TSPL mode 0 — бит 0 = печатать чёрное, бит 1 = белое
  const bytes = Buffer.alloc(widthBytes * H, 0xff);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (canvas.bitmap.width * y + x) << 2;
      const lum = canvas.bitmap.data[idx]; // grayscale → R=G=B
      if (lum < threshold) {
        const byteIndex = y * widthBytes + (x >> 3);
        const bit = 7 - (x & 7);
        bytes[byteIndex] &= ~(1 << bit); // сброс бита = чёрная точка
      }
    }
  }

  const header = Buffer.from(
    `SIZE ${widthMm} mm,${heightMm} mm\r\n` +
    `GAP 2 mm,0 mm\r\n` +
    `DIRECTION 0\r\n` +
    `REFERENCE 0,0\r\n` +
    `DENSITY 8\r\n` +
    `SPEED 4\r\n` +
    `CLS\r\n` +
    `BITMAP 0,0,${widthBytes},${H},0,`,
    "ascii"
  );
  const tail = Buffer.from(`\r\nPRINT 1,1\r\n`, "ascii");
  return Buffer.concat([header, bytes, tail]);
}

// RAW-отправка байтов в очередь печати через winspool (WritePrinter) из PowerShell
async function waitForPrintJob(queue, jobId, timeoutMs = 1500) {
  if (!Number.isInteger(Number(jobId)) || Number(jobId) <= 0) return { state: "UNKNOWN" };
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
if (-not (Get-Command Get-PrintJob -ErrorAction SilentlyContinue)) { 'UNKNOWN'; return }
$deadline = [DateTime]::UtcNow.AddMilliseconds(${Math.max(500, Number(timeoutMs) || 4500)})
$last = ''
do {
  $job = Get-PrintJob -PrinterName ${psQuote(queue)} -ID ${Number(jobId)} -ErrorAction SilentlyContinue
  if (-not $job) { 'DONE'; return }
  $last = [string]$job.JobStatus
  if ($last -match 'Offline|PaperOut|Blocked|UserIntervention|Deleting') {
    'ERROR|||' + $last
    return
  }
  if ($last -match 'Error' -and $last -notmatch 'Printing') {
    'ERROR|||' + $last
    return
  }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)
'QUEUED|||' + $last
`;
  const out = (await runPs(script, { timeoutMs: Math.max(10000, Number(timeoutMs) + 5000) })).trim();
  const [state, status = ""] = out.split("|||");
  return { state: state || "UNKNOWN", status };
}

async function cancelPrintJob(queue, jobId) {
  if (!Number.isInteger(Number(jobId)) || Number(jobId) <= 0) return;
  await runPs(
    `Remove-PrintJob -PrinterName ${psQuote(queue)} -ID ${Number(jobId)} -ErrorAction SilentlyContinue`
  ).catch(() => {});
}

async function sendRaw(queue, buffer, { verify = true, verifyTimeoutMs = 4500, documentName = "GRA label", requestKey = "" } = {}) {
  const tmp = path.join(os.tmpdir(), "grasklad_label_" + crypto.randomBytes(6).toString("hex") + ".bin");
  fs.writeFileSync(tmp, buffer);
  const script = `
$ErrorActionPreference = 'Stop'
$sig = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
public class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.Drv", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool OpenPrinter(string src, out IntPtr h, IntPtr d);
  [DllImport("winspool.Drv", SetLastError=true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.Drv", CharSet=CharSet.Unicode, SetLastError=true)] static extern int StartDocPrinter(IntPtr h, int lvl, ref DOCINFO di);
  [DllImport("winspool.Drv", SetLastError=true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.Drv", SetLastError=true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", SetLastError=true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", SetLastError=true)] static extern bool WritePrinter(IntPtr h, byte[] buf, int count, out int written);
  public static int Send(string printer, string file, string documentName) {
    byte[] bytes = File.ReadAllBytes(file);
    IntPtr h; DOCINFO di = new DOCINFO(); di.pDocName = documentName; di.pDataType = "RAW";
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) return 0;
    int jobId = StartDocPrinter(h, 1, ref di);
    if (jobId <= 0) { ClosePrinter(h); return 0; }
    if (!StartPagePrinter(h)) { EndDocPrinter(h); ClosePrinter(h); return 0; }
    int written; bool ok = WritePrinter(h, bytes, bytes.Length, out written) && written == bytes.Length;
    EndPagePrinter(h); EndDocPrinter(h); ClosePrinter(h);
    return ok ? jobId : 0;
  }
}
'@
Add-Type -TypeDefinition $sig -Language CSharp
$res = [RawPrinter]::Send(${psQuote(queue)}, ${psQuote(tmp)}, ${psQuote(documentName)})
if ($res -gt 0) { "JOB=$res" } else { "FAIL" }
`;
  try {
    const out = await runPs(script);
    const match = /JOB=(\d+)/.exec(out);
    if (!match) throw new Error("Печать не удалась (WritePrinter вернул FAIL). Проверьте очередь: " + queue);
    const jobId = Number(match[1]);
    printerRuntimeLog("job_accepted", { queue, jobId, requestKey, verifyTimeoutMs });
    if (verify) {
      const verifyStartedAt = Date.now();
      const result = await waitForPrintJob(queue, jobId, verifyTimeoutMs);
      if (result.state === "ERROR") {
        await cancelPrintJob(queue, jobId);
        printerRuntimeLog("job_cancelled", { queue, jobId, requestKey, state: result.state, status: result.status || "" });
        const error = new Error(
          `Очередь ${queue} не передала задание принтеру${result.status ? ` (${result.status})` : ""}`
        );
        error.code = "PRINT_JOB_STUCK";
        throw error;
      }
      printerRuntimeLog(result.state === "DONE" ? "job_delivered" : "job_queued", {
        queue,
        jobId,
        requestKey,
        state: result.state,
        status: result.status || "",
        waitMs: Date.now() - verifyStartedAt,
      });
      return { jobId, deliveryState: result.state, jobStatus: result.status || "" };
    }
    return { jobId };
  } catch (error) {
    printerRuntimeLog("job_failed", {
      queue,
      requestKey,
      code: String(error?.code || "PRINT_FAILED"),
      error: String(error?.message || error).slice(0, 1000),
    });
    throw error;
  } finally {
    fs.unlink(tmp, () => {});
  }
}

async function sendRawWithRecovery(queue, buffer, cfg, options = {}) {
  try {
    // WritePrinter only confirms that Windows accepted bytes. Wait until the job
    // leaves the spooler; otherwise delayed jobs accumulate and print in a batch.
    const sent = await sendRaw(queue, buffer, {
      verify: true,
      verifyTimeoutMs: options.verifyTimeoutMs,
      documentName: options.documentName,
      requestKey: options.requestKey,
    });
    return { queue, recovered: false, ...sent };
  } catch (firstError) {
    // Driver repair is an explicit admin action. Never interrupt a worker's
    // packing flow with UAC after a print attempt.
    throw firstError;
  }
}

function buildTestTspl(cfg) {
  const w = Number(cfg.labelWidthMm || 58);
  const h = Number(cfg.labelHeightMm || 40);
  const dpmm = 8;
  const W = Math.round(w * dpmm);
  const H = Math.round(h * dpmm);
  const small = W <= 220 || H <= 220;
  return Buffer.from(
    `SIZE ${w} mm,${h} mm\r\nGAP 2 mm,0 mm\r\nDIRECTION 0\r\nDENSITY 8\r\nSPEED 4\r\nCLS\r\n` +
    `BOX 8,8,${Math.max(16, W - 8)},${Math.max(16, H - 8)},2\r\n` +
    (small
      ? `TEXT 18,22,"2",0,1,1,"CHZ"\r\nTEXT 18,62,"1",0,1,1,"20x20"\r\nBAR 18,108,${Math.max(40, W - 36)},10\r\n`
      : `TEXT 40,60,"3",0,1,1,"GRA-sklad"\r\nTEXT 40,130,"2",0,1,1,"Test print OK"\r\nTEXT 40,190,"2",0,1,1,"${w}x${h} thermal"\r\n`) +
    `PRINT 1,1\r\n`,
    "ascii"
  );
}

function getPrintProfile(cfg, role) {
  if (role !== "chz") return { ...(cfg || {}) };
  const rotation = [0, 90, 180, 270].includes(Number(cfg?.chzLabelRotation)) ? Number(cfg.chzLabelRotation) : 0;
  const scale = Number(cfg?.chzLabelScale || 0.93);
  return {
    ...(cfg || {}),
    printerQueue: cfg?.chzPrinterQueue || "",
    labelWidthMm: Number(cfg?.chzLabelWidthMm || 30),
    labelHeightMm: Number(cfg?.chzLabelHeightMm || 20),
    labelRotation: rotation,
    labelScale: Number.isFinite(scale) ? Math.max(0.5, Math.min(1, scale)) : 0.93,
  };
}

async function printLabelNow(payload, cfg, role = "primary") {
  const startedAt = Date.now();
  const requestKey = String(payload?._requestKey || printRequestKey(payload, role));
  const documentName = `GRA ${role === "chz" ? "CHZ" : "label"} ${requestKey}`;
  const profile = getPrintProfile(cfg, role);
  printerRuntimeLog("request_started", { requestKey, role });
  let status = role === "chz" ? await chzPrinterStatus(cfg) : await printerStatus(cfg);
  printerRuntimeLog("status_ready", {
    requestKey,
    role,
    queue: status?.queue || "",
    cached: status?.cached === true,
    elapsedMs: Date.now() - startedAt,
  });
  if (!status.ready) {
    if (role === "chz" && cfg?.chzPrinterEnabled !== true) {
      throw new Error("Второй принтер Честного знака выключен в настройках приложения.");
    }
    if (role === "chz") {
      if (status.state === "SAME_AS_PRIMARY") {
        throw new Error("Для Честного знака выбрана та же очередь, что и для основной этикетки. Выберите второй принтер.");
      }
      if (status.state === "AMBIGUOUS") {
        throw new Error("Найдено несколько вторых термопринтеров. Выберите очередь Честного знака в настройках приложения.");
      }
      throw new Error(`Второй принтер Честного знака не готов${status.queue ? `: ${status.queue}` : ""}.`);
    }
    throw new Error(
      status.physicalPresent
        ? `Основной принтер не готов: ${status.queue || "очередь не выбрана"}. Откройте «Принтеры» и выберите рабочую очередь.`
        : "Основной принтер не подключён. Проверьте питание и USB-кабель."
    );
  }
  if (!status.ready) {
    if (role === "chz" && status.state === "SAME_AS_PRIMARY") {
      throw new Error("Для Честного знака выбрана та же очередь, что и для основной этикетки. Выберите второй принтер.");
    }
    if (role === "chz" && status.state === "AMBIGUOUS") {
      throw new Error("Найдено несколько вторых Xprinter. Выберите очередь Честного знака в настройках приложения.");
    }
    throw new Error(role === "chz" ? "Второй принтер Честного знака не готов." : "Принтер Xprinter XP-365B найден, но очередь печати не готова.");
  }
  let queue = status.queue;

  if (payload.testPattern) {
    const sent = await sendRawWithRecovery(queue, buildTestTspl(profile), cfg, {
      role,
      verifyTimeoutMs: role === "chz" ? 10000 : 1500,
      documentName,
      requestKey,
    });
    queue = sent.queue;
    return { printed: 1, pages: 1, queue, test: true };
  }

  const copies = normalizeCopies(payload.copies);
  const buf = await resolvePdfBuffer(payload);
  printerRuntimeLog("file_ready", { requestKey, role, bytes: buf.length, elapsedMs: Date.now() - startedAt });
  const pngPages = isPng(buf) ? [buf] : await pdfToPngBuffers(buf);
  if (!pngPages.length) throw new Error("В файле этикеток нет страниц для печати");

  const rawJobs = [];
  if (payload.layoutMode === "chz_two_up") {
    const captionPng = decodePngDataUrl(payload.captionDataUrl);
    const twoUpProfile = {
      ...profile,
      labelWidthMm: 58,
      labelHeightMm: 40,
      labelScale: 1,
    };
    const cache = new Map();
    for (let sheet = 0; sheet < copies; sheet++) {
      const [leftIndex, rightIndex] = chzTwoUpPagePairIndexes(
        pngPages.length,
        sheet,
      );
      const cacheKey = `${leftIndex}:${rightIndex}`;
      let tspl = cache.get(cacheKey);
      if (!tspl) {
        const canvas = await buildChzTwoUpCanvas(
          pngPages[leftIndex],
          pngPages[rightIndex],
          captionPng,
        );
        const sheetPng = await canvas.getBufferAsync(Jimp.MIME_PNG);
        tspl = await pngToTspl(sheetPng, twoUpProfile, { threshold: 160 });
        cache.set(cacheKey, tspl);
      }
      rawJobs.push(tspl);
    }
  } else {
  for (const png of pngPages) {
    let preparedPng = png;
    if (role === "chz" && Number(profile.labelRotation || 0) !== 0) {
      const rotated = await Jimp.read(png);
      rotated.rotate(Number(profile.labelRotation));
      preparedPng = await rotated.getBufferAsync(Jimp.MIME_PNG);
    }
    const tspl = await pngToTspl(preparedPng, profile, { fitMode: payload.fitMode || (role === "chz" ? "package" : undefined) });
    for (let copy = 0; copy < copies; copy++) {
      rawJobs.push(tspl);
    }
  }
  }
  printerRuntimeLog("render_ready", { requestKey, role, pages: pngPages.length, jobs: rawJobs.length, elapsedMs: Date.now() - startedAt });
  const verifyTimeoutMs = role === "chz"
    ? Math.max(10000, Math.min(60000, 5000 + rawJobs.length * 1000))
    : Math.max(1500, Math.min(5000, 1000 + rawJobs.length * 500));
  const sent = await sendRawWithRecovery(queue, Buffer.concat(rawJobs), cfg, {
    verifyTimeoutMs,
    role,
    documentName,
    requestKey,
  });
  queue = sent.queue;
  const result = { printed: rawJobs.length, pages: pngPages.length, queue, deliveryState: sent.deliveryState || "UNKNOWN" };
  printerRuntimeLog("request_finished", { requestKey, role, queue, printed: result.printed, deliveryState: result.deliveryState, elapsedMs: Date.now() - startedAt });
  return result;
}

function printLabel(payload, cfg) {
  const role =
    payload?.layoutMode === "chz_two_up"
      ? "primary"
      : payload?.printerRole === "chz"
        ? "chz"
        : "primary";
  if (role === "chz") {
    const job = chzPrintChain.then(() => printLabelNow(payload || {}, cfg || {}, role));
    chzPrintChain = job.catch(() => {});
    return job;
  }
  const normalizedPayload = payload || {};
  const requestKey = printRequestKey(normalizedPayload, role);
  return primaryPrintGate.run(
    requestKey,
    () => printLabelNow({ ...normalizedPayload, _requestKey: requestKey }, cfg || {}, role),
    { force: normalizedPayload.forceReprint === true || normalizedPayload.testPattern === true },
  );
}

module.exports = {
  listPrinters,
  hasQueue,
  printerReady,
  printerStatus,
  chzPrinterStatus,
  resolvePrinterQueue,
  resolveChzPrinterQueue,
  physicalXprinterState,
  ensureDriverInstalled,
  installBundledDrivers,
  readDriverLog,
  printLabel,
  _test: {
    selectPrinterQueue,
    queueHasHardError,
    queueStatusFromDetails,
    normalizeCopies,
    pngToTspl,
    chzTwoUpPagePairIndexes,
    buildChzTwoUpCanvas,
    getPrintProfile,
    shouldRotateForBestFit,
    findInkBounds,
    prepareLabelCanvas,
    createSingleFlightGate,
    printRequestKey,
  },
};
