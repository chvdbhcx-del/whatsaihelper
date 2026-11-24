// Настройки, которые меняются из панели оператора (хранятся в data/settings.json).
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const FILE = path.join(config.dataDir, "settings.json");

// Ключи ИИ в файле хранятся зашифрованными, если программа запущена в Windows-оболочке (globalThis.__secrets)
const SECRET_FIELDS = ["anthropicApiKey", "openaiApiKey"];
const ENC = "enc:";
let plaintextOnDisk = false;

function decryptFields(o) {
  const out = { ...o };
  for (const f of SECRET_FIELDS) {
    const v = out[f];
    if (typeof v !== "string" || !v) continue;
    if (v.startsWith(ENC)) {
      try {
        out[f] = globalThis.__secrets.decrypt(v.slice(ENC.length));
      } catch {
        out[f] = ""; // расшифровать нельзя (другой пользователь Windows): ключ нужно ввести заново
        console.warn(`Не удалось расшифровать сохранённый ключ (${f}): введите его заново в «Настройках ИИ»`);
      }
    } else if (globalThis.__secrets) plaintextOnDisk = true;
  }
  return out;
}

function encryptFields(o) {
  if (!globalThis.__secrets) return o;
  const out = { ...o };
  for (const f of SECRET_FIELDS) if (typeof out[f] === "string" && out[f]) out[f] = ENC + globalThis.__secrets.encrypt(out[f]);
  return out;
}

function read() {
  try {
    return decryptFields(JSON.parse(fs.readFileSync(FILE, "utf8")));
  } catch {
    return {};
  }
}

function write(obj) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(encryptFields(obj), null, 2), { mode: 0o600 });
}

let current = read();

// Google отключил gemini-2.5-flash для новых ключей: переводим старую настройку на актуальную модель
const RETIRED = { "gemini-2.5-flash": "gemini-3.5-flash", "gemini-2.5-flash-lite": "gemini-3.5-flash-lite" };
const retired = /generativelanguage\.googleapis\.com/.test(current.openaiBaseUrl ?? "") && RETIRED[current.openaiModel];
if (retired) current = { ...current, openaiModel: RETIRED[current.openaiModel] };
if (retired || plaintextOnDisk) {
  // Заодно шифруем ключи, сохранённые прежними версиями открытым текстом
  try {
    write(current);
  } catch {
    // не страшно: поправится при следующем сохранении из панели
  }
}

export function get() {
  return {
    aiProvider: current.aiProvider || process.env.AI_PROVIDER || "anthropic", // anthropic | openai
    anthropicApiKey: current.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "",
    openaiBaseUrl: current.openaiBaseUrl ?? process.env.OPENAI_BASE_URL ?? "",
    openaiApiKey: current.openaiApiKey || process.env.OPENAI_API_KEY || "",
    openaiModel: current.openaiModel ?? process.env.OPENAI_MODEL ?? "",
    dailyLimit: Number.isFinite(current.dailyLimit) ? current.dailyLimit : config.dailyReplyLimit,
    // Пауза перед ответом: бот ждёт, не допишет ли клиент ещё сообщение (настройка из панели, иначе переменная окружения)
    replyDelaySeconds: Number.isFinite(current.replyDelaySeconds) ? current.replyDelaySeconds : process.env.REPLY_DEBOUNCE_SECONDS !== undefined ? Number(process.env.REPLY_DEBOUNCE_SECONDS) : 2,
    // Быстрый режим: модели, которые «размышляют» перед ответом, отвечают без долгих размышлений
    fastAI: current.fastAI ?? true,
  };
}

// ---------- Номера WhatsApp (режим QR) ----------

export function accounts() {
  return (current.accounts ?? []).map((a) => ({ ...a, dailyLimit: Number.isFinite(a.dailyLimit) ? a.dailyLimit : get().dailyLimit }));
}

export function account(id) {
  return accounts().find((a) => a.id === id) ?? null;
}

function save(next) {
  write(next);
  current = next;
}

export function addAccount(name, id) {
  const list = current.accounts ?? [];
  const acc = { id: id ?? `n${Date.now().toString(36)}`, name: String(name || `Номер ${list.length + 1}`).slice(0, 60) };
  save({ ...current, accounts: [...list, acc] });
  return account(acc.id);
}

export function updateAccount(id, patch) {
  const list = (current.accounts ?? []).map((a) => {
    if (a.id !== id) return a;
    const n = { ...a };
    if (typeof patch.name === "string" && patch.name.trim()) n.name = patch.name.trim().slice(0, 60);
    if (patch.dailyLimit !== undefined && patch.dailyLimit !== "") {
      const v = Math.floor(Number(patch.dailyLimit));
      if (Number.isFinite(v) && v >= 0) n.dailyLimit = v;
    }
    return n;
  });
  save({ ...current, accounts: list });
  return account(id);
}

export function removeAccount(id) {
  // Запоминаем телефон удалённого номера: если его подключат снова, старые диалоги перейдут к нему
  const phone = (current.accounts ?? []).find((a) => a.id === id)?.phone;
  const removedPhones = { ...(current.removedPhones ?? {}) };
  if (phone) removedPhones[id] = phone;
  save({ ...current, removedPhones, accounts: (current.accounts ?? []).filter((a) => a.id !== id) });
}

/** Телефон номера бота, запомненный при последнем подключении. */
export function setAccountPhone(id, phone) {
  if (!phone) return;
  const list = current.accounts ?? [];
  if (!list.some((a) => a.id === id && a.phone !== phone)) return;
  save({ ...current, accounts: list.map((a) => (a.id === id ? { ...a, phone } : a)) });
}

export function removedPhone(id) {
  return current.removedPhones?.[id] ?? null;
}

export function update(patch) {
  const next = { ...current };
  if (typeof patch.anthropicApiKey === "string" && patch.anthropicApiKey.trim()) {
    next.anthropicApiKey = patch.anthropicApiKey.trim();
  }
  if (patch.aiProvider === "anthropic" || patch.aiProvider === "openai") next.aiProvider = patch.aiProvider;
  if (typeof patch.openaiBaseUrl === "string") next.openaiBaseUrl = patch.openaiBaseUrl.trim();
  if (typeof patch.openaiModel === "string") next.openaiModel = patch.openaiModel.trim();
  if (typeof patch.openaiApiKey === "string" && patch.openaiApiKey.trim()) next.openaiApiKey = patch.openaiApiKey.trim();
  if (patch.dailyLimit !== undefined) {
    const n = Math.floor(Number(patch.dailyLimit));
    if (Number.isFinite(n) && n >= 0) next.dailyLimit = n;
  }
  if (patch.replyDelaySeconds !== undefined) {
    const n = Number(patch.replyDelaySeconds);
    if (Number.isFinite(n) && n >= 0 && n <= 30) next.replyDelaySeconds = n;
  }
  if (typeof patch.fastAI === "boolean") next.fastAI = patch.fastAI;
  save(next);
  return get();
}
