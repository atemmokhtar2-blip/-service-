import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { consumeEditCredit, getEditCreditStatus, transitionEditRequest } from '../src/edit-credit-store.ts';

async function fixture() {
  const pg = new PGlite();
  await pg.exec(await readFile(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
  const ids = [randomUUID(), randomUUID()];
  await pg.query('INSERT INTO factory_users(telegram_user_id) VALUES (1)');
  for (let i = 0; i < ids.length; i++) {
    await pg.query(`INSERT INTO factory_instances(id, owner_telegram_id, template_key, status, request_id, public_code)
      VALUES ($1, 1, $2, 'active', $3, $4)`, [ids[i], `template-${i}`, randomUUID(), `XV-TESTCODE${i}`]);
  }
  async function draft(instanceId = ids[0]) {
    await pg.query(`INSERT INTO factory_edit_drafts(telegram_user_id,instance_id,request_text)
      VALUES (1,$1,'Please change the welcome message') ON CONFLICT (telegram_user_id)
      DO UPDATE SET instance_id=EXCLUDED.instance_id,request_text=EXCLUDED.request_text`, [instanceId]);
  }
  const db = async (strings, ...values) => {
    const text = strings.reduce((s, part, i) => s + part + (i < values.length ? '$' + (i + 1) : ''), '');
    return (await pg.query(text, values)).rows;
  };
  const quota = async () => (await pg.query('SELECT free_credits,window_started_at FROM factory_user_edit_quotas WHERE owner_telegram_id=1')).rows[0];
  const paid = async (instanceId = ids[0]) => (await pg.query('SELECT paid_edit_credits FROM factory_instances WHERE id=$1', [instanceId])).rows[0].paid_edit_credits;
  const count = async (table) => Number((await pg.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  await draft();
  return {pg,ids,db,draft,quota,paid,count};
}

test('each user gets two free requests shared across all their instances', async () => {
  const f = await fixture();
  try {
    const first = randomUUID();
    assert.equal((await consumeEditCredit(f.db,1,first))[0].payment_source,'free');
    assert.equal((await f.quota()).free_credits,1);
    await transitionEditRequest(f.db,99,'completed',first);

    await f.draft(f.ids[1]);
    const second = randomUUID();
    assert.equal((await consumeEditCredit(f.db,1,second))[0].payment_source,'free');
    assert.equal((await f.quota()).free_credits,0);
    await transitionEditRequest(f.db,99,'completed',second);

    await f.draft(f.ids[0]);
    assert.equal((await consumeEditCredit(f.db,1,randomUUID())).length,0);
    assert.equal((await f.quota()).free_credits,0);
    assert.equal(await f.count('factory_edit_requests'),2);
  } finally { await f.pg.close(); }
});

test('free balance resets after 24 hours and unused balance does not roll over', async () => {
  const f = await fixture();
  try {
    const first = randomUUID();
    await consumeEditCredit(f.db,1,first);
    await transitionEditRequest(f.db,99,'completed',first);
    await f.pg.query("UPDATE factory_user_edit_quotas SET free_credits=1, window_started_at=NOW()-INTERVAL '25 hours' WHERE owner_telegram_id=1");
    const status = await getEditCreditStatus(f.db,1,f.ids[0]);
    assert.equal(status[0].free_credits,2);
    assert.equal(status[0].resets_at,null);

    await f.draft();
    const second = await consumeEditCredit(f.db,1,randomUUID());
    assert.equal(second[0].payment_source,'free');
    assert.equal((await f.quota()).free_credits,1);
    assert.ok(new Date((await f.quota()).window_started_at).getTime() > Date.now()-60_000);
  } finally { await f.pg.close(); }
});

test('a request cannot consume twice while the same instance has an open request', async () => {
  const f = await fixture();
  try {
    await consumeEditCredit(f.db,1,randomUUID());
    await f.draft();
    assert.equal((await consumeEditCredit(f.db,1,randomUUID())).length,0);
    assert.equal((await f.quota()).free_credits,1);
    assert.equal(await f.count('factory_edit_credit_ledger'),1);
  } finally { await f.pg.close(); }
});

test('ledger failure rolls back the request, daily debit and draft removal', async () => {
  const f = await fixture();
  try {
    await f.pg.exec(`CREATE FUNCTION fail_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test ledger failure'; END $$;
      CREATE TRIGGER fail_ledger BEFORE INSERT ON factory_edit_credit_ledger FOR EACH ROW EXECUTE FUNCTION fail_ledger();`);
    await assert.rejects(consumeEditCredit(f.db,1,randomUUID()));
    assert.equal((await f.quota()).free_credits,2);
    assert.equal(await f.count('factory_edit_requests'),0);
    assert.equal(await f.count('factory_edit_drafts'),1);
  } finally { await f.pg.close(); }
});

test('paid credits remain separate and a rejected paid request refunds once', async () => {
  const f = await fixture();
  try {
    await f.pg.query("INSERT INTO factory_user_edit_quotas(owner_telegram_id,free_credits,window_started_at) VALUES (1,0,NOW())");
    await f.pg.query("UPDATE factory_instances SET paid_edit_credits=2 WHERE id=$1", [f.ids[0]]);
    const request = randomUUID();
    assert.equal((await consumeEditCredit(f.db,1,request))[0].payment_source,'paid');
    assert.equal(await f.paid(),1);
    assert.equal((await transitionEditRequest(f.db,99,'rejected',request)).length,1);
    assert.equal(await f.paid(),2);
    assert.equal((await transitionEditRequest(f.db,99,'rejected',request)).length,0);
    assert.equal(await f.count('factory_edit_credit_ledger'),2);
  } finally { await f.pg.close(); }
});

test('free rejection refunds only in the same active 24-hour window', async () => {
  const f = await fixture();
  try {
    const request = randomUUID();
    await consumeEditCredit(f.db,1,request);
    assert.equal((await f.quota()).free_credits,1);
    await transitionEditRequest(f.db,99,'rejected',request);
    assert.equal((await f.quota()).free_credits,2);

    await f.draft();
    const expiredRequest = randomUUID();
    await consumeEditCredit(f.db,1,expiredRequest);
    await f.pg.query("UPDATE factory_user_edit_quotas SET free_credits=2,window_started_at=NOW()-INTERVAL '25 hours' WHERE owner_telegram_id=1");
    await transitionEditRequest(f.db,99,'rejected',expiredRequest);
    assert.equal((await f.quota()).free_credits,2);
    assert.equal(await f.count('factory_edit_credit_ledger'),3);
  } finally { await f.pg.close(); }
});

test('another Telegram user cannot consume an owner draft or quota', async () => {
  const f = await fixture();
  try {
    assert.equal((await consumeEditCredit(f.db,2,randomUUID())).length,0);
    assert.equal(await f.count('factory_edit_requests'),0);
    assert.equal(await f.count('factory_edit_credit_ledger'),0);
  } finally { await f.pg.close(); }
});
