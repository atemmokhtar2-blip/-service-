import type { IncomingMessage, ServerResponse } from "node:http";
import { sql } from "../src/db.js";
import { intakeConfigFromEnv, ensureEditIntakeSchema, processEditIntakeOutbox } from "../src/edit-intake.js";
import { processGitHubEditOutboxSafely } from "../src/github-edit-intake.js";

// Scheduled reconciliation for the edit-request intake outbox. This bounds
// the delay of pending sends when the factory sees no Telegram traffic: the
// cron keeps retrying even when no webhook call happens. Vercel calls this
// route with Authorization: Bearer $CRON_SECRET; the route fails closed when
// CRON_SECRET is unset. It is a no-op unless the intake feature is enabled.
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers["authorization"] !== `Bearer ${secret}`) {
    res.statusCode = 401; res.end("Unauthorized"); return;
  }
  const config = intakeConfigFromEnv();
  try {
    let email = { sent: 0, failed: 0 };
    if (config) {
      await ensureEditIntakeSchema(sql);
      email = await processEditIntakeOutbox(sql, config, undefined, 10_000);
    }
    await processGitHubEditOutboxSafely(sql, 15_000, 2);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ email, github: "processed" }));
  } catch (error) {
    console.error("factory_edit_intake_cron_failed", { errorType: error instanceof Error ? error.name : "unknown" });
    res.statusCode = 500; res.end("Temporary failure");
  }
}
