"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DispenserController, firmwareCapabilities, normalizeLanes, calibrationFor, DEFAULT_CALIBRATION } = require("../src/dispenser");

function fixture(version) {
  const transport = {
    isOpen: false, commands: [],
    onLine(callback) { this.line = callback; }, onError() {},
    async open() { this.isOpen = true; }, async close() { this.isOpen = false; }, async flush() {},
    async write(command) {
      this.commands.push(command);
      if (command === "PING") queueMicrotask(() => this.line("PONG"));
      if (command === "VERSION") queueMicrotask(() => this.line(version));
      const match = command.match(/^CYCLEID\s+(\d+)\s+\d+\s+\d+\s+\d+\s+(\d+)$/);
      if (match) queueMicrotask(() => this.line(`DONE ${match[1]} token=${match[2]}`));
    },
  };
  const controller = new DispenserController({ transportFactory: () => transport, listPorts: async () => [], sleep: async () => {} });
  const config = { dispenserPort: "TEST", dispenserCalibration: DEFAULT_CALIBRATION.map((item) => ({ ...item, home: 817, eject: 1661, guardMin: 757, guardMax: 1721 })) };
  return { transport, controller, config };
}

test("ten channels are normalized; unset new channels have neutral calibration", () => {
  assert.deepEqual(normalizeLanes([1, "6", 10]), [1, 6, 10]);
  assert.throws(() => normalizeLanes([11]));
  assert.equal(DEFAULT_CALIBRATION.length, 10);
  assert.equal(calibrationFor({}, 10).home, calibrationFor({}, 10).eject);
  assert.equal(calibrationFor({ dispenserCalibration: DEFAULT_CALIBRATION.slice(0, 5) }, 6).home, 1500);
});

test("legacy firmware advertises only five channels; malformed metadata is rejected", () => {
  assert.deepEqual(firmwareCapabilities("VERSION old cycle_id=1"), { count: 5, availableLanes: [1,2,3,4,5] });
  assert.deepEqual(firmwareCapabilities("VERSION new channels=10 configured_mask=543"), { count: 10, availableLanes: [1,2,3,4,5,10] });
  assert.throws(() => firmwareCapabilities("VERSION channels=11"));
  assert.throws(() => firmwareCapabilities("VERSION channels=10 configured_mask=1024"));
});

test("mixed bundle issues jars sequentially across both dispensers and deduplicates retries", async () => {
  const { controller, transport, config } = fixture("VERSION dual cycle_id=1 channels=10 configured_mask=1023");
  const payload = { operationId: "mixed", lanes: [1,6,6,10] };
  const result = await controller.dispense(payload, config);
  assert.equal(result.ok, true);
  assert.equal(result.dispensed, 4);
  assert.deepEqual(transport.commands.filter((cmd) => cmd.startsWith("CYCLEID")).map((cmd) => Number(cmd.split(" ")[1])), [0,5,5,9]);
  assert.equal(transport.commands.filter((cmd) => cmd === "SET 5 817").length, 2);
  const length = transport.commands.length;
  assert.deepEqual(await controller.dispense(payload, config), result);
  assert.equal(transport.commands.length, length);
  assert.equal(controller.calibrationStatus(config).lanes[9].dispenser, 2);
  assert.equal(controller.calibrationStatus(config).lanes[9].localLane, 5);
});

for (const [name, version, error] of [
  ["legacy firmware", "VERSION old cycle_id=1", /прошивку/],
  ["unconfigured pins", "VERSION dual cycle_id=1 channels=10 configured_mask=31", /пин/],
]) {
  test(`${name} blocks the entire mixed order before any motion`, async () => {
    const { controller, transport, config } = fixture(version);
    const result = await controller.dispense({ operationId: name, lanes: [1,6] }, config);
    assert.equal(result.ok, false);
    assert.equal(result.safeToRetry, true);
    assert.match(result.error, error);
    assert.equal(transport.commands.some((cmd) => /^(CYCLEID|SET) /.test(cmd)), false);
    assert.equal(transport.commands.includes("STOP 5"), false);
    assert.equal(controller.calibrationStatus(config).lanes[5].configured, false);
    const first = await controller.dispense({ operationId: `${name}-first`, lanes: [1] }, config);
    assert.equal(first.ok, true);
  });
}

test("uncalibrated second channel blocks the entire order and HOME recovery", async () => {
  const { controller, transport } = fixture("VERSION dual cycle_id=1 channels=10 configured_mask=1023");
  const config = { dispenserPort: "TEST" };
  const result = await controller.dispense({ operationId: "neutral", lanes: [1,6] }, config);
  assert.equal(result.ok, false);
  assert.equal(result.safeToRetry, true);
  assert.match(result.error, /калибровку/);
  const recovered = await controller.recoverHome({ lanes: [1,6] }, config);
  assert.equal(recovered.ok, false);
  assert.equal(transport.commands.some((cmd) => /^(CYCLEID|SET) /.test(cmd)), false);
});

test("calibration and HOME recovery use global channels without touching dispenser one", async () => {
  const { controller, transport, config } = fixture("VERSION dual cycle_id=1 channels=10 configured_mask=1023");
  await controller.check(config);
  transport.commands.length = 0;
  assert.equal((await controller.calibrationCommand({ action: "move", lane: 10, target: 1100 }, config)).ok, true);
  assert.equal((await controller.calibrationCommand({ action: "sync", lane: 10 }, config)).ok, true);
  assert.equal((await controller.recoverHome({ lanes: [6,10] }, config)).ok, true);
  assert.ok(transport.commands.includes("SET 9 1100"));
  assert.ok(transport.commands.includes("CAL 9 817 1661"));
  assert.ok(transport.commands.includes("SET 9 817"));
  assert.ok(transport.commands.every((cmd) => Number(cmd.split(" ")[1]) >= 5));
});
