// Optional one-time OAuth setup for the edit-request intake sender.
//
// DISABLED unless INTAKE_SETUP_ENABLED="true". When disabled, both setup
// routes return 404 and nothing in this module runs. This flow exists so the
// owner can authorize the Gmail sender once through Google's consent screen
// instead of handling the refresh token by hand. It never enables the intake
// itself: EDIT_INTAKE_EMAIL_ENABLED and EDIT_INTAKE_ACTIVATED_AFTER remain
// the operator's separate, explicit decisions (see docs/EDIT_INTAKE.md).
//
// Security model:
// - Starting the flow requires a bearer owner token (INTAKE_SETUP_OWNER_TOKEN,
//   at least 32 random bytes). Without it, nobody can begin a consent flow.
// - The OAuth state parameter is generated server-side, stored hashed-at-rest
//   in factory_intake_setup_states, valid for 10 minutes, and consumed
//   atomically on first use. A callback without a fresh, unconsumed state
//   fails; a replayed callback fails because the state is already consumed.
// - The authorization code is exchanged exactly once, server-side, against
//   https://oauth2.googleapis.com/token. The code, access token and refresh
//   token are never logged, rendered, or returned to the browser.
// - The refresh token is stored only AES-256-GCM-encrypted (the same
//   TOKEN_ENCRYPTION_KEY scheme as bot tokens in src/security.ts) in the
//   singleton row of factory_intake_sender_auth. The sender reads it only when
//   GOOGLE_INTAKE_AUTH_SOURCE=database and the intake is separately enabled.
// - The granted scope is recorded as returned by Google so a later review can
//   confirm the authorization never exceeded gmail.send.
//
// Re-running the flow replaces the stored token (owner re-consent recovery).
// After a successful setup the route should be disabled again by unsetting
// INTAKE_SETUP_ENABLED.

import { createHash, timingSafeEqual, randomBytes } from "node:crypto";

type Query = (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>;
type Fetcher = typeof fetch;


const EXCHANGE_TIMEOUT_MS = 8_000;
export const INTAKE_SETUP_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export type IntakeSetupConfig = {
  ownerToken: string;
  clientId: string;
  clientSecret: string;
  sender: string;
  redirectUri: string;
};

export function intakeSetupConfigFromEnv(env: NodeJS.ProcessEnv = process.env): IntakeSetupConfig | null {
  const flag = (env.INTAKE_SETUP_ENABLED ?? "").trim().toLowerCase();
  if (flag !== "true" && flag !== "1") return null;
  const ownerToken = (env.INTAKE_SETUP_OWNER_TOKEN ?? "").trim();
  const clientId = (env.GOOGLE_INTAKE_CLIENT_ID ?? "").trim();
  const clientSecret = (env.GOOGLE_INTAKE_CLIENT_SECRET ?? "").trim();
  const sender = (env.GOOGLE_INTAKE_SENDER ?? "").trim();
  const baseUrl = (env.PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (ownerToken.length < 32 || !clientId || !clientSecret || !sender || !validOrigin(baseUrl) || !/^[a-f0-9]{64}$/i.test(env.TOKEN_ENCRYPTION_KEY ?? "")) {
    console.warn("factory_intake_setup_config_incomplete");
    return null;
  }
  return { ownerToken, clientId, clientSecret, sender, redirectUri: `${baseUrl}/api/intake-setup/callback` };
}

export async function ensureIntakeSetupSchema(db: Query): Promise<void> {
  await db`
    CREATE TABLE IF NOT EXISTS factory_intake_setup_states (
      state TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      consumed_at TIMESTAMPTZ
    )
  `;
  await db`
    CREATE TABLE IF NOT EXISTS factory_intake_sender_auth (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      sender TEXT NOT NULL,
      encrypted_refresh_token TEXT NOT NULL,
      granted_scope TEXT NOT NULL,
      authorized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

// Creates a fresh single-use state. The caller redirects the owner's browser
// to Google with it; only this server can validate it later, which binds the
// callback to a flow the owner actually started here (CSRF protection).
export async function createSetupState(db: Query): Promise<string> {
  const state = randomBytes(32).toString("hex");
  await db`INSERT INTO factory_intake_setup_states(state) VALUES (${hashState(state)})`;
  return state;
}

// Atomically consumes a state: true exactly once for a fresh state, false for
// unknown, expired, or already-used states (replay-safe). The interval bound
// is part of the consuming UPDATE so the check-and-consume is one statement.
export async function consumeSetupState(db: Query, state: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(state)) return false;
  const rows = await db`
    UPDATE factory_intake_setup_states
    SET consumed_at = NOW()
    WHERE state = ${hashState(state)}
      AND consumed_at IS NULL
      AND created_at > NOW() - INTERVAL '10 minutes'
    RETURNING state
  `;
  return rows.length === 1;
}

export function buildConsentUrl(config: IntakeSetupConfig, state: string, verifier: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: INTAKE_SETUP_SCOPE,
    access_type: "offline",
    // Request consent for offline access. Missing refresh tokens still fail closed.
    prompt: "consent",
    state,
    code_challenge: hashState(verifier),
    code_challenge_method: "S256",
    login_hint: config.sender,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export type ExchangeResult = { refreshToken: string; grantedScope: string };

// Exchanges the authorization code exactly once. Throws typed errors; the
// caller maps them to a generic failure response. Token material never
// appears in error messages or logs.
export async function exchangeCodeForTokens(config: IntakeSetupConfig, code: string, verifier: string, fetcher: Fetcher = fetch): Promise<ExchangeResult> {
  if (!/^[a-f0-9]{64}$/.test(verifier)) throw new Error("invalid_verifier");
  if (!code || code.length > 512 || /[\r\n]/.test(code)) throw new Error("invalid_code");
  const response = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri,
    }).toString(),
    signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`token_exchange_http_${response.status}`);
  const payload = (await response.json()) as { refresh_token?: string; scope?: string };
  if (!payload.refresh_token) throw new Error("token_exchange_no_refresh_token");
  if (payload.scope !== INTAKE_SETUP_SCOPE) throw new Error("token_exchange_scope_rejected");
  return { refreshToken: payload.refresh_token, grantedScope: payload.scope };
}

// Stores the encrypted refresh token in the singleton row. encrypt is
// src/security.ts's encryptToken, injected so this module stays testable and
// never touches the raw key itself.
export async function storeSenderAuth(
  db: Query,
  entry: { sender: string; encryptedRefreshToken: string; grantedScope: string },
): Promise<void> {
  await db`
    INSERT INTO factory_intake_sender_auth(id, sender, encrypted_refresh_token, granted_scope)
    VALUES (1, ${entry.sender}, ${entry.encryptedRefreshToken}, ${entry.grantedScope})
    ON CONFLICT (id) DO UPDATE SET
      sender = EXCLUDED.sender,
      encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
      granted_scope = EXCLUDED.granted_scope,
      updated_at = NOW()
  `;
}

export function validOrigin(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && u.origin === value;
  } catch { return false; }
}
export function hashState(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
export const SETUP_COOKIE = "__Secure-intake_setup";
export function setupCookie(state: string, verifier: string): string {
  return `${SETUP_COOKIE}=${state}.${verifier}; HttpOnly; Secure; SameSite=Lax; Path=/api/intake-setup; Max-Age=600`;
}
export function clearSetupCookie(): string {
  return `${SETUP_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/api/intake-setup; Max-Age=0`;
}
export function browserVerifier(cookie: string, state: string): string | null {
  const values = cookie.split(";").map(s => s.trim()).filter(s => s.startsWith(`${SETUP_COOKIE}=`));
  if (values.length !== 1 || !/^[a-f0-9]{64}$/.test(state)) return null;
  const parts = values[0].slice(SETUP_COOKIE.length + 1).split(".");
  if (parts.length !== 2 || !parts.every(p => /^[a-f0-9]{64}$/.test(p))) return null;
  return timingSafeEqual(Buffer.from(parts[0]), Buffer.from(state)) ? parts[1] : null;
}
export async function loadSenderRefreshToken(db: Query, sender: string, decrypt: (v: string) => string): Promise<string> {
  const rows = await db`SELECT sender, encrypted_refresh_token, granted_scope FROM factory_intake_sender_auth WHERE id = 1`;
  if (rows.length !== 1 || rows[0].sender !== sender || rows[0].granted_scope !== INTAKE_SETUP_SCOPE) throw new Error("sender_auth_invalid");
  const token = decrypt(String(rows[0].encrypted_refresh_token));
  if (!token) throw new Error("sender_auth_invalid");
  return token;
}
