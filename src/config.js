"use strict";
const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { DEFAULT_CALIBRATION } = require("./dispenser");

// Конфиг лежит в userData, чтобы менять URL/порт без пересборки установщика.
const DEFAULTS = {
  siteUrl: "http://SERVER_HOST/sborka/",
  // Секрет для desktop-эндпоинтов сервера (вход по отпечатку). Должен совпадать с сервером.
  // Значение-заглушка: задайте реальный секрет через config.json (см. config.example.json).
  desktopSecret: "CHANGE_ME_DESKTOP_SECRET",
  serialPort: "AUTO", // AUTO = автоопределение CH340/ESP32, либо "COM7"
  serialBaud: 115200,
  dispenserPort: "AUTO",
  dispenserBaud: 115200,
  dispenserHoldMs: 900,
  dispenserCalibration: DEFAULT_CALIBRATION.map((item) => ({ ...item })),
  idleLogoutMs: 5 * 60 * 1000, // 5 минут бездействия
  printerQueue: "Xprinter XP-365B",
  labelWidthMm: 58,
  labelHeightMm: 40,
  // Второй физический Xprinter для маленьких этикеток ЧЗ. Пока выключен,
  // обычная печать не меняется. Очередь и размер настраиваются один раз на рабочем ПК.
  chzPrinterEnabled: false,
  chzPrinterQueue: "",
  chzLabelWidthMm: 20,
  chzLabelHeightMm: 20,
  chzLabelRotation: 0,
  chzLabelScale: 0.93,
  chzLocalUrl: "http://127.0.0.1:3030",
};

function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(patch, { requirePersistence = false } = {}) {
  const next = { ...loadConfig(), ...patch };
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    const temporaryPath = `${configPath()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(temporaryPath, configPath());
  } catch (e) {
    console.error("saveConfig failed", e);
    if (requirePersistence) throw e;
  }
  return next;
}

module.exports = { DEFAULTS, loadConfig, saveConfig, configPath };
