"use strict";
const { contextBridge, ipcRenderer } = require("electron");
// ВАЖНО: preload у Electron работает в песочнице — require произвольных файлов (в т.ч.
// "../package.json") ЗАПРЕЩЁН и роняет весь preload → window.desktopBridge не создаётся →
// оболочка намертво виснет. Версию НЕ тянем из package.json, задаём литералом.
const version = "1.0.41";

// Мост между оболочкой/сайтом и главным процессом.
// window.desktopBridge доступен и в оболочке, и (через инъекцию) на сайте —
// сайт по наличию этого объекта понимает, что работает внутри десктоп-приложения.
contextBridge.exposeInMainWorld("desktopBridge", {
  isDesktop: true,
  platform: "windows",
  version,

  // конфиг
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (patch) => ipcRenderer.invoke("config:set", patch),

  // печать
  listPrinters: () => ipcRenderer.invoke("printer:list"),
  printLabel: (payload) => ipcRenderer.invoke("printer:printLabel", payload),
  printOrderLabels: (payload) => ipcRenderer.invoke("printer:printOrderLabels", payload),
  printChzLabel: (payload) => ipcRenderer.invoke("printer:printLabel", { ...(payload || {}), printerRole: "chz" }),
  dispense: (payload) => ipcRenderer.invoke("dispenser:dispense", payload),
  recoverDispenser: (payload) => ipcRenderer.invoke("dispenser:recoverHome", payload),
  getDispenserCalibration: () => ipcRenderer.invoke("dispenser:calibrationStatus"),
  getDispenserDiagnostics: () => ipcRenderer.invoke("dispenser:diagnostics"),
  calibrateDispenser: (payload) => ipcRenderer.invoke("dispenser:calibrationCommand", payload),
  saveDispenserCalibration: (payload) => ipcRenderer.invoke("dispenser:calibrationSave", payload),
  checkDispenser: () => ipcRenderer.invoke("dispenser:check"),
  getDispenserStatus: () => ipcRenderer.invoke("dispenser:status"),
  stopDispenser: () => ipcRenderer.invoke("dispenser:stop"),
  getChzPrinterStatus: () => ipcRenderer.invoke("printer:chzStatus"),
  getPrinterSetup: () => ipcRenderer.invoke("printer:setupState"),
  configurePrinterPair: (payload) => ipcRenderer.invoke("printer:configurePair", payload),
  testPrinterPair: (payload) => ipcRenderer.invoke("printer:testPair", payload),
  ensurePrinterDriver: () => ipcRenderer.invoke("printer:ensureDriver"),

  // драйверы (принтер + CH340 сканера) с повышением прав + диагностика портов
  installDrivers: () => ipcRenderer.invoke("driver:install"),
  listSerialPorts: () => ipcRenderer.invoke("serial:list"),

  // статус железа (принтер + сканер)
  getHardwareStatus: () => ipcRenderer.invoke("status:hardware"),
  onHardwareChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("hardware:changed", handler);
    return () => ipcRenderer.removeListener("hardware:changed", handler);
  },

  // отпечаток
  fpStatus: () => ipcRenderer.invoke("fp:status"),
  fpConnect: () => ipcRenderer.invoke("fp:connect"),
  fpEnroll: (opts) => ipcRenderer.invoke("fp:enroll", opts),
  fpLoadTemplates: (templates) => ipcRenderer.invoke("fp:loadTemplates", templates),
  fpIdentify: () => ipcRenderer.invoke("fp:identify"),
  fpDelete: (espId) => ipcRenderer.invoke("fp:delete", espId),
  fpCancel: () => ipcRenderer.invoke("fp:cancel"),
  onFpProgress: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on("fp:progress", handler);
    return () => ipcRenderer.removeListener("fp:progress", handler);
  },

  // сессия сайта
  applySession: (cookies) => ipcRenderer.invoke("session:apply", { cookies }),
  clearSession: () => ipcRenderer.invoke("session:clear"),

  // прокси к серверным desktop-эндпоинтам (обходит CORS, добавляет секрет)
  api: (pathName, opts) => ipcRenderer.invoke("api:fetch", { pathName, opts: opts || {} }),

  // обновление приложения
  checkUpdate: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onUpdateProgress: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on("update:progress", handler);
    return () => ipcRenderer.removeListener("update:progress", handler);
  },

  // активность из webview сайта (для сброса таймаута бездействия)
  onActivity: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("activity", handler);
    return () => ipcRenderer.removeListener("activity", handler);
  },

  // сайт сообщил о выходе сотрудника (кнопка «Выйти») → вернуться на экран отпечатка
  onSiteLogout: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("site:logout", handler);
    return () => ipcRenderer.removeListener("site:logout", handler);
  },
});
