import { isAllowedChannelMember } from "./subscription.js";

const API = "https://api.telegram.org";

export type TelegramUser = { id: number; username?: string; first_name?: string; is_bot?: boolean };
export type InlineButton = { text: string; callback_data?: string; url?: string };
export type TelegramMessage = { message_id: number };

async function call<T>(token: string, method: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12_000),
  });
  const json = await response.json() as { ok: boolean; result?: T; description?: string };
  if (!response.ok || !json.ok) throw new Error(`telegram_${method}_failed_${response.status}`);
  return json.result as T;
}

export async function getBotIdentity(token: string): Promise<TelegramUser> {
  return call<TelegramUser>(token, "getMe", {});
}

export async function getChannelMembership(token: string, channel: string, userId: number): Promise<boolean> {
  const member = await call<{ status: string; is_member?: boolean }>(token, "getChatMember", { chat_id: channel, user_id: userId });
  return isAllowedChannelMember(member);
}

export async function sendMessage(token: string, chatId: number, text: string, keyboard?: InlineButton[][]): Promise<TelegramMessage> {
  return call<TelegramMessage>(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

export async function editMessageText(token: string, chatId: number, messageId: number, text: string, keyboard?: InlineButton[][]): Promise<void> {
  await call(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

export async function deleteMessage(token: string, chatId: number, messageId: number): Promise<void> {
  await call(token, "deleteMessage", { chat_id: chatId, message_id: messageId });
}

export async function answerCallback(token: string, callbackId: string, text?: string): Promise<void> {
  await call(token, "answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) });
}
