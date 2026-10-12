"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DispenserController, normalizeLanes, cycleTimeoutMs, homeHoldMs, calibrationFor, DEFAULT_CALIBRATION, firmwareCapabilities } = require("../src/dispenser");

class FakeTransport {
  constructor(version = "VERSION gate12 cycle_id=1") {
    this.version = version;
    this.isOpen = false;
    this.commands = [];
    this.line = () => {};
  }
  onLine(callback) { this.line = callback; }
  onError() {}
  async open() { this.isOpen = true; }
  async close() { this.isOpen = false; }
  async flush() {}
  async write(command) {
    this.commands.push(command);
    if (command === "PING") queueMicrotask(() => this.line("PONG"));
    if (command === "VERSION") queueMicrotask(() => this.line(this.version));
    const match = command.match(/^CYCLEID\s+(\d+)\s+\d+\s+\d+\s+\d+\s+(\d+)$/);
    if (match) queueMicrotask(() => this.line(`DONE ${match[1]} token=${match[2]}`));
  }
}

test("validates one-based dispenser lanes", () => {
  assert.deepEqual(normalizeLanes([1, "5", 2]), [1, 5, 2]);
  assert.throws(() => normalizeLanes([0]), /Неверный/);
  assert.throws(() => normalizeLanes([]), /Не переданы/);
});

test("uses the calibrated movement timeout formula", () => {
  assert.equal(cycleTimeoutMs(DEFAULT_CALIBRATION[0], 900), 5576);
  assert.equal(homeHoldMs(DEFAULT_CALIBRATION[0]), 2188);
});

test("uses persisted calibration and falls back from invalid values", () => {
  assert.deepEqual(calibrationFor({ dispenserCalibration: [{ home: 900, eject: 1700, guardMin: 800, guardMax: 1800, speed: 600 }] }, 1), { home: 900, eject: 1700, guardMin: 800, guardMax: 1800, speed: 600 });
  assert.equal(calibrationFor({ dispenserCalibration: [{ home: 1, eject: 2, speed: 0 }] }, 1).home, DEFAULT_CALIBRATION[0].home);
});

test("dispenses repeated lanes sequentially and never repeats an operation id", async () => {
  const fake = new FakeTransport();
  const controller = new DispenserController({ transportFactory: () => fake, listPorts: async () => [], sleep: async () => {} });
  const first = await controller.dispense({ operationId: "order-1", lanes: [1, 1, 3] }, { dispenserPort: "COM6" });
  const commandCount = fake.commands.length;
  const second = await controller.dispense({ operationId: "order-1", lanes: [1, 1, 3] }, { dispenserPort: "COM6" });

  assert.equal(first.ok, true);
  assert.equal(first.dispensed, 3);
  assert.deepEqual(second, first);
  assert.equal(fake.commands.length, commandCount);
  assert.deepEqual(fake.commands.filter((line) => line.startsWith("CYCLEID")).map((line) => Number(line.split(" ")[1])), [0, 0, 2]);
  assert.equal(fake.commands.filter((line) => line === `SET 0 ${DEFAULT_CALIBRATION[0].home}`).length, 2);
  assert.equal(fake.commands.filter((line) => line === `SET 2 ${DEFAULT_CALIBRATION[2].home}`).length, 1);
  assert.equal(fake.commands.filter((line) => line === `SET 0 ${DEFAULT_CALIBRATION[0].guardMin}`).length, 6);
});

test("recovers selected lanes to home without running another dispense cycle", async () => {
  const fake = new FakeTransport();
  const controller = new DispenserController({ transportFactory: () => fake, listPorts: async () => [], sleep: async () => {} });

  const result = await controller.recoverHome({ lanes: [2, 2, 5] }, { dispenserPort: "COM6" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.lanes, [2, 5]);
  assert.equal(fake.commands.some((line) => line.startsWith("CYCLEID")), false);
  assert.equal(fake.commands.filter((line) => line === `SET 1 ${DEFAULT_CALIBRATION[1].home}`).length, 1);
  assert.equal(fake.commands.filter((line) => line === `SET 4 ${DEFAULT_CALIBRATION[4].home}`).length, 1);
  assert.equal(fake.commands.filter((line) => line === `SET 1 ${DEFAULT_CALIBRATION[1].guardMin}`).length, 3);
  assert.ok(fake.commands.indexOf("DETACH 1") < fake.commands.indexOf(`SET 1 ${DEFAULT_CALIBRATION[1].home}`));
});

test("keeps serial diagnostics available after a controller restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grasklad-dispenser-"));
  const logPath = path.join(dir, "dispenser.log");
  const first = new DispenserController({ logPath });
  first.log("TX TEST 1");
  const second = new DispenserController({ logPath });

  assert.match(second.diagnostics().log.at(-1), /TX TEST 1/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("actively checks that the ESP32 answers before an operation", async () => {
  const fake = new FakeTransport();
  const controller = new DispenserController({ transportFactory: () => fake, listPorts: async () => [], sleep: async () => {} });

  const first = await controller.check({ dispenserPort: "COM6" });
  const second = await controller.check({ dispenserPort: "COM6" });

  assert.equal(first.ready, true);
  assert.equal(first.port, "COM6");
  assert.match(first.firmwareVersion, /cycle_id=1/);
  assert.equal(second.ready, true);
  assert.equal(fake.commands.filter((line) => line === "PING").length, 2);
});

test("actively rechecks an AUTO-resolved dispenser port", async () => {
  const fake = new FakeTransport();
  const controller = new DispenserController({
    transportFactory: () => fake,
    listPorts: async () => ["COM6"],
    sleep: async () => {},
  });

  const first = await controller.check({ dispenserPort: "AUTO" });
  const second = await controller.check({ dispenserPort: "AUTO" });

  assert.equal(first.ready, true);
  assert.equal(first.port, "COM6");
  assert.equal(second.ready, true);
  assert.equal(fake.commands.filter((line) => line === "PING").length, 2);
});

test("reports a disconnected dispenser when PING is not answered", async () => {
  const fake = new FakeTransport();
  fake.write = async function (command) { this.commands.push(command); };
  const controller = new DispenserController({ transportFactory: () => fake, listPorts: async () => [], sleep: async () => {} });

  const result = await controller.check({ dispenserPort: "COM6" });

  assert.equal(result.ready, false);
  assert.equal(result.connected, false);
  assert.match(result.error, /PING/);
});

test("finds the dispenser on another COM port when the saved port belongs to a different ESP32", async () => {
  const transports = new Map();
  const controller = new DispenserController({
    listPorts: async () => ["COM6", "COM9"],
    transportFactory: (path) => {
      const fake = new FakeTransport();
      if (path === "COM6") fake.write = async function (command) { this.commands.push(command); };
      transports.set(path, fake);
      return fake;
    },
    sleep: async () => {},
  });

  const result = await controller.check({ dispenserPort: "COM6" });

  assert.equal(result.ready, true);
  assert.equal(result.port, "COM9");
  assert.ok(transports.get("COM6").commands.includes("PING"));
  assert.ok(transports.get("COM9").commands.includes("VERSION"));
});
