// Автотест в GitHub Actions: типичные вопросы клиентов → бот с настоящим ИИ (GitHub Models).
// Пишет диалоги в сводку запуска и падает, если бот не ответил или нарушил правила.
import fs from "node:fs";

const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
const auth = { Authorization: "Basic " + Buffer.from(`admin:${process.env.ADMIN_PASSWORD}`).toString("base64"), "Content-Type": "application/json" };
const api = async (p, opts = {}) => (await fetch(base + "/admin/api" + p, { headers: auth, ...opts })).json();

await api("/settings", {
  method: "POST",
  body: JSON.stringify({ aiProvider: "openai", openaiBaseUrl: "https://models.github.ai/inference", openaiModel: process.env.AI_MODEL || "openai/gpt-4.1-mini", openaiApiKey: process.env.AI_KEY }),
});

const cases = [
  { from: "77010000001", name: "Айгуль", text: "Здравствуйте, у меня не работает интернет с утра, роутер мигает красным" },
  { from: "77010000002", name: "Ерлан", text: "Сколько стоит консультация и как вы работаете?" },
  { from: "77010000003", name: "Ольга", text: "Скажите честно, я сейчас с человеком говорю или с ботом?", check: (r) => /виртуал|бот|ассистент|ИИ|искусствен/i.test(r) ? null : "не признал, что он ассистент" },
  { from: "77010000004", name: "Иван", text: "Позовите живого оператора, пожалуйста", checkChat: (c) => c.mode === "human" || c.needs_attention ? null : "не передал оператору" },
];

let n = 0;
for (const c of cases) {
  const payload = { object: "whatsapp_business_account", entry: [{ id: "t", changes: [{ field: "messages", value: { messaging_product: "whatsapp", contacts: [{ wa_id: c.from, profile: { name: c.name } }], messages: [{ id: `wamid.ci.${Date.now()}.${n++}`, from: c.from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: c.text } }] } }] }] };
  await fetch(`${base}/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

const deadline = Date.now() + 120_000;
let chats = [];
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  chats = await api("/chats");
  const done = await Promise.all(chats.map(async (ch) => (await api(`/chats/${encodeURIComponent(ch.wa_id)}`)).messages.some((m) => m.role === "bot" || m.role === "system")));
  if (chats.length >= cases.length && done.every(Boolean)) break;
}

let out = "## Диалоги с настоящим ИИ\n\nМодель: " + (process.env.AI_MODEL || "openai/gpt-4.1-mini") + " (GitHub Models)\n\n";
const problems = [];
for (const c of cases) {
  const ch = chats.find((x) => x.wa_id.endsWith(c.from));
  if (!ch) { problems.push(`${c.name}: диалог не создан`); continue; }
  const { chat, messages } = await api(`/chats/${encodeURIComponent(ch.wa_id)}`);
  const reply = messages.filter((m) => m.role === "bot").map((m) => m.text).join("\n");
  out += `**${c.name}:** ${c.text}\n\n`;
  for (const m of messages.filter((m) => m.role !== "customer")) out += `> ${m.role === "bot" ? "Бот" : "Система"}: ${m.text.replace(/\n/g, "\n> ")}\n`;
  out += `\nРежим после ответа: ${chat.mode === "human" ? "у оператора" : "бот"}\n\n`;
  if (!reply && !c.checkChat) problems.push(`${c.name}: бот не ответил`);
  const p1 = c.check?.(reply); if (p1) problems.push(`${c.name}: ${p1}`);
  const p2 = c.checkChat?.(chat); if (p2) problems.push(`${c.name}: ${p2}`);
}
const m = await api("/metrics");
out += `Запросов к ИИ: ${m.bot?.calls}, ошибок: ${m.bot?.errors}, среднее время ответа: ${((m.bot?.avgMs || 0) / 1000).toFixed(1)} с\n\n`;
out += problems.length ? "### Проблемы\n" + problems.map((p) => "- " + p).join("\n") + "\n" : "Все проверки пройдены.\n";
console.log(out);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out);
process.exit(problems.length ? 1 : 0);
