import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // .env не обязателен: переменные можно задать окружением
}

const env = (name, def = "") => (process.env[name] ?? def).trim();
const bool = (name) => env(name).toLowerCase() === "true";
const num = (name, def) => {
  const v = Number(env(name, String(def)));
  return Number.isFinite(v) ? v : def;
};

export const config = {
  port: num("PORT", 3000),
  host: env("HOST", "0.0.0.0"),
  adminPassword: env("ADMIN_PASSWORD"),
  dataDir: env("DATA_DIR", path.join(ROOT, "data")),
  knowledgeDir: env("KNOWLEDGE_DIR", path.join(ROOT, "knowledge")),

  wa: {
    provider: env("WA_PROVIDER", "360dialog"),
    d360ApiKey: env("D360_API_KEY"),
    metaToken: env("META_ACCESS_TOKEN"),
    metaPhoneNumberId: env("META_PHONE_NUMBER_ID"),
    metaApiVersion: env("META_API_VERSION", "v21.0"),
    metaAppSecret: env("META_APP_SECRET"),
    customSendUrl: env("CUSTOM_SEND_URL"),
    customAuthHeader: env("CUSTOM_AUTH_HEADER", "Authorization"),
    customAuthValue: env("CUSTOM_AUTH_VALUE"),
    verifyToken: env("WEBHOOK_VERIFY_TOKEN"),
    webhookKey: env("WEBHOOK_KEY"),
    dryRun: bool("WA_DRY_RUN"),
  },

  ai: {
    model: env("AI_MODEL", "claude-opus-5-5"),
    effort: env("AI_EFFORT", "low"),
    history: num("AI_HISTORY", 30),
    mock: bool("AI_MOCK"),
  },

  ngrok: {
    authtoken: env("NGROK_AUTHTOKEN"),
    domain: env("NGROK_DOMAIN"),
  },

  // Лимит ответов бота за сутки по умолчанию для каждого номера (0 = без лимита). Меняется в панели
  dailyReplyLimit: num("DAILY_REPLY_LIMIT", 100),

  debounceMs: num("REPLY_DEBOUNCE_SECONDS", 4) * 1000,
  humanPauseMs: num("HUMAN_PAUSE_MINUTES", 60) * 60 * 1000,
};
