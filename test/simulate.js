// Имитирует входящее сообщение WhatsApp на локальный сервер.
// Использование: node test/simulate.js "текст" [номер] [имя]
const [text = "Здравствуйте, не работает интернет", from = "77010000001", name = "Тестовый клиент"] = process.argv.slice(2);
const port = process.env.PORT || 3000;
const key = process.env.WEBHOOK_KEY ? `?key=${encodeURIComponent(process.env.WEBHOOK_KEY)}` : "";

const payload = {
  object: "whatsapp_business_account",
  entry: [{
    id: "test",
    changes: [{
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        contacts: [{ wa_id: from, profile: { name } }],
        messages: [{ id: `wamid.test.${Date.now()}`, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
      },
    }],
  }],
};

const res = await fetch(`http://localhost:${port}/webhook${key}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
console.log("Вебхук ответил:", res.status);
