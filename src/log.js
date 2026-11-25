// Журнал событий программы: последние записи в памяти (для раздела «Журнал» в панели)
// и файлы по дням в DATA_DIR/logs (хранятся 14 дней). Тексты сообщений клиентов в журнал не пишутся,
// номера телефонов частично скрыты: журнал можно спокойно отправить при обращении за помощью.
import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import { config } from "./config.js";

export const LOG_DIR = path.join(config.dataDir, "logs");
const KEEP_DAYS = 14;
const MAX_MEMORY = 3000;
const entries = [];
const listeners = new Set();
/** Подписка на новые записи (окно программы показывает по ним уведомления). */
export function onEntry(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
let seq = 0;

fs.mkdirSync(LOG_DIR, { recursive: true });
cleanup();

function day(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function cleanup() {
  try {
    const limit = Date.now() - KEEP_DAYS * 864e5;
    for (const f of fs.readdirSync(LOG_DIR)) {
      const p = path.join(LOG_DIR, f);
      if (/^app-\d{4}-\d{2}-\d{2}\.log$/.test(f) && fs.statSync(p).mtimeMs < limit) fs.rmSync(p, { force: true });
    }
  } catch {
    // журнал не должен ломать программу
  }
}

/** Скрывает середину номера: 77010000001 → +7701*****01. Принимает id чата вида "номер|jid" или jid. */
export function maskPhone(id) {
  const s = String(id ?? "");
  const jid = s.includes("|") ? s.split("|").pop() : s;
  const digits = jid.split("@")[0].replace(/\D/g, "");
  if (digits.length < 7) return jid ? "клиент" : "";
  return `+${digits.slice(0, 4)}${"*".repeat(digits.length - 6)}${digits.slice(-2)}`;
}

/** Какой номер бота обслуживает чат "номер|jid". */
export function accountOf(chatId) {
  const s = String(chatId ?? "");
  return s.includes("|") ? s.split("|")[0] : "api";
}

const fmt = (e) => `${new Date(e.time).toISOString()} ${e.level.toUpperCase().padEnd(5)} [${e.category}] ${e.message}`;

/**
 * @param {"info"|"warn"|"error"} level
 * @param {string} category whatsapp | message | ai | limit | app | update | system
 */
export function log(level, category, message) {
  const e = { id: ++seq, time: Date.now(), level, category, message: String(message).slice(0, 2000) };
  entries.push(e);
  if (entries.length > MAX_MEMORY) entries.shift();
  for (const fn of listeners) {
    try {
      fn(e);
    } catch {
      // уведомления не должны ломать журнал
    }
  }
  try {
    fs.appendFileSync(path.join(LOG_DIR, `app-${day(e.time)}.log`), fmt(e) + "\n");
  } catch {
    // нет места на диске и т.п.: журнал в памяти всё равно работает
  }
  return e;
}
export const info = (c, m) => log("info", c, m);
export const warn = (c, m) => log("warn", c, m);
export const error = (c, m) => log("error", c, m);

/** Записи после id `after` (для обновления панели), с фильтрами. */
export function list({ after = 0, level = "", category = "", limit = 500 } = {}) {
  const levels = level === "error" ? ["error"] : level === "warn" ? ["warn", "error"] : null;
  return entries
    .filter((e) => e.id > after && (!levels || levels.includes(e.level)) && (!category || e.category === category))
    .slice(-limit);
}

/** Текст журнала за последние `days` дней (для скачивания). */
export function exportText(days = 3) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const p = path.join(LOG_DIR, `app-${day(Date.now() - i * 864e5)}.log`);
    if (fs.existsSync(p)) out.push(fs.readFileSync(p, "utf8"));
  }
  return out.join("");
}

// Всё, что программа пишет в консоль (включая ошибки библиотек), тоже попадает в журнал
for (const [method, level] of [["log", "info"], ["info", "info"], ["warn", "warn"], ["error", "error"]]) {
  const orig = console[method].bind(console);
  console[method] = (...args) => {
    orig(...args);
    let text = util.format(...args);
    if (/ExperimentalWarning|SQLite is an experimental/.test(text)) return;
    // Стек вызовов в журнале не нужен оператору: оставляем первую строку, без повторов «Error: Error:»
    text = text.split(/\n\s+at\s/)[0].replace(/^(Error:\s*)+/, "").trim();
    log(level, "system", text);
  };
}
process.on("uncaughtException", (e) => error("app", `Непредвиденная ошибка: ${e.stack || e.message}`));
process.on("unhandledRejection", (e) => error("app", `Необработанная ошибка: ${e?.stack || e?.message || e}`));
