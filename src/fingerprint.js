"use strict";
const { EventEmitter } = require("events");
const { execFile } = require("child_process");

// Запуск PowerShell и возврат stdout (для PnP-диагностики USB-serial устройств).
function runPsPlain(script) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve((stdout || "").toString()))
    );
  });
}

// Ленивая загрузка serialport (нативный модуль) — чтобы приложение не падало,
// если модуль не собран/ESP не подключён.
let SerialPortLib = null;
function loadSerial() {
  if (SerialPortLib) return SerialPortLib;
  try {
    const sp = require("serialport");
    SerialPortLib = { SerialPort: sp.SerialPort, ReadlineParser: require("@serialport/parser-readline").ReadlineParser };
    return SerialPortLib;
  } catch (e) {
    const err = new Error(
      "Модуль serialport не установлен/не собран под Electron. Выполните: npm run rebuild (нужны Build Tools). Отпечаток недоступен, остальное работает."
    );
    err.code = "NO_SERIALPORT";
    throw err;
  }
}
function serialAvailable() {
  try { loadSerial(); return true; } catch { return false; }
}

class FingerprintManager extends EventEmitter {
  constructor() {
    super();
    this.port = null;
    this.parser = null;
    this.portPath = null;
    this.connected = false;
    this.busy = false;
    this._lineHandlers = [];
    this._cancelFlag = false;
  }

  async _findPort(cfg) {
    if (cfg.serialPort && cfg.serialPort !== "AUTO") return cfg.serialPort;
    const { SerialPort } = loadSerial();
    const ports = await SerialPort.list();
    const reservedDispenserPort = String(cfg.dispenserPort || "").trim().toLowerCase();
    const availablePorts = reservedDispenserPort
      ? ports.filter((p) => String(p.path || "").trim().toLowerCase() !== reservedDispenserPort)
      : ports;
    // ESP32 обычно через CH340 (vendorId 1a86) или CP210x (10c4) / FTDI (0403)
    const match = availablePorts.find((p) => {
      const vid = (p.vendorId || "").toLowerCase();
      const man = (p.manufacturer || "").toLowerCase();
      return vid === "1a86" || vid === "10c4" || vid === "0403" ||
        man.includes("ch340") || man.includes("wch") || man.includes("silicon labs") || man.includes("ftdi");
    });
    return match ? match.path : (availablePorts[0] && availablePorts[0].path) || null;
  }

  status(cfg) {
    return {
      connected: this.connected,
      port: this.portPath,
      busy: this.busy,
    };
  }

  // Диагностика: COM-порты (с драйвером) + USB-serial устройства по PnP (в т.ч. БЕЗ драйвера).
  // Позволяет отличить «ESP не подключён» от «подключён, но нет драйвера CH340».
  async listSerialPorts() {
    const result = { ports: [], usbSerial: [], chipPresentNoDriver: false };
    try {
      const { SerialPort } = loadSerial();
      const ports = await SerialPort.list();
      result.ports = ports.map((p) => ({
        path: p.path,
        vendorId: (p.vendorId || "").toLowerCase(),
        productId: (p.productId || "").toLowerCase(),
        manufacturer: p.manufacturer || "",
        friendlyName: p.friendlyName || "",
      }));
    } catch (e) {
      result.serialError = String((e && e.message) || e);
    }
    try {
      const out = await runPsPlain(
        "Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | " +
        "Where-Object { $_.InstanceId -match 'VID_1A86|VID_10C4|VID_0403|CH340|CH910|CP210|USB.?SERIAL' } | " +
        "ForEach-Object { \"$($_.Status)|$($_.Class)|$($_.FriendlyName)|$($_.InstanceId)\" }"
      );
      for (const ln of out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
        const [status, cls, name, id] = ln.split("|");
        result.usbSerial.push({ status, class: cls, name, instanceId: id });
        const noDriver = (status && status.toUpperCase() !== "OK") ||
          (cls && cls.toLowerCase() !== "ports");
        if (noDriver) result.chipPresentNoDriver = true;
      }
    } catch (e) {
      result.pnpError = String((e && e.message) || e);
    }
    return result;
  }

  async connect(cfg) {
    if (this.connected && this.port && this.port.isOpen) {
      return { ok: true, port: this.portPath, already: true };
    }
    if (!serialAvailable()) {
      return { ok: false, error: "Сканер недоступен: модуль serialport не собран. Остальное приложение работает." };
    }
    const { SerialPort, ReadlineParser } = loadSerial();
    const path = await this._findPort(cfg);
    if (!path) {
      // Порта нет: подключён ли чип CH340 без драйвера? Тогда предложим поставить драйвер.
      let needDriver = false;
      try { needDriver = (await this.listSerialPorts()).chipPresentNoDriver; } catch {}
      return needDriver
        ? { ok: false, needDriver: true, error: "Сканер подключён, но не установлен драйвер CH340. Нажмите «Установить драйвер сканера»." }
        : { ok: false, error: "COM-порт ESP32 не найден. Подключите сканер по USB (кабель должен быть с данными, не только зарядка)." };
    }

    await new Promise((resolve, reject) => {
      this.port = new SerialPort({ path, baudRate: Number(cfg.serialBaud || 115200) }, (err) => {
        if (err) return reject(err);
        resolve();
      });
    }).catch((e) => {
      throw new Error("Не удалось открыть " + path + ": " + (e.message || e));
    });

    this.portPath = path;
    this.connected = true;
    this.parser = this.port.pipe(new ReadlineParser({ delimiter: "\n" }));
    this.parser.on("data", (line) => this._onLine(String(line).replace(/\r$/, "")));
    this.port.on("close", () => { this.connected = false; });
    this.port.on("error", () => { this.connected = false; });

    // проверка связи: прошивка отвечает на "c" (статус/счётчик шаблонов)
    const ok = await this._command("c", (l) => /Stored templates|Capacity|UART:/i.test(l) ? true : null, 3000).catch(() => null);
    return { ok: true, port: path, ready: Boolean(ok) };
  }

  _onLine(line) {
    if (!line) return;
    // прогресс наружу (Place finger / Remove / Scan N)
    if (/place|remove|scan|finger|прилож|убер/i.test(line)) {
      this.emit("progress", line);
    }
    for (const h of this._lineHandlers.slice()) h(line);
  }

  _write(cmd) {
    if (!this.port || !this.port.isOpen) throw new Error("Сканер не подключён");
    this.port.write(cmd + "\n");
  }

  // Отправить команду и ждать, пока matcher вернёт не-null (результат) или таймаут
  _command(cmd, matcher, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error("Таймаут ожидания ответа сканера на: " + cmd));
      }, timeoutMs);
      const handler = (line) => {
        if (done) return;
        let res;
        try { res = matcher(line); } catch (e) { res = null; }
        if (res !== null && res !== undefined) {
          done = true;
          cleanup();
          resolve(res);
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        const i = this._lineHandlers.indexOf(handler);
        if (i >= 0) this._lineHandlers.splice(i, 1);
      };
      this._lineHandlers.push(handler);
      try { if (cmd) this._write(cmd); } catch (e) { cleanup(); reject(e); }
    });
  }

  // Регистрация под прошивку модуля: команда "e <id>", 4 скана, финал "Saved as ID <id>".
  // Прошивка хранит шаблон ВНУТРИ модуля по ID (кросс-ПК выгрузка пока не поддерживается).
  async enroll(cfg, { espId }) {
    if (!this.connected) { const c = await this.connect(cfg); if (!c.ok) return c; }
    if (this.busy) return { ok: false, error: "Сканер занят" };
    this.busy = true;
    this._cancelFlag = false;
    try {
      const result = await this._command(
        `e ${espId}`,
        (line) => {
          if (this._cancelFlag) return { cancelled: true };
          if (new RegExp(`Saved as ID\\s+${espId}\\b`, "i").test(line) || /Saved as ID/i.test(line)) return { ok: true };
          if (/Store Buffer.*error|Enroll (failed|error)|Image (error|too messy)|Feature (error|fail)|did not match|Failed/i.test(line)) {
            return { ok: false, error: line };
          }
          return null;
        },
        90000
      );
      if (result.cancelled) return { ok: false, cancelled: true };
      if (!result.ok) return result;
      // шаблон остаётся в модуле; templateB64 не выгружаем
      return { ok: true, espId, templateB64: null };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    } finally {
      this.busy = false;
    }
  }

  // Прошивка хранит шаблоны в модуле — заливка снаружи не нужна (no-op).
  async loadTemplates(cfg, templates) {
    if (!this.connected) { const c = await this.connect(cfg); if (!c.ok) return c; }
    return { ok: true, loaded: (templates || []).map((t) => t && t.espId).filter(Boolean), failed: [], moduleStored: true };
  }

  // Поиск 1:N через "s" (scan once): "MATCH ID=<id> confidence=<c>" | not found | No finger
  async identify(cfg) {
    if (!this.connected) { const c = await this.connect(cfg); if (!c.ok) return c; }
    if (this.busy) return { ok: false, error: "Сканер занят" };
    this.busy = true;
    this._cancelFlag = false;
    try {
      const res = await this._command(
        "s",
        (line) => {
          if (this._cancelFlag) return { cancelled: true };
          const m = /MATCH\s+ID=(\d+)\s+confidence=(\d+)/i.exec(line);
          if (m) return { ok: true, espId: Number(m[1]), confidence: Number(m[2]) };
          if (/not found|UNKNOWN FINGER/i.test(line)) return { ok: false, noMatch: true };
          if (/No finger/i.test(line)) return { ok: false, noFinger: true };
          if (/Image (error|too messy)|Feature (error|fail)/i.test(line)) return { ok: false, noMatch: true };
          return null;
        },
        6000
      );
      return res;
    } catch (e) {
      // таймаут ожидания = палец не приложен, не считаем ошибкой
      return { ok: false, noFinger: true };
    } finally {
      this.busy = false;
    }
  }

  // Удалить отпечаток из модуля по ID
  async deleteFinger(cfg, espId) {
    if (!this.connected) { const c = await this.connect(cfg); if (!c.ok) return c; }
    if (this.busy) return { ok: false, error: "Сканер занят" };
    this.busy = true;
    try {
      const res = await this._command(
        `d ${espId}`,
        (l) => /Deleted|deleted|OK/i.test(l) ? { ok: true } : (/error|fail/i.test(l) ? { ok: false, error: l } : null),
        8000
      ).catch(() => ({ ok: true }));
      return res;
    } finally { this.busy = false; }
  }

  async cancel() {
    this._cancelFlag = true;
    this.busy = false; // освобождаем сканер, чтобы UI не залипал
    try { this._write("q"); } catch {} // выход из wait-режима прошивки
    return { ok: true };
  }

  close() {
    try { if (this.port && this.port.isOpen) this.port.close(); } catch {}
    this.connected = false;
  }
}

module.exports = new FingerprintManager();
