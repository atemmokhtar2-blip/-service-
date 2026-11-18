import { randomUUID } from "node:crypto";
import { sql } from "./db.js";
import { decryptToken, encryptToken, signServiceRequest } from "./security.js";
import { getBotIdentity, getChannelMembership, sendMessage, editMessageText, type TelegramUser } from "./telegram.js";
import { isFactoryAdmin } from "./subscription.js";
import { diagnosticCode } from "./diagnostics.js";
import { getTemplateDefinition, templateMenuRecord } from "./engines/template_registry.js";
import { checkTemplateReadiness, validateProvisionInput, validateProvisionResponse, validateProvisionUrl } from "./engines/provision_contract.js";

export const TEMPLATES = templateMenuRecord();
type TemplateKey = string;

const factoryToken = () => process.env.FACTORY_BOT_TOKEN ?? "";
const channel = () => process.env.REQUIRED_CHANNEL_ID ?? "@K_J6k";
const channelUrl = () => process.env.REQUIRED_CHANNEL_URL ?? "https://t.me/K_J6k";

const subscriptionPrompt = "🔐 <b>التحقق من صلاحية الدخول</b>\n\n<b>أهلاً بك في مصنع البوتات</b>\nللاستمرار، اشترك في القناة الرسمية أولاً، ثم اضغط «تحقق من الاشتراك».\n\n👑 <b>مالك القناة ومشرفوها:</b> دخول مباشر عند تأكيد صلاحياتهم من Telegram.";

const subscriptionKeyboard = [[
  { text: "الاشتراك في القناة", url: channelUrl() },
  { text: "تحقق من الاشتراك", callback_data: "check_subscription" },
]];

export async function requireMembership(user: TelegramUser, chatId: number, messageId?: number): Promise<boolean> {
  if (isFactoryAdmin(user.id, process.env.FACTORY_ADMIN_IDS)) return true;
  try {
    if (await getChannelMembership(factoryToken(), channel(), user.id)) return true;
  } catch { /* A Telegram membership lookup failure must not grant access. */ }

  if (messageId !== undefined) {
    try {
      await editMessageText(factoryToken(), chatId, messageId, subscriptionPrompt, subscriptionKeyboard);
    } catch {
      // Do not send a second copy if Telegram cannot edit the original prompt.
      console.warn("factory_subscription_prompt_edit_failed");
    }
  } else {
    await sendMessage(factoryToken(), chatId, subscriptionPrompt, subscriptionKeyboard);
  }
  return false;
}

const welcomeText = "~ اهلا بك في اقوى صانع بوتات» .\n~ اصنع بوتك الان وبخطوة واحدة» .\n~ فقط ارسل التوكن» .\n\nاختر القالب الذي تريد تصنيعه:";

export async function start(user: TelegramUser, chatId: number, messageId?: number): Promise<void> {
  if (!(await requireMembership(user, chatId, messageId))) return;
  await sql`
    INSERT INTO factory_users(telegram_user_id, username, first_name)
    VALUES (${user.id}, ${user.username ?? null}, ${user.first_name ?? null})
    ON CONFLICT(telegram_user_id) DO UPDATE SET username=EXCLUDED.username, first_name=EXCLUDED.first_name, updated_at=NOW()
  `;
  if (messageId !== undefined) {
    await editMessageText(factoryToken(), chatId, messageId, welcomeText, templateKeyboard(user.id));
  } else {
    await sendMessage(factoryToken(), chatId, welcomeText, templateKeyboard(user.id));
  }
}

function templateKeyboard(userId: number) {
  return Object.entries(TEMPLATES).map(([key, item]) => [{ text: item.title, callback_data: `template:${key}` }]);
}

export async function showTemplate(user: TelegramUser, chatId: number, key: string): Promise<void> {
  if (!(await requireMembership(user, chatId))) return;
  if (!getTemplateDefinition(key)) return;
  const template = key as TemplateKey;
  const existing = await sql`SELECT status, bot_username FROM factory_instances WHERE owner_telegram_id=${user.id} AND template_key=${template} LIMIT 1`;
  if (existing.length) {
    const row = existing[0];
    await sendMessage(factoryToken(), chatId,
      `لديك بالفعل نسخة من قالب ${TEMPLATES[template].title}.\nالحالة: ${statusArabic(String(row.status))}${row.bot_username ? `\nالبوت: @${escapeHtml(String(row.bot_username))}` : ""}\nلا يمكن إنشاء نسخة ثانية من نفس القالب.`,
      [
        ...(String(row.status) === "failed" ? [[{ text: "إعادة محاولة التصنيع", callback_data: `retry:${template}` }]] : []),
        [{ text: "العودة للقوالب", callback_data: "templates" }],
      ]);
    return;
  }
  await sql`
    INSERT INTO factory_pending_actions(telegram_user_id, action, template_key)
    VALUES (${user.id}, 'awaiting_token', ${template})
    ON CONFLICT(telegram_user_id) DO UPDATE SET action='awaiting_token', template_key=EXCLUDED.template_key, created_at=NOW()
  `;
  await sendMessage(factoryToken(), chatId,
    `اخترت: ${TEMPLATES[template].title}\n${TEMPLATES[template].description}\n\nأرسل توكن البوت من BotFather في رسالة واحدة. لن يظهر التوكن في ردود المصنع، وسيتم تخزينه مشفراً.`,
    [[{ text: "إلغاء", callback_data: "cancel_creation" }]]);
}

export async function submitToken(user: TelegramUser, chatId: number, rawToken: string): Promise<void> {
  if (!(await requireMembership(user, chatId))) return;
  const pending = await sql`SELECT template_key FROM factory_pending_actions WHERE telegram_user_id=${user.id} AND action='awaiting_token' LIMIT 1`;
  if (!pending.length) return;
  const template = String(pending[0].template_key) as TemplateKey;
  const input = validateProvisionInput({ ownerId: user.id, templateKey: template, token: rawToken });
  if (!input.ok) {
    await sendMessage(factoryToken(), chatId, "تعذّر التحقق من بيانات التصنيع. تأكد من اختيار قالب مسجل وإرسال توكن صحيح.");
    return;
  }
  const token = input.value.token;

  let identity: TelegramUser;
  try { identity = await getBotIdentity(token); }
  catch {
    await sendMessage(factoryToken(), chatId, "التوكن غير صالح أو تعذر الوصول إلى Telegram. راجع التوكن وحاول مرة أخرى.");
    return;
  }
  if (!identity.is_bot) {
    await sendMessage(factoryToken(), chatId, "التوكن لا يعود إلى بوت صالح. أرسل توكن بوت من BotFather.");
    return;
  }

  const requestId = randomUUID();
  const instanceId = randomUUID();
  const encrypted = encryptToken(token);
  try {
    const inserted = await sql`
      INSERT INTO factory_instances(id, owner_telegram_id, template_key, status, request_id, bot_id, bot_username, encrypted_token)
      VALUES (${instanceId}, ${user.id}, ${template}, 'provisioning', ${requestId}, ${identity.id}, ${identity.username ?? null}, ${encrypted})
      ON CONFLICT(owner_telegram_id, template_key) DO NOTHING
      RETURNING id
    `;
    if (!inserted.length) {
      await sendMessage(factoryToken(), chatId, "لديك بالفعل نسخة محجوزة أو منشأة من هذا القالب. لن يتم إنشاء نسخة مكررة.");
      return;
    }
    await sql`DELETE FROM factory_pending_actions WHERE telegram_user_id=${user.id}`;
    await sendMessage(factoryToken(), chatId,
      `تم التحقق من التوكن بنجاح للبوت @${escapeHtml(identity.username ?? "بدون اسم")}.\n\nحُجز طلب التصنيع بأمان. جارٍ تجهيز الربط مع محرك القالب؛ لن نعلن نجاح التشغيل قبل تأكيد الخدمة الأصلية.`,
      [[{ text: "حالة النسخة", callback_data: `instance:${template}` }, { text: "القوالب", callback_data: "templates" }]]);
    await provisionTemplate(template, { requestId, ownerId: user.id, token, identity });
    await showInstance(user, chatId, template);
  } catch (error) {
    const code = safeCode(error);
    await sql`UPDATE factory_instances SET status='failed', safe_error_code=${code}, updated_at=NOW() WHERE request_id=${requestId}`;
    await sendMessage(factoryToken(), chatId, "تعذر إكمال حجز النسخة بسبب خطأ داخلي آمن. احتفظنا برمز الخطأ: " + code);
  }
}

async function provisionTemplate(
  template: TemplateKey,
  payload: { requestId: string; ownerId: number; token: string; identity: TelegramUser },
): Promise<void> {
  const definition = getTemplateDefinition(template);
  if (!definition) {
    await sql`UPDATE factory_instances SET status='failed', safe_error_code='TEMPLATE_NOT_REGISTERED', updated_at=NOW() WHERE request_id=${payload.requestId}`;
    return;
  }
  const url = process.env[definition.provisionUrlEnv];
  if (!url) {
    console.error(JSON.stringify({ event: "factory_source_provision_config_missing", request_id: payload.requestId, template, env_key: definition.provisionUrlEnv }));
    await sql`UPDATE factory_instances SET status='failed', safe_error_code='SOURCE_ADAPTER_NOT_CONFIGURED', updated_at=NOW() WHERE request_id=${payload.requestId}`;
    return;
  }

  const startedAt = Date.now();
  const endpoint = validateProvisionUrl(url);
  if (!endpoint) {
    console.error(JSON.stringify({ event: "factory_source_provision_bad_url", request_id: payload.requestId, template }));
    await sql`UPDATE factory_instances SET status='failed', safe_error_code='SOURCE_URL_INVALID', updated_at=NOW() WHERE request_id=${payload.requestId}`;
    return;
  }

  const readiness = await checkTemplateReadiness(endpoint, definition);
  if (!readiness.ok) {
    console.error(JSON.stringify({ event: "factory_source_readiness_failed", request_id: payload.requestId, template, failure_code: readiness.code }));
    await sql`UPDATE factory_instances SET status='failed', safe_error_code=${readiness.code}, updated_at=NOW() WHERE request_id=${payload.requestId}`;
    return;
  }

  const body = JSON.stringify({
    contract_version: definition.contractVersion,
    request_id: payload.requestId,
    owner_telegram_id: payload.ownerId,
    template,
    bot_token: payload.token,
  });
  const path = endpoint.pathname;
  let response: Response;
  try {
    const signed = signServiceRequest("POST", path, body);
    response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "accept": "application/json",
        "x-factory-timestamp": signed.timestamp,
        "x-factory-signature": signed.signature,
        "idempotency-key": payload.requestId,
        "x-factory-contract-version": String(definition.contractVersion),
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const failure = error instanceof Error && error.name === "TimeoutError" ? "UPSTREAM_TIMEOUT"
      : error instanceof TypeError ? "UPSTREAM_NETWORK_ERROR" : "UPSTREAM_REQUEST_ERROR";
    console.error(JSON.stringify({ event: "factory_source_provision_transport_error", request_id: payload.requestId, template, host: endpoint.host, path, failure, duration_ms: Date.now() - startedAt }));
    await sql`UPDATE factory_instances SET status='failed', safe_error_code=${failure}, updated_at=NOW() WHERE request_id=${payload.requestId}`;
    return;
  }
  if (!response.ok) {
    let upstreamCode = "UNCLASSIFIED";
    try {
      const upstream = await response.clone().json() as Record<string, unknown>;
      upstreamCode = diagnosticCode(upstream.error_code ?? upstream.code ?? upstream.error);
    } catch { /* Never log raw response bodies. */ }
    console.error(JSON.stringify({ event: "factory_source_provision_rejected", request_id: payload.requestId, template, host: endpoint.host, path, http_status: response.status, upstream_error_code: upstreamCode, duration_ms: Date.now() - startedAt }));
    await sql`UPDATE factory_instances SET status='failed', safe_error_code='SOURCE_PROVISION_FAILED', updated_at=NOW() WHERE request_id=${payload.requestId}`;
    return;
  }

  let rawResult: unknown;
  try {
    rawResult = await response.json();
  } catch {
    console.error(JSON.stringify({ event: "factory_source_provision_invalid_json", request_id: payload.requestId, template, host: endpoint.host, path, http_status: response.status, duration_ms: Date.now() - startedAt }));
    await sql`UPDATE factory_instances SET status='failed', safe_error_code='SOURCE_RESPONSE_INVALID_JSON', updated_at=NOW() WHERE request_id=${payload.requestId}`;
    return;
  }

  const contract = validateProvisionResponse(rawResult, {
    requestId: payload.requestId,
    ownerId: payload.ownerId,
    botId: payload.identity.id,
    botUsername: payload.identity.username,
    template: definition,
  });
  if (!contract.ok) {
    console.error(JSON.stringify({ event: "factory_source_contract_rejected", request_id: payload.requestId, template, host: endpoint.host, path, http_status: response.status, failure_code: contract.code, duration_ms: Date.now() - startedAt }));
    await sql`UPDATE factory_instances SET status='failed', safe_error_code=${contract.code}, updated_at=NOW() WHERE request_id=${payload.requestId}`;
    return;
  }

  const result = contract.value;
  console.info(JSON.stringify({ event: "factory_source_provision_accepted", request_id: payload.requestId, template, host: endpoint.host, path, http_status: response.status, source_status: result.status, duration_ms: Date.now() - startedAt }));
  const state = result.status === "active" ? "active" : "provisioning";
  await sql`UPDATE factory_instances SET status=${state}, source_instance_id=${result.instanceId}, bot_id=${result.botId}, bot_username=${result.botUsername ?? null}, safe_error_code=NULL, updated_at=NOW() WHERE request_id=${payload.requestId}`;
}

export async function showTemplates(user: TelegramUser, chatId: number): Promise<void> {
  if (!(await requireMembership(user, chatId))) return;
  await sendMessage(factoryToken(), chatId, "قوالب المصنع المتاحة:", templateKeyboard(user.id));
}

async function refreshDownloadStatus(requestId: string): Promise<void> {
  const base = process.env.DOWNLOAD_PROVISION_URL;
  if (!base) return;
  try {
    const endpoint = new URL(`/internal/factory/status/${requestId}`, base);
    const signed = signServiceRequest("GET", endpoint.pathname, "");
    const response = await fetch(endpoint, {
      method: "GET",
      headers: { "x-factory-timestamp": signed.timestamp, "x-factory-signature": signed.signature },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return;
    const result = await response.json() as { status?: string; bot_id?: number; bot_username?: string; instance_id?: string; error_code?: string };
    if (!["active", "provisioning", "failed"].includes(String(result.status))) return;
    await sql`
      UPDATE factory_instances SET status=${result.status}, source_instance_id=${result.instance_id ?? null},
        bot_id=${result.bot_id ?? null}, bot_username=${result.bot_username ?? null},
        safe_error_code=${result.error_code ?? null}, updated_at=NOW()
      WHERE request_id=${requestId}
    `;
  } catch {
    // Status refresh is best-effort; the durable source record remains authoritative.
  }
}

export async function showInstance(user: TelegramUser, chatId: number, template: string): Promise<void> {
  if (!(await requireMembership(user, chatId))) return;
  if (!getTemplateDefinition(template)) return;
  const key = template as TemplateKey;
  let rows = await sql`SELECT request_id, status, bot_username, safe_error_code FROM factory_instances WHERE owner_telegram_id=${user.id} AND template_key=${key} LIMIT 1`;
  if (!rows.length) return sendMessage(factoryToken(), chatId, "لا توجد نسخة مسجلة من هذا القالب.");
  if (key === "download" && ["provisioning", "active"].includes(String(rows[0].status))) {
    await refreshDownloadStatus(String(rows[0].request_id));
    rows = await sql`SELECT request_id, status, bot_username, safe_error_code FROM factory_instances WHERE owner_telegram_id=${user.id} AND template_key=${key} LIMIT 1`;
  }
  const row = rows[0];
  const keyboard = [
    ...(String(row.status) === "failed" ? [[{ text: "إعادة محاولة التصنيع", callback_data: `retry:${template}` }]] : []),
    ...(String(row.status) === "provisioning" ? [[{ text: "تحديث الحالة", callback_data: `instance:${template}` }]] : []),
    [{ text: "القوالب", callback_data: "templates" }],
  ];
  await sendMessage(factoryToken(), chatId,
    `القالب: ${TEMPLATES[template as TemplateKey]?.title ?? template}\nالحالة: ${statusArabic(String(row.status))}\nالبوت: ${row.bot_username ? "@" + escapeHtml(String(row.bot_username)) : "لم يتم تفعيله بعد"}${row.safe_error_code ? "\nرمز الحالة: " + escapeHtml(String(row.safe_error_code)) : ""}`,
    keyboard);
}

export async function retryProvision(user: TelegramUser, chatId: number, template: string): Promise<void> {
  if (!(await requireMembership(user, chatId))) return;
  if (!(template in TEMPLATES)) return;
  const key = template as TemplateKey;
  const rows = await sql`
    SELECT request_id, encrypted_token, status
    FROM factory_instances
    WHERE owner_telegram_id=${user.id} AND template_key=${key}
    LIMIT 1
  `;
  if (!rows.length) return sendMessage(factoryToken(), chatId, "لا توجد نسخة لإعادة تصنيعها.");
  const row = rows[0];
  if (String(row.status) !== "failed") return showInstance(user, chatId, key);
  try {
    const token = decryptToken(String(row.encrypted_token));
    const identity = await getBotIdentity(token);
    if (!identity.is_bot) throw new Error("INVALID_BOT_IDENTITY");
    const requestId = String(row.request_id);
    await sql`UPDATE factory_instances SET status='provisioning', safe_error_code=NULL, updated_at=NOW() WHERE request_id=${requestId}`;
    await provisionTemplate(key, { requestId, ownerId: user.id, token, identity });
  } catch (error) {
    const code = safeCode(error);
    await sql`UPDATE factory_instances SET status='failed', safe_error_code=${code}, updated_at=NOW() WHERE owner_telegram_id=${user.id} AND template_key=${key}`;
  }
  await showInstance(user, chatId, key);
}

function statusArabic(status: string): string {
  const values: Record<string,string> = { reserved:"محجوزة", awaiting_token:"بانتظار التوكن", provisioning:"قيد التصنيع", active:"تعمل", paused:"متوقفة مؤقتاً", failed:"لم يكتمل التصنيع" };
  return values[status] ?? "غير معروفة";
}
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]!)); }
function safeCode(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_]{3,60}$/i.test(error.message)) return error.message;
  return "FACTORY_INTERNAL_ERROR";
}
