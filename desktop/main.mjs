// Программа для Windows: запускает бота и открывает панель оператора в окне.
// Терминал и npm не нужны: вход в WhatsApp по QR и ключ ИИ настраиваются в окне.
import { app, BrowserWindow, dialog, Menu, nativeTheme, Notification, powerSaveBlocker, safeStorage, shell } from "electron";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import updaterPkg from "electron-updater";

const { autoUpdater } = updaterPkg;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TITLE = "ИИ-ассистент WhatsApp";

// Вторая копия программы сразу завершается: иначе она подключила бы те же номера и WhatsApp выбил бы сессию
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  process.exit(0);
}

let win = null;
let password = "";

function freePort(start) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(freePort(start + 1)));
    srv.listen(start, "127.0.0.1", () => srv.close(() => resolve(start)));
  });
}

function prepareFolders() {
  const userData = app.getPath("userData");
  const dataDir = path.join(userData, "data");
  const knowledgeDir = path.join(userData, "knowledge");
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(knowledgeDir)) {
    fs.mkdirSync(knowledgeDir, { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, "knowledge"))) {
      if (f.endsWith(".md")) fs.copyFileSync(path.join(ROOT, "knowledge", f), path.join(knowledgeDir, f));
    }
  }
  const pwFile = path.join(dataDir, "panel-password");
  if (!fs.existsSync(pwFile)) fs.writeFileSync(pwFile, crypto.randomBytes(18).toString("base64url"), { mode: 0o600 });
  return { dataDir, knowledgeDir, password: fs.readFileSync(pwFile, "utf8").trim() };
}

async function firstRunWarning(dataDir) {
  const flag = path.join(dataDir, "risk-accepted");
  if (fs.existsSync(flag)) return true;
  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: TITLE,
    message: "Перед началом работы",
    detail:
      "Программа подключается к обычному WhatsApp как WhatsApp Web. Это неофициальный способ: он нарушает условия WhatsApp, и номер могут заблокировать.\n\n" +
      "Бот отвечает только тем, кто написал вам первым, не делает рассылок и шлёт не больше заданного лимита ответов в день.\n\n" +
      "Если клиент всерьёз спросит, человек ли с ним общается, бот честно ответит, что он виртуальный ассистент, и предложит позвать сотрудника.",
    buttons: ["Понимаю, продолжить", "Выйти"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return false;
  fs.writeFileSync(flag, new Date().toISOString());
  return true;
}

// ---------- Обновления из GitHub Releases ----------
// Состояние видно в панели (раздел «О программе») через globalThis.__desktop.
const update = { status: "idle", version: null, percent: 0, error: null, checkedAt: null };
let updateRetries = 0;
let updateRetryTimer = null;
let installing = false;
let ulog = () => {}; // журнал программы (подключается после запуска сервера)

function setupUpdates() {
  globalThis.__desktop = {
    version: app.getVersion(),
    state: () => ({ ...update, current: app.getVersion(), packaged: app.isPackaged }),
    check: () => checkUpdates(),
    // Рамка окна и системные диалоги в той же теме, что и панель; выбор сохраняется между запусками
    setTheme: (t) => {
      nativeTheme.themeSource = ["light", "dark"].includes(t) ? t : "system";
      try {
        fs.writeFileSync(path.join(app.getPath("userData"), "theme"), nativeTheme.themeSource);
      } catch {}
    },
    // Автозапуск вместе с Windows: после перезагрузки компьютера бот снова отвечает сам
    getAutostart: () => app.getLoginItemSettings().openAtLogin,
    setAutostart: (on) => {
      app.setLoginItemSettings({ openAtLogin: !!on, args: ["--hidden"] });
      ulog("info", on ? "Автозапуск с Windows включён" : "Автозапуск с Windows выключен");
      return app.getLoginItemSettings().openAtLogin;
    },
    openPath: (p) => {
      shell.openPath(p);
      return true;
    },
    install: () => {
      if (update.status !== "downloaded") return false;
      installing = true;
      ulog("info", `Установка обновления ${update.version} и перезапуск`);
      setImmediate(() => autoUpdater.quitAndInstall(true, true));
      return true;
    },
  };
  if (!app.isPackaged) {
    update.status = "dev";
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null; // свой журнал на русском ниже; служебный английский со стеком оператору не нужен
  autoUpdater.on("checking-for-update", () => Object.assign(update, { status: "checking", error: null }));
  autoUpdater.on("update-not-available", () => {
    updateRetries = 0;
    Object.assign(update, { status: "latest", checkedAt: Date.now() });
    ulog("info", `Проверка обновлений: установлена последняя версия ${app.getVersion()}`);
  });
  autoUpdater.on("update-available", (i) => {
    updateRetries = 0;
    Object.assign(update, { status: "downloading", version: i.version, percent: 0, checkedAt: Date.now() });
    ulog("info", `Найдена новая версия ${i.version}, скачивание`);
  });
  autoUpdater.on("download-progress", (p) => Object.assign(update, { status: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (i) => {
    Object.assign(update, { status: "downloaded", version: i.version, percent: 100 });
    ulog("info", `Версия ${i.version} скачана и готова к установке`);
  });
  autoUpdater.on("error", (e) => {
    const raw = String(e?.message || e).split("\n")[0].replace(/^(Error:\s*)+/, "");
    const offline = /ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_CONNECTION|ERR_TIMED_OUT|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET/i.test(raw);
    // Повторяем проверку позже: 2, 5, 15, 30 минут, дальше раз в час
    const mins = [2, 5, 15, 30, 60][Math.min(updateRetries, 4)];
    updateRetries++;
    clearTimeout(updateRetryTimer);
    updateRetryTimer = setTimeout(checkUpdates, mins * 60 * 1000);
    const text = offline ? "нет связи с сервером обновлений (похоже, нет интернета)" : raw;
    Object.assign(update, { status: "error", error: text, checkedAt: Date.now() });
    ulog("warn", `Не удалось проверить обновления: ${text}. Повторим через ${mins} мин`);
  });
  checkUpdates();
  setInterval(checkUpdates, 4 * 60 * 60 * 1000); // каждые 4 часа
}

function checkUpdates() {
  if (!app.isPackaged || ["checking", "downloading", "downloaded"].includes(update.status)) return;
  autoUpdater.checkForUpdates().catch(() => {});
}

// Пароль панели отдаём только своей панели на этом компьютере
app.on("login", (event, _wc, _details, authInfo, callback) => {
  if (authInfo.host !== "127.0.0.1") return;
  event.preventDefault();
  callback("admin", password);
});

app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  try {
    const t = fs.readFileSync(path.join(app.getPath("userData"), "theme"), "utf8").trim();
    if (["light", "dark"].includes(t)) nativeTheme.themeSource = t;
  } catch {}
  const folders = prepareFolders();
  password = folders.password;
  if (!(await firstRunWarning(folders.dataDir))) return app.quit();

  // Ключи ИИ шифруются средствами Windows (DPAPI): из файла настроек их не прочитать на другом компьютере или под другим пользователем
  if (safeStorage.isEncryptionAvailable()) {
    globalThis.__secrets = {
      encrypt: (t) => safeStorage.encryptString(t).toString("base64"),
      decrypt: (b) => safeStorage.decryptString(Buffer.from(b, "base64")),
    };
  }

  const port = await freePort(37373);
  Object.assign(process.env, {
    PORT: String(port),
    HOST: "127.0.0.1", // панель доступна только на этом компьютере
    ADMIN_PASSWORD: password,
    DATA_DIR: folders.dataDir,
    KNOWLEDGE_DIR: folders.knowledgeDir,
    WA_PROVIDER: process.env.WA_PROVIDER || "web",
  });

  try {
    const server = await import(pathToFileURL(path.join(ROOT, "src", "server.js")).href);
    await server.ready;
    const logm = await import(pathToFileURL(path.join(ROOT, "src", "log.js")).href);
    ulog = (level, msg) => logm.log(level, "update", msg);
    // Уведомления Windows (не чаще раза в минуту на одно и то же): номер отключился или требует QR-кода,
    // бот передал диалог оператору, ИИ не отвечает
    const shown = new Map();
    const titleOf = (e) => {
      if (e.category === "whatsapp" && e.level !== "info") return e.level === "error" ? "WhatsApp: нужна помощь" : "WhatsApp: проблема с подключением";
      if (e.category === "message" && /^Передано оператору/.test(e.message)) return "Клиент ждёт оператора";
      if (e.category === "ai" && e.level === "error" && /^Ошибка ИИ/.test(e.message)) return "ИИ не отвечает: клиенты ждут оператора";
      return null;
    };
    logm.onEntry((e) => {
      const title = titleOf(e);
      if (!title || !Notification.isSupported()) return;
      const key = e.category === "message" ? "handoff" : e.category === "ai" ? "ai-error" : e.message.replace(/\d+/g, "#");
      if (Date.now() - (shown.get(key) ?? 0) < 60_000) return;
      shown.set(key, Date.now());
      const n = new Notification({ title, body: e.message.slice(0, 200) });
      n.on("click", () => { if (win) { win.show(); win.focus(); } });
      n.show();
    });
    // Не даём Windows усыпить программу: во сне связь с WhatsApp рвётся, а бот не отвечает
    powerSaveBlocker.start("prevent-app-suspension");
  } catch (e) {
    dialog.showErrorBox(TITLE, `Не удалось запустить бота:\n${e.stack || e.message}`);
    return app.quit();
  }

  setupUpdates();
  // Первый запуск: включаем автозапуск, чтобы после перезагрузки бот работал сам (выключается в «О программе»)
  const autoFlag = path.join(folders.dataDir, "autostart-set");
  if (app.isPackaged && !fs.existsSync(autoFlag)) {
    globalThis.__desktop.setAutostart(true);
    fs.writeFileSync(autoFlag, "1");
  }

  // Без стандартного меню: масштаб (Ctrl +/−/0, Ctrl + колесо) делает сама панель и запоминает его
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({ width: 1320, height: 860, minWidth: 900, minHeight: 600, title: TITLE, autoHideMenuBar: true, backgroundColor: nativeTheme.shouldUseDarkColors ? "#0f1412" : "#f3f5f4" });
  win.webContents.setZoomFactor(1);
  win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  win.on("page-title-updated", (e) => e.preventDefault());
  const isHttp = (u) => /^https?:\/\//i.test(u);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttp(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // Окно программы показывает только панель: чужие адреса открываются в браузере
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith(`http://127.0.0.1:${port}/`)) return;
    e.preventDefault();
    if (isHttp(url)) shell.openExternal(url);
  });
  win.on("close", (e) => {
    if (installing) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      title: TITLE,
      message: "Закрыть программу?",
      detail: "Пока программа закрыта, бот не отвечает клиентам.",
      buttons: ["Свернуть", "Закрыть"],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice === 0) {
      e.preventDefault();
      win.minimize();
    }
  });
  win.loadURL(`http://127.0.0.1:${port}/admin/`);
  if (process.argv.includes("--hidden")) win.minimize(); // запуск вместе с Windows: сразу в свёрнутом виде
});

app.on("window-all-closed", () => app.quit());
