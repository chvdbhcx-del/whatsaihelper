import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, "bot.db"));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS chats (
    wa_id            TEXT PRIMARY KEY,
    name             TEXT,
    mode             TEXT NOT NULL DEFAULT 'bot',   -- bot | human
    needs_attention  INTEGER NOT NULL DEFAULT 0,
    handoff_reason   TEXT,
    last_customer_at INTEGER,
    last_human_at    INTEGER,
    updated_at       INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_id      TEXT NOT NULL,
    wa_msg_id  TEXT UNIQUE,
    role       TEXT NOT NULL,                       -- customer | bot | operator | system
    text       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (wa_id, id);
`);

// Миграция: номер бота, к которому относится чат (несколько аккаунтов в режиме QR)
if (!db.prepare(`PRAGMA table_info(chats)`).all().some((c) => c.name === "account_id")) {
  db.exec(`ALTER TABLE chats ADD COLUMN account_id TEXT NOT NULL DEFAULT 'api'`);
}

const now = () => Date.now();

export function upsertChat(waId, name, accountId = "api") {
  db.prepare(
    `INSERT INTO chats (wa_id, name, account_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(wa_id) DO UPDATE SET name = COALESCE(excluded.name, chats.name)`
  ).run(waId, name ?? null, accountId, now());
}

export function getChat(waId) {
  return db.prepare(`SELECT * FROM chats WHERE wa_id = ?`).get(waId);
}

export function listChats() {
  return db
    .prepare(
      `SELECT c.*, (SELECT text FROM messages m WHERE m.wa_id = c.wa_id ORDER BY id DESC LIMIT 1) AS last_text
       FROM chats c ORDER BY c.needs_attention DESC, c.updated_at DESC LIMIT 500`
    )
    .all();
}

/** Сохраняет сообщение. Возвращает false, если сообщение с таким wa_msg_id уже было (повтор вебхука). */
export function addMessage(waId, role, text, waMsgId = null) {
  const t = now();
  const res = db
    .prepare(`INSERT OR IGNORE INTO messages (wa_id, wa_msg_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(waId, waMsgId, role, text, t);
  if (res.changes === 0) return false;
  const extra =
    role === "customer" ? ", last_customer_at = ?" : role === "operator" ? ", last_human_at = ?" : "";
  const params = extra ? [t, t, waId] : [t, waId];
  db.prepare(`UPDATE chats SET updated_at = ?${extra} WHERE wa_id = ?`).run(...params);
  return true;
}

export function getMessages(waId, limit = 200) {
  return db
    .prepare(`SELECT * FROM (SELECT * FROM messages WHERE wa_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`)
    .all(waId, limit);
}

export function setMode(waId, mode, { reason = null, attention = mode === "human" } = {}) {
  db.prepare(`UPDATE chats SET mode = ?, handoff_reason = ?, needs_attention = ?, updated_at = ? WHERE wa_id = ?`).run(
    mode,
    reason,
    attention ? 1 : 0,
    now(),
    waId
  );
}

export function clearAttention(waId) {
  db.prepare(`UPDATE chats SET needs_attention = 0 WHERE wa_id = ?`).run(waId);
}

export function countBotRepliesSince(ts, accountId) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages m JOIN chats c ON c.wa_id = m.wa_id
       WHERE m.role = 'bot' AND m.created_at >= ? AND c.account_id = ?`
    )
    .get(ts, accountId).n;
}

export function hasCustomerMessages(waId) {
  return !!db.prepare(`SELECT 1 FROM messages WHERE wa_id = ? AND role = 'customer' LIMIT 1`).get(waId);
}

export function markAttention(waId) {
  db.prepare(`UPDATE chats SET needs_attention = 1 WHERE wa_id = ?`).run(waId);
}
