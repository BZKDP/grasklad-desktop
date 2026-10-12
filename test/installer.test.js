"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.join(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("installer provisions Xprinter and supports disconnected installation", () => {
  const nsis = read("build/installer.nsh");
  const provision = read("printer-driver/provision-printer.cmd");
  const setup = read("printer-driver/install-printer.ps1");

  assert.match(nsis, /provision-printer\.cmd/i);
  assert.match(provision, /Sysnative\\WindowsPowerShell/i);
  assert.match(setup, /AllowDisconnected/);
  assert.match(setup, /Sysnative\\pnputil\.exe/i);
});

test("bundled driver installer reports failures instead of unconditional success", () => {
  const batch = read("printer-driver/install-drivers.bat");

  assert.match(batch, /set \/a FAIL=0/i);
  assert.match(batch, /\[failed\]/i);
  assert.match(batch, /exit \/b 1/i);
});

test("preload bridge version matches the desktop package version", () => {
  const packageVersion = JSON.parse(read("package.json")).version;
  const preload = read("src/preload.js");

  assert.match(preload, new RegExp(`const version = ["']${packageVersion.replace(/\./g, "\\.")}["']`));
});
