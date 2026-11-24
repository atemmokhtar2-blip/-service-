import type { IncomingMessage, ServerResponse } from "node:http";
import { encryptToken } from "./security.ts";
import { intakeSetupConfigFromEnv, ensureIntakeSetupSchema, consumeSetupState, exchangeCodeForTokens, storeSenderAuth, browserVerifier, clearSetupCookie } from "./intake-setup.ts";

// Completes the one-time OAuth setup for the edit-request intake sender.
// This is the redirect URI registered on the Google client
// (https://<deployment>/api/intake-setup/callback).
//
// DISABLED unless INTAKE_SETUP_ENABLED="true" (404 otherwise). The callback
// only proceeds with a state that this server issued, that is unconsumed, and
// that is younger than 10 minutes; consuming it is atomic, so a replayed or
// guessed callback fails. The authorization code is exchanged once,
// server-side; code and tokens are never logged or rendered. The refresh
// token is stored AES-256-GCM-encrypted in factory_intake_sender_auth; the
// intake reads it only with the explicit database auth selector and its
// separate feature enablement, neither of which this callback changes.
// Success and failure pages carry no details beyond a plain outcome.
export function createSetupCallbackHandler(sql: (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>, env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch) {
return async function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("cache-control", "no-store");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
  const config = intakeSetupConfigFromEnv(env);
  if (!config) { res.statusCode = 404; res.end("Not Found"); return; }
  let params: URLSearchParams;
  try {
    params = new URL(req.url ?? "", "https://invalid.local").searchParams;
  } catch {
    res.statusCode = 400; res.end("Bad Request"); return;
  }
  const state = params.get("state") ?? "";
  const code = params.get("code") ?? "";
  const oauthError = params.get("error");
  const verifier = browserVerifier(req.headers.cookie ?? "", state);
  if (!verifier || ["state", "code", "error"].some(k => params.getAll(k).length > 1)) {
    res.statusCode = 400; res.end("Invalid setup callback"); return;
  }
  res.setHeader("set-cookie", clearSetupCookie());
  try {
    await ensureIntakeSetupSchema(sql);
    // Consume the state even on an OAuth error redirect so a denied or
    // malformed callback can never be retried with a fresh code later.
    if (!(await consumeSetupState(sql, state))) {
      res.statusCode = 400; res.end("Invalid or expired setup state"); return;
    }
    if (oauthError || !code) {
      res.statusCode = 400; res.end("Authorization not completed"); return;
    }
    const tokens = await exchangeCodeForTokens(config, code, verifier, fetcher);
    await storeSenderAuth(sql, {
      sender: config.sender,
      encryptedRefreshToken: encryptToken(tokens.refreshToken),
      grantedScope: tokens.grantedScope,
    });
    res.statusCode = 200;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end("Sender authorization stored. The intake remains disabled until the operator enables it separately. You can close this tab.");
  } catch (error) {
    // Token material is never included in logs: only the error name.
    console.error("factory_intake_setup_callback_failed", { errorType: error instanceof Error ? error.name : "unknown" });
    res.statusCode = 500; res.end("Temporary failure");
  }
}

}
