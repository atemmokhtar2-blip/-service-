import type { IncomingMessage, ServerResponse } from "node:http";
import { ensureSchema, markUpdateDone, markUpdateFailed, recordUpdate, sql } from "../src/db.js";
import { answerCallback, deleteMessage, sendMessage } from "../src/telegram.js";
import { confirmDeleteBot, deleteBotFromFactory, retryProvision, showInstance, showMyBots, showTemplate, showTemplates, start, submitToken } from "../src/factory.js";
import { cancelEditRequest, captureEditText, confirmEditRequest, ensureEditSchema, handleAdminEditAction, hasEditDraft, showEditPurchaseInfo, showManagedInstance, startEditRequest, grantPaidCredits } from "../src/edits.js";

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

type TelegramUpdate = {
  update_id?: number;
  message?: { message_id: number; chat?: { id?: number; type?: string }; from?: { id: number; username?: string; first_name?: string; is_bot?: boolean }; text?: string };
  callback_query?: { id: string; data?: string; from: { id: number; username?: string; first_name?: string; is_bot?: boolean }; message?: { message_id: number; chat?: { id?: number } } };
};

export default async function handler(req: IncomingMessage & { body?: TelegramUpdate }, res: ServerResponse) {
  let claimedUpdateId: number | null = null;
  if (req.method !== "POST") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || req.headers["x-telegram-bot-api-secret-token"] !== secret) { res.statusCode = 401; res.end("Unauthorized"); return; }
  try {
    await ensureSchema();
    await ensureEditSchema();
    const update = req.body ?? await readBody(req);
    if (!Number.isSafeInteger(update.update_id)) {
      res.statusCode = 400; res.end("Invalid update"); return;
    }
    claimedUpdateId = update.update_id!;
    if (!(await recordUpdate(claimedUpdateId))) {
      res.statusCode = 200; res.end("OK"); return;
    }
    const token = process.env.FACTORY_BOT_TOKEN;
    if (!token) throw new Error("factory_bot_token_not_configured");

    if (update.message?.chat?.id && update.message.from && update.message.chat.type === "private") {
      const user = update.message.from;
      const chatId = update.message.chat.id;
      if (update.message.text?.startsWith("/grant_edits ")) {
        const parts = update.message.text.trim().split(/\\s+/);
        const amount = Number(parts[2]);
        await grantPaidCredits(user, chatId, String(parts[1] ?? "").toUpperCase(), amount);
      }
      else if (update.message.text === "/start") await start(user, chatId);
      else if (update.message.text === "/templates") await showTemplates(user, chatId);
      else if (update.message.text && !update.message.text.startsWith("/")) {
        if (await hasEditDraft(user.id)) {
          const { requireMembership } = await import("../src/factory.js");
          if (await requireMembership(user, chatId)) await captureEditText(user, chatId, update.message.text);
        } else {
          const pending = await sql`SELECT template_key FROM factory_pending_actions WHERE telegram_user_id=${user.id} AND action='awaiting_token' LIMIT 1`;
          if (!pending.length) {
            await sendMessage(token, chatId, "اختار القالب الأول من القائمة، وبعدها ابعت توكن البوت.");
          } else {
            try {
              await deleteMessage(token, chatId, update.message.message_id);
            } catch {
              console.warn("factory_token_message_delete_failed", { updateId: update.update_id });
              await sendMessage(token, chatId,
                "تعذر حذف رسالة التوكن تلقائيًا، لذلك لم نستخدم التوكن. احذف الرسالة يدويًا، وأصدر توكنًا جديدًا من BotFather ثم أعد المحاولة.");
              await markUpdateDone(claimedUpdateId);
              res.statusCode = 200; res.end("OK"); return;
            }
            const templateKey = String(pending[0].template_key);
            await submitToken(user, chatId, update.message.text);
            const saved = await sql`SELECT menu_message_id FROM factory_users WHERE telegram_user_id=${user.id} LIMIT 1`;
            const instance = await sql`SELECT id FROM factory_instances WHERE owner_telegram_id=${user.id} AND template_key=${templateKey} LIMIT 1`;
            if (instance.length) await showManagedInstance(user, chatId, templateKey, saved[0]?.menu_message_id ? Number(saved[0].menu_message_id) : undefined);
          }
        }
      }
    }
    if (update.callback_query) {
      const q = update.callback_query;
      const chatId = q.message?.chat?.id;
      if (chatId) {
        await answerCallback(token, q.id);
        if (q.data === "templates" || q.data === "create_bot") await showTemplates(q.from, chatId, q.message?.message_id);
        else if (q.data === "my_bots") await showMyBots(q.from, chatId, q.message?.message_id);
        else if (q.data === "main_menu") await start(q.from, chatId, q.message?.message_id);
        else if (q.data === "check_subscription") await start(q.from, chatId, q.message?.message_id);
        else if (q.data === "cancel_creation") {
          await sql`DELETE FROM factory_pending_actions WHERE telegram_user_id=${q.from.id}`;
          await showTemplates(q.from, chatId, q.message?.message_id);
        } else if (q.data?.startsWith("template:")) await showTemplate(q.from, chatId, q.data.slice(9), q.message?.message_id);
        else if (q.data?.startsWith("instance:")) await showManagedInstance(q.from, chatId, q.data.slice(9), q.message?.message_id);
        else if (q.data?.startsWith("retry:")) {
          const key = q.data.slice(6);
          await retryProvision(q.from, chatId, key, q.message?.message_id);
          await showManagedInstance(q.from, chatId, key, q.message?.message_id);
        }
        else if (q.data?.startsWith("edit_start:")) await startEditRequest(q.from, chatId, q.data.slice(11));
        else if (q.data === "edit_confirm") await confirmEditRequest(q.from, chatId);
        else if (q.data === "edit_cancel") await cancelEditRequest(q.from, chatId);
        else if (q.data?.startsWith("edit_buy:")) await showEditPurchaseInfo(q.from, chatId, q.data.slice(9));
        else if (q.data?.startsWith("edit_admin:")) {
          const parts = q.data.split(":");
          if (parts.length === 3) await handleAdminEditAction(q.from, chatId, parts[1], parts[2]);
        }
        else if (q.data?.startsWith("delete_bot:")) await confirmDeleteBot(q.from, chatId, q.data.slice(11), q.message?.message_id);
        else if (q.data?.startsWith("delete_confirm:")) await deleteBotFromFactory(q.from, chatId, q.data.slice(15), q.message?.message_id);
        else if (q.data?.startsWith("delete_cancel:")) {
          const key = q.data.slice(14);
          await showManagedInstance(q.from, chatId, key, q.message?.message_id);
        }
      }
    }
    await markUpdateDone(claimedUpdateId);
    res.statusCode = 200; res.end("OK");
  } catch (error) {
    if (claimedUpdateId !== null) {
      try { await markUpdateFailed(claimedUpdateId); } catch { /* Telegram retry remains the recovery path. */ }
    }
    console.error("factory_webhook_failed", { errorType: error instanceof Error ? error.name : "unknown" });
    res.statusCode = 500; res.end("Temporary failure");
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
