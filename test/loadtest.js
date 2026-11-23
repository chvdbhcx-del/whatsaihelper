// Нагрузочный тест: несколько ИИ-«клиентов» одновременно пишут боту.
// Всё происходит локально: сообщения идут на вебхук вашего сервера, а ответы бота
// НЕ отправляются в WhatsApp (сервер должен быть запущен с WA_DRY_RUN=true).
//
// Запуск (в другом окне, пока работает `npm start` с WA_DRY_RUN=true):
//   npm run loadtest -- --customers 5 --rate 20 --minutes 3
//
// Параметры:
//   --customers N   сколько клиентов пишут одновременно (по умолчанию 5)
//   --rate N        всего сообщений клиентов в минуту, на всех (по умолчанию 20)
//   --minutes N     длительность теста (по умолчанию 3)
//   --url URL       адрес сервера (по умолчанию http://localhost:PORT)
//   --timeout N     сколько секунд ждать ответа бота (по умолчанию 120)

import { config } from "../src/config.js";
import { complete, metrics as customerMetrics } from "../src/ai.js";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1]]] : acc), [])
);
const CUSTOMERS = Math.max(1, Number(args.customers ?? 5));
const RATE = Math.max(1, Number(args.rate ?? 20));
const MINUTES = Math.max(0.1, Number(args.minutes ?? 3));
const BASE = (args.url ?? `http://localhost:${config.port}`).replace(/\/+$/, "");
const TIMEOUT_MS = Number(args.timeout ?? 120) * 1000;
const ACCOUNT = "loadtest";
const AUTH = "Basic " + Buffer.from(`admin:${config.adminPassword}`).toString("base64");

const SCENARIOS = [
  "У тебя не работает интернет со вчерашнего вечера. Роутер ты уже перезагружал.",
  "Ты хочешь сменить пароль от личного кабинета и не можешь найти, где это сделать.",
  "Ты недоволен: проблема повторяется третий раз за неделю, хочешь компенсацию.",
  "Ты сомневаешься, что тебе отвечает живой человек, и прямо спрашиваешь об этом.",
  "Ты спрашиваешь, сколько стоит выезд мастера и когда он может приехать.",
  "Ты пишешь коротко и с опечатками, интернет то пропадает, то появляется.",
  "Ты пишешь по-казахски или смешиваешь казахский с русским: не открываются сайты.",
  "Ты просто хочешь узнать график работы поддержки.",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}/admin/api${path}`, { ...opts, headers: { Authorization: AUTH, "Content-Type": "application/json", ...opts.headers } });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function sendAsCustomer(number, name, text) {
  const payload = {
    entry: [{ changes: [{ value: {
      contacts: [{ wa_id: number, profile: { name } }],
      messages: [{ id: `wamid.load.${number}.${Date.now()}.${Math.random().toString(36).slice(2)}`, from: number, type: "text", text: { body: text } }],
    } }] }],
  };
  const key = config.wa.webhookKey ? `&key=${encodeURIComponent(config.wa.webhookKey)}` : "";
  const res = await fetch(`${BASE}/webhook?account=${ACCOUNT}${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`webhook ${res.status}`);
}

/** Ждём новое сообщение бота после lastId. */
async function waitForBot(chatId, lastId, deadline) {
  while (Date.now() < deadline) {
    await sleep(500);
    const data = await api(`/chats/${encodeURIComponent(chatId)}`).catch(() => null);
    if (!data) continue;
    const reply = data.messages.find((m) => m.id > lastId && m.role === "bot");
    if (reply) return { reply, chat: data.chat, messages: data.messages };
    if (data.chat.mode === "human" && data.messages.some((m) => m.id > lastId && m.role === "system")) {
      return { reply: null, chat: data.chat, messages: data.messages };
    }
  }
  return null;
}

const CUSTOMER_RULES =
  "Ты играешь роль клиента, который пишет в WhatsApp в техподдержку компании. Пиши как живой человек в мессенджере: коротко, 1–2 предложения, без markdown. " +
  "Не говори, что ты ИИ или тестировщик. Если вопрос решён или тебе сказали, что подключат специалиста, коротко поблагодари.";

async function customerSays(scenario, history) {
  // Для модели-«клиента» роли зеркальны: бот для неё собеседник (user), клиент — она сама (assistant)
  const msgs = history.map((m) => ({ role: m.role === "customer" ? "assistant" : "user", content: m.text }));
  if (!msgs.length || msgs[0].role !== "user") msgs.unshift({ role: "user", content: "(Ты открыл чат с поддержкой. Напиши первое сообщение.)" });
  const merged = [];
  for (const m of msgs) {
    if (merged.at(-1)?.role === m.role) merged.at(-1).content += `\n${m.content}`;
    else merged.push({ ...m });
  }
  if (merged.at(-1).role !== "user") merged.push({ role: "user", content: "(Собеседник молчит. Напиши следующее сообщение.)" });
  const { text } = await complete({ system: `${CUSTOMER_RULES}\nТвоя ситуация: ${scenario}`, messages: merged, tag: "customer", maxTokens: 300 });
  return text.trim() || "Алло?";
}

const results = { conversations: 0, customerMessages: 0, botReplies: 0, handoffs: 0, timeouts: 0, errors: 0, latencies: [] };

async function customerLoop(index, endAt) {
  const intervalMs = (CUSTOMERS * 60_000) / RATE;
  let n = 0;
  while (Date.now() < endAt) {
    const number = `7999${String(index).padStart(3, "0")}${String(n++).padStart(4, "0")}`;
    const chatId = `${ACCOUNT}|${number}`;
    const scenario = SCENARIOS[(index + n) % SCENARIOS.length];
    const name = `Тест ${index + 1}.${n}`;
    let history = [];
    let lastId = 0;
    results.conversations++;

    for (let turn = 0; turn < 8 && Date.now() < endAt; turn++) {
      const turnStart = Date.now();
      try {
        const text = await customerSays(scenario, history);
        await sendAsCustomer(number, name, text);
        results.customerMessages++;
        const sentAt = Date.now();
        const got = await waitForBot(chatId, lastId, sentAt + TIMEOUT_MS);
        if (!got) {
          results.timeouts++;
          break;
        }
        history = got.messages.filter((m) => m.role === "customer" || m.role === "bot" || m.role === "operator");
        lastId = got.messages.at(-1).id;
        if (got.reply) {
          results.botReplies++;
          results.latencies.push(Date.now() - sentAt);
        }
        if (got.chat.mode === "human") {
          results.handoffs++;
          break; // диалог передан оператору: начинаем новый с другим «клиентом»
        }
      } catch (e) {
        results.errors++;
        console.error(`[клиент ${index + 1}]`, e.message);
        await sleep(2000);
        break;
      }
      await sleep(Math.max(0, intervalMs - (Date.now() - turnStart)));
    }
  }
}

function pct(list, p) {
  const l = [...list].sort((a, b) => a - b);
  return l.length ? l[Math.min(l.length - 1, Math.floor((p / 100) * l.length))] : 0;
}
const sec = (ms) => `${(ms / 1000).toFixed(1)} с`;

async function main() {
  const status = await api("/status").catch((e) => {
    console.error(`Не удалось подключиться к серверу ${BASE}: ${e.message}. Запустите npm start и проверьте ADMIN_PASSWORD.`);
    process.exit(1);
  });
  if (!status.dryRun) {
    console.error("Сервер запущен без WA_DRY_RUN=true. Нагрузочный тест можно запускать только в тестовом режиме, чтобы ничего не ушло в WhatsApp.");
    process.exit(1);
  }
  await api("/metrics/reset", { method: "POST" });
  console.log(`Нагрузочный тест: ${CUSTOMERS} клиентов, ~${RATE} сообщений/мин, ${MINUTES} мин. Сервер: ${BASE}`);
  console.log("Диалоги видны в панели оператора. Ctrl+C — остановить.\n");

  const started = Date.now();
  const endAt = started + MINUTES * 60_000;
  const progress = setInterval(() => {
    const m = Math.round((Date.now() - started) / 1000);
    console.log(`[${m} с] сообщений клиентов: ${results.customerMessages}, ответов бота: ${results.botReplies}, передано оператору: ${results.handoffs}, таймаутов: ${results.timeouts}, p95 ответа: ${sec(pct(results.latencies, 95))}`);
  }, 15_000);

  await Promise.all(Array.from({ length: CUSTOMERS }, (_, i) => sleep(i * 700).then(() => customerLoop(i, endAt))));
  clearInterval(progress);

  const server = await api("/metrics").catch(() => ({}));
  const bot = server.bot ?? {};
  const cust = customerMetrics().customer;
  const minutes = (Date.now() - started) / 60_000;

  console.log("\n========== Итоги ==========");
  console.log(`Длительность:                 ${minutes.toFixed(1)} мин`);
  console.log(`Диалогов:                     ${results.conversations}`);
  console.log(`Сообщений клиентов:           ${results.customerMessages} (${(results.customerMessages / minutes).toFixed(1)} в минуту)`);
  console.log(`Ответов бота:                 ${results.botReplies}`);
  console.log(`Передано оператору:           ${results.handoffs}`);
  console.log(`Бот не ответил вовремя:       ${results.timeouts}`);
  console.log(`Ошибки теста:                 ${results.errors}`);
  console.log("\nВремя от сообщения клиента до ответа бота (включая паузу REPLY_DEBOUNCE_SECONDS):");
  console.log(`  среднее ${sec(results.latencies.reduce((a, b) => a + b, 0) / (results.latencies.length || 1))}, медиана ${sec(pct(results.latencies, 50))}, 95% ${sec(pct(results.latencies, 95))}, макс ${sec(pct(results.latencies, 100))}`);
  console.log("\nИИ бота (на сервере):");
  console.log(`  запросов ${bot.calls ?? 0}, ошибок ${bot.errors ?? 0}, из них лимит запросов (429) ${bot.rateLimited ?? 0}`);
  console.log(`  время запроса: среднее ${sec(bot.avgMs ?? 0)}, 95% ${sec(bot.p95Ms ?? 0)}, макс ${sec(bot.maxMs ?? 0)}`);
  console.log(`  токены: вход ${bot.inputTokens ?? 0}, выход ${bot.outputTokens ?? 0}`);
  console.log("\nИИ «клиентов» (этот скрипт):");
  console.log(`  запросов ${cust?.calls ?? 0}, ошибок ${cust?.errors ?? 0}, лимит (429) ${cust?.rateLimited ?? 0}, токены: вход ${cust?.inputTokens ?? 0}, выход ${cust?.outputTokens ?? 0}`);
  if (bot.calls) {
    const perReply = ((bot.inputTokens ?? 0) + (bot.outputTokens ?? 0)) / bot.calls;
    console.log(`\nВ среднем ${Math.round(perReply)} токенов на один ответ бота. При 100 ответах в день: ~${Math.round(perReply * 100)} токенов в день.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
