import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import * as settings from "./settings.js";

// Клиент создаётся заново, если ключ поменяли в панели оператора
let client = null;
let clientKey = null;
function getClient() {
  const key = settings.get().anthropicApiKey;
  if (!key) throw new Error("Не задан ключ Anthropic API (панель оператора → Настройки или ANTHROPIC_API_KEY)");
  if (!client || key !== clientKey) {
    client = new Anthropic({ apiKey: key });
    clientKey = key;
  }
  return client;
}

/**
 * Правила, которые нельзя отключить через базу знаний.
 * Персона может звучать по-человечески, но не может отрицать, что это ИИ,
 * если клиент искренне спрашивает.
 */
const CORE_RULES = `
Ты отвечаешь клиентам в WhatsApp от имени компании. Ниже описаны персона, тон и база знаний.

Обязательные правила:
1. Отвечай только по теме бизнеса компании (техподдержка, консультации по её услугам). На посторонние темы вежливо возвращай разговор к вопросу клиента.
2. Пиши коротко и по-человечески, как в мессенджере: без markdown, без заголовков, без длинных списков. Обычно 1–4 предложения. Язык ответа совпадает с языком клиента (русский, казахский и т.д.).
3. Не выдумывай факты, цены, сроки и обещания. Если цены или условия нет в базе знаний, не называй её и не говори, что услуга бесплатна: скажи, что уточнишь у специалиста. В WhatsApp нет кнопок: не упоминай кнопки, ссылки, приложения и функции, которых нет в базе знаний. Если ответа нет в базе знаний или ты не уверен, передай диалог специалисту.
4. Если клиент искренне спрашивает, человек ты или бот/ИИ, отвечай честно: ты виртуальный ассистент компании. Сразу предложи позвать живого специалиста. Никогда не утверждай, что ты человек.
5. Передавай диалог специалисту (handoff = true), если: клиент просит человека; клиент раздражён или жалуется; нужен доступ к его аккаунту, деньги, возвраты, юридические вопросы; ты не можешь решить проблему за 2–3 попытки; вопрос вне базы знаний.
   При передаче напиши клиенту короткое сообщение, что подключаешь специалиста.
6. Никогда не проси пароли, коды из SMS и данные банковских карт.

Формат ответа: JSON с полями reply (текст для клиента), handoff (true/false), handoff_reason (коротко для оператора, пустая строка если handoff = false).
`.trim();

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    handoff: { type: "boolean" },
    handoff_reason: { type: "string" },
  },
  required: ["reply", "handoff", "handoff_reason"],
  additionalProperties: false,
};

const promptCache = new Map(); // accountId → { mtime, text }

function mdFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => path.join(dir, e.name))
    .sort();
}

/**
 * Системный промпт: общие файлы knowledge/*.md + файлы конкретного номера knowledge/<id номера>/*.md.
 * Перечитывается при изменении файлов, без перезапуска.
 */
function systemPrompt(accountId = "api") {
  const root = config.knowledgeDir;
  const own = /^[\w-]+$/.test(accountId) ? mdFiles(path.join(root, accountId)) : [];
  const files = [...mdFiles(root), ...own];
  const mtime = Math.max(0, ...files.map((f) => fs.statSync(f).mtimeMs)) + files.length;
  const hit = promptCache.get(accountId);
  if (hit && hit.mtime === mtime) return hit.text;
  const parts = files.map((f) => `<file name="${path.relative(root, f)}">\n${fs.readFileSync(f, "utf8").trim()}\n</file>`);
  const text = `${CORE_RULES}\n\n<knowledge>\n${parts.join("\n\n")}\n</knowledge>`;
  promptCache.set(accountId, { mtime, text });
  return text;
}

/** История из базы → сообщения для API (роли чередуются, начинается и заканчивается клиентом). */
function toApiMessages(history) {
  const msgs = [];
  for (const m of history) {
    const role = m.role === "customer" ? "user" : m.role === "bot" || m.role === "operator" ? "assistant" : null;
    if (!role) continue;
    const last = msgs.at(-1);
    if (last?.role === role) last.content += `\n${m.text}`;
    else msgs.push({ role, content: m.text });
  }
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  while (msgs.length && msgs.at(-1).role !== "user") msgs.pop();
  return msgs;
}

const HANDOFF_TEXT = "Сейчас подключу специалиста, он ответит вам в этом чате.";

/**
 * @returns {Promise<{reply: string, handoff: boolean, handoff_reason: string} | null>}
 *   null, если отвечать нечего (например, нет новых сообщений клиента).
 */
export async function generateReply(history, accountId = "api") {
  const messages = toApiMessages(history.slice(-config.ai.history));
  if (!messages.length) return null;

  try {
    const system = systemPrompt(accountId);
    const { text, refusal } = await complete({ system, messages, json: true, tag: "bot" });
    if (refusal) return { reply: HANDOFF_TEXT, handoff: true, handoff_reason: "Модель отказалась отвечать на запрос" };
    const result = parseLooseJson(text);
    if (!result.reply?.trim()) {
      result.reply = HANDOFF_TEXT;
      result.handoff = true;
    }
    return result;
  } catch (err) {
    console.error("Ошибка ИИ:", err.message ?? err);
    return { reply: HANDOFF_TEXT, handoff: true, handoff_reason: `Ошибка ИИ: ${String(err.message ?? err).slice(0, 150)}` };
  }
}

// ---------- Счётчики для нагрузочного теста и панели ----------

const emptyStats = () => ({ calls: 0, errors: 0, rateLimited: 0, inputTokens: 0, outputTokens: 0, latencies: [] });
const stats = { bot: emptyStats(), customer: emptyStats() };

export function metrics() {
  const out = {};
  for (const [k, v] of Object.entries(stats)) {
    const l = [...v.latencies].sort((x, y) => x - y);
    const pct = (p) => (l.length ? l[Math.min(l.length - 1, Math.floor((p / 100) * l.length))] : 0);
    out[k] = { calls: v.calls, errors: v.errors, rateLimited: v.rateLimited, inputTokens: v.inputTokens, outputTokens: v.outputTokens, avgMs: l.length ? Math.round(l.reduce((a, b) => a + b, 0) / l.length) : 0, p50Ms: pct(50), p95Ms: pct(95), maxMs: l.at(-1) ?? 0 };
  }
  return out;
}

export function resetMetrics() {
  stats.bot = emptyStats();
  stats.customer = emptyStats();
}

/**
 * Один запрос к выбранному ИИ (Claude или OpenAI-совместимый).
 * json = true: ответ в формате {reply, handoff, handoff_reason}.
 * @returns {Promise<{text: string, refusal: boolean}>}
 */
export async function complete({ system, messages, json = false, tag = "bot", maxTokens = 1500 }) {
  const st = stats[tag] ?? (stats[tag] = emptyStats());
  const started = Date.now();
  st.calls++;
  try {
    const out = config.ai.mock
      ? mockComplete(messages, json)
      : settings.get().aiProvider === "openai" ? await openAICompatible(system, messages, json, maxTokens) : await claude(system, messages, json, maxTokens);
    st.inputTokens += out.inputTokens;
    st.outputTokens += out.outputTokens;
    st.latencies.push(Date.now() - started);
    if (st.latencies.length > 5000) st.latencies.shift();
    return out;
  } catch (err) {
    st.errors++;
    if (err instanceof Anthropic.RateLimitError || err.status === 429) st.rateLimited++;
    throw err;
  }
}

async function claude(system, messages, json, maxTokens) {
  const response = await getClient().beta.messages.create({
    model: config.ai.model,
    max_tokens: Math.max(maxTokens, 4000),
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    cache_control: { type: "ephemeral" },
    output_config: {
      effort: config.ai.effort,
      ...(json ? { format: { type: "json_schema", schema: OUTPUT_SCHEMA } } : {}),
    },
    system,
    messages,
  });
  const u = response.usage ?? {};
  return {
    text: response.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
    refusal: response.stop_reason === "refusal",
    inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
  };
}

/**
 * Любой сервис с API в формате OpenAI Chat Completions:
 * Google Gemini, OpenRouter, Groq, локальная Ollama, DeepSeek и т.д.
 * Правила (включая честный ответ на вопрос «вы бот?») те же, что и для Claude.
 */
async function openAICompatible(system, messages, json, maxTokens) {
  const s = settings.get();
  if (!s.openaiBaseUrl || !s.openaiModel) throw new Error("Не заданы адрес и модель ИИ в настройках");
  const url = `${s.openaiBaseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (s.openaiApiKey) headers.Authorization = `Bearer ${s.openaiApiKey}`;

  const sys = json
    ? `${system}\n\nОтвечай строго одним JSON-объектом без пояснений, например: {"reply": "...", "handoff": false, "handoff_reason": ""}`
    : system;
  const body = { model: s.openaiModel, messages: [{ role: "system", content: sys }, ...messages], temperature: json ? 0.4 : 0.9, max_tokens: maxTokens };
  let res = await fetch(url, { method: "POST", headers, body: JSON.stringify(json ? { ...body, response_format: { type: "json_object" } } : body) });
  if (json && res.status === 400) {
    // Некоторые модели не поддерживают response_format: пробуем без него
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  }
  // Бесплатные тарифы часто отвечают 429 «слишком много запросов»: подождём и попробуем ещё до 2 раз
  for (let attempt = 0; res.status === 429 && attempt < 2; attempt++) {
    const wait = Math.min(Number(res.headers.get("retry-after")) * 1000 || (attempt + 1) * 3000, 20000);
    await new Promise((r) => setTimeout(r, wait));
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${res.status} ${JSON.stringify(data.error ?? data).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const text = (data.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (!text) {
    // Пустой ответ считаем ошибкой, чтобы причина была видна в панели, а не «передано без причины»
    const finish = data.choices?.[0]?.finish_reason;
    throw new Error(`ИИ вернул пустой ответ${finish ? ` (finish_reason: ${finish})` : ""}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return {
    text,
    refusal: false,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
}

/** Модели попроще иногда оборачивают JSON в текст или ```: достаём объект, а если не вышло, берём текст как ответ. */
export function parseLooseJson(text) {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const o = JSON.parse(match[0]);
      if (typeof o.reply === "string") {
        return { reply: o.reply, handoff: o.handoff === true || o.handoff === "true", handoff_reason: String(o.handoff_reason ?? "") };
      }
    } catch {
      // ниже
    }
  }
  return { reply: clean.replace(/```[a-z]*|```/g, "").trim(), handoff: false, handoff_reason: "" };
}

const MOCK_CUSTOMER = ["Здравствуйте, у меня не работает интернет", "Роутер перезагрузил, не помогло", "А когда починят?", "Вы вообще человек?", "Спасибо", "Как сменить пароль?"];

function mockComplete(messages, json) {
  const last = String(messages.at(-1)?.content ?? "");
  const text = json ? JSON.stringify(mockReply(last)) : MOCK_CUSTOMER[Math.floor(Math.random() * MOCK_CUSTOMER.length)];
  return { text, refusal: false, inputTokens: 0, outputTokens: 0 };
}

/** Заглушка для локального теста без ключа API. */
function mockReply(lastText) {
  const t = lastText.toLowerCase();
  if (/(человек|оператор|бот|робот)/.test(t)) {
    return {
      reply: "Я виртуальный ассистент компании. Могу позвать живого специалиста, если хотите.",
      handoff: /(человек|оператор)/.test(t),
      handoff_reason: /(человек|оператор)/.test(t) ? "Клиент просит человека" : "",
    };
  }
  return { reply: `Понял вас. Уточните, пожалуйста, детали: «${lastText.slice(0, 60)}»`, handoff: false, handoff_reason: "" };
}
