import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import { config, ROOT } from "./config.js";
import * as db from "./db.js";
import * as wa from "./whatsapp.js";
import { onIncoming, operatorSend, usageToday } from "./bot.js";
import { metrics, resetMetrics } from "./ai.js";
import * as settings from "./settings.js";
import * as waweb from "./waweb.js";

const app = express();

// ---------- Вебхук WhatsApp ----------

// Подтверждение адреса вебхука (Meta и партнёры шлют GET с hub.challenge)
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === config.wa.verifyToken) {
    return res.status(200).send(String(req.query["hub.challenge"] ?? ""));
  }
  res.sendStatus(403);
});

app.post("/webhook", express.raw({ type: "*/*", limit: "2mb" }), (req, res) => {
  if (config.wa.webhookKey && req.query.key !== config.wa.webhookKey) return res.sendStatus(403);
  if (!wa.verifySignature(req.body, req.get("x-hub-signature-256"))) return res.sendStatus(401);

  let payload;
  try {
    payload = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.sendStatus(400);
  }
  // Отвечаем сразу: WhatsApp повторяет доставку, если ответа нет несколько секунд
  res.sendStatus(200);

  for (const msg of wa.parseWebhook(payload)) {
    // Тестовый режим без WhatsApp: номер бота можно указать в ?account= (нагрузочный тест использует account=loadtest)
    if (config.wa.dryRun && (req.query.account || config.wa.provider === "web")) {
      msg.account = String(req.query.account || settings.accounts()[0]?.id || "main").replace(/[^\w-]/g, "");
    }
    try {
      onIncoming(msg);
    } catch (e) {
      console.error("onIncoming:", e);
    }
  }
});

// ---------- Панель оператора ----------

function adminAuth(req, res, next) {
  if (!config.adminPassword) return res.status(503).send("Задайте ADMIN_PASSWORD в .env");
  const [scheme, encoded] = (req.get("authorization") ?? "").split(" ");
  const [user, pass] = Buffer.from(encoded ?? "", "base64").toString().split(":");
  const ok =
    scheme === "Basic" &&
    user === "admin" &&
    pass?.length === config.adminPassword.length &&
    crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(config.adminPassword));
  if (ok) return next();
  res.set("WWW-Authenticate", 'Basic realm="operator"').sendStatus(401);
}

const admin = express.Router();
admin.use(adminAuth, express.json({ limit: "2mb" }));
admin.get("/", (_req, res) => res.sendFile(path.join(ROOT, "public", "admin.html")));
admin.get("/api/chats", (_req, res) => res.json(db.listChats()));
admin.get("/api/chats/:id", (req, res) => {
  const chat = db.getChat(req.params.id);
  if (!chat) return res.sendStatus(404);
  res.json({ chat, messages: db.getMessages(req.params.id) });
});
admin.post("/api/chats/:id/mode", (req, res) => {
  const mode = req.body?.mode === "human" ? "human" : "bot";
  db.setMode(req.params.id, mode, { reason: mode === "human" ? "Оператор перехватил диалог" : null, attention: false });
  db.addMessage(req.params.id, "system", mode === "human" ? "Оператор взял диалог" : "Диалог возвращён боту");
  res.json({ ok: true });
});
admin.post("/api/chats/:id/send", async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "Пустое сообщение" });
  try {
    await operatorSend(req.params.id, text);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
admin.get("/api/status", (_req, res) => {
  const s = settings.get();
  const web = config.wa.provider === "web";
  res.json({
    provider: config.wa.provider,
    dryRun: config.wa.dryRun,
    accounts: web
      ? settings.accounts().map((a) => ({ ...a, wa: config.wa.dryRun ? { status: "dry_run" } : waweb.accountState(a.id), usage: usageToday(a.id) }))
      : [{ id: "api", name: "Официальный API", wa: { status: "api" }, usage: usageToday("api") }],
    ai: {
      provider: s.aiProvider,
      anthropicKeySet: !!s.anthropicApiKey,
      openaiBaseUrl: s.openaiBaseUrl,
      openaiModel: s.openaiModel,
      openaiKeySet: !!s.openaiApiKey,
    },
    aiMock: config.ai.mock,
  });
});
admin.post("/api/settings", (req, res) => {
  const s = settings.update(req.body ?? {});
  res.json({ ok: true, dailyLimit: s.dailyLimit });
});
// ---------- База знаний (редактор в панели) ----------
function knowledgePath(rel) {
  const clean = String(rel ?? "");
  if (!/^([\w-]+\/)?[\w.-]+\.md$/.test(clean) || clean.includes("..")) return null;
  return path.join(config.knowledgeDir, clean);
}
admin.get("/api/knowledge", (_req, res) => {
  const out = [];
  const walk = (dir, prefix) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isFile() && e.name.endsWith(".md")) out.push(prefix + e.name);
      else if (e.isDirectory() && !prefix) walk(path.join(dir, e.name), `${e.name}/`);
    }
  };
  walk(config.knowledgeDir, "");
  res.json(out);
});
admin.get("/api/knowledge/file", (req, res) => {
  const p = knowledgePath(req.query.name);
  if (!p) return res.status(400).json({ error: "Недопустимое имя файла" });
  res.json({ name: req.query.name, text: fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "" });
});
admin.put("/api/knowledge/file", (req, res) => {
  const p = knowledgePath(req.body?.name);
  if (!p) return res.status(400).json({ error: "Недопустимое имя файла" });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, String(req.body?.text ?? ""));
  res.json({ ok: true });
});

// ---------- Программа для Windows: версия и обновления ----------
admin.get("/api/app", (_req, res) => {
  const d = globalThis.__desktop;
  res.json(d ? { desktop: true, ...d.state() } : { desktop: false, current: process.env.npm_package_version || null });
});
admin.post("/api/app/check", (_req, res) => {
  globalThis.__desktop?.check();
  res.json({ ok: true });
});
admin.post("/api/app/install", (_req, res) => {
  res.json({ ok: !!globalThis.__desktop?.install() });
});

admin.get("/api/metrics", (_req, res) => res.json(metrics()));
admin.post("/api/metrics/reset", (_req, res) => {
  resetMetrics();
  res.json({ ok: true });
});

// ---------- Номера (режим QR) ----------
admin.post("/api/accounts", (req, res) => {
  if (config.wa.provider !== "web") return res.status(400).json({ error: "Несколько номеров доступны только в режиме QR (WA_PROVIDER=web)" });
  const acc = settings.addAccount(req.body?.name);
  if (!config.wa.dryRun) waweb.startAccount(acc.id);
  res.json(acc);
});
admin.post("/api/accounts/:id", (req, res) => {
  if (req.params.id === "api") {
    settings.update({ dailyLimit: req.body?.dailyLimit });
    return res.json({ ok: true });
  }
  const acc = settings.updateAccount(req.params.id, req.body ?? {});
  if (!acc) return res.sendStatus(404);
  res.json(acc);
});
admin.post("/api/accounts/:id/logout", async (req, res) => {
  try {
    await waweb.logout(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
admin.delete("/api/accounts/:id", async (req, res) => {
  if (!settings.account(req.params.id)) return res.sendStatus(404);
  await waweb.removeAccount(req.params.id);
  settings.removeAccount(req.params.id);
  res.json({ ok: true });
});
app.use("/admin", admin);

app.get("/health", (_req, res) => res.json({ ok: true }));

export const ready = new Promise((resolve) => app.listen(config.port, config.host, async () => {
  console.log(`Сервер запущен на порту ${config.port}`);
  if (config.ngrok.authtoken) await startNgrok();
  if (config.wa.provider === "web") {
    if (!settings.accounts().length) settings.addAccount("Основной номер", "main");
    if (!config.wa.dryRun) {
      waweb.init(onIncoming);
      for (const a of settings.accounts()) waweb.startAccount(a.id);
    }
    console.log(`Откройте http://localhost:${config.port}/admin и отсканируйте QR-код телефоном`);
  }
  console.log(`Вебхук: /webhook   Панель оператора: /admin   Провайдер: ${config.wa.provider}${config.wa.dryRun ? " (DRY RUN)" : ""}`);
  if (config.ai.mock) console.log("ИИ: заглушка (AI_MOCK=true)");
  resolve();
}));

/** Публичный HTTPS-адрес через ngrok, чтобы вебхук работал без своего домена и сервера. */
async function startNgrok() {
  try {
    const ngrok = await import("@ngrok/ngrok");
    const listener = await ngrok.forward({
      addr: config.port,
      authtoken: config.ngrok.authtoken,
      ...(config.ngrok.domain ? { domain: config.ngrok.domain } : {}),
    });
    const url = listener.url();
    const key = config.wa.webhookKey ? `?key=${encodeURIComponent(config.wa.webhookKey)}` : "";
    console.log(`ngrok: ${url}`);
    console.log(`Адрес вебхука для кабинета партнёра: ${url}/webhook${key}`);
    console.log(`Панель оператора: ${url}/admin`);
    if (!config.ngrok.domain) {
      console.log("Внимание: без NGROK_DOMAIN адрес меняется при каждом запуске, и вебхук придётся обновлять у партнёра.");
    }
  } catch (e) {
    console.error("Не удалось запустить ngrok:", e.message);
  }
}
