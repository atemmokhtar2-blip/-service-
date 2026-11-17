import { randomUUID } from "node:crypto";

const token = process.env.FACTORY_BOT_TOKEN ?? "";
const baseUrl = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

if (!token || !baseUrl || !secret) {
  throw new Error("FACTORY_BOT_TOKEN, PUBLIC_BASE_URL, and TELEGRAM_WEBHOOK_SECRET are required");
}
if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
  throw new Error("TELEGRAM_WEBHOOK_SECRET must contain only Telegram-supported characters");
}

const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: `${baseUrl}/api/webhook`,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  }),
  signal: AbortSignal.timeout(15000),
});
const result = await response.json() as { ok: boolean; description?: string };
if (!response.ok || !result.ok) {
  throw new Error(`Telegram setWebhook failed: ${response.status}`);
}
process.stdout.write("Factory Telegram webhook registered.\n");
