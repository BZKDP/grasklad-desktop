"use strict";

const fs = require("fs");

const LANE_COUNT = 10;
const GROUP_PAUSE_MS = 450;
const DEFAULT_CALIBRATION = [
  { home: 817, eject: 1661, guardMin: 757, guardMax: 1721, speed: 500 },
  { home: 817, eject: 1661, guardMin: 757, guardMax: 1721, speed: 500 },
  { home: 817, eject: 1767, guardMin: 757, guardMax: 1827, speed: 500 },
  { home: 817, eject: 1661, guardMin: 757, guardMax: 1721, speed: 500 },
  { home: 817, eject: 1767, guardMin: 757, guardMax: 1827, speed: 500 },
];
while (DEFAULT_CALIBRATION.length < LANE_COUNT) {
  DEFAULT_CALIBRATION.push({ home: 1500, eject: 1500, guardMin: 1440, guardMax: 1560, speed: 500 });
}

function firmwareCapabilities(version) {
  const countMatch = String(version).match(/\bchannels=(\d+)\b/);
  const count = countMatch ? Number(countMatch[1]) : 5;
  if (!Number.isInteger(count) || count < 1 || count > LANE_COUNT) throw new Error("Неизвестное число каналов прошивки дозатора");
  const maskMatch = String(version).match(/\bconfigured_mask=(\d+)\b/);
  const mask = maskMatch ? Number(maskMatch[1]) : (1 << count) - 1;
  if (!Number.isInteger(mask) || mask < 0 || mask >= (1 << count)) throw new Error("Некорректная маска каналов прошивки дозатора");
  return { count, availableLanes: Array.from({ length: count }, (_, i) => i + 1).filter((lane) => mask & (1 << (lane - 1))) };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeLanes(value) {
  if (!Array.isArray(value) || value.length < 1) throw new Error("Не переданы дорожки дозатора");
  if (value.length > 100) throw new Error("Слишком много банок в одной операции");
  return value.map((lane) => {
    const number = Number(lane);
    if (!Number.isInteger(number) || number < 1 || number > LANE_COUNT) {
      throw new Error(`Неверный номер дорожки: ${lane}`);
    }
    return number;
  });
}

function cycleTimeoutMs(calibration, holdMs) {
  return Math.ceil((Math.abs(calibration.eject - calibration.home) * 2 / calibration.speed + holdMs / 1000 + 1.3) * 1000);
}

function homeHoldMs(calibration) {
  return Math.ceil(Math.abs(calibration.eject - calibration.home) / calibration.speed * 1000 + 500);
}

function calibrationFor(config, lane) {
  const fallback = DEFAULT_CALIBRATION[lane - 1];
  const saved = Array.isArray(config?.dispenserCalibration) ? config.dispenserCalibration[lane - 1] : null;
  const home = Number(saved?.home);
  const eject = Number(saved?.eject);
  const speed = Number(saved?.speed);
  const normalized = {
    home: Number.isInteger(home) && home >= 700 && home <= 2300 ? home : fallback.home,
    eject: Number.isInteger(eject) && eject >= 700 && eject <= 2300 ? eject : fallback.eject,
    speed: Number.isInteger(speed) && speed >= 30 && speed <= 2000 ? speed : fallback.speed,
  };
  normalized.guardMin = Math.max(700, Math.min(Number(saved?.guardMin) || 2300, normalized.home, normalized.eject) - (saved?.guardMin ? 0 : 60));
  normalized.guardMax = Math.min(2300, Math.max(Number(saved?.guardMax) || 700, normalized.home, normalized.eject) + (saved?.guardMax ? 0 : 60));
  if (normalized.guardMin >= normalized.guardMax) {
    normalized.guardMin = Math.max(700, Math.min(normalized.home, normalized.eject) - 60);
    normalized.guardMax = Math.min(2300, Math.max(normalized.home, normalized.eject) + 60);
  }
  return normalized;
}

function createSerialTransport(path, baudRate) {
  let SerialPort;
  let ReadlineParser;
  try {
    ({ SerialPort } = require("serialport"));
    ({ ReadlineParser } = require("@serialport/parser-readline"));
  } catch {
    throw new Error("Модуль serialport не установлен в desktop-приложении");
  }
  const port = new SerialPort({ path, baudRate, autoOpen: false, dtr: false, rts: false });
  const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));
  return {
    get isOpen() { return port.isOpen; },
    onLine(callback) { parser.on("data", (line) => callback(String(line || "").trim())); },
    onError(callback) { port.on("error", callback); },
    open() {
      return new Promise((resolve, reject) => port.open((error) => error ? reject(error) : resolve()));
    },
    close() {
      return new Promise((resolve) => {
        if (!port.isOpen) return resolve();
        port.close(() => resolve());
      });
    },
    flush() {
      return new Promise((resolve, reject) => port.flush((error) => error ? reject(error) : resolve()));
    },
    write(command) {
      return new Promise((resolve, reject) => {
        port.write(`${String(command).trim()}\n`, "ascii", (error) => {
          if (error) return reject(error);
          port.drain((drainError) => drainError ? reject(drainError) : resolve());
        });
      });
    },
  };
}

async function listSerialPaths() {
  try {
    const { SerialPort } = require("serialport");
    const ports = await SerialPort.list();
    return ports.map((port) => String(port.path || "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

class DispenserController {
  constructor(options = {}) {
    this.transportFactory = options.transportFactory || createSerialTransport;
    this.listPorts = options.listPorts || listSerialPaths;
    this.sleep = options.sleep || delay;
    this.logPath = options.logPath || null;
    this.transport = null;
    this.portName = null;
    this.waiters = new Set();
    this.queue = Promise.resolve();
    this.operations = new Map();
    this.nextToken = 1;
    this.active = null;
    this.firmwareVersion = null;
    this.firmwareLaneCount = 0;
    this.availableLanes = [];
    this.lastError = null;
    this.checkPromise = null;
    this.positions = DEFAULT_CALIBRATION.map((item) => item.home);
    this.logEntries = [];
    this.logWrites = 0;
  }

  log(message) {
    const line = `${new Date().toISOString()} ${message}`;
    this.logEntries.push(line);
    if (this.logEntries.length > 500) this.logEntries.splice(0, this.logEntries.length - 500);
    if (this.logPath) {
      try {
        this.logWrites += 1;
        if (this.logWrites % 100 === 1 && fs.existsSync(this.logPath) && fs.statSync(this.logPath).size > 10 * 1024 * 1024) {
          const previous = `${this.logPath}.1`;
          try { fs.rmSync(previous, { force: true }); } catch {}
          fs.renameSync(this.logPath, previous);
        }
        fs.appendFileSync(this.logPath, `${line}\n`, "utf8");
      } catch {}
    }
    console.log(`[dispenser] ${message}`);
  }

  handleLine(line) {
    if (!line) return;
    this.log(`RX ${line}`);
    for (const waiter of [...this.waiters]) waiter(line);
  }

  waitFor(match, timeoutMs, timeoutMessage) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const listener = (line) => {
        const result = match(line);
        if (!result) return;
        clearTimeout(timer);
        this.waiters.delete(listener);
        result.error ? reject(result.error) : resolve(result.value);
      };
      timer = setTimeout(() => {
        this.waiters.delete(listener);
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      this.waiters.add(listener);
    });
  }

  async send(command) {
    if (!this.transport?.isOpen) throw new Error("Дозатор не подключён");
    this.log(`TX ${command}`);
    await this.transport.write(command);
  }

  async ping() {
    const pong = this.waitFor((line) => line === "PONG" ? { value: true } : null, 1600, "ESP32 дозатора не ответила на PING");
    await this.send("PING");
    await pong;
  }

  async connectPort(portName, baudRate) {
    await this.close();
    const transport = this.transportFactory(portName, baudRate);
    this.transport = transport;
    this.portName = portName;
    transport.onLine((line) => this.handleLine(line));
    transport.onError((error) => {
      this.lastError = String(error?.message || error);
      this.log(`SERIAL ERROR ${this.lastError}`);
    });
    await transport.open();
    await this.sleep(700);
    await transport.flush();
    await this.ping();
    const version = this.waitFor(
      (line) => line.startsWith("VERSION ") ? { value: line } : null,
      900,
      "ESP32 не сообщила версию прошивки"
    );
    await this.send("VERSION");
    const versionLine = await version;
    if (!versionLine.includes("cycle_id=1")) {
      await this.close();
      throw new Error("Нужна безопасная прошивка дозатора с CYCLEID");
    }
    this.firmwareVersion = versionLine;
    const capabilities = firmwareCapabilities(versionLine);
    this.firmwareLaneCount = capabilities.count;
    this.availableLanes = capabilities.availableLanes;
    this.lastError = null;
    for (const lane of this.availableLanes) {
      const channel = lane - 1;
      await this.send(`STOP ${channel}`);
      await this.send(`DETACH ${channel}`);
    }
    this.log(`CONNECTED ${portName} ${versionLine}`);
  }

  async connect(config = {}) {
    const configuredPort = String(config.dispenserPort || "AUTO").trim() || "AUTO";
    const baudRate = Number(config.dispenserBaud || 115200);
    if (this.transport?.isOpen && this.firmwareVersion?.includes("cycle_id=1")) return;

    const candidates = [];
    if (configuredPort.toUpperCase() !== "AUTO") candidates.push(configuredPort);
    const discovered = await this.listPorts().catch(() => []);
    for (const path of discovered) {
      if (!candidates.some((item) => item.toLowerCase() === String(path).toLowerCase())) candidates.push(String(path));
    }
    if (!candidates.length) throw new Error("COM-порты не найдены. Проверьте USB-кабель и питание дозатора.");

    const failures = [];
    for (const portName of candidates) {
      try {
        await this.connectPort(portName, baudRate);
        return;
      } catch (error) {
        failures.push(`${portName}: ${error?.message || error}`);
        this.log(`PROBE FAILED ${failures[failures.length - 1]}`);
        await this.close();
      }
    }
    throw new Error(`ESP32 дозатора не найдена. Проверены ${candidates.join(", ")}. ${failures.at(-1) || ""}`.trim());
  }

  async check(config = {}) {
    if (this.active || this.currentOperationId) {
      const state = this.status();
      return { ...state, ok: state.connected, ready: state.connected, busy: true };
    }
    if (this.checkPromise) return this.checkPromise;
    this.checkPromise = (async () => {
      const requestedPort = String(config.dispenserPort || "AUTO").trim() || "AUTO";
      try {
        // AUTO resolves to a concrete COM port, so comparing it with "AUTO"
        // skipped the active PING on every later health check.
        const alreadyConnected = Boolean(
          this.transport?.isOpen && this.firmwareVersion?.includes("cycle_id=1"),
        );
        await this.connect(config);
        if (alreadyConnected) await this.ping();
        this.lastError = null;
        return { ...this.status(), ok: true, ready: true };
      } catch (error) {
        this.lastError = String(error?.message || error);
        await this.close();
        return {
          ...this.status(),
          ok: false,
          ready: false,
          connected: false,
          port: requestedPort,
          error: this.lastError,
        };
      }
    })();
    try {
      return await this.checkPromise;
    } finally {
      this.checkPromise = null;
    }
  }

  async emergencyStop() {
    if (!this.transport?.isOpen) return;
    for (const lane of this.availableLanes) {
      const channel = lane - 1;
      try { await this.send(`STOP ${channel}`); } catch {}
      try { await this.send(`DETACH ${channel}`); } catch {}
    }
    this.active = null;
  }

  assertLanesAvailable(lanes, config = {}, requireCalibration = false) {
    for (const lane of normalizeLanes(lanes)) {
      const label = `Дозатор ${Math.ceil(lane / 5)}, дорожка ${(lane - 1) % 5 + 1}`;
      if (lane > this.firmwareLaneCount) throw new Error(`${label}: обновите прошивку ESP32 для второго дозатора`);
      if (!this.availableLanes.includes(lane)) throw new Error(`${label}: пин ESP32 не настроен`);
      const calibration = calibrationFor(config, lane);
      if (requireCalibration && Math.abs(calibration.home - calibration.eject) < 20) {
        throw new Error(`${label}: сначала сохраните калибровку HOME и выдачи`);
      }
    }
  }

  async forceHomeLane(lane, config = {}) {
    this.assertLanesAvailable([lane], config, true);
    const channel = lane - 1;
    const calibration = calibrationFor(config, lane);
    const direction = calibration.eject >= calibration.home ? 1 : -1;
    const returnRate = Math.max(1400, Math.min(2000, calibration.speed * 3));
    const pushTarget = direction > 0
      ? Math.max(calibration.guardMin, calibration.home - 60)
      : Math.min(calibration.guardMax, calibration.home + 60);
    const reliefTarget = direction > 0
      ? Math.min(calibration.guardMax, calibration.home + 80)
      : Math.max(calibration.guardMin, calibration.home - 80);
    const powerMaxMs = 9000;
    await this.send(`STOP ${channel}`);
    // CYCLE starts the firmware power watchdog when the servo is first attached.
    // Re-attaching here resets that watchdog; changing POWERMAX alone does not.
    await this.send(`DETACH ${channel}`);
    await this.send(`LIM ${channel} ${calibration.guardMin} ${calibration.guardMax}`);
    await this.send(`RATE ${channel} ${returnRate}`);
    await this.send(`HOLD ${channel} 1`);
    await this.send(`POWERMAX ${channel} ${powerMaxMs}`);

    // The servo has no position feedback. A short relief/push sequence breaks a
    // jar wedge much more reliably than repeatedly commanding the same HOME PWM.
    await this.send(`SET ${channel} ${reliefTarget}`);
    await this.sleep(300);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await this.send(`SET ${channel} ${pushTarget}`);
      await this.sleep(380);
      if (attempt < 3) {
        await this.send(`SET ${channel} ${reliefTarget}`);
        await this.sleep(180);
      }
    }
    await this.send(`SET ${channel} ${calibration.home}`);
    await this.sleep(650);
    await this.send(`HOLD ${channel} 0`);
    await this.send(`DETACH ${channel}`);
    this.positions[channel] = calibration.home;
    this.log(`HOME PULSED lane=${lane} relief=${reliefTarget} push=${pushTarget} attempts=3 rate=${returnRate}`);
  }

  async runCycle(lane, config = {}) {
    this.assertLanesAvailable([lane], config, true);
    const channel = lane - 1;
    const calibration = calibrationFor(config, lane);
    const holdMs = Math.max(100, Math.min(2500, Number(config.dispenserHoldMs || 900)));
    const timeoutMs = cycleTimeoutMs(calibration, holdMs);
    const powerMax = Math.max(4000, Math.min(15000, timeoutMs + 1000));
    const token = this.nextToken;
    this.nextToken = token >= 2_000_000_000 ? 1 : token + 1;
    await this.send(`LIM ${channel} ${calibration.guardMin} ${calibration.guardMax}`);
    await this.send(`RATE ${channel} ${calibration.speed}`);
    await this.send(`HOLD ${channel} 0`);
    await this.send(`POWERMAX ${channel} ${powerMax}`);
    const done = this.waitFor((line) => {
      const doneMatch = line.match(/^DONE\s+(\d+)(?:\s+token=(\d+))?$/);
      if (doneMatch) {
        const doneChannel = Number(doneMatch[1]);
        const doneToken = Number(doneMatch[2]);
        if (doneChannel === channel && doneToken === token) return { value: true };
        return null;
      }
      const safeMatch = line.match(/^SAFE DETACH\s+(\d+)/);
      if (safeMatch && Number(safeMatch[1]) === channel) {
        return { error: new Error(`Автостоп дорожки ${lane}: проверьте механизм`) };
      }
      if (/^ERR(?:\s|$)/.test(line)) return { error: new Error(`ESP32: ${line}`) };
      return null;
    }, timeoutMs, `Дорожка ${lane} не подтвердила выдачу за ${Math.ceil(timeoutMs / 1000)} сек.`);
    this.active = { lane, channel, token };
    await this.send(`CYCLEID ${channel} ${calibration.home} ${calibration.eject} ${holdMs} ${token}`);
    await done;
    // DONE confirms the firmware's logical position. Re-apply the home pulse with
    // torque held long enough to recover from a physically stalled flap.
    await this.forceHomeLane(lane, config);
    this.active = null;
  }

  async runOperation(operationId, lanes, config) {
    let started = false;
    this.currentOperationId = operationId;
    this.log(`OPERATION START ${operationId} lanes=${lanes.join(",")}`);
    try {
      await this.connect(config);
      this.assertLanesAvailable(lanes, config, true);
      for (let index = 0; index < lanes.length; index += 1) {
        started = true;
        this.log(`OPERATION LANE START ${operationId} item=${index + 1}/${lanes.length} lane=${lanes[index]}`);
        await this.runCycle(lanes[index], config);
        this.log(`OPERATION LANE DONE ${operationId} item=${index + 1}/${lanes.length} lane=${lanes[index]}`);
        if (index + 1 < lanes.length) await this.sleep(GROUP_PAUSE_MS);
      }
      const result = { ok: true, operationId, dispensed: lanes.length, lanes };
      this.log(`OPERATION DONE ${operationId} lanes=${lanes.join(",")}`);
      return result;
    } catch (error) {
      await this.emergencyStop().catch(() => {});
      const result = {
        ok: false,
        operationId,
        error: String(error?.message || error),
        safeToRetry: !started,
      };
      this.log(`OPERATION FAILED ${operationId} safeToRetry=${result.safeToRetry} error=${result.error}`);
      return result;
    } finally {
      this.currentOperationId = null;
    }
  }

  dispense(payload = {}, config = {}) {
    const operationId = String(payload.operationId || "").trim();
    if (!operationId) return Promise.resolve({ ok: false, error: "Нет идентификатора операции", safeToRetry: true });
    if (this.operations.has(operationId)) return this.operations.get(operationId);
    let lanes;
    try { lanes = normalizeLanes(payload.lanes); }
    catch (error) { return Promise.resolve({ ok: false, error: error.message, safeToRetry: true }); }
    const task = this.queue.then(() => this.runOperation(operationId, lanes, config));
    this.queue = task.catch(() => {});
    this.operations.set(operationId, task);
    while (this.operations.size > 200) {
      const oldestOperationId = this.operations.keys().next().value;
      if (!oldestOperationId || oldestOperationId === operationId) break;
      this.operations.delete(oldestOperationId);
    }
    return task;
  }


  recoverHome(payload = {}, config = {}) {
    let lanes;
    try { lanes = [...new Set(normalizeLanes(payload.lanes))]; }
    catch (error) { return Promise.resolve({ ok: false, error: error.message }); }
    const task = this.queue.then(async () => {
      await this.connect(config);
      this.assertLanesAvailable(lanes, config, true);
      for (const lane of lanes) await this.forceHomeLane(lane, config);
      return { ok: true, lanes };
    }).catch((error) => ({ ok: false, error: String(error?.message || error) }));
    this.queue = task.catch(() => {});
    return task;
  }

  calibrationStatus(config = {}) {
    return {
      ...this.status(),
      lanes: Array.from({ length: LANE_COUNT }, (_, index) => ({
        lane: index + 1,
        dispenser: Math.floor(index / 5) + 1,
        localLane: index % 5 + 1,
        supported: index < this.firmwareLaneCount,
        configured: this.availableLanes.includes(index + 1),
        ...calibrationFor(config, index + 1),
        current: Number(this.positions[index] || calibrationFor(config, index + 1).home),
      })),
    };
  }

  diagnostics() {
    let persisted = [];
    if (this.logPath) {
      try {
        const stat = fs.statSync(this.logPath);
        const bytes = Math.min(stat.size, 256 * 1024);
        const buffer = Buffer.alloc(bytes);
        const fd = fs.openSync(this.logPath, "r");
        try { fs.readSync(fd, buffer, 0, bytes, stat.size - bytes); } finally { fs.closeSync(fd); }
        persisted = buffer.toString("utf8").split(/\r?\n/).filter(Boolean).slice(-250);
      } catch {}
    }
    return {
      ...this.status(),
      log: (persisted.length ? persisted : this.logEntries).slice(-250),
    };
  }

  calibrationCommand(payload = {}, config = {}) {
    const action = String(payload.action || "").trim();
    const lane = Number(payload.lane);
    if (!Number.isInteger(lane) || lane < 1 || lane > LANE_COUNT) {
      return Promise.resolve({ ok: false, error: "Выберите дорожку 1–10" });
    }
    const task = this.queue.then(async () => {
      await this.connect(config);
      this.assertLanesAvailable([lane], config, ["home", "test", "sync"].includes(action));
      const channel = lane - 1;
      const calibration = calibrationFor(config, lane);
      if (action === "home") {
        await this.forceHomeLane(lane, config);
      } else if (action === "release") {
        await this.send(`STOP ${channel}`);
        await this.send(`HOLD ${channel} 0`);
        await this.send(`DETACH ${channel}`);
      } else if (action === "move") {
        const target = Math.max(700, Math.min(2300, Number(payload.target)));
        if (!Number.isInteger(target)) throw new Error("Некорректное положение сервы");
        const rate = Math.max(30, Math.min(800, Number(payload.speed || 300)));
        await this.send(`STOP ${channel}`);
        await this.send(`LIM ${channel} 700 2300`);
        await this.send(`RATE ${channel} ${rate}`);
        await this.send(`POWERMAX ${channel} 15000`);
        await this.send(`HOLD ${channel} 1`);
        await this.send(`SET ${channel} ${target}`);
        await this.sleep(Math.ceil(Math.abs(target - Number(this.positions[channel] || calibration.home)) / rate * 1000 + 350));
        this.positions[channel] = target;
      } else if (action === "center") {
        await this.send(`STOP ${channel}`);
        await this.send(`LIM ${channel} 700 2300`);
        await this.send(`RATE ${channel} 300`);
        await this.send(`POWERMAX ${channel} 15000`);
        await this.send(`HOLD ${channel} 1`);
        await this.send(`SET ${channel} 1500`);
        await this.sleep(Math.ceil(Math.abs(1500 - Number(this.positions[channel] || calibration.home)) / 300 * 1000 + 500));
        this.positions[channel] = 1500;
      } else if (action === "test") {
        await this.runCycle(lane, config);
        this.positions[channel] = calibration.home;
      } else if (action === "sync") {
        await this.send(`CAL ${channel} ${calibration.home} ${calibration.eject}`);
      } else {
        throw new Error("Неизвестная команда калибровки");
      }
      return { ok: true, lane, current: this.positions[channel], calibration };
    }).catch((error) => ({ ok: false, error: String(error?.message || error) }));
    this.queue = task.catch(() => {});
    return task;
  }

  status() {
    const connected = Boolean(this.transport?.isOpen);
    return {
      ok: connected,
      ready: connected,
      connected,
      port: this.portName,
      firmwareVersion: this.firmwareVersion,
      firmwareLaneCount: this.firmwareLaneCount,
      availableLanes: [...this.availableLanes],
      error: this.lastError,
      busy: Boolean(this.active || this.currentOperationId),
      active: this.active,
      activeOperationId: this.currentOperationId || null,
      recentOperationIds: [...this.operations.keys()].slice(-100),
    };
  }

  async close() {
    for (const waiter of [...this.waiters]) this.waiters.delete(waiter);
    if (this.transport) await this.transport.close().catch(() => {});
    this.transport = null;
    this.portName = null;
    this.firmwareVersion = null;
    this.firmwareLaneCount = 0;
    this.availableLanes = [];
    this.active = null;
  }
}

module.exports = {
  DispenserController,
  LANE_COUNT,
  firmwareCapabilities,
  DEFAULT_CALIBRATION,
  normalizeLanes,
  cycleTimeoutMs,
  homeHoldMs,
  calibrationFor,
};
