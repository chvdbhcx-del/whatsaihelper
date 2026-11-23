// Программа для Windows: запускает бота и открывает панель оператора в окне.
// Терминал и npm не нужны: вход в WhatsApp по QR и ключ ИИ настраиваются в окне.
import { app, BrowserWindow, dialog, shell } from "electron";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TITLE = "ИИ-ассистент WhatsApp";

if (!app.requestSingleInstanceLock()) app.quit();

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

app.on("login", (event, _wc, _details, _authInfo, callback) => {
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
  const folders = prepareFolders();
  password = folders.password;
  if (!(await firstRunWarning(folders.dataDir))) return app.quit();

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
  } catch (e) {
    dialog.showErrorBox(TITLE, `Не удалось запустить бота:\n${e.stack || e.message}`);
    return app.quit();
  }

  win = new BrowserWindow({ width: 1280, height: 820, title: TITLE, autoHideMenuBar: true, backgroundColor: "#f4f5f7" });
  win.on("page-title-updated", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("close", (e) => {
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
});

app.on("window-all-closed", () => app.quit());
