// Режим «обычный WhatsApp»: вход по QR-коду, как WhatsApp Web на компьютере.
// Можно подключить несколько номеров: у каждого своя сессия, свой QR и свой дневной лимит.
//
// ВНИМАНИЕ: это неофициальный способ (библиотека Baileys). Он нарушает условия WhatsApp,
// и номер могут заблокировать. Подробности в README.
//
// Ограничения, заложенные в код:
//  - бот отвечает только в личных чатах, где клиент написал первым (группы, статусы, каналы игнорируются);
//  - никаких рассылок и сообщений первым;
//  - подключённые номера никогда не переписываются друг с другом: сообщения между ними игнорируются;
//  - дневной лимит ответов бота для каждого номера (см. bot.js);
//  - никаких приёмов обхода блокировок и подмены номеров.

import fs from "node:fs";
import * as log from "./log.js";
import path from "node:path";
import pino from "pino";
import QRCode from "qrcode";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  isJidBroadcast,
  isJidNewsletter,
  isJidStatusBroadcast,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { config } from "./config.js";

const AUTH_ROOT = path.join(config.dataDir, "wa-auth");
// Резервная копия данных входа: если файл сессии повредится (например, компьютер выключили во время записи),
// программа восстановит его из копии, и номер не придётся подключать заново.
const BACKUP_ROOT = path.join(config.dataDir, "wa-auth-backup");
const MAX_RETRY_MS = 5 * 60 * 1000;

function backupAuth(accountId) {
  const src = path.join(AUTH_ROOT, accountId);
  if (!fs.existsSync(path.join(src, "creds.json"))) return;
  try {
    JSON.parse(fs.readFileSync(path.join(src, "creds.json"), "utf8")); // копируем только целую сессию
    const tmp = path.join(BACKUP_ROOT, `${accountId}.tmp`);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(src, tmp, { recursive: true });
    fs.rmSync(path.join(BACKUP_ROOT, accountId), { recursive: true, force: true });
    fs.renameSync(tmp, path.join(BACKUP_ROOT, accountId));
  } catch (e) {
    log.warn("whatsapp", `Номер «${accountId}»: не удалось сохранить резервную копию сессии: ${e.message}`);
  }
}

/** Если файл сессии пропал или повреждён, а копия есть — восстанавливаем её. */
function restoreAuthIfBroken(accountId) {
  const dir = path.join(AUTH_ROOT, accountId);
  const backup = path.join(BACKUP_ROOT, accountId);
  if (!fs.existsSync(path.join(backup, "creds.json"))) return;
  let broken = !fs.existsSync(path.join(dir, "creds.json"));
  if (!broken) {
    try {
      JSON.parse(fs.readFileSync(path.join(dir, "creds.json"), "utf8"));
    } catch {
      broken = true;
    }
  }
  if (!broken) return;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(backup, dir, { recursive: true });
  log.warn("whatsapp", `Номер «${accountId}»: файл сессии был повреждён или пропал, восстановлен из резервной копии`);
}

function dropBackup(accountId) {
  fs.rmSync(path.join(BACKUP_ROOT, accountId), { recursive: true, force: true });
}
const MAX_AGE_MS = 10 * 60 * 1000; // не отвечаем на сообщения старше 10 минут (например, пришедшие, пока бот был выключен)
const logger = pino({ level: "warn" });

let onMessage = () => {};
let cachedVersion = null;
const sessions = new Map(); // accountId → Session

/** Номера (и их скрытые LID-идентификаторы) всех подключённых аккаунтов бота. */
function ownJids() {
  const set = new Set();
  for (const s of sessions.values()) for (const j of s.jids) set.add(j);
  return set;
}

class Session {
  constructor(accountId) {
    this.accountId = accountId;
    this.authDir = path.join(AUTH_ROOT, accountId);
    this.sock = null;
    this.stopped = false;
    this.jids = new Set();
    this.lastKeys = new Map(); // jid → ключ последнего входящего (для «прочитано»)
    this.state = { status: "starting", qrDataUrl: null, me: null, error: null };
    this.retryTimer = null;
    this.retries = 0;
    this.backupTimer = null;
  }

  /** Переподключение с нарастающей паузой: 5 с, 10 с, 20 с… но не реже раза в 5 минут. Попытки не прекращаются. */
  scheduleReconnect(reason) {
    clearTimeout(this.retryTimer);
    const delay = Math.min(5000 * 2 ** this.retries, MAX_RETRY_MS);
    this.retries++;
    log.warn("whatsapp", `Номер «${this.accountId}»: ${reason}. Попытка переподключения №${this.retries} через ${Math.round(delay / 1000)} с`);
    this.retryTimer = setTimeout(() => this.connect().catch((e) => this.scheduleReconnect(`ошибка подключения: ${e.message}`)), delay);
  }

  async connect() {
    if (this.stopped) return;
    restoreAuthIfBroken(this.accountId);
    const { state: auth, saveCreds } = await useMultiFileAuthState(this.authDir);
    if (!cachedVersion) {
      try {
        ({ version: cachedVersion } = await fetchLatestBaileysVersion());
      } catch {
        // без сети к GitHub используем версию по умолчанию из библиотеки
      }
    }

    const sock = makeWASocket({
      auth,
      ...(cachedVersion ? { version: cachedVersion } : {}),
      logger,
      markOnlineOnConnect: false, // телефон продолжает получать уведомления
      syncFullHistory: false,
    });
    this.sock = sock;
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (this.sock !== sock) return;
      if (qr) {
        if (this.state.status !== "qr") log.info("whatsapp", `Номер «${this.accountId}»: ждёт сканирования QR-кода`);
        this.state.status = "qr";
        this.state.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 280 });
      }
      if (connection === "open") {
        this.state.status = "connected";
        this.state.qrDataUrl = null;
        this.state.error = null;
        this.state.me = sock.user?.id?.split(":")[0] ?? null;
        this.jids = new Set([sock.user?.id, sock.user?.lid].filter(Boolean).map(jidNormalizedUser));
        log.info("whatsapp", `Номер «${this.accountId}» подключён: ${log.maskPhone(this.state.me)}${this.retries ? ` (после ${this.retries} попыток)` : ""}`);
        this.retries = 0;
        backupAuth(this.accountId);
        clearInterval(this.backupTimer);
        this.backupTimer = setInterval(() => this.state.status === "connected" && backupAuth(this.accountId), 6 * 60 * 60 * 1000);
      }
      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        this.state.me = null;
        if (this.stopped) return;
        if (code === DisconnectReason.loggedOut) {
          this.state.status = "logged_out";
          log.warn("whatsapp", `Номер «${this.accountId}»: вышли из аккаунта на телефоне, нужен новый QR-код`);
          this.state.error = "Сессия завершена на телефоне. Отсканируйте QR заново.";
          this.jids = new Set();
          fs.rmSync(this.authDir, { recursive: true, force: true });
          dropBackup(this.accountId); // копия тоже недействительна: WhatsApp завершил сессию
        } else if (code === DisconnectReason.connectionReplaced) {
          this.state.status = "error";
          this.state.error = "Этот номер открыт в другом WhatsApp Web. Закройте его и перезапустите бота.";
          log.error("whatsapp", `Номер «${this.accountId}»: ${this.state.error}`);
          return; // не переподключаемся, чтобы не выбивать друг друга
        } else {
          this.state.status = "reconnecting";
          this.state.error = lastDisconnect?.error?.message ?? null;
          this.scheduleReconnect(`связь потеряна (код ${code ?? "?"}${this.state.error ? ", " + this.state.error : ""})`);
          return;
        }
        // После выхода из аккаунта показываем новый QR-код
        this.retryTimer = setTimeout(() => this.connect().catch((e) => this.scheduleReconnect(`ошибка подключения: ${e.message}`)), 3000);
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return; // история и синхронизация не считаются новыми сообщениями
      const own = ownJids();
      for (const m of messages) {
        const jid = m.key.remoteJid;
        if (!jid || m.key.fromMe) continue;
        if (isJidGroup(jid) || isJidBroadcast(jid) || isJidStatusBroadcast(jid) || isJidNewsletter(jid)) continue;
        if (!isPnUser(jid) && !isLidUser(jid)) continue;
        // Сообщения от других номеров этого же бота игнорируем: аккаунты не общаются между собой
        const alt = m.key.remoteJidAlt ?? m.key.senderPn;
        if (own.has(jidNormalizedUser(jid)) || (alt && own.has(jidNormalizedUser(alt)))) continue;
        const ts = Number(m.messageTimestamp) * 1000;
        if (ts && Date.now() - ts > MAX_AGE_MS) continue;
        const text = extractText(m.message);
        if (text == null) continue; // служебные сообщения (реакции, протокол и т.п.)
        this.lastKeys.set(jid, m.key);
        onMessage({ account: this.accountId, id: m.key.id, from: jid, name: m.pushName, text });
      }
    });
  }

  async send(jid, text, quote = null) {
    if (this.state.status !== "connected" || !this.sock) throw new Error("WhatsApp не подключён");
    if (ownJids().has(jidNormalizedUser(jid))) throw new Error("Аккаунты бота не пишут друг другу");
    const quoted = quote?.id ? { key: { remoteJid: jid, fromMe: false, id: quote.id }, message: { conversation: quote.text ?? "" } } : undefined;
    await this.sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined);
  }

  async markRead(jid) {
    const key = this.lastKeys.get(jid);
    if (key && this.sock && this.state.status === "connected") await this.sock.readMessages([key]).catch(() => {});
  }

  async logout() {
    if (this.sock) await this.sock.logout().catch(() => {});
  }

  async stop({ removeAuth = false } = {}) {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.backupTimer);
    if (removeAuth) await this.logout();
    this.sock?.end?.(undefined);
    this.sock = null;
    if (removeAuth) {
      fs.rmSync(this.authDir, { recursive: true, force: true });
      dropBackup(this.accountId);
    }
  }
}

function extractText(msg) {
  if (!msg) return null;
  const inner = msg.ephemeralMessage?.message ?? msg.viewOnceMessage?.message ?? msg;
  if (inner.conversation) return inner.conversation;
  if (inner.extendedTextMessage?.text) return inner.extendedTextMessage.text;
  if (inner.imageMessage) return `[клиент прислал фото${inner.imageMessage.caption ? `, подпись: ${inner.imageMessage.caption}` : ""}]`;
  if (inner.videoMessage) return `[клиент прислал видео${inner.videoMessage.caption ? `, подпись: ${inner.videoMessage.caption}` : ""}]`;
  if (inner.documentMessage) return "[клиент прислал документ]";
  if (inner.audioMessage) return "[клиент прислал голосовое сообщение]";
  if (inner.locationMessage) return "[клиент прислал геолокацию]";
  if (inner.stickerMessage) return "[стикер]";
  if (inner.contactMessage) return "[клиент прислал контакт]";
  return null;
}

// ---------- Управление аккаунтами ----------

export function init(handler) {
  onMessage = handler;
}

export function startAccount(accountId) {
  if (sessions.has(accountId)) return sessions.get(accountId);
  const s = new Session(accountId);
  sessions.set(accountId, s);
  s.connect().catch((e) => {
    s.state.status = "error";
    s.state.error = e.message;
    s.scheduleReconnect(`ошибка запуска: ${e.message}`);
  });
  return s;
}

export async function removeAccount(accountId) {
  const s = sessions.get(accountId);
  sessions.delete(accountId);
  if (s) await s.stop({ removeAuth: true });
  else fs.rmSync(path.join(AUTH_ROOT, accountId), { recursive: true, force: true });
  dropBackup(accountId);
}

export function accountState(accountId) {
  return sessions.get(accountId)?.state ?? { status: "stopped", qrDataUrl: null, me: null, error: null };
}

function session(accountId) {
  const s = sessions.get(accountId);
  if (!s) throw new Error(`Номер «${accountId}» не подключён`);
  return s;
}

export const sendText = (accountId, jid, text, quote) => session(accountId).send(jid, text, quote);
export const markRead = (accountId, jid) => sessions.get(accountId)?.markRead(jid);
export const logout = (accountId) => session(accountId).logout();
