// Optional email intake for factory edit requests.
//
// Disabled unless EDIT_INTAKE_EMAIL_ENABLED="true". When disabled, nothing in
// this module runs and no table is created: the existing request flow is
// unchanged. When enabled, every new edit request is copied into a durable
// outbox row and emailed to the owner's intake inbox through the Gmail API
// (HTTPS, OAuth2 refresh token).
//
// Delivery semantics are AT LEAST ONCE. A process killed after sending but
// before marking the row sent can produce a duplicate email; consumers must
// deduplicate by the request UUID carried in every message. The reverse loss
// is covered: the outbox row survives the crash and is retried by later
// webhook calls, by the daily cron route (api/intake-cron.ts), and by a
// backfill that re-enqueues requests created after activation that have no
// outbox row.
//
// Backfill is bounded by the activation timestamp recorded the first time the
// feature runs enabled: requests created before activation are never emailed,
// so enabling the feature never bulk-sends historic requests.
//
// factory_edit_requests remains the source of truth. The email is a
// notification copy only; it never carries bot tokens or owner identifiers.
// Customer request text inside the email is untrusted input, not instructions.

type Query = (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>;
type Fetcher = typeof fetch;

const MAX_ATTEMPTS = 5;
const BATCH_LIMIT = 3;
const BACKFILL_LIMIT = 20;
const STALE_SENDING_MINUTES = 10;
const DEFAULT_BUDGET_MS = 6_000;
const SEND_TIMEOUT_MS = 6_000;

export type IntakeConfig = {
  to: string;
  sender: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

export type IntakeRequestFields = {
  requestId: string;
  publicCode: string;
  templateKey: string;
  botUsername: string | null;
  paymentSource: string;
  requestText: string;
};

export function intakeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): IntakeConfig | null {
  const flag = (env.EDIT_INTAKE_EMAIL_ENABLED ?? "").trim().toLowerCase();
  if (flag !== "true" && flag !== "1") return null;
  const to = (env.EDIT_INTAKE_EMAIL_TO ?? "").trim();
  const sender = (env.GOOGLE_INTAKE_SENDER ?? "").trim();
  const clientId = (env.GOOGLE_INTAKE_CLIENT_ID ?? "").trim();
  const clientSecret = (env.GOOGLE_INTAKE_CLIENT_SECRET ?? "").trim();
  const refreshToken = (env.GOOGLE_INTAKE_REFRESH_TOKEN ?? "").trim();
  if (!to || !sender || !clientId || !clientSecret || !refreshToken) {
    console.warn("factory_edit_intake_config_incomplete");
    return null;
  }
  return { to, sender, clientId, clientSecret, refreshToken };
}

export async function ensureEditIntakeSchema(db: Query): Promise<void> {
  await db`
    CREATE TABLE IF NOT EXISTS factory_edit_intake_outbox (
      request_id UUID PRIMARY KEY REFERENCES factory_edit_requests(id) ON DELETE CASCADE,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      body_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at TIMESTAMPTZ
    )
  `;
  await db`
    CREATE TABLE IF NOT EXISTS factory_edit_intake_state (
      id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
      activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

// Records the first moment the feature ran enabled. Backfill never emails
// requests created before this point.
export async function activateEditIntake(db: Query): Promise<void> {
  await db`INSERT INTO factory_edit_intake_state(id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING`;
}

export function buildIntakeSubject(fields: IntakeRequestFields): string {
  return `[factory-edit-intake] ${fields.publicCode} ${fields.requestId.slice(0, 8).toUpperCase()}`;
}

export function buildIntakeBody(fields: IntakeRequestFields): string {
  return [
    "نسخة استقبال آلية لطلب تعديل جديد من المصنع.",
    "",
    `رقم الطلب: ${fields.requestId}`,
    `رمز النسخة: ${fields.publicCode}`,
    `القالب: ${fields.templateKey}`,
    `البوت: ${fields.botUsername ? "@" + fields.botUsername : "غير محدد"}`,
    `مصدر الرصيد: ${fields.paymentSource === "free" ? "مجاني" : "مدفوع"}`,
    "",
    "نص الطلب:",
    fields.requestText,
    "",
    "هذه الرسالة نسخة إعلامية فقط وقد تتكرر في حالات نادرة؛ رقم الطلب هو المرجع. السجل الأساسي محفوظ في قاعدة بيانات المصنع.",
  ].join("\n");
}

function assertHeaderSafe(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("invalid_address_header");
  return value;
}

function encodeHeader(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function buildRawMessage(config: IntakeConfig, subject: string, bodyText: string): string {
  const to = assertHeaderSafe(config.to);
  const from = assertHeaderSafe(config.sender);
  return [
    `To: ${to}`,
    `From: ${from}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(bodyText, "utf8").toString("base64"),
  ].join("\r\n");
}

function base64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function createIntakeSender(config: IntakeConfig, fetcher: Fetcher = fetch) {
  let cached: { token: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
    const response = await fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`token_refresh_http_${response.status}`);
    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) throw new Error("token_refresh_no_access_token");
    cached = { token: payload.access_token, expiresAt: Date.now() + Number(payload.expires_in ?? 3000) * 1000 };
    return cached.token;
  }

  return async function send(subject: string, bodyText: string): Promise<void> {
    const token = await accessToken();
    const raw = base64Url(buildRawMessage(config, subject, bodyText));
    const response = await fetcher("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`gmail_send_http_${response.status}`);
  };
}

export async function enqueueEditIntake(db: Query, config: IntakeConfig, fields: IntakeRequestFields): Promise<void> {
  await db`
    INSERT INTO factory_edit_intake_outbox(request_id, recipient, subject, body_text)
    VALUES (${fields.requestId}::uuid, ${config.to}, ${buildIntakeSubject(fields)}, ${buildIntakeBody(fields)})
    ON CONFLICT (request_id) DO NOTHING
  `;
}

// Re-enqueue requests created after activation that have no outbox row: for
// example after a crash between the request commit and the enqueue. Requests
// created before activation are never emailed.
export async function backfillEditIntake(db: Query, config: IntakeConfig): Promise<number> {
  const missing = await db`
    SELECT r.id, r.public_code, r.request_text, r.payment_source, i.template_key, i.bot_username
    FROM factory_edit_requests r
    JOIN factory_instances i ON i.id = r.instance_id
    JOIN factory_edit_intake_state s ON s.id = TRUE AND r.created_at >= s.activated_at
    LEFT JOIN factory_edit_intake_outbox o ON o.request_id = r.id
    WHERE o.request_id IS NULL AND r.created_at > NOW() - INTERVAL '2 days'
    ORDER BY r.created_at ASC
    LIMIT ${BACKFILL_LIMIT}
  `;
  for (const row of missing) {
    await enqueueEditIntake(db, config, {
      requestId: String(row.id),
      publicCode: String(row.public_code),
      templateKey: String(row.template_key),
      botUsername: row.bot_username ? String(row.bot_username) : null,
      paymentSource: String(row.payment_source),
      requestText: String(row.request_text),
    });
  }
  return missing.length;
}

// Atomically claims a batch of pending rows for sending. The status flip to
// 'sending' with FOR UPDATE SKIP LOCKED means two concurrent processors never
// send the same row. A row left in 'sending' by a killed process becomes
// claimable again after STALE_SENDING_MINUTES; its attempt was already
// counted, so crash loops still converge to 'failed'.
export async function claimEditIntakeBatch(db: Query, limit: number = BATCH_LIMIT): Promise<any[]> {
  return db`
    WITH picked AS (
      SELECT request_id FROM factory_edit_intake_outbox
      WHERE (status = 'pending' AND attempts < ${MAX_ATTEMPTS})
         OR (status = 'sending' AND attempts < ${MAX_ATTEMPTS}
             AND updated_at < NOW() - INTERVAL '10 minutes') -- STALE_SENDING_MINUTES
      ORDER BY created_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE factory_edit_intake_outbox o
    SET status = 'sending', attempts = o.attempts + 1, updated_at = NOW()
    FROM picked WHERE o.request_id = picked.request_id
    RETURNING o.request_id, o.subject, o.body_text, o.attempts
  `;
}

// Backfill, then claim one batch and send each claimed row at most once per
// invocation (a row that fails is never retried within the same call, so one
// broken sender cannot burn all attempts at once). The time budget bounds how
// long this adds to the calling webhook invocation; rows not reached within
// the budget are released back to 'pending' for a later call or the cron
// route. Per-row send failures never throw; unexpected database errors do
// (callers guard).
export async function processEditIntakeOutbox(
  db: Query,
  config: IntakeConfig | null,
  fetcher?: Fetcher,
  budgetMs: number = DEFAULT_BUDGET_MS,
): Promise<{ sent: number; failed: number }> {
  if (!config) return { sent: 0, failed: 0 };
  await backfillEditIntake(db, config);
  const send = createIntakeSender(config, fetcher ?? fetch);
  const deadline = Date.now() + budgetMs;
  const claimed = await claimEditIntakeBatch(db);
  let sent = 0;
  let failed = 0;
  for (const row of claimed) {
    const requestId = String(row.request_id);
    const attempts = Number(row.attempts);
    if (Date.now() >= deadline) {
      // No time left: release the claim so a later call retries promptly.
      await db`
        UPDATE factory_edit_intake_outbox SET status = 'pending', updated_at = NOW()
        WHERE request_id = ${requestId}::uuid AND status = 'sending'
      `;
      continue;
    }
    try {
      await send(String(row.subject), String(row.body_text));
      await db`
        UPDATE factory_edit_intake_outbox SET status = 'sent', sent_at = NOW(), last_error = NULL, updated_at = NOW()
        WHERE request_id = ${requestId}::uuid
      `;
      sent++;
    } catch (error) {
      // Record only the coded failure, never transport messages or payloads.
      const code = error instanceof Error && /^(gmail_send_http_|token_refresh_)/.test(error.message)
        ? error.message
        : error instanceof Error ? error.name : "unknown";
      await db`
        UPDATE factory_edit_intake_outbox
        SET status = ${attempts >= MAX_ATTEMPTS ? "failed" : "pending"}, last_error = ${code}, updated_at = NOW()
        WHERE request_id = ${requestId}::uuid
      `;
      failed++;
    }
  }
  return { sent, failed };
}

// Guarded entry points used by the webhook, the confirm flow and the cron
// route. They never throw into the caller. Enqueue is database-only (one
// insert after schema no-ops) so the customer-facing path gains no network
// calls; sending happens in the webhook's post-processing pass and the cron.
export async function enqueueEditIntakeSafely(db: Query, fields: IntakeRequestFields): Promise<void> {
  try {
    const config = intakeConfigFromEnv();
    if (!config) return;
    await ensureEditIntakeSchema(db);
    await activateEditIntake(db);
    await enqueueEditIntake(db, config, fields);
  } catch (error) {
    console.error("factory_edit_intake_enqueue_failed", {
      requestId: fields.requestId,
      errorType: error instanceof Error ? error.name : "unknown",
    });
  }
}

export async function processEditIntakeOutboxSafely(db: Query, budgetMs: number = DEFAULT_BUDGET_MS): Promise<void> {
  const startedAt = Date.now();
  try {
    const config = intakeConfigFromEnv();
    if (!config) return;
    await ensureEditIntakeSchema(db);
    await activateEditIntake(db);
    const result = await processEditIntakeOutbox(db, config, undefined, budgetMs);
    if (result.sent || result.failed) {
      console.warn("factory_edit_intake_processed", { ...result, duration_ms: Date.now() - startedAt });
    }
  } catch (error) {
    console.error("factory_edit_intake_processing_failed", {
      errorType: error instanceof Error ? error.name : "unknown",
      duration_ms: Date.now() - startedAt,
    });
  }
      }
