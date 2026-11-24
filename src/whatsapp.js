import crypto from "node:crypto";
import * as log from "./log.js";
import { config } from "./config.js";
import * as waweb from "./waweb.js";

const wa = config.wa;

/** Куда и с каким заголовком отправлять сообщения, в зависимости от провайдера. */
function endpoint() {
  switch (wa.provider) {
    case "meta":
      return {
        url: `https://graph.facebook.com/${wa.metaApiVersion}/${wa.metaPhoneNumberId}/messages`,
        headers: { Authorization: `Bearer ${wa.metaToken}` },
      };
    case "360dialog":
      return {
        url: "https://waba-v2.360dialog.io/messages",
        headers: { "D360-API-KEY": wa.d360ApiKey },
      };
    case "custom":
      return {
        url: wa.customSendUrl,
        headers: { [wa.customAuthHeader]: wa.customAuthValue },
      };
    default:
      throw new Error(`Неизвестный WA_PROVIDER: ${wa.provider}`);
  }
}

async function post(body) {
  if (wa.dryRun) {
    // В консоль полный текст (для отладки), в журнал без текста переписки
    process.stdout.write(`[WA_DRY_RUN] → ${JSON.stringify(body)}\n`);
    if (body.to) log.info("message", `Тестовый режим: отправка ${log.maskPhone(body.to)} не выполняется`);
    return { dryRun: true };
  }
  const { url, headers } = endpoint();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`WhatsApp API ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

/** В режиме QR идентификатор чата имеет вид «id номера|jid клиента». */
export function splitChatId(chatId) {
  const i = chatId.indexOf("|");
  return i < 0 ? { account: "api", to: chatId } : { account: chatId.slice(0, i), to: chatId.slice(i + 1) };
}

/** quote: {id, text} — входящее сообщение клиента, на которое отвечаем цитатой. */
export function sendText(chatId, text, quote = null) {
  if (wa.provider === "web") {
    const { account, to } = splitChatId(chatId);
    return wa.dryRun ? post({ account, to, text: { body: text }, ...(quote?.id ? { context: { message_id: quote.id } } : {}) }) : waweb.sendText(account, to, text, quote);
  }
  const to = chatId;
  return post({ recipient_type: "individual", to, type: "text", text: { body: text, preview_url: false }, ...(quote?.id ? { context: { message_id: quote.id } } : {}) });
}

/** Синие галочки: клиент видит, что сообщение прочитано. */
export function markRead(messageId, chatId) {
  if (wa.provider === "web") {
    const { account, to } = splitChatId(chatId);
    return wa.dryRun ? Promise.resolve() : waweb.markRead(account, to);
  }
  return post({ status: "read", message_id: messageId }).catch((e) => log.warn("whatsapp", `Не удалось отметить сообщение прочитанным: ${e.message}`));
}

/** Проверка подписи X-Hub-Signature-256 (Meta). Без секрета приложения проверка пропускается. */
export function verifySignature(rawBody, signatureHeader) {
  if (!wa.metaAppSecret) return true;
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", wa.metaAppSecret).update(rawBody).digest("hex");
  const got = signatureHeader.slice(7);
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

/**
 * Достаёт входящие сообщения из вебхука в формате Cloud API
 * (так присылают Meta, 360dialog и большинство официальных партнёров).
 */
export function parseWebhook(payload) {
  const out = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const names = Object.fromEntries((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of value.messages ?? []) {
        out.push({ id: m.id, from: m.from, name: names[m.from], type: m.type, text: extractText(m) });
      }
    }
  }
  return out;
}

function extractText(m) {
  switch (m.type) {
    case "text":
      return m.text?.body ?? "";
    case "button":
      return m.button?.text ?? "";
    case "interactive":
      return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "";
    case "image":
    case "video":
    case "document":
      return `[клиент прислал файл: ${m.type}${m[m.type]?.caption ? `, подпись: ${m[m.type].caption}` : ""}]`;
    case "audio":
      return "[клиент прислал голосовое сообщение]";
    case "location":
      return "[клиент прислал геолокацию]";
    case "sticker":
      return "[стикер]";
    default:
      return `[сообщение типа ${m.type}]`;
  }
}
