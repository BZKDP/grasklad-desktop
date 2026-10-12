"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Jimp = require("jimp");
const { _test } = require("../src/printer");

function queue(name, driver, port, offline = false, status = 3, extendedStatus = 2) {
  return { name, driver, port, offline, status, extendedStatus };
}

test("selects the native-driver queue on the physically active USB port", () => {
  const printers = [
    queue("Xprinter XP-365B", "Xprinter XP-365B", "USB004", true),
    queue("Xprinter XP-365B (копия 1)", "Xprinter XP-365B", "USB011", true),
    queue("Xprinter XP-365B RAW", "Generic / Text Only", "USB011", false),
  ];

  const result = _test.selectPrinterQueue(printers, "Xprinter XP-365B", ["USB011"], true);

  assert.equal(result.queue, "Xprinter XP-365B (копия 1)");
  assert.equal(result.found, true);
  assert.equal(result.onLivePort, true);
  assert.equal(result.adopted, true);
});

test("does not treat an offline stale USB queue as a connected printer", () => {
  const printers = [queue("Xprinter XP-365B", "Xprinter XP-365B", "USB004", true)];

  const result = _test.selectPrinterQueue(printers, "Xprinter XP-365B", [], false);

  assert.equal(result.queue, "Xprinter XP-365B");
  assert.equal(result.found, false);
  assert.equal(result.onLivePort, false);
});

test("accepts Windows unknown extended status for a healthy native queue", () => {
  const printer = queue("Xprinter XP-365B", "Xprinter XP-365B", "USB004", false, 3, 2);

  assert.equal(_test.queueHasHardError(printer), false);
  assert.deepEqual(_test.queueStatusFromDetails(printer), {
    queue: "Xprinter XP-365B",
    exists: true,
    ready: true,
    state: "READY",
  });
  const result = _test.selectPrinterQueue([printer], "Xprinter XP-365B", ["USB004"], true);
  assert.equal(result.found, true);
});

test("uses one healthy native USB queue when PnP port mapping is unavailable", () => {
  const printer = queue("Xprinter XP-365B", "Xprinter XP-365B", "USB006", false, 3, 2);

  const result = _test.selectPrinterQueue([printer], "Xprinter XP-365B", [], false);
  assert.equal(result.found, true);
  assert.equal(result.onLivePort, true);
  assert.equal(result.inferredPhysicalPresent, true);
});

test("never adopts a Generic Text queue when the native queue needs repair", () => {
  const printers = [
    queue("Warehouse labels", "Xprinter XP-365B", "USB004", true),
    queue("Xprinter XP-365B RAW", "Generic / Text Only", "USB011", false),
  ];

  const result = _test.selectPrinterQueue(printers, "Missing configured queue", ["USB011"], true);

  assert.equal(result.queue, "Warehouse labels");
  assert.equal(result.found, false);
  assert.equal(result.onLivePort, false);
});

test("adopts an unusually named native queue when it is on the active port", () => {
  const printers = [queue("Packing desk printer", "Xprinter XP-365B", "USB007", false)];

  const result = _test.selectPrinterQueue(printers, "Xprinter XP-365B", ["USB007"], true);

  assert.equal(result.queue, "Packing desk printer");
  assert.equal(result.found, true);
  assert.equal(result.adopted, true);
});

test("never selects a configured Generic Text queue", () => {
  const printers = [
    queue("Xprinter XP-365B RAW", "Generic / Text Only", "USB003", false, 3),
    queue("Xprinter XP-365B (copy 2)", "Xprinter XP-365B", "USB002", false, 3),
  ];

  const result = _test.selectPrinterQueue(printers, "Xprinter XP-365B RAW", ["USB002"], true);

  assert.equal(result.queue, "Xprinter XP-365B (copy 2)");
  assert.equal(result.found, true);
});

test("infers the only healthy native USB port when the registry mapping is unavailable", () => {
  const printers = [
    queue("Xprinter XP-365B", "Xprinter XP-365B", "USB004", true, 7),
    queue("Xprinter XP-365B (copy 2)", "Xprinter XP-365B", "USB002", false, 3),
  ];

  const result = _test.selectPrinterQueue(printers, "Xprinter XP-365B", [], true);

  assert.equal(result.queue, "Xprinter XP-365B (copy 2)");
  assert.equal(result.onLivePort, true);
  assert.equal(result.found, true);
});

test("normalizes invalid copy counts and caps oversized requests", () => {
  assert.equal(_test.normalizeCopies(undefined), 1);
  assert.equal(_test.normalizeCopies("not-a-number"), 1);
  assert.equal(_test.normalizeCopies(0), 1);
  assert.equal(_test.normalizeCopies(2.9), 2);
  assert.equal(_test.normalizeCopies(1000), 100);
});

test("uses an independent size, queue and rotation for CHZ labels", () => {
  const profile = _test.getPrintProfile({
    printerQueue: "Main",
    labelWidthMm: 58,
    labelHeightMm: 40,
    chzPrinterQueue: "CHZ second",
    chzLabelWidthMm: 30,
    chzLabelHeightMm: 20,
    chzLabelRotation: 90,
  }, "chz");
  assert.equal(profile.printerQueue, "CHZ second");
  assert.equal(profile.labelWidthMm, 30);
  assert.equal(profile.labelHeightMm, 20);
  assert.equal(profile.labelRotation, 90);
});

test("rotates portrait package labels but keeps landscape labels horizontal", () => {
  assert.equal(_test.shouldRotateForBestFit(444, 630, 464, 320), true);
  assert.equal(_test.shouldRotateForBestFit(630, 444, 464, 320), false);
  assert.equal(_test.shouldRotateForBestFit(400, 400, 464, 320), false);
});

test("package label mode trims whitespace and fills a 58x40 canvas", async () => {
  const source = new Jimp(444, 630, 0xffffffff);
  source.scan(60, 80, 324, 470, function paintBlack(_x, _y, index) {
    this.bitmap.data[index] = 0;
    this.bitmap.data[index + 1] = 0;
    this.bitmap.data[index + 2] = 0;
    this.bitmap.data[index + 3] = 255;
  });
  const png = await source.getBufferAsync(Jimp.MIME_PNG);
  const canvas = await _test.prepareLabelCanvas(
    png,
    { labelWidthMm: 58, labelHeightMm: 40 },
    { fitMode: "package" }
  );
  const bounds = _test.findInkBounds(canvas);

  assert.equal(canvas.bitmap.width, 464);
  assert.equal(canvas.bitmap.height, 320);
  assert.ok(bounds.width >= 300, `expected wide rotated content, got ${bounds.width}`);
  assert.ok(bounds.height >= 280, `expected near-full height, got ${bounds.height}`);
  assert.ok(bounds.minX >= 0 && bounds.minY >= 0);
  assert.ok(bounds.maxX < canvas.bitmap.width && bounds.maxY < canvas.bitmap.height);
});

test("CHZ two-up mode cycles PDF pages in physical sheet pairs", () => {
  assert.deepEqual(_test.chzTwoUpPagePairIndexes(2, 0), [0, 1]);
  assert.deepEqual(_test.chzTwoUpPagePairIndexes(2, 1), [0, 1]);
  assert.deepEqual(_test.chzTwoUpPagePairIndexes(11, 0), [0, 1]);
  assert.deepEqual(_test.chzTwoUpPagePairIndexes(11, 5), [10, 0]);
  assert.deepEqual(_test.chzTwoUpPagePairIndexes(11, 6), [1, 2]);
  assert.deepEqual(_test.chzTwoUpPagePairIndexes(1, 20), [0, 0]);
});

test("CHZ two-up canvas is exactly 58x40 mm with two QR halves and cut marks", async () => {
  const left = new Jimp(200, 200, 0xffffffff);
  const right = new Jimp(200, 200, 0xffffffff);
  left.scan(20, 20, 160, 160, function paintLeft(_x, _y, index) {
    this.bitmap.data[index] = 0;
    this.bitmap.data[index + 1] = 0;
    this.bitmap.data[index + 2] = 0;
    this.bitmap.data[index + 3] = 255;
  });
  right.scan(20, 20, 160, 160, function paintRight(_x, _y, index) {
    this.bitmap.data[index] = 0;
    this.bitmap.data[index + 1] = 0;
    this.bitmap.data[index + 2] = 0;
    this.bitmap.data[index + 3] = 255;
  });
  const canvas = await _test.buildChzTwoUpCanvas(
    await left.getBufferAsync(Jimp.MIME_PNG),
    await right.getBufferAsync(Jimp.MIME_PNG),
  );

  assert.equal(canvas.bitmap.width, 464);
  assert.equal(canvas.bitmap.height, 320);
  assert.equal(canvas.getPixelColor(231, 2), 0x000000ff);
  assert.equal(canvas.getPixelColor(231, 318), 0x000000ff);
  assert.notEqual(canvas.getPixelColor(100, 100), 0xffffffff);
  assert.notEqual(canvas.getPixelColor(360, 100), 0xffffffff);
});

test("RAW TSPL resets the printer reference before every label", async () => {
  const canvas = new Jimp(464, 320, 0xffffffff);
  const png = await canvas.getBufferAsync(Jimp.MIME_PNG);
  const tspl = await _test.pngToTspl(png, {
    labelWidthMm: 58,
    labelHeightMm: 40,
    labelScale: 1,
  });
  assert.match(tspl.subarray(0, 180).toString("ascii"), /DIRECTION 0\r\nREFERENCE 0,0\r\n/);
});

test("joins duplicate active print requests and reports one physical print", async () => {
  const gate = _test.createSingleFlightGate({ cooldownMs: 15000 });
  let release;
  let runs = 0;
  const task = () => {
    runs += 1;
    return new Promise((resolve) => { release = () => resolve({ printed: 1, queue: "Main" }); });
  };

  const first = gate.run("same-label", task);
  await Promise.resolve();
  const duplicate = gate.run("same-label", task);
  release();

  assert.deepEqual(await first, { printed: 1, queue: "Main" });
  assert.deepEqual(await duplicate, {
    printed: 0,
    queue: "Main",
    deduplicated: true,
    joinedActive: true,
  });
  assert.equal(runs, 1);
});

test("rejects a different label while the printer is busy", async () => {
  const gate = _test.createSingleFlightGate({ cooldownMs: 15000 });
  let release;
  const first = gate.run("label-a", () => new Promise((resolve) => {
    release = () => resolve({ printed: 1 });
  }));
  await Promise.resolve();

  await assert.rejects(
    gate.run("label-b", async () => ({ printed: 1 })),
    (error) => error?.code === "PRINT_BUSY",
  );
  release();
  await first;
});

test("deduplicates a recently completed label", async () => {
  let now = 1000;
  const gate = _test.createSingleFlightGate({ cooldownMs: 15000, now: () => now });
  let runs = 0;
  const task = async () => ({ printed: ++runs, queue: "Main" });

  assert.equal((await gate.run("label", task)).printed, 1);
  now += 1000;
  const duplicate = await gate.run("label", task);

  assert.equal(duplicate.printed, 0);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.recent, true);
  assert.equal(runs, 1);
});
