import * as db from "./db.js";
import * as wa from "./whatsapp.js";
import { generateReply } from "./ai.js";
import { config } from "./config.js";
import * as settings from "./settings.js";
import * as log from "./log.js";

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Сколько ответов бота отправлено сегодня с этого номера и какой у него лимит. */
export function usageToday(accountId = "api") {
  if (accountId === "loadtest") return { sent: db.countBotRepliesSince(startOfToday(), accountId), limit: 0 }; // тестовые чаты без лимита
  const limit = accountId === "api" ? settings.get().dailyLimit : settings.account(accountId)?.dailyLimit ?? settings.get().dailyLimit;
  return { sent: db.countBotRepliesSince(startOfToday(), accountId), limit };
}

const timers = new Map(); // wa_id → таймер ответа
const busy = new Set(); // wa_id, для которых сейчас идёт генерация
const again = new Set(); // пришли новые сообщения во время генерации

/** Вызывается на каждое входящее сообщение клиента. */
export function onIncoming(msg) {
  const account = msg.account ?? "api";
  const chatId = msg.account ? `${msg.account}|${msg.from}` : msg.from;
  db.upsertChat(chatId, msg.name, account);
  const isNew = db.addMessage(chatId, "customer", msg.text, msg.id);
  if (!isNew) return; // повторная доставка вебхука
  log.info("message", `Входящее от ${log.maskPhone(chatId)} (${msg.text.length} симв.), номер «${account}»`);
  wa.markRead(msg.id, chatId);
  schedule(chatId);
}

function schedule(waId) {
  clearTimeout(timers.get(waId));
  timers.set(
    waId,
    setTimeout(() => {
      timers.delete(waId);
      respond(waId).catch((e) => log.error("bot", `Сбой обработки ${log.maskPhone(waId)}: ${e.stack || e.message}`));
    }, config.debounceMs)
  );
}

function botMayAnswer(chat) {
  if (chat.mode !== "bot") return false;
  // Оператор недавно писал в этот чат: не перебиваем его
  if (chat.last_human_at && Date.now() - chat.last_human_at < config.humanPauseMs) return false;
  return true;
}

async function respond(waId) {
  if (busy.has(waId)) {
    again.add(waId);
    return;
  }
  const chat = db.getChat(waId);
  if (!chat) return;
  if (!botMayAnswer(chat)) {
    db.markAttention(waId); // клиент ждёт ответа оператора
    log.info("message", `${log.maskPhone(waId)}: диалог у оператора, бот молчит`);
    return;
  }

  const { sent, limit } = usageToday(chat.account_id);
  if (limit > 0 && sent >= limit) {
    // Лимит на сегодня исчерпан: бот молчит, диалог ждёт оператора
    // Завтра бот снова начнёт отвечать сам
    db.markAttention(waId);
    const note = `Дневной лимит ответов бота (${limit}) исчерпан, клиент ждёт оператора`;
    if (db.getMessages(waId, 1).at(-1)?.text !== note) db.addMessage(waId, "system", note);
    log.warn("limit", `Лимит ${sent}/${limit} на номере «${chat.account_id}» исчерпан: ${log.maskPhone(waId)} ждёт оператора`);
    return;
  }

  busy.add(waId);
  try {
    const history = db.getMessages(waId, config.ai.history + 10);
    if (history.findLast((m) => m.role !== "system")?.role !== "customer") return; // уже ответили
    const started = Date.now();
    const result = await generateReply(history, chat.account_id);
    if (!result) return;
    log.info("ai", `Ответ ИИ для ${log.maskPhone(waId)} за ${((Date.now() - started) / 1000).toFixed(1)} с${result.handoff ? ", с передачей оператору" : ""}`);

    // Пока модель думала, оператор мог перехватить чат
    const fresh = db.getChat(waId);
    if (!botMayAnswer(fresh)) {
      log.info("message", `${log.maskPhone(waId)}: оператор взял диалог, пока ИИ думал; ответ не отправлен`);
      return;
    }

    await wa.sendText(waId, result.reply);
    db.addMessage(waId, "bot", result.reply);
    log.info("message", `Ответ бота отправлен ${log.maskPhone(waId)} (${sent + 1}/${limit || "∞"} за сегодня)`);

    if (result.handoff) {
      db.setMode(waId, "human", { reason: result.handoff_reason || "Бот передал диалог" });
      db.addMessage(waId, "system", `Передано оператору: ${result.handoff_reason || "без причины"}`);
      log.info("message", `Передано оператору ${log.maskPhone(waId)}: ${result.handoff_reason || "без причины"}`);
    }
  } catch (e) {
    log.error("message", `Не удалось ответить ${log.maskPhone(waId)}: ${e.message}`);
    db.setMode(waId, "human", { reason: `Ошибка отправки: ${e.message.slice(0, 200)}` });
  } finally {
    busy.delete(waId);
    if (again.delete(waId)) schedule(waId);
  }
}

/**
 * Оператор вернул диалог боту: если последнее сообщение клиента осталось без ответа, бот отвечает на него сразу,
 * учитывая всю переписку, включая ответы оператора. Дальше бот отвечает как обычно.
 */
export function resumeBot(waId) {
  const last = db.getMessages(waId, 50).findLast((m) => m.role !== "system");
  if (last?.role === "customer") {
    log.info("message", `${log.maskPhone(waId)}: диалог возвращён боту, отвечаем на последнее сообщение клиента`);
    schedule(waId);
  }
}

/** Ответ оператора из панели. */
export async function operatorSend(waId, text) {
  // Писать можно только тем, кто сам написал первым: никаких рассылок
  if (!db.hasCustomerMessages(waId)) throw new Error("Клиент ещё не писал в этот чат");
  await wa.sendText(waId, text);
  db.addMessage(waId, "operator", text);
  log.info("message", `Оператор ответил ${log.maskPhone(waId)}`);
  db.clearAttention(waId);
}
