import type { IncomingMessage, ServerResponse } from "node:http";
import { ensureSchema, recordUpdate } from "../src/db.js";
import { answerCallback, deleteMessage } from "../src/telegram.js";
import { retryProvision, showInstance, showTemplate, showTemplates, start, submitToken } from "../src/factory.js";

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

type TelegramUpdate = {
  update_id?: number;
  message?: { message_id: number; chat?: { id?: number; type?: string }; from?: { id: number; username?: string; first_name?: string; is_bot?: boolean }; text?: string };
  callback_query?: { id: string; data?: string; from: { id: number; username?: string; first_name?: string; is_bot?: boolean }; message?: { chat?: { id?: number } } };
};

export default async function handler(req: IncomingMessage & { body?: TelegramUpdate }, res: ServerResponse) {
  if (req.method !== "POST") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || req.headers["x-telegram-bot-api-secret-token"] !== secret) { res.statusCode = 401; res.end("Unauthorized"); return; }
  try {
    await ensureSchema();
    const update = req.body ?? await readBody(req);
    if (!Number.isSafeInteger(update.update_id) || !(await recordUpdate(update.update_id!))) {
      res.statusCode = 200; res.end("OK"); return;
    }
    const token = process.env.FACTORY_BOT_TOKEN;
    if (!token) throw new Error("factory_bot_token_not_configured");

    if (update.message?.chat?.id && update.message.from && update.message.chat.type === "private") {
      const user = update.message.from;
      const chatId = update.message.chat.id;
      if (update.message.text === "/start") await start(user, chatId);
      else if (update.message.text === "/templates") await showTemplates(user, chatId);
      else if (update.message.text && !update.message.text.startsWith("/")) {
        // Remove the submitted credential from chat history immediately after processing.
        try { await deleteMessage(token, chatId, update.message.message_id); } catch {
          console.warn("factory_token_message_delete_failed", { updateId: update.update_id });
        }
        await submitToken(user, chatId, update.message.text);
      }
    }
    if (update.callback_query) {
      const q = update.callback_query;
      const chatId = q.message?.chat?.id;
      if (chatId) {
        await answerCallback(token, q.id);
        if (q.data === "templates") await showTemplates(q.from, chatId);
        else if (q.data === "check_subscription") await start(q.from, chatId);
        else if (q.data === "cancel_creation") {
          const { sql } = await import("../src/db.js");
          await sql`DELETE FROM factory_pending_actions WHERE telegram_user_id=${q.from.id}`;
          await showTemplates(q.from, chatId);
        } else if (q.data?.startsWith("template:")) await showTemplate(q.from, chatId, q.data.slice(9));
        else if (q.data?.startsWith("instance:")) await showInstance(q.from, chatId, q.data.slice(9));
        else if (q.data?.startsWith("retry:")) await retryProvision(q.from, chatId, q.data.slice(6));
      }
    }
    res.statusCode = 200; res.end("OK");
  } catch (error) {
    // Do not log request bodies, bot tokens, Telegram API URLs, or raw exception messages.
    console.error("factory_webhook_failed", { errorType: error instanceof Error ? error.name : "unknown" });
    res.statusCode = 200; res.end("OK");
  }
}

async function readBody(req: IncomingMessage): Promise<TelegramUpdate> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > 1024 * 1024) throw new Error("request_body_too_large");
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as TelegramUpdate;
}
