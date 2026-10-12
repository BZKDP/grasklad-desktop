"use strict";
/* Оболочка ГРА-склад: вход по отпечатку, админка, хост webview сайта, таймаут бездействия. */

const B = window.desktopBridge || {};
const $ = (id) => document.getElementById(id);

const state = {
  cfg: null,
  roster: [],            // [{userId, fingerId, name, surname, fpEnabled}]
  fingerToUser: new Map(),// fingerId -> employee
  currentUser: null,     // вошедший сотрудник
  siteLoaded: false,
  sitePreloaded: false,
  siteReady: false,
  locked: false,
  idleTimer: null,
  identifyRunning: false,
  mode: "fp",            // fp | site | admin
  passwordMode: false,   // ПК без сканера: вход по логину/паролю на сайте, без авто-блокировки
  siteLoaderWatchdog: null, // сторож «вечной загрузки» рабочего места
};

// ---------------- утилиты экранов ----------------
function show(screen) {
  for (const s of ["screen-fp", "screen-site", "screen-admin"]) $(s).hidden = s !== screen;
  $("topbar").style.display = screen === "screen-site" ? "none" : "flex";
  document.body.classList.toggle("on-site", screen === "screen-site");
  state.mode = screen === "screen-fp" ? "fp" : screen === "screen-site" ? "site" : "admin";
}

// ---------------- статус железа ----------------
function pollHardware() {
  if (state._hardwarePollPromise) return state._hardwarePollPromise;
  state._hardwarePollPromise = (async () => {
    try {
      const st = await B.getHardwareStatus();
      updateHwUi(st);
    } catch (e) {
      updateHwUi({ printer: { ok: false }, scanner: { connected: false } });
    }
  })().finally(() => {
    state._hardwarePollPromise = null;
  });
  return state._hardwarePollPromise;
}
function printerText(pr) {
  if (state._printerSetupRunning) return "настройка принтера · подтвердите запрос Windows";
  if (state._printerSetupMessage && pr.setupRequired) return state._printerSetupMessage;
  if (pr.ok) return "готов · " + (pr.queue || "");
  if (pr.exists) return "не подключён (проверьте кабель/питание)";
  return "не найден (нет драйвера/принтера)";
}
function chzPrinterText(pr) {
  if (!pr.enabled) return "выключен в настройках";
  if (pr.ok) return "готов · " + (pr.queue || "");
  if (pr.state === "SAME_AS_PRIMARY") return "выбрана очередь основного принтера";
  if (pr.state === "AMBIGUOUS") return "выберите очередь второго принтера";
  if (pr.exists) return "очередь есть, но физически не подключён";
  return "не найден";
}

async function maybeSetupPrinter(pr) {
  if (!pr.physicalPresent) {
    state._printerSetupAttempted = false;
    state._printerSetupMessage = "";
    return;
  }
  if (pr.ok) {
    state._printerSetupAttempted = false;
    state._printerSetupMessage = "";
    return;
  }
  // A temporarily busy/offline existing queue must not interrupt packing with UAC.
  // Automatic elevation is reserved for a fresh PC with no printer queue/driver.
  if (!pr.setupRequired || pr.exists || state._printerSetupAttempted || state._printerSetupRunning) return;

  state._printerSetupAttempted = true;
  state._printerSetupRunning = true;
  state._printerSetupMessage = "";
  updateHwUi({ printer: pr });
  try {
    const result = await B.ensurePrinterDriver();
    if (!result.ok) {
      state._printerSetupMessage = result.declined
        ? "запрос прав Windows отклонён"
        : (result.error || "не удалось настроить принтер");
    }
  } catch (e) {
    state._printerSetupMessage = "не удалось настроить принтер";
  } finally {
    state._printerSetupRunning = false;
    pollHardware();
  }
}

function updateHwUi(st) {
  const pr = st && st.printer || {};
  const chz = st && st.chzPrinter || {};
  const ds = st && st.dispenser || {};
  // карточки на главном экране
  const prCard = $("hw-printer-card"), chzCard = $("hw-chz-printer-card"), dsCard = $("hw-dispenser-card");
  if (prCard) {
    prCard.className = "hw-card " + (pr.ok ? "ok" : "bad");
    $("hw-printer-text").textContent = printerText(pr);
  }
  if (chzCard) {
    const chzOk = !chz.enabled || chz.ok;
    chzCard.className = "hw-card " + (chzOk ? "ok" : "bad");
    $("hw-chz-printer-text").textContent = chzPrinterText(chz);
  }
  if (dsCard) {
    const ready = ds.ready === true && ds.connected === true;
    dsCard.className = "hw-card " + (ready ? "ok" : "bad");
    $("hw-dispenser-text").textContent = ready
      ? ("подключён" + (ds.port ? " · " + ds.port : ""))
      : (ds.error || "не найден (проверьте USB и питание)");
  }
  // нижняя полоска
  const pd = $("sb-printer-dot"), cd = $("sb-chz-printer-dot"), dd = $("sb-dispenser-dot");
  if (pd) pd.className = "sb-dot " + (pr.ok ? "ok" : "bad");
  if (cd) cd.className = "sb-dot " + ((!chz.enabled || chz.ok) ? "ok" : "bad");
  if (dd) dd.className = "sb-dot " + (ds.ready === true && ds.connected === true ? "ok" : "bad");
  $("sb-printer").textContent = "Принтер: " + (pr.ok ? "готов" : (pr.exists ? "не подключён" : "не найден"));
  $("sb-chz-printer").textContent = "ЧЗ: " + (!chz.enabled ? "выкл" : (chz.ok ? "готов" : (chz.exists ? "не подключён" : "не найден")));
  $("sb-dispenser").textContent = "Дозатор: " + (ds.ready === true && ds.connected === true ? ("подключён" + (ds.port ? " (" + ds.port + ")" : "")) : "не найден");
  maybeSetupPrinter(pr);
}
function startClock() {
  const tick = () => {
    const d = new Date();
    const el = $("sb-clock");
    if (el) el.textContent = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  };
  tick();
  setInterval(tick, 15000);
}
function setFpStatus(text, isError) {
  $("fp-status").textContent = isError ? "" : (text || "");
  $("fp-error").textContent = isError ? (text || "") : "";
}
function setRingProgress(pct) {
  const c = 289; // 2*pi*46
  $("fp-ring-progress").style.strokeDashoffset = String(c - (c * Math.max(0, Math.min(100, pct))) / 100);
}

// ---------------- сервер ----------------
async function api(pathName, method, body) {
  const r = await B.api(pathName, { method: method || "GET", body });
  if (!r || !r.ok) {
    const msg = (r && r.data && (r.data.error || r.data.raw)) || (r && r.error) || ("HTTP " + (r && r.status));
    const err = new Error(msg);
    err.status = r && r.status;
    throw err;
  }
  return r.data;
}

// ---------------- загрузка ростера и заливка в модуль ----------------
async function loadRosterAndTemplates() {
  try {
    const data = await api("api/desktop/roster");
    state.roster = (data && data.employees) || [];
    state.fingerToUser = new Map();
    const templates = [];
    for (const e of state.roster) {
      if (e.fpEnabled && e.fingerId) {
        state.fingerToUser.set(Number(e.fingerId), e);
        if (e.templateB64) templates.push({ espId: Number(e.fingerId), templateB64: e.templateB64 });
      }
    }
    if (templates.length) {
      const res = await B.fpLoadTemplates(templates);
      if (!res.ok) console.warn("Часть шаблонов не залилась в сканер:", res);
    }
    return true;
  } catch (e) {
    console.error("roster failed", e);
    return false;
  }
}

// Предзагрузка сайта в фоне (за экраном отпечатка) — чтобы после входа не было белого экрана
function preloadSite() {
  const site = $("site");
  if (!site || state.sitePreloaded) return;
  state.sitePreloaded = true;
  // события загрузки webview -> показываем/прячем спиннер
  site.addEventListener("did-start-loading", () => { state.siteReady = false; if (state.mode === "site") showSiteLoader(true); });
  site.addEventListener("did-stop-loading", () => { showSiteLoader(false); });
  site.addEventListener("did-finish-load", () => { state.siteReady = true; showSiteLoader(false); });
  site.addEventListener("did-fail-load", (e) => {
    // ВАЖНО: перезагружаем страницу ТОЛЬКО при сбое ГЛАВНОГО кадра.
    // Сбой подресурса (картинка товара, фоновый fetch, SSE) НЕ должен ронять рабочее
    // место сотрудника — иначе после «Завершить заказ» его откатывало к выбору поставки.
    if (!e || e.isMainFrame === false) return;
    if (e.errorCode === -3) return; // -3 = ABORTED (норма при reload/навигации)
    state.siteReady = false;
    if (e.errorCode) {
      $("site-loader-text").textContent = "Нет связи с сайтом. Повтор…";
      setTimeout(() => { try { site.reload(); } catch {} }, 2500);
    }
  });
  // Кнопка «Обновить» из сторожа «вечной загрузки»
  const retry = $("site-loader-retry");
  if (retry) retry.onclick = () => { showSiteLoader(true); try { site.reload(); } catch { site.src = state.cfg.siteUrl; } };
  site.src = state.cfg.siteUrl; // фоновая загрузка статики (покажет экран логина сайта)
}
function showSiteLoader(on) {
  const l = $("site-loader");
  if (l) l.hidden = !on;
  const retry = $("site-loader-retry");
  if (state.siteLoaderWatchdog) { clearTimeout(state.siteLoaderWatchdog); state.siteLoaderWatchdog = null; }
  if (on) {
    const txt = $("site-loader-text");
    if (txt) txt.textContent = "Открываем рабочее место…";
    if (retry) retry.hidden = true;
    // Сторож: если за 30с рабочее место не открылось (нет ни did-finish-load, ни did-fail-load —
    // например main-frame завис без явной ошибки) — показываем кнопку «Обновить», чтобы не висло вечно.
    state.siteLoaderWatchdog = setTimeout(() => {
      state.siteLoaderWatchdog = null;
      const t = $("site-loader-text");
      if (t) t.textContent = "Долго открывается. Нажмите «Обновить».";
      if (retry) retry.hidden = false;
    }, 30000);
  } else if (retry) {
    retry.hidden = true;
  }
}

async function refreshPreloadedSiteAuth(site) {
  if (!site || !state.sitePreloaded || !state.siteReady || typeof site.executeJavaScript !== "function") return false;
  try {
    await site.executeJavaScript("window.dispatchEvent(new Event('desktop-auth-refresh')); true", false);
    return true;
  } catch (e) {
    console.warn("desktop auth refresh failed", e);
    return false;
  }
}

// ---------------- вход сотрудника ----------------
async function loginUser(emp) {
  setFpStatus("Входим: " + emp.surname + " " + emp.name + "…");
  try {
    const data = await api("api/desktop/login", "POST", { userId: emp.userId });
    if (data && data.cookies) await B.applySession(data.cookies);
    state.currentUser = emp;
    state.locked = false;

    const site = $("site");
    $("site-locker").hidden = true;
    show("screen-site");
    showSiteLoader(true);
    // сессия уже проставлена в partition — перезагружаем сайт, чтобы войти сразу в кабинет
    const refreshed = await refreshPreloadedSiteAuth(site);
    if (refreshed) {
      showSiteLoader(false);
    } else if (state.sitePreloaded) {
      try { site.reload(); } catch { site.src = state.cfg.siteUrl; }
    } else {
      site.src = state.cfg.siteUrl;
      state.sitePreloaded = true;
    }
    resetIdle();
  } catch (e) {
    setFpStatus("Не удалось войти: " + e.message, true);
    setTimeout(() => startIdentifyLoop(), 1500);
  }
}

// ПК без сканера: показываем сайт и даём войти по логину/паролю прямо на сайте.
// Оболочка сессию НЕ ведёт (state.currentUser остаётся пустым), поэтому авто-блокировки
// по таймауту НЕ будет — как и просили (только для этого режима).
async function enterPasswordMode() {
  state.passwordMode = true;
  stopIdentifyLoop();
  if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
  state.currentUser = null;
  state.locked = false;
  $("site-locker").hidden = true;
  show("screen-site");
  showSiteLoader(true);
  const site = $("site");
  if (state.sitePreloaded && state.siteReady) { try { site.reload(); } catch { site.src = state.cfg.siteUrl; } }
  else if (!state.sitePreloaded) { site.src = state.cfg.siteUrl; state.sitePreloaded = true; }
  askSitePasswordLogin(site);
}
// Просим сайт сразу открыть форму «логин/пароль» (иначе в desktop-режиме он показывает экран отпечатка).
function askSitePasswordLogin(site) {
  if (!site || typeof site.executeJavaScript !== "function") return;
  const fire = () => { try { site.executeJavaScript("window.dispatchEvent(new Event('desktop-show-password-login')); true", false); } catch {} };
  fire();
  setTimeout(fire, 1200);
  setTimeout(fire, 2600);
}

// 4-значный PIN админа для быстрой разблокировки заблокированной сессии сотрудника.
// (Сотрудник отошёл — админ вводит PIN и продолжает работу в его текущей сессии.)
const ADMIN_UNLOCK_PIN = "9891";

// Разблокировка админом по PIN: снимаем locker и продолжаем ТЕКУЩУЮ сессию (как отпечаток того же сотрудника).
function unlockByAdminPin() {
  stopIdentifyLoop();
  const pb = $("locker-pin-box"); if (pb) pb.hidden = true;
  const ab = $("locker-admin-btn"); if (ab) ab.hidden = false;
  const pin = $("locker-pin"); if (pin) pin.value = "";
  const err = $("locker-pin-err"); if (err) err.textContent = "";
  $("site-locker").hidden = true;
  state.locked = false;
  show("screen-site");
  resetIdle();
}

// Разблокировка: тот же сотрудник вернулся -> просто снять locker (останется на месте)
async function unlockOrSwitch(emp) {
  if (state.currentUser && Number(emp.userId) === Number(state.currentUser.userId)) {
    $("site-locker").hidden = true;
    state.locked = false;
    show("screen-site");
    resetIdle();
  } else {
    // другой сотрудник — новая сессия и его кабинет
    state.siteLoaded = false; // перезагрузим сайт под новым пользователем
    await B.clearSession();
    await loginUser(emp);
  }
}

// ---------------- цикл идентификации ----------------
async function startIdentifyLoop() {
  if (state.identifyRunning) return;
  state.identifyRunning = true;
  $("fp-retry").hidden = true;
  setFpStatus("Приложите палец…");
  setRingProgress(0);

  while (state.identifyRunning) {
    let res;
    try {
      res = await B.fpIdentify();
    } catch (e) {
      res = { ok: false, error: String(e && e.message || e) };
    }
    if (!state.identifyRunning) break;

    if (res && res.ok && res.espId != null) {
      const emp = state.fingerToUser.get(Number(res.espId));
      if (emp) {
        state.identifyRunning = false;
        setRingProgress(100);
        if (state.locked) await unlockOrSwitch(emp);
        else await loginUser(emp);
        return;
      } else {
        setFpStatus("Палец не привязан к сотруднику", true);
        await sleep(1200);
        setFpStatus("Приложите палец…");
      }
    } else if (res && res.noMatch) {
      setFpStatus("Палец не распознан, попробуйте ещё раз", true);
      await sleep(900);
      if (!state.locked) setFpStatus("Приложите палец…");
    } else if (res && res.noFinger) {
      // пальца нет на сканере — просто ждём, без сообщений об ошибке
    } else if (res && res.error) {
      setFpStatus(res.error, true);
      $("fp-retry").hidden = false;
      state.identifyRunning = false;
      return;
    }
    await sleep(res && res.noFinger ? 500 : 300);
  }
}
function stopIdentifyLoop() { state.identifyRunning = false; B.fpCancel().catch(() => {}); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- таймаут бездействия ----------------
function resetIdle() {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  const ms = Number(state.cfg.idleLogoutMs || 300000);
  state.idleTimer = setTimeout(lockSession, ms);
}
function lockSession() {
  if (state.mode !== "site" || !state.currentUser) return;
  state.locked = true;
  $("site-locker").hidden = false;
  $("site-locker-status").textContent = "Приложите палец, чтобы продолжить";
  // сброс админ-PIN интерфейса на локере
  const pb = $("locker-pin-box"); if (pb) pb.hidden = true;
  const ab = $("locker-admin-btn"); if (ab) ab.hidden = false;
  const pin = $("locker-pin"); if (pin) pin.value = "";
  const err = $("locker-pin-err"); if (err) err.textContent = "";
  // не рвём сессию сайта и не перезагружаем webview — вернёмся на то же место
  startIdentifyLoop();
}

// активность сотрудника сбрасывает таймер (в оболочке и внутри сайта)
["mousemove", "keydown", "mousedown", "wheel", "touchstart"].forEach((ev) =>
  window.addEventListener(ev, () => { if (state.mode === "site" && !state.locked) resetIdle(); }, { passive: true })
);
// активность, пришедшая из webview сайта (через main)
if (B.onActivity) B.onActivity(() => { if (state.mode === "site" && !state.locked) resetIdle(); });

// Сотрудник нажал «Выйти» на сайте → возврат на экран отпечатка (вход другим пальцем / Админка)
async function handleSiteLogout() {
  if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
  state.currentUser = null;
  state.locked = false;
  state.siteLoaded = false;
  $("site-locker").hidden = true;
  try { await B.clearSession(); } catch {}
  if (state.passwordMode) {
    // ПК без сканера: не возвращаемся на экран отпечатка — остаёмся на сайте (форма входа по паролю)
    const site = $("site");
    show("screen-site");
    showSiteLoader(true);
    try { site.reload(); } catch { site.src = state.cfg.siteUrl; }
    askSitePasswordLogin(site);
    return;
  }
  show("screen-fp");
  setFpStatus("Приложите палец для входа");
  $("fp-error").textContent = "";
  startIdentifyLoop();
}
if (B.onSiteLogout) B.onSiteLogout(() => { handleSiteLogout(); });

// ---------------- админка ----------------
function openAdmin() {
  stopIdentifyLoop();
  show("screen-admin");
  $("admin-login").hidden = false;
  $("admin-employees").hidden = true;
  $("admin-settings").hidden = true;
  $("admin-login-error").textContent = "";
  $("admin-login-user").value = "";
  $("admin-login-pass").value = "";
  checkVersion();
}

// ---------------- версия / обновление ----------------
async function checkVersion() {
  $("ver-status").textContent = "";
  $("btn-ver-update").hidden = true;
  try {
    const r = await B.checkUpdate();
    $("ver-current").textContent = r.current || "—";
    if (!r.ok) { $("ver-latest").textContent = "нет связи"; $("ver-status").textContent = r.error || ""; return; }
    $("ver-latest").textContent = r.latest || "—";
    $("ver-notes").textContent = r.notes || "";
    if (r.updateAvailable) {
      $("btn-ver-update").hidden = false;
      $("ver-status").textContent = "Доступна новая версия " + r.latest;
    } else {
      $("ver-status").textContent = "Установлена последняя версия";
    }
  } catch (e) {
    $("ver-latest").textContent = "ошибка";
    $("ver-status").textContent = String(e && e.message || e);
  }
}
async function installUpdate() {
  const btn = $("btn-ver-update");
  const wrap = $("ver-progress-wrap");
  const bar = $("ver-progress-bar");
  const oldLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Обновление…";
  if (wrap) wrap.hidden = false;
  if (bar) bar.style.width = "0%";
  $("ver-status").textContent = "Подготовка к обновлению…";
  let unsub = null;
  if (B.onUpdateProgress) {
    unsub = B.onUpdateProgress((p) => {
      if (!p) return;
      const pct = Math.max(0, Math.min(100, Number(p.pct) || 0));
      if (bar) bar.style.width = pct + "%";
      if (p.phase === "download") {
        const mb = (n) => (Number(n) / 1048576).toFixed(0);
        const info = p.total ? mb(p.received) + " / " + mb(p.total) + " МБ" : mb(p.received) + " МБ";
        $("ver-status").textContent = "Скачивание обновления: " + pct + "%  (" + info + ")";
      } else if (p.phase === "launch") {
        $("ver-status").textContent = "Запуск установщика… приложение сейчас закроется.";
      } else if (p.phase === "done") {
        $("ver-status").textContent = "Установщик запущен. Закрываем приложение…";
      }
    });
  }
  try {
    const r = await B.installUpdate();
    if (!r.ok) {
      const url = r.downloadUrl || "about:blank";
      $("ver-status").textContent = "Не удалось обновить: " + (r.error || "") +
        ". Скачайте вручную в браузере: " + url;
      btn.disabled = false;
      btn.textContent = oldLabel;
      if (wrap) wrap.hidden = true;
    }
    // при успехе приложение закрывается само, запустится установщик
  } catch (e) {
    $("ver-status").textContent = "Ошибка обновления: " + String((e && e.message) || e) +
      ". Скачайте установщик вручную с сервера обновлений.";
    btn.disabled = false;
    btn.textContent = oldLabel;
    if (wrap) wrap.hidden = true;
  } finally {
    if (unsub) unsub();
  }
}
function closeAdmin() {
  // вернуться туда, где были
  if (state.currentUser && state.siteLoaded) { show("screen-site"); resetIdle(); }
  else if (state.passwordMode) { enterPasswordMode(); }
  else { show("screen-fp"); }
}

async function adminSignin() {
  const login = $("admin-login-user").value.trim();
  const password = $("admin-login-pass").value;
  $("admin-login-error").textContent = "";
  if (!login || !password) { $("admin-login-error").textContent = "Введите логин и пароль"; return; }
  try {
    const data = await api("api/desktop/admin-auth", "POST", { login, password });
    if (!data || data.role !== "super_admin") {
      $("admin-login-error").textContent = "Доступ только суперадмину";
      return;
    }
    $("admin-login").hidden = true;
    $("admin-employees").hidden = false;
    $("admin-settings").hidden = false;
    await renderEmployees();
    fillSettings();
  } catch (e) {
    $("admin-login-error").textContent = e.message || "Ошибка входа";
  }
}

async function renderEmployees() {
  await loadRosterAndTemplates();
  const box = $("admin-emp-list");
  box.innerHTML = "";
  if (!state.roster.length) { box.innerHTML = '<div class="admin-hint">Нет сотрудников</div>'; return; }
  for (const e of state.roster) {
    const row = document.createElement("div");
    row.className = "emp-row";
    const hasFinger = e.fingerId != null;
    row.innerHTML =
      `<div class="emp-info"><div class="emp-name">${esc(e.surname || "")} ${esc(e.name || "")}</div>` +
      `<div class="emp-meta">${hasFinger ? "палец #" + e.fingerId : "отпечаток не задан"}</div></div>` +
      `<div class="emp-actions">` +
        `<span class="emp-fp-badge ${e.fpEnabled ? "on" : "off"}">${e.fpEnabled ? "вход по пальцу" : "выкл"}</span>` +
        `<label class="switch"><input type="checkbox" data-fp-toggle="${e.userId}" ${e.fpEnabled ? "checked" : ""}><span class="switch-slider"></span></label>` +
        `<button class="btn" data-fp-enroll="${e.userId}">${hasFinger ? "Изменить отпечаток" : "Добавить отпечаток"}</button>` +
        (hasFinger ? `<button class="btn btn-ghost" data-fp-delete="${e.userId}">Удалить</button>` : "") +
      `</div>`;
    box.appendChild(row);
  }
  box.querySelectorAll("[data-fp-toggle]").forEach((el) =>
    el.onchange = () => toggleFp(Number(el.dataset.fpToggle), el.checked)
  );
  box.querySelectorAll("[data-fp-enroll]").forEach((el) =>
    el.onclick = () => enrollEmployee(Number(el.dataset.fpEnroll))
  );
  box.querySelectorAll("[data-fp-delete]").forEach((el) =>
    el.onclick = () => deleteFingerEmployee(Number(el.dataset.fpDelete))
  );
}

async function deleteFingerEmployee(userId) {
  const emp = state.roster.find((r) => Number(r.userId) === userId);
  if (!emp) return;
  try {
    if (emp.fingerId != null) await B.fpDelete(emp.fingerId).catch(() => {});
    await api("api/desktop/delete-fingerprint", "POST", { userId });
    await renderEmployees();
  } catch (e) {
    const box = $("admin-emp-list");
    if (box) box.insertAdjacentHTML("afterbegin", `<div class="admin-error">Ошибка удаления: ${esc(e.message)}</div>`);
  }
}

async function toggleFp(userId, enabled) {
  try {
    await api("api/desktop/set-fp-enabled", "POST", { userId, enabled });
    await renderEmployees();
  } catch (e) {
    const box = $("admin-emp-list");
    if (box) box.insertAdjacentHTML("afterbegin", `<div class="admin-error">Ошибка: ${esc(e.message)}. Повторите.</div>`);
    setTimeout(() => { const el = box && box.querySelector(".admin-error"); if (el) el.remove(); }, 4000);
  }
}

async function enrollEmployee(userId) {
  const emp = state.roster.find((r) => Number(r.userId) === userId);
  $("enroll-modal").hidden = false;
  $("enroll-title").textContent = "Отпечаток: " + (emp ? (emp.surname + " " + emp.name) : "");
  $("enroll-error").textContent = "";
  $("enroll-status").textContent = "Определяем номер пальца…";
  const off = B.onFpProgress((msg) => { $("enroll-status").textContent = translateProgress(msg); });
  try {
    let fingerId = emp && emp.fingerId;
    if (!fingerId) {
      const nid = await api("api/desktop/next-finger-id");
      fingerId = nid.fingerId;
    }
    $("enroll-status").textContent = "Приложите палец сотрудника (4 раза)…";
    const res = await B.fpEnroll({ espId: fingerId });
    if (!res.ok) { $("enroll-error").textContent = res.error || "Не удалось зарегистрировать"; return; }
    await api("api/desktop/enroll", "POST", { userId, fingerId, templateB64: res.templateB64 || null });
    $("enroll-status").textContent = "Готово! Отпечаток сохранён.";
    await sleep(1200);
    $("enroll-modal").hidden = true;
    await renderEmployees();
  } catch (e) {
    $("enroll-error").textContent = e.message || "Ошибка";
  } finally {
    off();
  }
}

// ---------------- каталог сотрудников (добавление из общей базы) ----------------
let directoryCache = [];
let directoryDirty = false;

function openDirectory() {
  $("directory-modal").hidden = false;
  $("directory-search").value = "";
  $("directory-status").textContent = "Загрузка списка…";
  $("directory-list").innerHTML = "";
  directoryDirty = false;
  loadDirectory();
  setTimeout(() => { try { $("directory-search").focus(); } catch {} }, 60);
}
function closeDirectory() {
  $("directory-modal").hidden = true;
  if (directoryDirty) { directoryDirty = false; renderEmployees(); }
}
async function loadDirectory() {
  try {
    const data = await api("api/desktop/directory");
    directoryCache = (data && data.employees) || [];
    filterDirectory();
    $("directory-status").textContent = directoryCache.length
      ? "Найдите сотрудника и нажмите «Добавить». Стажёры тоже здесь."
      : "Список пуст — общая база недоступна";
  } catch (e) {
    $("directory-status").textContent = "Не удалось загрузить список: " + (e.message || "");
  }
}
function renderDirectory(list) {
  const box = $("directory-list");
  box.innerHTML = "";
  if (!list.length) { box.innerHTML = '<div class="directory-empty">Ничего не найдено</div>'; return; }
  for (const e of list) {
    const row = document.createElement("div");
    row.className = "directory-row";
    row.innerHTML =
      `<div class="directory-info"><div class="directory-name">${esc(e.fullName || e.login)}` +
        (e.isIntern ? `<span class="badge-intern">стажёр</span>` : "") +
      `</div><div class="directory-login">${esc(e.login || "")}</div></div>` +
      (e.alreadyAdded
        ? `<div class="directory-added">✓ уже в списке</div>`
        : `<button class="btn btn-primary btn-sm" data-add="${e.externalUserId}">Добавить</button>`);
    box.appendChild(row);
  }
  box.querySelectorAll("[data-add]").forEach((el) =>
    el.onclick = () => addEmployeeFromDirectory(Number(el.dataset.add), el)
  );
}
function filterDirectory() {
  const q = $("directory-search").value.trim().toLowerCase();
  const list = q
    ? directoryCache.filter((e) => `${e.fullName} ${e.login}`.toLowerCase().includes(q))
    : directoryCache;
  renderDirectory(list);
}
async function addEmployeeFromDirectory(externalUserId, btnEl) {
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = "Добавляем…"; }
  try {
    await api("api/desktop/add-employee", "POST", { externalUserId });
    directoryDirty = true;
    const item = directoryCache.find((x) => Number(x.externalUserId) === externalUserId);
    if (item) item.alreadyAdded = true;
    if (btnEl && btnEl.parentElement) {
      const holder = btnEl.parentElement;
      btnEl.remove();
      holder.insertAdjacentHTML("beforeend", `<div class="directory-added">✓ добавлен</div>`);
    }
  } catch (e) {
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = "Добавить"; }
    $("directory-status").textContent = "Ошибка: " + (e.message || "");
  }
}

function translateProgress(msg) {
  const m = String(msg || "").toLowerCase();
  if (m.includes("place the same")) return "Приложите тот же палец ещё раз…";
  if (m.includes("place finger")) return "Приложите палец…";
  if (m.includes("remove")) return "Уберите палец";
  if (m.includes("scan") && m.includes("ok")) return "Скан принят ✓";
  return msg;
}

// ---------------- настройки ----------------
function fillSettings() {
  $("cfg-site-url").value = state.cfg.siteUrl || "";
  $("cfg-serial").value = state.cfg.serialPort || "AUTO";
  $("cfg-printer").value = state.cfg.printerQueue || "";
  $("cfg-chz-enabled").checked = state.cfg.chzPrinterEnabled === true;
  $("cfg-chz-printer").value = state.cfg.chzPrinterQueue || "";
  $("cfg-chz-width").value = Number(state.cfg.chzLabelWidthMm || 30);
  $("cfg-chz-height").value = Number(state.cfg.chzLabelHeightMm || 20);
  $("cfg-chz-rotation").value = String(state.cfg.chzLabelRotation || 0);
  $("cfg-chz-scale").value = Math.round(Number(state.cfg.chzLabelScale || 0.93) * 100);
}
async function saveSettings() {
  state.cfg = await B.setConfig({
    siteUrl: $("cfg-site-url").value.trim(),
    serialPort: $("cfg-serial").value.trim() || "AUTO",
    printerQueue: $("cfg-printer").value.trim(),
    chzPrinterEnabled: $("cfg-chz-enabled").checked === true,
    chzPrinterQueue: $("cfg-chz-printer").value.trim(),
    chzLabelWidthMm: Math.max(10, Math.min(100, Number($("cfg-chz-width").value || 30))),
    chzLabelHeightMm: Math.max(10, Math.min(100, Number($("cfg-chz-height").value || 20))),
    chzLabelRotation: [0, 90, 180, 270].includes(Number($("cfg-chz-rotation").value)) ? Number($("cfg-chz-rotation").value) : 0,
    chzLabelScale: Math.max(0.5, Math.min(1, Number($("cfg-chz-scale").value || 93) / 100)),
  });
  $("admin-settings-status").textContent = "Сохранено. Перезапустите приложение для смены адреса сайта.";
}

// ---------------- инициализация ----------------
// Никакое обещание не должно вешать UI: если IPC/железо/PowerShell зависли — идём дальше.
function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

async function init() {
  // 1) ПРИВЯЗКИ КНОПОК — синхронно и ПЕРВЫМ ДЕЛОМ, ДО любых await.
  //    Иначе если getConfig/fpConnect/опрос железа зависнут, «Админка» и вход по паролю
  //    становятся мёртвыми (именно это и ловил сотрудник на ПК без сканера).
  const bind = (id, prop, fn) => { try { const el = $(id); if (el) el[prop] = fn; } catch {} };
  bind("btn-admin", "onclick", openAdmin);
  bind("btn-admin-close", "onclick", closeAdmin);
  bind("btn-admin-signin", "onclick", adminSignin);
  bind("btn-cfg-save", "onclick", saveSettings);
  bind("fp-retry", "onclick", () => startIdentifyLoop());
  bind("fp-password-login", "onclick", enterPasswordMode);
  bind("enroll-cancel", "onclick", () => { B.fpCancel(); $("enroll-modal").hidden = true; });
  bind("btn-add-employee", "onclick", openDirectory);
  bind("directory-close", "onclick", closeDirectory);
  bind("directory-search", "oninput", filterDirectory);
  bind("directory-modal", "onclick", (ev) => { if (ev.target === $("directory-modal")) closeDirectory(); });
  bind("btn-test-print", "onclick", testPrint);
  bind("btn-test-chz-print", "onclick", testChzPrint);
  bind("btn-install-driver", "onclick", installDriver);
  bind("btn-fp-reconnect", "onclick", reconnectFp);
  bind("btn-serial-diag", "onclick", serialDiag);
  bind("fp-install-driver", "onclick", installDriverFromFp);
  bind("btn-ver-check", "onclick", checkVersion);
  bind("btn-ver-update", "onclick", installUpdate);
  { const lockerAdminBtn = $("locker-admin-btn"); if (lockerAdminBtn) lockerAdminBtn.onclick = () => {
      $("locker-pin-box").hidden = false; lockerAdminBtn.hidden = true;
      const el = $("locker-pin"); el.value = ""; $("locker-pin-err").textContent = ""; el.focus();
    }; }
  { const lockerPin = $("locker-pin"); if (lockerPin) lockerPin.oninput = (e) => {
      const v = String(e.target.value || "").replace(/\D/g, "").slice(0, 4);
      e.target.value = v; $("locker-pin-err").textContent = "";
      if (v.length === 4) { if (v === ADMIN_UNLOCK_PIN) unlockByAdminPin(); else { $("locker-pin-err").textContent = "Неверный PIN"; e.target.value = ""; } }
    }; }

  show("screen-fp");
  startClock();

  // 2) Конфиг с таймаутом — если главный процесс не ответит, берём дефолт и продолжаем.
  state.cfg = (await withTimeout(B.getConfig(), 4000)) || state.cfg || {};

  // фоновая предзагрузка сайта, чтобы вход был без белого экрана
  try { preloadSite(); } catch {}

  // 3) Опрос железа — не ждёт сканер и не блокирует UI (внутри всё через .then/таймаут).
  try { pollHardware(); } catch {}
  setInterval(() => { try { pollHardware(); } catch {} }, 4000);
  if (typeof B.onHardwareChanged === "function") {
    try {
      B.onHardwareChanged(() => {
        pollHardware();
        try { $("site")?.send("hardware:changed"); } catch {}
      });
    } catch {}
  }

  // Отпечаток временно полностью отключён: сразу открываем обычный вход сайта.
  await enterPasswordMode();
}

async function testPrint() {
  $("admin-settings-status").textContent = "Печать теста…";
  const r = await B.printLabel({ url: null, base64: null, testPattern: true }).catch((e) => ({ ok: false, error: String(e) }));
  $("admin-settings-status").textContent = r.ok ? "Отправлено на принтер" : ("Ошибка печати: " + (r.error || ""));
}
async function testChzPrint() {
  state.cfg = await B.setConfig({
    chzPrinterEnabled: $("cfg-chz-enabled").checked === true,
    chzPrinterQueue: $("cfg-chz-printer").value.trim(),
    chzLabelWidthMm: Math.max(10, Math.min(100, Number($("cfg-chz-width").value || 30))),
    chzLabelHeightMm: Math.max(10, Math.min(100, Number($("cfg-chz-height").value || 20))),
    chzLabelRotation: [0, 90, 180, 270].includes(Number($("cfg-chz-rotation").value)) ? Number($("cfg-chz-rotation").value) : 0,
    chzLabelScale: Math.max(0.5, Math.min(1, Number($("cfg-chz-scale").value || 93) / 100)),
  });
  $("admin-settings-status").textContent = "Печать теста ЧЗ на втором принтере…";
  const r = await B.printChzLabel({ testPattern: true }).catch((e) => ({ ok: false, error: String(e) }));
  $("admin-settings-status").textContent = r.ok ? `Тест ЧЗ отправлен: ${r.queue || "второй принтер"}` : ("Ошибка печати ЧЗ: " + (r.error || ""));
}
async function installDriver() {
  $("admin-settings-status").textContent = "Устанавливаем драйверы… подтвердите запрос Windows (кнопка «Да»).";
  const r = await B.installDrivers();
  if (!r.ok) {
    $("admin-settings-status").textContent = r.declined
      ? "Вы отклонили запрос прав. Нажмите ещё раз и выберите «Да»."
      : ("Драйверы: " + (r.error || "ошибка"));
    return;
  }
  $("admin-settings-status").textContent = r.needReplug
    ? "Драйверы установлены. Выньте и снова вставьте USB сканера, затем «Переподключить сканер»."
    : "Драйверы установлены. Переподключаю сканер…";
  await sleep(800);
  await reconnectFp();
}
async function reconnectFp() {
  $("admin-settings-status").textContent = "Переподключаем сканер…";
  const r = await B.fpConnect();
  if (r.ok) {
    $("admin-settings-status").textContent = "Сканер на " + r.port;
  } else if (r.needDriver) {
    $("admin-settings-status").textContent = "Сканер подключён, но нет драйвера CH340 — нажмите «Установить драйверы».";
  } else {
    $("admin-settings-status").textContent = "Сканер: " + (r.error || "нет");
  }
}
// Установка драйвера сканера прямо с экрана отпечатка (кнопка появляется при needDriver)
async function installDriverFromFp() {
  setFpStatus("Устанавливаем драйвер сканера… подтвердите запрос Windows (кнопка «Да»).");
  $("fp-error").textContent = "";
  $("fp-install-driver").disabled = true;
  const r = await B.installDrivers();
  $("fp-install-driver").disabled = false;
  if (!r.ok) {
    setFpStatus(r.declined
      ? "Вы отклонили запрос прав. Нажмите ещё раз и выберите «Да»."
      : ("Не удалось установить драйвер: " + (r.error || "")), true);
    return; // кнопка остаётся для повторной попытки
  }
  setFpStatus(r.needReplug
    ? "Драйвер установлен. Выньте и снова вставьте USB сканера…"
    : "Драйвер установлен. Подключаем сканер…");
  await sleep(1500);
  const c = await B.fpConnect();
  if (c.ok) { $("fp-install-driver").hidden = true; await loadRosterAndTemplates(); startIdentifyLoop(); }
  else { setFpStatus(c.error || "Переткните USB сканера и нажмите «Повторить».", true); $("fp-install-driver").hidden = !c.needDriver; $("fp-retry").hidden = false; }
}
async function serialDiag() {
  $("admin-settings-status").textContent = "Опрашиваем порты и принтеры…";
  const r = await B.listSerialPorts();
  const ports = (r.ports || []).map((p) => p.path + (p.vendorId ? " (VID " + p.vendorId + ")" : "")).join(", ") || "нет COM-портов";
  const usb = (r.usbSerial || []).map((d) => d.name + " [" + d.status + "]").join("; ") || "USB-serial устройств не видно";
  let printers = [];
  try { const pl = await B.listPrinters(); printers = Array.isArray(pl) ? pl : []; } catch {}
  const printersText = printers.length ? printers.join(" | ") : "принтеров не найдено";
  let verdict = "";
  if (r.chipPresentNoDriver) verdict = " → чип подключён, но нет драйвера — нажмите «Установить драйверы».";
  $("admin-settings-status").textContent = "ПРИНТЕРЫ: " + printersText + "   ||   COM: " + ports + " | USB: " + usb + verdict;
}

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// прогресс отпечатка на экране входа
if (B.onFpProgress) B.onFpProgress((msg) => {
  if (state.mode === "fp" || state.locked) {
    const t = translateProgress(msg);
    if (state.locked) $("site-locker-status").textContent = t; else setFpStatus(t);
  }
});

window.addEventListener("DOMContentLoaded", init);
