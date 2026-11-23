import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { consumeEditCredit, transitionEditRequest } from '../src/edit-credit-store.ts';

async function fixture() {
  const pg = new PGlite();
  await pg.exec(await readFile(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
  const id = randomUUID();
  await pg.query('INSERT INTO factory_users(telegram_user_id) VALUES (1)');
  await pg.query(`INSERT INTO factory_instances(id, owner_telegram_id, template_key, status, request_id, public_code)
    VALUES ($1, 1, 'download', 'active', $2, 'XV-TESTCODE')`, [id, randomUUID()]);
  async function draft() {
    await pg.query(`INSERT INTO factory_edit_drafts(telegram_user_id,instance_id,request_text)
      VALUES (1,$1,'Please change the welcome message') ON CONFLICT (telegram_user_id)
      DO UPDATE SET instance_id=EXCLUDED.instance_id,request_text=EXCLUDED.request_text`, [id]);
  }
  const db = async (strings, ...values) => {
    const text = strings.reduce((s, part, i) => s + part + (i < values.length ? '$' + (i + 1) : ''), '');
    return (await pg.query(text, values)).rows;
  };
  const balance = async () => (await pg.query('SELECT free_edit_credits,paid_edit_credits FROM factory_instances WHERE id=$1', [id])).rows[0];
  const count = async (table) => Number((await pg.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  await draft();
  return {pg,id,db,draft,balance,count};
}

test('edit debit, request, ledger and draft consumption commit together and replay is harmless', async () => {
  const f = await fixture();
  try {
    const request = randomUUID();
    const rows = await consumeEditCredit(f.db,1,request);
    assert.equal(rows[0].payment_source,'free');
    assert.equal((await f.balance()).free_edit_credits,0);
    assert.equal(await f.count('factory_edit_requests'),1);
    assert.equal(await f.count('factory_edit_credit_ledger'),1);
    assert.equal(await f.count('factory_edit_drafts'),0);
    assert.equal((await consumeEditCredit(f.db,1,randomUUID())).length,0);
    assert.equal(await f.count('factory_edit_credit_ledger'),1);
  } finally { await f.pg.close(); }
});

test('open request and insufficient credits cannot debit an account', async () => {
  const f = await fixture();
  try {
    await consumeEditCredit(f.db,1,randomUUID());
    await f.draft();
    assert.equal((await consumeEditCredit(f.db,1,randomUUID())).length,0);
    assert.equal((await f.balance()).free_edit_credits,0);
    assert.equal(await f.count('factory_edit_credit_ledger'),1);
    await f.pg.query("UPDATE factory_edit_requests SET status='completed'");
    assert.equal((await consumeEditCredit(f.db,1,randomUUID())).length,0);
    assert.equal(await f.count('factory_edit_credit_ledger'),1);
  } finally { await f.pg.close(); }
});

test('ledger failure rolls back the debit, request and draft removal', async () => {
  const f = await fixture();
  try {
    await f.pg.exec(`CREATE FUNCTION fail_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test ledger failure'; END $$;
      CREATE TRIGGER fail_ledger BEFORE INSERT ON factory_edit_credit_ledger FOR EACH ROW EXECUTE FUNCTION fail_ledger();`);
    await assert.rejects(consumeEditCredit(f.db,1,randomUUID()));
    assert.equal((await f.balance()).free_edit_credits,1);
    assert.equal(await f.count('factory_edit_requests'),0);
    assert.equal(await f.count('factory_edit_drafts'),1);
  } finally { await f.pg.close(); }
});

test('paid-credit rejection refunds and records it once even on repeated actions', async () => {
  const f = await fixture();
  try {
    await f.pg.query("UPDATE factory_instances SET free_edit_period=date_trunc('month',NOW())::date,free_edit_credits=0,paid_edit_credits=2");
    const request = randomUUID();
    assert.equal((await consumeEditCredit(f.db,1,request))[0].payment_source,'paid');
    assert.equal((await f.balance()).paid_edit_credits,1);
    assert.equal((await transitionEditRequest(f.db,99,'rejected',request)).length,1);
    assert.equal((await f.balance()).paid_edit_credits,2);
    assert.equal((await transitionEditRequest(f.db,99,'rejected',request)).length,0);
    assert.equal(await f.count('factory_edit_credit_ledger'),2);
  } finally { await f.pg.close(); }
});

test('refund ledger failure rolls back both rejection and credit restoration', async () => {
  const f = await fixture();
  try {
    const request = randomUUID();
    await consumeEditCredit(f.db,1,request);
    await f.pg.exec(`CREATE FUNCTION fail_refund() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.source='refund' THEN RAISE EXCEPTION 'test refund failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_refund BEFORE INSERT ON factory_edit_credit_ledger FOR EACH ROW EXECUTE FUNCTION fail_refund();`);
    await assert.rejects(transitionEditRequest(f.db,99,'rejected',request));
    assert.equal((await f.balance()).free_edit_credits,0);
    assert.equal((await f.pg.query('SELECT status FROM factory_edit_requests WHERE id=$1',[request])).rows[0].status,'pending');
    assert.equal(await f.count('factory_edit_credit_ledger'),1);
  } finally { await f.pg.close(); }
});

test('rejecting last month free request cannot inflate this month allowance', async () => {
  const f = await fixture();
  try {
    const request = randomUUID();
    await consumeEditCredit(f.db,1,request);
    await f.pg.query("UPDATE factory_edit_requests SET created_at=NOW()-INTERVAL '1 month'");
    await f.pg.query("UPDATE factory_instances SET free_edit_period=date_trunc('month',NOW())::date,free_edit_credits=1");
    await transitionEditRequest(f.db,99,'rejected',request);
    assert.equal((await f.balance()).free_edit_credits,1);
    assert.equal(await f.count('factory_edit_credit_ledger'),1);
  } finally { await f.pg.close(); }
});

test('free rejection restores only once; completion never refunds', async () => {
  const f = await fixture();
  try {
    const first = randomUUID();
    await consumeEditCredit(f.db,1,first);
    await transitionEditRequest(f.db,99,'rejected',first);
    assert.equal((await f.balance()).free_edit_credits,1);
    assert.equal((await transitionEditRequest(f.db,99,'rejected',first)).length,0);
    await f.draft();
    const second = randomUUID();
    await consumeEditCredit(f.db,1,second);
    await transitionEditRequest(f.db,99,'completed',second);
    assert.equal((await f.balance()).free_edit_credits,0);
    assert.equal((await transitionEditRequest(f.db,99,'rejected',second)).length,0);
    assert.equal(await f.count('factory_edit_credit_ledger'),3);
  } finally { await f.pg.close(); }
});

test('another user cannot consume an owner draft', async () => {
  const f = await fixture();
  try {
    assert.equal((await consumeEditCredit(f.db,2,randomUUID())).length,0);
    assert.equal((await f.balance()).free_edit_credits,1);
    assert.equal(await f.count('factory_edit_requests'),0);
    assert.equal(await f.count('factory_edit_drafts'),1);
  } finally { await f.pg.close(); }
});
