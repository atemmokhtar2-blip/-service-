import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "./db.js";
import { editMessageText, sendMessage, type InlineButton, type TelegramUser } from "./telegram.js";

const token = () => process.env.FACTORY_BOT_TOKEN ?? "";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]!));
}

export async function ensureEditSchema(): Promise<void> {
  await sql`ALTER TABLE factory_instances ADD COLUMN IF NOT EXISTS public_code TEXT`;
  await sql`ALTER TABLE factory_instances ADD COLUMN IF NOT EXISTS free_edit_credits INTEGER NOT NULL DEFAULT 1`;
  await sql`ALTER TABLE factory_instances ADD COLUMN IF NOT EXISTS free_edit_period DATE`;
  await sql`ALTER TABLE factory_instances ADD COLUMN IF NOT EXISTS paid_edit_credits INTEGER NOT NULL DEFAULT 0`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS factory_instances_public_code_unique ON factory_instances(public_code) WHERE public_code IS NOT NULL`;
  await sql`
    CREATE TABLE IF NOT EXISTS factory_edit_drafts (
      telegram_user_id BIGINT PRIMARY KEY REFERENCES factory_users(telegram_user_id) ON DELETE CASCADE,
      instance_id UUID NOT NULL REFERENCES factory_instances(id) ON DELETE CASCADE,
      request_text TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS factory_edit_requests (
      id UUID PRIMARY KEY,
      instance_id UUID NOT NULL REFERENCES factory_instances(id) ON DELETE CASCADE,
      owner_telegram_id BIGINT NOT NULL REFERENCES factory_users(telegram_user_id),
      public_code TEXT NOT NULL,
      request_text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','in_progress','completed','rejected')),
      payment_source TEXT NOT NULL CHECK (payment_source IN ('free','paid')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      handled_by BIGINT,
      admin_note TEXT
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS factory_edit_requests_owner_idx ON factory_edit_requests(owner_telegram_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS factory_edit_requests_instance_idx ON factory_edit_requests(instance_id, created_at DESC)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS factory_edit_requests_one_open_per_instance ON factory_edit_requests(instance_id) WHERE status IN ('pending','in_progress')`;
  await sql`CREATE TABLE IF NOT EXISTS factory_edit_credit_ledger (id BIGSERIAL PRIMARY KEY, instance_id UUID NOT NULL REFERENCES factory_instances(id) ON DELETE CASCADE, owner_telegram_id BIGINT NOT NULL REFERENCES factory_users(telegram_user_id), delta INTEGER NOT NULL, source TEXT NOT NULL CHECK (source IN ('monthly_free','paid_purchase','admin_adjustment','request_consumption','refund')), reference_id UUID, actor_telegram_id BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
}

async function ensurePublicCode(instanceId: string, ownerId: number): Promise<string> {
  const existing = await sql`SELECT public_code FROM factory_instances WHERE id=${instanceId} AND owner_telegram_id=${ownerId} LIMIT 1`;
  if (!existing.length) throw new Error("instance_not_found");
  if (existing[0].public_code) return String(existing[0].public_code);
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = `XV-${randomBytes(12).toString("hex").toUpperCase()}`;
    const rows = await sql`
      UPDATE factory_instances SET public_code=${code}, updated_at=NOW()
      WHERE id=${instanceId} AND owner_telegram_id=${ownerId} AND public_code IS NULL
      RETURNING public_code
    `;
    if (rows.length) return String(rows[0].public_code);
    const current = await sql`SELECT public_code FROM factory_instances WHERE id=${instanceId} AND owner_telegram_id=${ownerId} LIMIT 1`;
    if (current[0]?.public_code) return String(current[0].public_code);
  }
  throw new Error("instance_code_generation_failed");
}

export async function showManagedInstance(user: TelegramUser, chatId: number, templateKey: string, messageId?: number): Promise<void> {
  const rows = await sql`
    SELECT id, template_key, status, bot_username, public_code, free_edit_credits, to_char(free_edit_period, 'YYYY-MM-DD') AS free_edit_period,
      paid_edit_credits
    FROM factory_instances
    WHERE owner_telegram_id=${user.id} AND template_key=${templateKey}
    LIMIT 1
  `;
  if (!rows.length) {
    await sendMessage(token(), chatId, "لا توجد نسخة مسجلة من هذا القالب.");
    return;
  }
  const row = rows[0];
  const code = await ensurePublicCode(String(row.id), user.id);
  const currentMonth = await sql`SELECT date_trunc('month', NOW())::date AS month_start`;
  const period = row.free_edit_period ? String(row.free_edit_period).slice(0,10) : "";
  const activePeriod = String(currentMonth[0].month_start).slice(0,10);
  const free = period === activePeriod ? Number(row.free_edit_credits) : 1;
  const paid = Number(row.paid_edit_credits ?? 0);
  const status = String(row.status);
  const statusLabel = status === "active" ? "نشطة" : status === "provisioning" ? "قيد التجهيز" : status === "failed" ? "تعذر تشغيلها" : status;
  const heading = status === "active" ? "تم إنشاء نسختك بنجاح" : status === "failed" ? "تعذر إكمال إنشاء نسختك" : "نسختك قيد التجهيز";
  const text = `<b>${heading}</b>\n\n<b>${escapeHtml(String(row.bot_username ? "@" + row.bot_username : "نسختك"))}</b>\n<code>${code}</code>\n\nالحالة: <b>${statusLabel}</b>\n\n<b>إدارة نسختك</b>\nرصيد التعديل المجاني: <b>${free}</b>\nرصيد التعديلات المدفوعة: <b>${paid}</b>\n\nينتهي الرصيد المجاني غير المستخدم مع بداية الشهر الجديد.`;
  const keyboard: InlineButton[][] = [
    [{ text: "⚙️ تعديل على نسختك", callback_data: `edit_start:${row.id}`, style: "success" }],
    [{ text: "شراء تعديلات إضافية", callback_data: `edit_buy:${row.id}` }],
    [{ text: "🗑 حذف البوت من المصنع", callback_data: `delete_bot:${templateKey}`, style: "danger" }],
    [{ text: "العودة إلى بوتاتي", callback_data: "my_bots" }],
  ];
  if (messageId) {
    try { await editMessageText(token(), chatId, messageId, text, keyboard); return; } catch { /* send a fresh screen if the old one cannot be edited */ }
  }
  await sendMessage(token(), chatId, text, keyboard);
}

export async function startEditRequest(user: TelegramUser, chatId: number, instanceId: string): Promise<void> {
  const rows = await sql`SELECT id FROM factory_instances WHERE id=${instanceId} AND owner_telegram_id=${user.id} LIMIT 1`;
  if (!rows.length) {
    await sendMessage(token(), chatId, "النسخة المطلوبة غير موجودة في حسابك.");
    return;
  }
  await sql`
    INSERT INTO factory_edit_drafts(telegram_user_id, instance_id, request_text)
    VALUES (${user.id}, ${instanceId}, NULL)
    ON CONFLICT(telegram_user_id) DO UPDATE SET instance_id=EXCLUDED.instance_id, request_text=NULL, created_at=NOW(), updated_at=NOW()
  `;
  await sendMessage(token(), chatId, "اكتب التعديل اللي محتاجه في نسختك بالتفصيل.\n\nوضح المطلوب والنتيجة اللي تتوقعها. لا ترسل توكن البوت أو أي كلمة سر هنا.");
}

export async function hasEditDraft(userId: number): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM factory_edit_drafts WHERE telegram_user_id=${userId} LIMIT 1`;
  return rows.length > 0;
}

export async function captureEditText(user: TelegramUser, chatId: number, text: string): Promise<void> {
  const clean = text.trim();
  if (clean.length < 20 || clean.length > 2000) {
    await sendMessage(token(), chatId, "اكتب وصفًا من 20 إلى 3000 حرف حتى نقدر نفهم التعديل بدقة.");
    return;
  }
  const rows = await sql`
    UPDATE factory_edit_drafts SET request_text=${clean}, updated_at=NOW()
    WHERE telegram_user_id=${user.id} RETURNING instance_id
  `;
  if (!rows.length) return;
  await sendMessage(token(), chatId,
    `<b>مراجعة طلب التعديل</b>\n\n${escapeHtml(clean)}\n\nهل تريد إرسال الطلب إلى إدارة المصنع؟`,
    [[{ text: "إرسال الطلب", callback_data: "edit_confirm", style: "success" }, { text: "إلغاء", callback_data: "edit_cancel", style: "danger" }]]);
}

export async function cancelEditRequest(user: TelegramUser, chatId: number): Promise<void> {
  await sql`DELETE FROM factory_edit_drafts WHERE telegram_user_id=${user.id}`;
  await sendMessage(token(), chatId, "تم إلغاء طلب التعديل.");
}

export async function confirmEditRequest(user: TelegramUser, chatId: number): Promise<void> {
  const drafts = await sql`
    SELECT d.instance_id, d.request_text, i.public_code, i.template_key, i.bot_username
    FROM factory_edit_drafts d
    JOIN factory_instances i ON i.id=d.instance_id AND i.owner_telegram_id=d.telegram_user_id
    WHERE d.telegram_user_id=${user.id} AND d.request_text IS NOT NULL
    LIMIT 1
  `;
  if (!drafts.length) {
    await sendMessage(token(), chatId, "لا يوجد طلب تعديل جاهز للإرسال. ابدأ الطلب من صفحة نسختك.");
    return;
  }
  const draft = drafts[0];
  const code = await ensurePublicCode(String(draft.instance_id), user.id);
  const openRequests = await sql`SELECT 1 FROM factory_edit_requests WHERE instance_id=${draft.instance_id} AND status IN ('pending','in_progress') LIMIT 1`;
  if (openRequests.length) {
    await sendMessage(token(), chatId, "لديك بالفعل طلب تعديل مفتوح على هذه النسخة. انتظر إغلاقه قبل إرسال طلب جديد.");
    return;
  }
  const freeRows = await sql`
    UPDATE factory_instances
    SET free_edit_credits = CASE WHEN free_edit_period IS NULL OR free_edit_period < date_trunc('month', NOW())::date THEN 0 ELSE free_edit_credits - 1 END,
        free_edit_period = date_trunc('month', NOW())::date,
        updated_at=NOW()
    WHERE id=${draft.instance_id} AND owner_telegram_id=${user.id}
      AND (free_edit_period IS NULL OR free_edit_period < date_trunc('month', NOW())::date OR free_edit_credits > 0)
    RETURNING id
  `;
  let paymentSource: "free" | "paid" = "free";
  if (!freeRows.length) {
    const paidRows = await sql`
      UPDATE factory_instances SET paid_edit_credits=paid_edit_credits-1, updated_at=NOW()
      WHERE id=${draft.instance_id} AND owner_telegram_id=${user.id} AND paid_edit_credits > 0
      RETURNING id
    `;
    if (!paidRows.length) {
      await sendMessage(token(), chatId, "رصيدك المجاني لهذا الشهر انتهى ولا يوجد رصيد مدفوع. تقدر تطلب شراء تعديلات إضافية من زر الشراء.");
      return;
    }
    paymentSource = "paid";
  }
  const requestId = randomUUID();
  try {
    await sql`
    INSERT INTO factory_edit_requests(id, instance_id, owner_telegram_id, public_code, request_text, status, payment_source)
    VALUES (${requestId}, ${draft.instance_id}, ${user.id}, ${code}, ${draft.request_text}, 'pending', ${paymentSource})
    `;
  } catch {
    if (paymentSource === 'free') {
      await sql`UPDATE factory_instances SET free_edit_credits=free_edit_credits+1 WHERE id=${draft.instance_id} AND owner_telegram_id=${user.id} AND free_edit_period=date_trunc('month', NOW())::date`;
    } else {
      await sql`UPDATE factory_instances SET paid_edit_credits=paid_edit_credits+1 WHERE id=${draft.instance_id} AND owner_telegram_id=${user.id}`;
    }
    await sendMessage(token(), chatId, "تعذر تسجيل الطلب بسبب وجود طلب مفتوح أو تعارض مؤقت. لم يتم استهلاك رصيدك؛ حاول مرة أخرى بعد مراجعة صفحة نسختك.");
    return;
  }
  await sql`INSERT INTO factory_edit_credit_ledger(instance_id, owner_telegram_id, delta, source, reference_id) VALUES (${draft.instance_id}, ${user.id}, -1, 'request_consumption', ${requestId})`;
  await sql`DELETE FROM factory_edit_drafts WHERE telegram_user_id=${user.id}`;
  await sendMessage(token(), chatId, `تم إرسال طلب التعديل بنجاح.\nرمز نسختك: <code>${code}</code>\nرقم الطلب: <code>${requestId.slice(0,8).toUpperCase()}</code>\nسيتم إشعارك عند بدء التنفيذ أو اكتماله.`);
  const admins = (process.env.FACTORY_ADMIN_IDS ?? "").split(",").map((v) => Number(v.trim())).filter((v) => Number.isSafeInteger(v) && v > 0);
  if (!admins.length) {
    console.error("factory_edit_admins_not_configured", { requestId });
    return;
  }
  const owner = [user.first_name, user.username ? `@${user.username}` : null].filter(Boolean).join(' · ') || String(user.id);
  const message = `<b>طلب تعديل جديد</b>\n\nالنسخة: <code>${code}</code>\nالقالب: <b>${escapeHtml(String(draft.template_key))}</b>\nالبوت: ${escapeHtml(String(draft.bot_username ? "@" + draft.bot_username : "غير محدد"))}\nالمالك: ${escapeHtml(owner)}\nTelegram ID: <code>${user.id}</code>\nمصدر الرصيد: <b>${paymentSource === "free" ? "مجاني" : "مدفوع"}</b>\nرقم الطلب: <code>${requestId}</code>\n\n<b>المطلوب:</b>\n${escapeHtml(String(draft.request_text))}`;
  const keyboard: InlineButton[][] = [
    [{ text: "بدء التنفيذ", callback_data: `edit_admin:in_progress:${requestId}`, style: "primary" }],
    [{ text: "اكتمل التعديل", callback_data: `edit_admin:completed:${requestId}`, style: "success" }, { text: "رفض الطلب", callback_data: `edit_admin:rejected:${requestId}`, style: "danger" }],
  ];
  for (const adminId of admins) {
    try { await sendMessage(token(), adminId, message, keyboard); }
    catch (error) { console.error("factory_edit_admin_delivery_failed", { requestId, adminId, errorType: error instanceof Error ? error.name : "unknown" }); }
  }
}

export async function handleAdminEditAction(admin: TelegramUser, chatId: number, action: string, requestId: string): Promise<void> {
  const allowed = (process.env.FACTORY_ADMIN_IDS ?? "").split(",").some((v) => v.trim() === String(admin.id));
  if (!allowed) return;
  if (!["in_progress", "completed", "rejected"].includes(action)) return;
  const rows = await sql`
    UPDATE factory_edit_requests SET status=${action}, handled_by=${admin.id}, updated_at=NOW()
    WHERE id=${requestId} AND status IN ('pending','in_progress')
    RETURNING owner_telegram_id, public_code, instance_id, payment_source
  `;
  if (!rows.length) {
    await sendMessage(token(), chatId, "الطلب غير موجود أو تم إغلاقه بالفعل.");
    return;
  }
  const row = rows[0];
  if (action === "rejected") {
    let refunded = false;
    if (row.payment_source === "paid") {
      const restored = await sql`UPDATE factory_instances SET paid_edit_credits=paid_edit_credits+1, updated_at=NOW() WHERE id=${row.instance_id} AND owner_telegram_id=${row.owner_telegram_id} RETURNING id`;
      refunded = restored.length > 0;
    } else {
      const restored = await sql`UPDATE factory_instances SET free_edit_credits=free_edit_credits+1, updated_at=NOW() WHERE id=${row.instance_id} AND owner_telegram_id=${row.owner_telegram_id} AND free_edit_period=date_trunc('month', NOW())::date RETURNING id`;
      refunded = restored.length > 0;
    }
    if (refunded) await sql`INSERT INTO factory_edit_credit_ledger(instance_id, owner_telegram_id, delta, source, reference_id, actor_telegram_id) VALUES (${row.instance_id}, ${row.owner_telegram_id}, 1, 'refund', ${requestId}, ${admin.id})`;
  }
  const labels: Record<string,string> = { in_progress: "بدأنا تنفيذ التعديل على نسختك.", completed: "اكتمل التعديل على نسختك.", rejected: "تعذر قبول طلب التعديل. تم إعادة الرصيد إن كان لا يزال صالحًا؛ تواصل مع الإدارة لمعرفة التفاصيل." };
  await sendMessage(token(), Number(row.owner_telegram_id), `${labels[action]}\nرمز النسخة: <code>${escapeHtml(String(row.public_code))}</code>`);
  await sendMessage(token(), chatId, action === "completed" ? "تم تسجيل اكتمال الطلب وإبلاغ صاحبه." : action === "rejected" ? "تم رفض الطلب وإبلاغ صاحبه." : "تم تحويل الطلب إلى قيد التنفيذ.");
}

export async function showEditPurchaseInfo(user: TelegramUser, chatId: number, instanceId: string): Promise<void> {
  const rows = await sql`SELECT public_code FROM factory_instances WHERE id=${instanceId} AND owner_telegram_id=${user.id} LIMIT 1`;
  if (!rows.length) return;
  const code = await ensurePublicCode(instanceId, user.id);
  const contact = process.env.FACTORY_SUPPORT_USERNAME ?? "";
  const suffix = contact ? `\nتواصل مع الإدارة: @${escapeHtml(contact.replace(/^@/, ""))}` : "\nأرسل للإدارة رمز نسختك لشراء رصيد إضافي.";
  await sendMessage(token(), chatId, `لشراء تعديلات إضافية لنسختك، أرسل رمز النسخة <code>${code}</code> للإدارة.${suffix}`);
}

export async function grantPaidCredits(admin: TelegramUser, chatId: number, publicCode: string, amount: number): Promise<void> {
  const allowed = (process.env.FACTORY_ADMIN_IDS ?? "").split(",").some((v) => v.trim() === String(admin.id));
  if (!allowed || !/^[A-Z0-9-]{8,32}$/.test(publicCode) || !Number.isSafeInteger(amount) || amount < 1 || amount > 100) {
    await sendMessage(token(), chatId, "صيغة الأمر غير صحيحة أو لا تملك صلاحية التنفيذ. الصيغة: /grant_edits XV-CODE 5");
    return;
  }
  const rows = await sql`UPDATE factory_instances SET paid_edit_credits=paid_edit_credits+${amount}, updated_at=NOW() WHERE public_code=${publicCode} RETURNING id, owner_telegram_id`;
  if (!rows.length) { await sendMessage(token(), chatId, "لم يتم العثور على نسخة بهذا الرمز."); return; }
  await sql`INSERT INTO factory_edit_credit_ledger(instance_id, owner_telegram_id, delta, source, actor_telegram_id) VALUES (${rows[0].id}, ${rows[0].owner_telegram_id}, ${amount}, 'paid_purchase', ${admin.id})`;
  await sendMessage(token(), chatId, `تم إضافة ${amount} رصيد تعديل مدفوع للنسخة <code>${escapeHtml(publicCode)}</code>.`);
  await sendMessage(token(), Number(rows[0].owner_telegram_id), `تم إضافة ${amount} رصيد تعديل مدفوع إلى نسختك. رمز النسخة: <code>${escapeHtml(publicCode)}</code>`);
}
