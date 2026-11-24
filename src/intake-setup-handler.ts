import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { intakeSetupConfigFromEnv, ensureIntakeSetupSchema, createSetupState, buildConsentUrl, setupCookie } from "./intake-setup.js";

const FORM_COOKIE = "__Secure-intake_form";
function same(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function formCookie(value: string, age: number): string {
  return `${FORM_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/api/intake-setup; Max-Age=${age}`;
}

export function createSetupStartHandler(db: (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>, env: NodeJS.ProcessEnv = process.env) {
  return async function handler(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const config = intakeSetupConfigFromEnv(env);
    if (!config) { res.statusCode = 404; res.end("Not Found"); return; }
    if (req.method !== "GET" && req.method !== "POST") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
    if (req.method === "GET") {
      const nonce = randomBytes(32).toString("hex");
      res.setHeader("set-cookie", formCookie(nonce, 600));
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.statusCode = 200;
      res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Sender authorization</title><h1>Authorize intake sender</h1><p>Enter the owner setup key. This does not enable request delivery.</p><form method="post" action="/api/intake-setup"><input type="hidden" name="nonce" value="${nonce}"><label>Owner setup key <input type="password" name="owner_token" required autocomplete="off" maxlength="512"></label><button type="submit">Continue to Google</button></form></html>`);
      return;
    }
    if (req.headers.origin !== new URL(config.redirectUri).origin || (req.headers["content-type"] ?? "").split(";")[0] !== "application/x-www-form-urlencoded") {
      res.statusCode = 403; res.end("Forbidden"); return;
    }
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 2048) { res.statusCode = 413; res.end("Too large"); return; }
      }
      const params = new URLSearchParams(body);
      const nonce = params.get("nonce") ?? "";
      const tokens = (req.headers.cookie ?? "").split(";").map(v => v.trim()).filter(v => v.startsWith(`${FORM_COOKIE}=`));
      if (params.getAll("nonce").length !== 1 || params.getAll("owner_token").length !== 1 || tokens.length !== 1 || !/^[a-f0-9]{64}$/.test(nonce) || !same(tokens[0].slice(FORM_COOKIE.length + 1), nonce) || !same(params.get("owner_token") ?? "", config.ownerToken)) {
        res.statusCode = 401; res.end("Unauthorized"); return;
      }
      await ensureIntakeSetupSchema(db);
      const state = await createSetupState(db);
      const verifier = randomBytes(32).toString("hex");
      res.setHeader("set-cookie", [formCookie("", 0), setupCookie(state, verifier)]);
      res.statusCode = 303;
      res.setHeader("location", buildConsentUrl(config, state, verifier));
      res.end();
    } catch (error) {
      console.error("factory_intake_setup_start_failed", { errorType: error instanceof Error ? error.name : "unknown" });
      res.statusCode = 500; res.end("Temporary failure");
    }
  };
}
