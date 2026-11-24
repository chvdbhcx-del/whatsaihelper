// Настройки, которые меняются из панели оператора (хранятся в data/settings.json).
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const FILE = path.join(config.dataDir, "settings.json");

function read() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

let current = read();

// Google отключил gemini-2.5-flash для новых ключей: переводим старую настройку на актуальную модель
const RETIRED = { "gemini-2.5-flash": "gemini-3.5-flash", "gemini-2.5-flash-lite": "gemini-3.5-flash-lite" };
if (/generativelanguage\.googleapis\.com/.test(current.openaiBaseUrl ?? "") && RETIRED[current.openaiModel]) {
  current = { ...current, openaiModel: RETIRED[current.openaiModel] };
  try {
    fs.writeFileSync(FILE, JSON.stringify(current, null, 2), { mode: 0o600 });
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
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
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
  save({ ...current, accounts: (current.accounts ?? []).filter((a) => a.id !== id) });
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
  save(next);
  return get();
}
