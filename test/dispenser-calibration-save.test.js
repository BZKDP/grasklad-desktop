"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const os = require("node:os");
const { LANE_COUNT, calibrationFor } = require("../src/dispenser");
const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
const start = main.indexOf('ipcMain.handle("dispenser:calibrationSave"');
const end = main.indexOf('ipcMain.handle("dispenser:stop"', start);
function handler(config, persistenceFailure = false, syncFailure = false) {
  let callback, saved;
  const context = vm.createContext({
    LANE_COUNT, calibrationFor,
    ipcMain: { handle: (_, fn) => { callback = fn; } }, loadConfig: () => config,
    saveConfig: (patch, options) => { assert.equal(options.requirePersistence, true); if (persistenceFailure) throw new Error("disk full"); saved = { ...config, ...patch }; return saved; },
    dispenser: { calibrationCommand: async () => syncFailure ? { ok: false, error: "offline" } : { ok: true } },
  });
  vm.runInContext(main.slice(start, end), context);
  return { run: (payload) => callback({}, payload), saved: () => saved };
}
test("saving channel ten extends legacy config and preserves first five calibrations", async () => {
  const initial = { dispenserCalibration: Array.from({ length: 5 }, (_, i) => ({ home: 820 + i, eject: 1700 + i, guardMin: 750, guardMax: 1800, speed: 500 })) };
  const fixture = handler(initial);
  assert.equal((await fixture.run({ lane: 10, home: 900, eject: 1800 })).ok, true);
  assert.equal(fixture.saved().dispenserCalibration.length, 10);
  assert.deepEqual(Array.from(fixture.saved().dispenserCalibration.slice(0,5)), initial.dispenserCalibration);
  assert.equal(fixture.saved().dispenserCalibration[9].home, 900);
  assert.equal(initial.dispenserCalibration.length, 5);
});
test("persistence and sync errors do not claim calibration succeeded", async () => {
  const failed = handler({}, true);
  assert.equal((await failed.run({ lane: 6, home: 900, eject: 1800 })).ok, false);
  const offline = handler({}, false, true);
  const result = await offline.run({ lane: 6, home: 900, eject: 1800 });
  assert.equal(result.ok, false);
  assert.equal(result.saved, true);
  assert.equal(offline.saved().dispenserCalibration[5].home, 900);
});
test("atomic calibration persistence survives config module reload", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grasklad-config-test-"));
  try {
    const source = fs.readFileSync(path.join(__dirname, "../src/config.js"), "utf8");
    function loadModule() {
      const context = vm.createContext({ module: { exports: {} }, console, require: (name) => name === "electron" ? { app: { getPath: () => directory } } : name === "./dispenser" ? require("../src/dispenser") : require(name) });
      vm.runInContext(source, context);
      return context.module.exports;
    }
    const first = loadModule();
    const calibrations = Array.from({ length: 10 }, (_, i) => calibrationFor({}, i + 1));
    calibrations[9] = { home: 950, eject: 1650, guardMin: 890, guardMax: 1710, speed: 500 };
    first.saveConfig({ dispenserCalibration: calibrations }, { requirePersistence: true });
    const second = loadModule();
    assert.equal(second.loadConfig().dispenserCalibration[9].home, 950);
    assert.equal(second.loadConfig().dispenserCalibration[0].home, 817);
    assert.equal(fs.existsSync(path.join(directory, "config.json.tmp")), false);
  } finally {
    // Only the explicitly created temporary fixture directory is removed.
    assert.ok(directory.startsWith(path.join(os.tmpdir(), "grasklad-config-test-")));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
