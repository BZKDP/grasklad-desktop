"use strict";
const { app, BrowserWindow, ipcMain, globalShortcut, session, shell } = require("electron");
const path = require("path");
const { loadConfig, saveConfig } = require("./config");
const printer = require("./printer");
const fingerprint = require("./fingerprint");
const { DispenserController, LANE_COUNT, calibrationFor } = require("./dispenser");

let mainWindow = null;
let cfg = null;
let hardwareChangeTimer = null;
const dispenser = new DispenserController({
  logPath: path.join(app.getPath("userData"), "dispenser.log"),
});
const WM_DEVICECHANGE = 0x0219;

function notifyHardwareChanged() {
  if (hardwareChangeTimer) clearTimeout(hardwareChangeTimer);
  hardwareChangeTimer = setTimeout(() => {
    hardwareChangeTimer = null;
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("hardware:changed");
    } catch {}
  }, 250);
}

// Один экземпляр (kiosk на рабочем месте — второй запуск фокусит первый)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  cfg = loadConfig();

  const devNoKiosk = process.env.GRA_NO_KIOSK === "1"; // dev: обычное окно для отладки
  mainWindow = new BrowserWindow({
    show: false,
    width: devNoKiosk ? 1280 : undefined,
    height: devNoKiosk ? 800 : undefined,
    fullscreen: !devNoKiosk,
    kiosk: !devNoKiosk, // скрывает taskbar Windows, занимает весь экран
    frame: devNoKiosk,
    autoHideMenuBar: true,
    backgroundColor: "#0f1622",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // webview тег для встраивания сайта
      webviewTag: true,
      // отдельная сессия для webview, чтобы cookie сайта жили изолированно
      partition: "persist:grasklad",
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Windows sends this message immediately when a USB printer is attached,
  // removed or moved to another port. The renderer then refreshes the queue.
  mainWindow.hookWindowMessage(WM_DEVICECHANGE, notifyHardwareChanged);

  if (devNoKiosk) {
    mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
      console.log(`[shell:${level}] ${message} (${sourceId}:${line})`);
    });
  }

  if (process.env.GRA_SCREENSHOT) {
    setTimeout(async () => {
      try {
        const img = await mainWindow.webContents.capturePage();
        require("fs").writeFileSync(process.env.GRA_SCREENSHOT, img.toPNG());
      } catch (e) { console.error("screenshot failed", e); }
      app.exit(0);
    }, 5500);
  }

  mainWindow.loadFile(path.join(__dirname, "..", "assets", "shell.html"));

  // В kiosk выход из fullscreen блокируем; служебный выход — Ctrl+Shift+Alt+Q
  mainWindow.on("leave-full-screen", () => {
    if (cfg && cfg.kioskLocked !== false) mainWindow.setFullScreen(true);
  });

  mainWindow.on("closed", () => {
    if (hardwareChangeTimer) clearTimeout(hardwareChangeTimer);
    hardwareChangeTimer = null;
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  // Секретный аккорд для выхода/обслуживания (чтобы админ мог закрыть kiosk)
  globalShortcut.register("Control+Shift+Alt+Q", () => {
    app.exit(0);
  });
  // Открыть DevTools для отладки (служебное)
  globalShortcut.register("Control+Shift+Alt+D", () => {
    if (mainWindow) mainWindow.webContents.openDevTools({ mode: "detach" });
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  fingerprint.close();
  dispenser.close().catch(() => {});
  app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  fingerprint.close();
  dispenser.close().catch(() => {});
});

// ------------------- IPC: конфиг -------------------
ipcMain.handle("config:get", () => loadConfig());
ipcMain.handle("config:set", (_e, patch) => {
  cfg = saveConfig(patch || {});
  return cfg;
});

// ------------------- IPC: дозатор -------------------
ipcMain.handle("dispenser:status", () => dispenser.status());
ipcMain.handle("dispenser:check", async () => dispenser.check(loadConfig()));
ipcMain.handle("dispenser:dispense", async (_event, payload) => {
  return dispenser.dispense(payload || {}, loadConfig());
});
ipcMain.handle("dispenser:recoverHome", async (_event, payload) => {
  return dispenser.recoverHome(payload || {}, loadConfig());
});
ipcMain.handle("dispenser:calibrationStatus", () => dispenser.calibrationStatus(loadConfig()));
ipcMain.handle("dispenser:diagnostics", () => dispenser.diagnostics());
ipcMain.handle("dispenser:calibrationCommand", async (_event, payload) => {
  return dispenser.calibrationCommand(payload || {}, loadConfig());
});
ipcMain.handle("dispenser:calibrationSave", async (_event, payload) => {
  const lane = Number(payload?.lane);
  const home = Number(payload?.home);
  const eject = Number(payload?.eject);
  const speed = Number(payload?.speed || 500);
  if (!Number.isInteger(lane) || lane < 1 || lane > LANE_COUNT) return { ok: false, error: "Выберите дорожку 1–10" };
  if (![home, eject].every((value) => Number.isInteger(value) && value >= 700 && value <= 2300)) return { ok: false, error: "Положения должны быть от 700 до 2300 мкс" };
  if (Math.abs(home - eject) < 20) return { ok: false, error: "HOME и ВЫДАЧА должны отличаться минимум на 20 мкс" };
  if (!Number.isFinite(speed)) return { ok: false, error: "Некорректная скорость" };
  const conf = loadConfig();
  const calibrations = Array.from({ length: LANE_COUNT }, (_, index) => calibrationFor(conf, index + 1));
  calibrations[lane - 1] = {
    home,
    eject,
    guardMin: Math.max(700, Math.min(home, eject) - 60),
    guardMax: Math.min(2300, Math.max(home, eject) + 60),
    speed: Math.max(30, Math.min(2000, Math.round(speed))),
  };
  let next;
  try { next = saveConfig({ dispenserCalibration: calibrations }, { requirePersistence: true }); }
  catch (error) { return { ok: false, error: `Калибровка не сохранена на ПК: ${error.message}` }; }
  const synced = await dispenser.calibrationCommand({ action: "sync", lane }, next);
  return synced?.ok === false ? { ...synced, saved: true, error: `Сохранено на ПК, но не синхронизировано с ESP32: ${synced.error}` } : { ok: true, lane, calibration: calibrations[lane - 1] };
});
ipcMain.handle("dispenser:stop", async () => {
  await dispenser.emergencyStop();
  return { ok: true };
});

// ------------------- IPC: печать -------------------
ipcMain.handle("printer:list", async () => {
  try {
    return await printer.listPrinters();
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});

async function readPrinterPairState() {
  const conf = loadConfig();
  const [printers, primary, chz] = await Promise.all([
    printer.listPrinters().catch(() => []),
    printer.printerStatus(conf).catch((error) => ({ ready: false, state: "ERROR", error: String(error?.message || error) })),
    printer.chzPrinterStatus(conf).catch((error) => ({ ready: false, state: "ERROR", error: String(error?.message || error) })),
  ]);
  return {
    ok: true,
    printers: Array.isArray(printers) ? printers : [],
    primary: { ...primary, ok: primary?.ready === true, queue: primary?.queue || conf.printerQueue || "" },
    chz: { ...chz, ok: chz?.ready === true, queue: chz?.queue || conf.chzPrinterQueue || "" },
    config: {
      primaryQueue: conf.printerQueue || "",
      chzQueue: conf.chzPrinterQueue || "",
      chzEnabled: conf.chzPrinterEnabled === true,
      primarySize: `${Number(conf.labelWidthMm || 58)}x${Number(conf.labelHeightMm || 40)}`,
      chzSize: `${Number(conf.chzLabelWidthMm || 20)}x${Number(conf.chzLabelHeightMm || 20)}`,
    },
  };
}

async function configurePrinterPair(payload) {
  const primaryQueue = String(payload?.primaryQueue || "").trim();
  const chzQueue = String(payload?.chzQueue || "").trim();
  if (!primaryQueue || !chzQueue) throw new Error("Выберите оба принтера");
  if (primaryQueue.toLowerCase() === chzQueue.toLowerCase()) {
    throw new Error("Для этикетки маркетплейса и ЧЗ нужны разные принтеры");
  }
  const printers = await printer.listPrinters();
  const byName = new Map(printers.map((name) => [String(name).toLowerCase(), String(name)]));
  const primary = byName.get(primaryQueue.toLowerCase());
  const chz = byName.get(chzQueue.toLowerCase());
  if (!primary) throw new Error(`Очередь основного принтера не найдена: ${primaryQueue}`);
  if (!chz) throw new Error(`Очередь принтера ЧЗ не найдена: ${chzQueue}`);
  saveConfig({ printerQueue: primary, chzPrinterQueue: chz, chzPrinterEnabled: true });
  return readPrinterPairState();
}

ipcMain.handle("printer:setupState", async () => {
  try {
    return await readPrinterPairState();
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle("printer:configurePair", async (_event, payload) => {
  try {
    return await configurePrinterPair(payload);
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle("printer:testPair", async (_event, payload) => {
  try {
    const state = await configurePrinterPair(payload);
    if (!state.primary?.ok || !state.chz?.ok) {
      const missing = [];
      if (!state.primary?.ok) missing.push("основной принтер не готов");
      if (!state.chz?.ok) missing.push("принтер ЧЗ не готов");
      return { ...state, ok: false, error: missing.join("; ") };
    }
    const conf = loadConfig();
    const [primaryResult, chzResult] = await Promise.allSettled([
      printer.printLabel({ testPattern: true }, conf),
      printer.printLabel({ testPattern: true, printerRole: "chz" }, conf),
    ]);
    const primaryOk = primaryResult.status === "fulfilled";
    const chzOk = chzResult.status === "fulfilled";
    return {
      ...(await readPrinterPairState()),
      ok: primaryOk && chzOk,
      tested: true,
      primaryTest: primaryOk
        ? { ok: true, queue: primaryResult.value?.queue || conf.printerQueue }
        : { ok: false, error: String(primaryResult.reason?.message || primaryResult.reason) },
      chzTest: chzOk
        ? { ok: true, queue: chzResult.value?.queue || conf.chzPrinterQueue }
        : { ok: false, error: String(chzResult.reason?.message || chzResult.reason) },
      error: [
        !primaryOk ? `основная этикетка: ${primaryResult.reason?.message || primaryResult.reason}` : "",
        !chzOk ? `ЧЗ: ${chzResult.reason?.message || chzResult.reason}` : "",
      ].filter(Boolean).join("; "),
    };
  } catch (error) {
    return { ok: false, tested: true, error: String(error?.message || error) };
  }
});

ipcMain.handle("printer:printLabel", async (_e, payload) => {
  // payload: { url?, base64?, dataUrl?, copies?, fitMode? }
  try {
    const conf = loadConfig();
    const p = { ...(payload || {}) };
    // Относительный URL этикетки (/OZ/files/...) → абсолютный по адресу сайта.
    if (p.url && typeof p.url === "string" && !/^https?:\/\//i.test(p.url)) {
      try { p.url = new URL(p.url, appBaseUrl()).href; } catch {}
    }
    const res = await printer.printLabel(p, conf);
    if (p.printerRole === "chz") {
      if (res.queue && res.queue !== conf.chzPrinterQueue) {
        try { saveConfig({ chzPrinterQueue: res.queue }); } catch {}
      }
    } else if (res.queue && res.queue !== conf.printerQueue) {
      try { saveConfig({ printerQueue: res.queue }); } catch {}
    }
    return { ok: true, ...res };
  } catch (e) {
    return { ok: false, code: String(e?.code || "PRINT_FAILED"), error: String(e && e.message || e) };
  }
});

function localChzBaseUrl(conf) {
  const value = String(conf?.chzLocalUrl || "http://127.0.0.1:3030").replace(/\/+$/, "");
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("Сервис Честного знака должен работать только локально (127.0.0.1)");
  }
  return parsed.href.replace(/\/+$/, "");
}

async function postLocalChz(conf, pathName, body, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${localChzBaseUrl(conf)}${pathName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
      cache: "no-store",
    });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : {}; } catch {}
    if (!response.ok) throw new Error(data?.error || `Локальный сервис ЧЗ: HTTP ${response.status}`);
    return data || {};
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Локальный сервис Честного знака не ответил вовремя");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

ipcMain.handle("printer:printOrderLabels", async (_e, payload) => {
  const conf = loadConfig();
  const primary = { ...(payload?.primary || {}) };
  const context = payload?.chzContext || {};
  let prepared = null;
  let chzQueue = null;
  let primaryPrintedForAttempt = false;
  try {
    if (!primary.url && !primary.base64 && !primary.dataUrl) throw new Error("Не передана этикетка маркетплейса");
    if (primary.url && typeof primary.url === "string" && !/^https?:\/\//i.test(primary.url)) {
      try { primary.url = new URL(primary.url, appBaseUrl()).href; } catch {}
    }
    const expectedCount = Number(context.expectedCount);
    if (!Number.isInteger(expectedCount) || expectedCount < 0) throw new Error("Сайт не передал количество кодов ЧЗ для заказа");
    const manifestStatus = String(context.manifestStatus || "missing");
    if (!["confirmed", "not_required"].includes(manifestStatus)) {
      throw new Error(`Расчёт Честного знака не готов: ${manifestStatus}`);
    }
    if (expectedCount > 0 && context.jobsReady !== true) {
      throw new Error("Коды Честного знака ещё не выпущены или не введены в оборот");
    }
    if (expectedCount === 0) {
      const result = await printer.printLabel(primary, conf);
      if (result.queue && result.queue !== conf.printerQueue) saveConfig({ printerQueue: result.queue });
      return { ok: true, primaryPrinted: true, chzRequired: false, ...result };
    }
    if (conf.chzPrinterEnabled !== true) throw new Error("Второй принтер Честного знака выключен в настройках приложения");
    const chzStatus = await printer.chzPrinterStatus(conf);
    if (!chzStatus.ready) {
      if (chzStatus.state === "SAME_AS_PRIMARY") throw new Error("Для ЧЗ выбрана та же очередь, что и для основной этикетки");
      if (chzStatus.state === "AMBIGUOUS") throw new Error("Выберите очередь второго принтера ЧЗ в настройках приложения");
      throw new Error("Второй принтер Честного знака не готов");
    }
    prepared = await postLocalChz(conf, "/api/automation/print-order/prepare", {
      marketplace: context.marketplace,
      entityId: context.entityId,
      orderId: context.orderId,
      expectedCount,
      reprintReason: context.reprintReason || null,
    });
    if (prepared.primaryOnly === true && prepared.chzAlreadyPrinted === true) {
      const primaryResult = await printer.printLabel(primary, conf);
      primaryPrintedForAttempt = true;
      if (primaryResult.queue && primaryResult.queue !== conf.printerQueue) {
        try { saveConfig({ printerQueue: primaryResult.queue }); } catch {}
      }
      await postLocalChz(conf, "/api/automation/print-order/complete", {
        token: prepared.token,
        success: true,
        primaryPrinted: true,
      }).catch(() => {});
      return {
        ok: true,
        primaryPrinted: true,
        chzPrinted: true,
        chzCount: expectedCount,
        recoveredPrimaryOnly: true,
        queue: primaryResult.queue,
      };
    }
    if (!prepared.required || !Array.isArray(prepared.labels) || prepared.labels.length !== expectedCount) {
      throw new Error("Локальный сервис вернул неполный комплект этикеток ЧЗ");
    }
    const skipPrimary = prepared.skipPrimary === true;
    const primaryPromise = skipPrimary
      ? Promise.resolve({ ok: true, skipped: true, queue: conf.printerQueue || null })
      : printer.printLabel(primary, conf);
    const chzPromise = Promise.all(prepared.labels.map((label) => printer.printLabel({
      base64: label.imageBase64,
      copies: 1,
      fitMode: "package",
      printerRole: "chz",
    }, conf)));
    const [primaryResult, chzResults] = await Promise.allSettled([primaryPromise, chzPromise]);
    const chzOk = chzResults.status === "fulfilled";
    primaryPrintedForAttempt = skipPrimary || primaryResult.status === "fulfilled";
    if (chzOk) chzQueue = chzResults.value.find((item) => item?.queue)?.queue || chzStatus.queue;
    await postLocalChz(conf, "/api/automation/print-order/complete", {
      token: prepared.token,
      success: chzOk,
      primaryPrinted: primaryPrintedForAttempt,
      printerName: chzQueue || chzStatus.queue,
      error: chzOk ? null : String(chzResults.reason?.message || chzResults.reason || "Ошибка печати ЧЗ"),
    }).catch(() => {});
    if (!skipPrimary && primaryResult.status === "fulfilled" && primaryResult.value?.queue && primaryResult.value.queue !== conf.printerQueue) {
      try { saveConfig({ printerQueue: primaryResult.value.queue }); } catch {}
    }
    if (chzOk && chzQueue && chzQueue !== conf.chzPrinterQueue) {
      try { saveConfig({ chzPrinterQueue: chzQueue }); } catch {}
    }
    if (primaryResult.status === "rejected" || !chzOk) {
      const errors = [];
      if (primaryResult.status === "rejected") errors.push(`основная этикетка: ${primaryResult.reason?.message || primaryResult.reason}`);
      if (!chzOk) errors.push(`ЧЗ: ${chzResults.reason?.message || chzResults.reason}`);
      return {
        ok: false,
        primaryPrinted: primaryPrintedForAttempt,
        chzPrinted: chzOk,
        chzCount: chzOk ? expectedCount : 0,
        error: errors.join("; "),
      };
    }
    return { ok: true, primaryPrinted: true, chzPrinted: true, chzCount: expectedCount, queue: primaryResult.value.queue, chzQueue };
  } catch (error) {
    if (prepared?.token) {
      await postLocalChz(conf, "/api/automation/print-order/complete", {
        token: prepared.token,
        success: false,
        primaryPrinted: primaryPrintedForAttempt,
        printerName: chzQueue,
        error: String(error?.message || error),
      }).catch(() => {});
    }
    return { ok: false, primaryPrinted: false, chzPrinted: false, error: String(error?.message || error) };
  }
});

ipcMain.handle("printer:ensureDriver", async () => {
  try {
    const conf = loadConfig();
    const result = await printer.ensureDriverInstalled(conf);
    if (result.ok && result.queue && result.queue !== conf.printerQueue) {
      try { saveConfig({ printerQueue: result.queue }); } catch {}
    }
    return result;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

ipcMain.handle("printer:chzStatus", async () => {
  try {
    const conf = loadConfig();
    const result = await printer.chzPrinterStatus(conf);
    if (result.ready && result.adopted && result.queue && result.queue !== conf.chzPrinterQueue) {
      try { saveConfig({ chzPrinterQueue: result.queue }); } catch {}
    }
    return { ok: result.ready === true, ...result };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

// Установка ВСЕХ вшитых драйверов (принтер + CH340 сканера) с повышением прав (UAC).
// Успех подтверждаем по ФАКТУ появления COM-порта, а не по коду возврата pnputil.
ipcMain.handle("driver:install", async () => {
  try {
    const before = await fingerprint.listSerialPorts().catch(() => ({ ports: [] }));
    const r = await printer.installBundledDrivers({ elevated: true });
    if (r.declined) {
      return { ok: false, declined: true, error: "Запрос прав Windows отклонён. Нажмите ещё раз и выберите «Да».", log: r.log };
    }
    // Проверяем, появился ли COM-порт ESP (CH340) после установки
    const after = await fingerprint.listSerialPorts().catch(() => ({ ports: [] }));
    const hasCh340 = (after.ports || []).some((p) =>
      (p.vendorId || "").toLowerCase() === "1a86" || /ch340|ch341|wch/i.test((p.friendlyName || "") + (p.manufacturer || ""))
    );
    if (hasCh340) return { ok: true, portFound: true, log: r.log };
    if (r.done) {
      // драйвер обработан, но порт ещё не появился — как правило нужно переткнуть ESP
      return { ok: true, portFound: false, needReplug: true, log: r.log };
    }
    return { ok: false, error: "Установка не завершилась. Проверьте подключение и повторите.", log: r.log };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

// Диагностика: список всех COM-портов + распознанные USB-serial устройства.
// Помогает понять, виден ли ESP системе вообще (нет порта = нет драйвера CH340).
ipcMain.handle("serial:list", async () => {
  try {
    return await fingerprint.listSerialPorts();
  } catch (e) {
    return { ports: [], error: String(e && e.message || e) };
  }
});

// ------------------- IPC: статус железа -------------------
ipcMain.handle("status:hardware", async () => {
  const conf = loadConfig();
  let printerStatus = { ok: false, queue: conf.printerQueue };
  try {
    const r = await printer.printerStatus(conf);
    printerStatus = {
      ok: r.ready,
      exists: r.exists,
      state: r.state,
      queue: r.queue,
      adopted: r.adopted,
      physicalPresent: r.physicalPresent,
      setupRequired: r.setupRequired,
      onLivePort: r.onLivePort,
    };
    // Автоподбор нашёл термопринтер под другим именем — запоминаем в конфиг, чтобы печать шла на него.
    if (r.adopted && r.queue && r.queue !== conf.printerQueue) {
      try { saveConfig({ ...conf, printerQueue: r.queue }); } catch {}
    }
  } catch (e) {
    printerStatus = { ok: false, queue: conf.printerQueue, error: String(e && e.message || e) };
  }
  let chzPrinter = { ok: false, enabled: conf.chzPrinterEnabled === true, queue: conf.chzPrinterQueue || "" };
  try {
    const r = await printer.chzPrinterStatus(conf);
    chzPrinter = { ok: r.ready === true, ...r };
    if (r.ready && r.adopted && r.queue && r.queue !== conf.chzPrinterQueue) {
      try { saveConfig({ chzPrinterQueue: r.queue }); } catch {}
    }
  } catch (e) {
    chzPrinter = { ...chzPrinter, error: String(e && e.message || e) };
  }
  const dispenserStatus = await dispenser.check(conf).catch((error) => ({
    ok: false,
    ready: false,
    connected: false,
    port: conf.dispenserPort || "AUTO",
    error: String(error?.message || error),
  }));
  return { printer: printerStatus, chzPrinter, dispenser: dispenserStatus };
});

// ------------------- IPC: отпечаток -------------------
ipcMain.handle("fp:status", async () => {
  const conf = loadConfig();
  return fingerprint.status(conf);
});

ipcMain.handle("fp:connect", async () => {
  const conf = loadConfig();
  return fingerprint.connect(conf);
});

ipcMain.handle("fp:enroll", async (_e, opts) => {
  // opts: { espId } — присвоить ID в модуле, вернуть выгруженный шаблон (base64)
  const conf = loadConfig();
  return fingerprint.enroll(conf, opts || {});
});

ipcMain.handle("fp:loadTemplates", async (_e, templates) => {
  // templates: [{ espId, templateB64 }] — залить шаблоны сотрудников в модуль
  const conf = loadConfig();
  return fingerprint.loadTemplates(conf, templates || []);
});

ipcMain.handle("fp:identify", async () => {
  const conf = loadConfig();
  return fingerprint.identify(conf);
});

ipcMain.handle("fp:delete", async (_e, espId) => {
  const conf = loadConfig();
  return fingerprint.deleteFinger(conf, espId);
});

ipcMain.handle("fp:cancel", async () => {
  return fingerprint.cancel();
});

// Прогресс отпечатка (Place finger / Remove / scan N) — стримим в renderer
fingerprint.on("progress", (msg) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("fp:progress", msg);
  }
});

// Активность внутри webview сайта -> сброс таймаута бездействия в оболочке
ipcMain.on("activity", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("activity");
  }
});

// Сайт (внутри webview) сообщил о выходе сотрудника → оболочка возвращается на экран отпечатка
ipcMain.on("site:logout", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("site:logout");
  }
});

// ------------------- IPC: сессия сайта (вход по отпечатку) -------------------
// Проставить cookie сессии в webview-партицию (сервер вернул set-cookie)
ipcMain.handle("session:apply", async (_e, { cookies }) => {
  try {
    const ses = session.fromPartition("persist:grasklad");
    const conf = loadConfig();
    const base = new URL(conf.siteUrl);
    for (const c of cookies || []) {
      await ses.cookies.set({
        url: `${base.protocol}//${base.host}`,
        name: c.name,
        value: c.value,
        path: c.path || "/",
        httpOnly: c.httpOnly !== false,
      });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

ipcMain.handle("session:clear", async () => {
  try {
    const ses = session.fromPartition("persist:grasklad");
    await ses.clearStorageData({ storages: ["cookies"] });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

// ------------------- IPC: обновление приложения -------------------
function appBaseUrl() {
  const conf = loadConfig();
  const u = new URL(conf.siteUrl);
  return `${u.protocol}//${u.host}`;
}

ipcMain.handle("update:check", async () => {
  try {
    const base = appBaseUrl();
    const res = await fetch(`${base}/app/version`, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const current = app.getVersion();
    const latest = String(data.version || "");
    return {
      ok: true,
      current,
      latest,
      notes: data.notes || "",
      downloadUrl: data.url || `${base}/app`,
      sha256: data.sha256 || null,
      size: Number(data.size) || null,
      updateAvailable: latest && latest !== current,
    };
  } catch (e) {
    return { ok: false, current: app.getVersion(), error: String(e && e.message || e) };
  }
});

// Скачать установщик с проверкой целостности (размер + sha256) и повторами.
// Возвращает Buffer или бросает ошибку после нескольких неудач.
async function downloadInstallerVerified(url, expected, onProgress, attempts = 4) {
  const crypto = require("crypto");
  let last = "";
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) { last = "HTTP " + res.status; continue; }
      const clen = Number(res.headers.get("content-length")) || null;
      const total = clen || expected.size || 0;
      // Потоковое чтение тела — даёт реальный прогресс скачивания для UI.
      let buf;
      if (res.body && typeof res.body.getReader === "function") {
        const reader = res.body.getReader();
        const chunks = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          chunks.push(chunk);
          received += chunk.length;
          if (onProgress) { try { onProgress(received, total); } catch {} }
        }
        buf = Buffer.concat(chunks);
      } else {
        buf = Buffer.from(await res.arrayBuffer());
        if (onProgress) { try { onProgress(buf.length, total); } catch {} }
      }
      const size = buf.length;
      const sha = crypto.createHash("sha256").update(buf).digest("hex");
      const sizeOk = expected.size ? size === expected.size : (clen ? size === clen : size > 1024 * 1024);
      const shaOk = expected.sha256 ? sha.toLowerCase() === String(expected.sha256).toLowerCase() : true;
      if (sizeOk && shaOk) return buf;
      last = `повреждён (получено ${size} байт${expected.size ? " из " + expected.size : (clen ? " из " + clen : "")}, sha ${shaOk ? "ok" : "не совпал"})`;
    } catch (e) {
      last = String((e && e.message) || e);
    }
  }
  throw new Error("не удалось скачать целый установщик за " + attempts + " попыток: " + last);
}

ipcMain.handle("update:install", async (_e) => {
  try {
    const base = appBaseUrl();
    // сверяем целостность по данным из version.json (sha256/size)
    let expected = {};
    try {
      const vr = await fetch(`${base}/app/version`, { cache: "no-store" });
      if (vr.ok) { const v = await vr.json(); expected = { sha256: v.sha256 || null, size: Number(v.size) || null }; }
    } catch {}
    const send = (p) => { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("update:progress", p); } catch {} };
    send({ phase: "download", received: 0, total: expected.size || 0, pct: 0 });
    const buf = await downloadInstallerVerified(`${base}/app`, expected, (received, total) => {
      const pct = total ? Math.min(100, Math.floor((received / total) * 100)) : 0;
      send({ phase: "download", received, total, pct });
    });
    send({ phase: "launch", pct: 100 });
    const tmp = path.join(require("os").tmpdir(), "GRA-sklad-Setup.exe");
    require("fs").writeFileSync(tmp, buf);
    // Пауза, чтобы антивирус успел отпустить только что записанный файл.
    await new Promise((r) => setTimeout(r, 1200));
    // Запуск через ShellExecute (shell.openPath) — корректно поднимает UAC-элевацию.
    // child_process.spawn на manifested-инсталляторе даёт EACCES (ERROR_ELEVATION_REQUIRED)
    // и роняет приложение необработанным событием 'error'.
    let launchErr = "";
    try {
      launchErr = await shell.openPath(tmp); // "" при успехе, иначе текст ошибки
    } catch (e) {
      launchErr = String((e && e.message) || e);
    }
    if (launchErr) {
      // Запасной путь: запуск через оболочку cmd `start` (никогда не даёт EACCES).
      try {
        require("child_process")
          .spawn("cmd.exe", ["/c", "start", "", tmp], { detached: true, stdio: "ignore", windowsHide: true })
          .unref();
        launchErr = "";
      } catch (e2) {
        launchErr = String((e2 && e2.message) || e2);
      }
    }
    if (launchErr) {
      return { ok: false, error: "не удалось запустить установщик: " + launchErr, downloadUrl: `${base}/app` };
    }
    send({ phase: "done", pct: 100 });
    setTimeout(() => app.exit(0), 1500);
    return { ok: true, size: buf.length };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), downloadUrl: appBaseUrl() + "/app" };
  }
});

// ------------------- IPC: серверные desktop-эндпоинты -------------------
ipcMain.handle("api:fetch", async (_e, { pathName, opts }) => {
  const conf = loadConfig();
  const base = new URL(conf.siteUrl);
  const url = new URL(pathName.replace(/^\//, ""), `${base.protocol}//${base.host}${base.pathname.endsWith("/") ? base.pathname : base.pathname + "/"}`).toString();
  const headers = Object.assign(
    { "Content-Type": "application/json", "X-Desktop-Secret": conf.desktopSecret },
    (opts && opts.headers) || {}
  );
  const method = (opts && opts.method) || "GET";
  const body = opts && opts.body ? JSON.stringify(opts.body) : undefined;

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(url, { method, headers, body, signal: controller.signal, keepalive: false });
      clearTimeout(timer);
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      lastErr = e;
      const cause = e && e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : "";
      console.warn(`[api:fetch] ${method} ${url} attempt ${attempt} failed: ${e && e.message} ${cause}`);
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  const cause = lastErr && lastErr.cause ? (lastErr.cause.code || lastErr.cause.message || "") : "";
  return { ok: false, status: 0, error: "Нет связи с сервером (" + (lastErr && lastErr.message || "fetch failed") + (cause ? ", " + cause : "") + ")" };
});
