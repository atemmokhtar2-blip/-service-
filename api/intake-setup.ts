import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { sql } from "../src/db.js";
import { intakeSetupConfigFromEnv, ensureIntakeSetupSchema, createSetupState, buildConsentUrl } from "../src/intake-setup.js";

// Starts the one-time OAuth setup for the edit-request intake sender.
//
// DISABLED unless INTAKE_SETUP_ENABLED="true": the route answers 404, the same
// as if it did not exist. When enabled it still does nothing unless the caller
// presents the owner bearer token (INTAKE_SETUP_OWNER_TOKEN): the setup is the
// owner's action alone. On success it 302-redirects the owner's browser to
// Google's consent screen with a fresh single-use server-side state. The
// callback (api/intake-setup/callback.ts) completes the exchange.
//
// This route never enables the intake itself and never touches customer
// traffic; see docs/EDIT_INTAKE_SETUP.md.
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
  const config = intakeSetupConfigFromEnv();
  if (!config) { res.statusCode = 404; res.end("Not Found"); return; }
  const presented = req.headers["authorization"] ?? "";
  const expected = `Bearer ${config.ownerToken}`;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.statusCode = 401; res.end("Unauthorized"); return;
  }
  try {
    await ensureIntakeSetupSchema(sql);
    const state = await createSetupState(sql);
    res.statusCode = 302;
    res.setHeader("location", buildConsentUrl(config, state));
    res.setHeader("cache-control", "no-store");
    res.end();
  } catch (error) {
    console.error("factory_intake_setup_start_failed", { errorType: error instanceof Error ? error.name : "unknown" });
    res.statusCode = 500; res.end("Temporary failure");
  }
}
