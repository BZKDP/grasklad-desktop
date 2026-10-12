"use strict";
// Preload для webview с сайтом ГРА-склад.
// Даёт сайту window.desktopBridge: детект десктоп-режима и прямую печать этикеток.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopBridge", {
  isDesktop: true,
  platform: "windows",
  version: "1.0.38",
  // Прямая печать этикетки на термопринтер.
  // payload: { url } | { base64 } | { dataUrl }, copies?
  printLabel: (payload) => ipcRenderer.invoke("printer:printLabel", payload),
  printOrderLabels: (payload) => ipcRenderer.invoke("printer:printOrderLabels", payload),
  dispense: (payload) => ipcRenderer.invoke("dispenser:dispense", payload),
  recoverDispenser: (payload) => ipcRenderer.invoke("dispenser:recoverHome", payload),
  getDispenserCalibration: () => ipcRenderer.invoke("dispenser:calibrationStatus"),
  getDispenserDiagnostics: () => ipcRenderer.invoke("dispenser:diagnostics"),
  calibrateDispenser: (payload) => ipcRenderer.invoke("dispenser:calibrationCommand", payload),
  saveDispenserCalibration: (payload) => ipcRenderer.invoke("dispenser:calibrationSave", payload),
  checkDispenser: () => ipcRenderer.invoke("dispenser:check"),
  getDispenserStatus: () => ipcRenderer.invoke("dispenser:status"),
  stopDispenser: () => ipcRenderer.invoke("dispenser:stop"),
  listPrinters: () => ipcRenderer.invoke("printer:list"),
  getPrinterSetup: () => ipcRenderer.invoke("printer:setupState"),
  configurePrinterPair: (payload) => ipcRenderer.invoke("printer:configurePair", payload),
  testPrinterPair: (payload) => ipcRenderer.invoke("printer:testPair", payload),
  onHardwareChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("hardware:changed", handler);
    return () => ipcRenderer.removeListener("hardware:changed", handler);
  },
  // Сайт сообщает оболочке о выходе сотрудника → вернуться на экран отпечатка.
  logout: () => ipcRenderer.send("site:logout"),
});

// Флаг в DOM, чтобы сайт мог сразу определить окружение (до инъекции JS)
try {
  window.addEventListener("DOMContentLoaded", () => {
    document.documentElement.setAttribute("data-desktop-app", "1");
  });
} catch {}

// Активность внутри сайта -> сброс таймаута бездействия в оболочке (не чаще раза в 5с)
let lastActivity = 0;
function pingActivity() {
  const now = Date.now();
  if (now - lastActivity > 5000) {
    lastActivity = now;
    ipcRenderer.send("activity");
  }
}
["mousemove", "keydown", "mousedown", "wheel", "touchstart"].forEach((ev) =>
  window.addEventListener(ev, pingActivity, { passive: true })
);
