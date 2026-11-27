// Each operation is one PostgreSQL statement. The quota row is locked by
// INSERT .. ON CONFLICT, so requests from different instances share one
// account-wide 24-hour allowance without overspending it.
type Query = (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>;

export async function getEditCreditStatus(db: Query, ownerId: number, instanceId: string) {
  return db`
    SELECT
      CASE
        WHEN q.window_started_at IS NULL
          OR q.window_started_at <= NOW() - INTERVAL '24 hours' THEN 2
        ELSE q.free_credits
      END AS free_credits,
      CASE
        WHEN q.window_started_at > NOW() - INTERVAL '24 hours'
          THEN q.window_started_at + INTERVAL '24 hours'
        ELSE NULL
      END AS resets_at,
      i.paid_edit_credits,
      EXISTS (
        SELECT 1 FROM factory_edit_requests r
        WHERE r.instance_id=i.id AND r.status IN ('pending','in_progress')
      ) AS has_open_request
    FROM factory_instances i
    LEFT JOIN factory_user_edit_quotas q ON q.owner_telegram_id=i.owner_telegram_id
    WHERE i.id=${instanceId} AND i.owner_telegram_id=${ownerId}
    LIMIT 1
  `;
}

export async function consumeEditCredit(db: Query, ownerId: number, requestId: string) {
  return db`
    WITH quota AS MATERIALIZED (
      INSERT INTO factory_user_edit_quotas(owner_telegram_id, free_credits, window_started_at)
      VALUES (${ownerId}, 2, NOW())
      ON CONFLICT (owner_telegram_id) DO UPDATE SET
        free_credits = CASE
          WHEN factory_user_edit_quotas.window_started_at <= NOW() - INTERVAL '24 hours' THEN 2
          ELSE factory_user_edit_quotas.free_credits
        END,
        window_started_at = CASE
          WHEN factory_user_edit_quotas.window_started_at <= NOW() - INTERVAL '24 hours' THEN NOW()
          ELSE factory_user_edit_quotas.window_started_at
        END,
        updated_at = NOW()
      RETURNING owner_telegram_id, free_credits, window_started_at
    ), draft AS MATERIALIZED (
      SELECT d.telegram_user_id, d.instance_id, d.request_text,
        i.public_code, i.template_key, i.bot_username, i.paid_edit_credits,
        q.free_credits,
        q.window_started_at AS free_credit_window_started_at,
        CASE WHEN q.free_credits > 0 THEN 'free' ELSE 'paid' END AS payment_source
      FROM factory_edit_drafts d
      JOIN factory_instances i ON i.id=d.instance_id AND i.owner_telegram_id=d.telegram_user_id
      JOIN quota q ON q.owner_telegram_id=d.telegram_user_id
      WHERE d.telegram_user_id=${ownerId} AND d.request_text IS NOT NULL AND i.public_code IS NOT NULL
      FOR UPDATE OF i, d
    ), created AS (
      INSERT INTO factory_edit_requests(
        id, instance_id, owner_telegram_id, public_code, request_text, status,
        payment_source, free_credit_window_started_at
      )
      SELECT ${requestId}::uuid, d.instance_id, d.telegram_user_id, d.public_code,
        d.request_text, 'pending', d.payment_source,
        CASE WHEN d.payment_source='free' THEN d.free_credit_window_started_at ELSE NULL END
      FROM draft d
      WHERE (d.payment_source='free' OR d.paid_edit_credits > 0)
        AND NOT EXISTS (
          SELECT 1 FROM factory_edit_requests r
          WHERE r.instance_id=d.instance_id AND r.status IN ('pending','in_progress')
        )
      RETURNING *
    ), debited_quota AS (
      UPDATE factory_user_edit_quotas q
      SET free_credits=q.free_credits-1, updated_at=NOW()
      FROM created c
      WHERE c.payment_source='free'
        AND q.owner_telegram_id=c.owner_telegram_id
        AND q.window_started_at=c.free_credit_window_started_at
        AND q.free_credits > 0
      RETURNING q.owner_telegram_id
    ), debited_instance AS (
      UPDATE factory_instances i
      SET paid_edit_credits=i.paid_edit_credits-1, updated_at=NOW()
      FROM created c
      WHERE c.payment_source='paid'
        AND i.id=c.instance_id AND i.owner_telegram_id=c.owner_telegram_id
        AND i.paid_edit_credits > 0
      RETURNING i.id
    ), logged AS (
      INSERT INTO factory_edit_credit_ledger(instance_id, owner_telegram_id, delta, source, reference_id)
      SELECT c.instance_id, c.owner_telegram_id, -1, 'request_consumption', c.id
      FROM created c
      WHERE (c.payment_source='free' AND EXISTS (
          SELECT 1 FROM debited_quota q WHERE q.owner_telegram_id=c.owner_telegram_id
        ))
        OR (c.payment_source='paid' AND EXISTS (
          SELECT 1 FROM debited_instance i WHERE i.id=c.instance_id
        ))
      RETURNING id
    ), cleared AS (
      DELETE FROM factory_edit_drafts d USING created c
      WHERE d.telegram_user_id=c.owner_telegram_id AND d.instance_id=c.instance_id
        AND EXISTS (SELECT 1 FROM logged)
      RETURNING d.telegram_user_id
    )
    SELECT c.*, d.template_key, d.bot_username
    FROM created c
    JOIN draft d ON d.instance_id=c.instance_id
    WHERE EXISTS (SELECT 1 FROM cleared)
  `;
}

export async function transitionEditRequest(db: Query, adminId: number, action: string, requestId: string) {
  return db`
    WITH locked AS MATERIALIZED (
      SELECT r.id, r.instance_id, r.owner_telegram_id, r.payment_source,
        r.free_credit_window_started_at
      FROM factory_edit_requests r
      JOIN factory_instances i ON i.id=r.instance_id AND i.owner_telegram_id=r.owner_telegram_id
      WHERE r.id=${requestId}::uuid AND r.status IN ('pending','in_progress')
      FOR UPDATE OF i, r
    ), changed AS (
      UPDATE factory_edit_requests r SET status=${action}, handled_by=${adminId}, updated_at=NOW()
      FROM locked l WHERE r.id=l.id AND r.status IN ('pending','in_progress')
      RETURNING r.*
    ), refunded_paid AS (
      UPDATE factory_instances i
      SET paid_edit_credits=i.paid_edit_credits+1, updated_at=NOW()
      FROM changed c
      WHERE i.id=c.instance_id AND i.owner_telegram_id=c.owner_telegram_id
        AND c.status='rejected' AND c.payment_source='paid'
      RETURNING i.id AS instance_id, i.owner_telegram_id
    ), refunded_free AS (
      UPDATE factory_user_edit_quotas q
      SET free_credits=LEAST(2, q.free_credits+1), updated_at=NOW()
      FROM changed c
      WHERE c.status='rejected' AND c.payment_source='free'
        AND q.owner_telegram_id=c.owner_telegram_id
        AND q.window_started_at=c.free_credit_window_started_at
        AND q.window_started_at > NOW() - INTERVAL '24 hours'
      RETURNING c.instance_id, q.owner_telegram_id
    ), refunded AS (
      SELECT instance_id, owner_telegram_id FROM refunded_paid
      UNION ALL
      SELECT instance_id, owner_telegram_id FROM refunded_free
    ), logged AS (
      INSERT INTO factory_edit_credit_ledger(instance_id, owner_telegram_id, delta, source, reference_id, actor_telegram_id)
      SELECT c.instance_id, c.owner_telegram_id, 1, 'refund', c.id, ${adminId}
      FROM changed c JOIN refunded f
        ON f.instance_id=c.instance_id AND f.owner_telegram_id=c.owner_telegram_id
      RETURNING id
    )
    SELECT c.* FROM changed c LEFT JOIN (SELECT count(*) FROM logged) l ON true
  `;
}
