// Each operation is one PostgreSQL statement: all data-changing CTEs commit or
// roll back together, including the credit ledger. No compensating writes.
type Query = (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>;

export async function consumeEditCredit(db: Query, ownerId: number, requestId: string) {
  return db`
    WITH draft AS MATERIALIZED (
      SELECT d.telegram_user_id, d.instance_id, d.request_text,
        i.public_code, i.template_key, i.bot_username,
        CASE WHEN i.free_edit_period IS NULL
          OR i.free_edit_period < date_trunc('month', NOW())::date
          OR i.free_edit_credits > 0 THEN 'free' ELSE 'paid' END AS payment_source,
        i.paid_edit_credits
      FROM factory_edit_drafts d
      JOIN factory_instances i ON i.id=d.instance_id AND i.owner_telegram_id=d.telegram_user_id
      WHERE d.telegram_user_id=${ownerId} AND d.request_text IS NOT NULL AND i.public_code IS NOT NULL
      FOR UPDATE OF i, d
    ), created AS (
      INSERT INTO factory_edit_requests(id, instance_id, owner_telegram_id, public_code, request_text, status, payment_source)
      SELECT ${requestId}::uuid, d.instance_id, d.telegram_user_id, d.public_code, d.request_text, 'pending', d.payment_source
      FROM draft d
      WHERE (d.payment_source='free' OR d.paid_edit_credits > 0)
        AND NOT EXISTS (SELECT 1 FROM factory_edit_requests r WHERE r.instance_id=d.instance_id AND r.status IN ('pending','in_progress'))
      RETURNING *
    ), debited AS (
      UPDATE factory_instances i
      SET free_edit_credits=CASE WHEN c.payment_source='free' THEN
          CASE WHEN i.free_edit_period IS NULL OR i.free_edit_period < date_trunc('month', NOW())::date THEN 0 ELSE i.free_edit_credits-1 END
          ELSE i.free_edit_credits END,
        free_edit_period=CASE WHEN c.payment_source='free' THEN date_trunc('month', NOW())::date ELSE i.free_edit_period END,
        paid_edit_credits=i.paid_edit_credits-CASE WHEN c.payment_source='paid' THEN 1 ELSE 0 END,
        updated_at=NOW()
      FROM created c WHERE i.id=c.instance_id AND i.owner_telegram_id=c.owner_telegram_id
      RETURNING i.id
    ), logged AS (
      INSERT INTO factory_edit_credit_ledger(instance_id, owner_telegram_id, delta, source, reference_id)
      SELECT c.instance_id, c.owner_telegram_id, -1, 'request_consumption', c.id
      FROM created c JOIN debited d ON d.id=c.instance_id RETURNING id
    ), cleared AS (
      DELETE FROM factory_edit_drafts d USING created c
      WHERE d.telegram_user_id=c.owner_telegram_id AND d.instance_id=c.instance_id
        AND EXISTS (SELECT 1 FROM logged) RETURNING d.telegram_user_id
    )
    SELECT c.*, d.template_key, d.bot_username FROM created c
    JOIN draft d ON d.instance_id=c.instance_id WHERE EXISTS (SELECT 1 FROM cleared)
  `;
}

export async function transitionEditRequest(db: Query, adminId: number, action: string, requestId: string) {
  return db`
    WITH locked AS MATERIALIZED (
      SELECT r.id, r.instance_id, r.owner_telegram_id, r.payment_source, r.created_at
      FROM factory_edit_requests r
      JOIN factory_instances i ON i.id=r.instance_id AND i.owner_telegram_id=r.owner_telegram_id
      WHERE r.id=${requestId}::uuid AND r.status IN ('pending','in_progress')
      FOR UPDATE OF i, r
    ), changed AS (
      UPDATE factory_edit_requests r SET status=${action}, handled_by=${adminId}, updated_at=NOW()
      FROM locked l WHERE r.id=l.id AND r.status IN ('pending','in_progress')
      RETURNING r.*
    ), refunded AS (
      UPDATE factory_instances i
      SET paid_edit_credits=i.paid_edit_credits+CASE WHEN c.payment_source='paid' THEN 1 ELSE 0 END,
        free_edit_credits=i.free_edit_credits+CASE WHEN c.payment_source='free' THEN 1 ELSE 0 END,
        updated_at=NOW()
      FROM changed c WHERE i.id=c.instance_id AND i.owner_telegram_id=c.owner_telegram_id
        AND c.status='rejected'
        AND (c.payment_source='paid' OR (i.free_edit_period=date_trunc('month', NOW())::date
          AND date_trunc('month', c.created_at)=date_trunc('month', NOW())))
      RETURNING i.id
    ), logged AS (
      INSERT INTO factory_edit_credit_ledger(instance_id, owner_telegram_id, delta, source, reference_id, actor_telegram_id)
      SELECT c.instance_id, c.owner_telegram_id, 1, 'refund', c.id, ${adminId}
      FROM changed c JOIN refunded f ON f.id=c.instance_id RETURNING id
    )
    SELECT c.* FROM changed c LEFT JOIN (SELECT count(*) FROM logged) l ON true
  `;
}
