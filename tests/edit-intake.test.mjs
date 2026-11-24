import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import {
  intakeConfigFromEnv,
  ensureEditIntakeSchema,
  activateEditIntake,
  enqueueEditIntake,
  backfillEditIntake,
  claimEditIntakeBatch,
  processEditIntakeOutbox,
  buildIntakeSubject,
  buildIntakeBody,
  buildRawMessage,
} from '../src/edit-intake.ts';

const CONFIG = {
  to: 'intake@example.com',
  sender: 'sender@example.com',
  clientId: 'cid',
  clientSecret: 'csecret',
  refreshToken: 'rtoken',
};

async function fixture({ activate = true } = {}) {
  const pg = new PGlite();
  await pg.exec(await readFile(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
  const instanceId = randomUUID();
  await pg.query('INSERT INTO factory_users(telegram_user_id) VALUES (1)');
  await pg.query(`INSERT INTO factory_instances(id, owner_telegram_id, template_key, status, request_id, public_code, bot_username)
    VALUES ($1, 1, 'download', 'active', $2, 'XV-TESTCODE', 'test_bot')`, [instanceId, randomUUID()]);
  const db = async (strings, ...values) => {
    const text = strings.reduce((s, part, i) => s + part + (i < values.length ? '$' + (i + 1) : ''), '');
    return (await pg.query(text, values)).rows;
  };
  await ensureEditIntakeSchema(db);
  if (activate) await activateEditIntake(db);
  async function addRequest({ requestText = 'Please change the welcome message', createdAt = null, status = 'pending' } = {}) {
    const requestId = randomUUID();
    if (createdAt) {
      await pg.query(`INSERT INTO factory_edit_requests(id, instance_id, owner_telegram_id, public_code, request_text, status, payment_source, created_at)
        VALUES ($1, $2, 1, 'XV-TESTCODE', $3, $4, 'free', $5)`, [requestId, instanceId, requestText, status, createdAt]);
    } else {
      await pg.query(`INSERT INTO factory_edit_requests(id, instance_id, owner_telegram_id, public_code, request_text, status, payment_source)
        VALUES ($1, $2, 1, 'XV-TESTCODE', $3, $4, 'free')`, [requestId, instanceId, requestText, status]);
    }
    return requestId;
  }
  const outbox = async (requestId) =>
    (await pg.query('SELECT * FROM factory_edit_intake_outbox WHERE request_id=$1', [requestId])).rows[0];
  const count = async () => Number((await pg.query('SELECT count(*) AS n FROM factory_edit_intake_outbox')).rows[0].n);
  const backdate = async (requestId, minutes) =>
    pg.query('UPDATE factory_edit_intake_outbox SET updated_at=NOW() - ($2 || \' minutes\')::interval WHERE request_id=$1', [requestId, String(minutes)]);
  return { pg, db, instanceId, addRequest, outbox, count, backdate };
}

function fieldsFor(requestId, overrides = {}) {
  return {
    requestId,
    publicCode: 'XV-TESTCODE',
    templateKey: 'download',
    botUsername: 'test_bot',
    paymentSource: 'free',
    requestText: 'Please change the welcome message',
    ...overrides,
  };
}

function fetcherReturning({ tokenStatus = 200, sendStatus = 200, calls = [] } = {}) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return { ok: tokenStatus === 200, status: tokenStatus, json: async () => tokenStatus === 200 ? { access_token: 'at', expires_in: 3600 } : {} };
    }
    return { ok: sendStatus === 200, status: sendStatus, json: async () => ({ id: 'm1' }) };
  };
}

test('disabled unless explicitly enabled, and config requires every variable', () => {
  assert.equal(intakeConfigFromEnv({}), null);
  assert.equal(intakeConfigFromEnv({ EDIT_INTAKE_EMAIL_ENABLED: 'false' }), null);
  assert.equal(intakeConfigFromEnv({ EDIT_INTAKE_EMAIL_ENABLED: 'true' }), null);
  const full = {
    EDIT_INTAKE_EMAIL_ENABLED: 'true',
    EDIT_INTAKE_EMAIL_TO: CONFIG.to,
    GOOGLE_INTAKE_SENDER: CONFIG.sender,
    GOOGLE_INTAKE_CLIENT_ID: CONFIG.clientId,
    GOOGLE_INTAKE_CLIENT_SECRET: CONFIG.clientSecret,
    GOOGLE_INTAKE_REFRESH_TOKEN: CONFIG.refreshToken,
  };
  assert.deepEqual(intakeConfigFromEnv(full), CONFIG);
});

test('enqueue is idempotent per request and email carries no tokens or owner identity', async () => {
  const f = await fixture();
  try {
    const requestId = await f.addRequest();
    await enqueueEditIntake(f.db, CONFIG, fieldsFor(requestId));
    await enqueueEditIntake(f.db, CONFIG, fieldsFor(requestId));
    assert.equal(await f.count(), 1);
    const row = await f.outbox(requestId);
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 0);
    assert.ok(row.subject.includes('XV-TESTCODE'));
    assert.ok(row.subject.includes(requestId.slice(0, 8).toUpperCase()));
    assert.ok(row.body_text.includes(requestId));
    assert.ok(row.body_text.includes('Please change the welcome message'));
    assert.ok(!/token|secret|password/i.test(row.body_text));
    assert.ok(!row.body_text.includes('0104') && !row.body_text.includes('telegram'));
  } finally { await f.pg.close(); }
});

test('activation recorded with the first request timestamp recovers a crashed first enqueue', async () => {
  const f = await fixture({ activate: false });
  // The boundary case: the first enabled request commits, activation records
  // its creation time, and then the enqueue crashes. Backfill must include it.
  const first = await f.addRequest();
  await activateEditIntake(f.db, first);
  assert.equal(await backfillEditIntake(f.db, CONFIG), 1);
  assert.ok(await f.outbox(first));
});

test('activation recorded with the first request timestamp excludes all earlier requests', async () => {
  const f = await fixture({ activate: false });
  const before = await f.addRequest({ createdAt: new Date(Date.now() - 3600 * 1000), status: 'completed' });
  const first = await f.addRequest();
  await activateEditIntake(f.db, first);
  assert.equal(await backfillEditIntake(f.db, CONFIG), 1);
  assert.ok(await f.outbox(first));
  assert.equal(await f.outbox(before), undefined);
});

test('activation recorded with the first request timestamp covers requests created before the record exists', async () => {
  const f = await fixture({ activate: false });
  // A second request created after the boundary request but before the
  // processing pass runs is post-activation and must be recoverable too.
  const first = await f.addRequest({ createdAt: new Date(Date.now() - 120 * 1000), status: 'completed' });
  const second = await f.addRequest({ createdAt: new Date(Date.now() - 60 * 1000) });
  await activateEditIntake(f.db, first);
  assert.equal(await backfillEditIntake(f.db, CONFIG), 2);
  assert.ok(await f.outbox(first));
  assert.ok(await f.outbox(second));
});

test('backfill covers only requests created after activation, and runs once per request', async () => {
  const f = await fixture({ activate: false });
  try {
    const beforeActivation = await f.addRequest({ createdAt: new Date(Date.now() - 3600 * 1000), status: 'completed' });
    await activateEditIntake(f.db);
    const afterActivation = await f.addRequest();
    assert.equal(await backfillEditIntake(f.db, CONFIG), 1);
    assert.equal(await backfillEditIntake(f.db, CONFIG), 0);
    assert.equal(await f.count(), 1);
    assert.ok(await f.outbox(afterActivation));
    assert.equal(await f.outbox(beforeActivation), undefined);
    // Without any activation record at all, nothing is backfilled.
    const g = await fixture({ activate: false });
    try {
      await g.addRequest();
      assert.equal(await backfillEditIntake(g.db, CONFIG), 0);
    } finally { await g.pg.close(); }
  } finally { await f.pg.close(); }
});

test('processing with null config is a no-op and never calls the network', async () => {
  const f = await fixture();
  try {
    const requestId = await f.addRequest();
    await enqueueEditIntake(f.db, CONFIG, fieldsFor(requestId));
    const calls = [];
    const result = await processEditIntakeOutbox(f.db, null, fetcherReturning({ calls }));
    assert.deepEqual(result, { sent: 0, failed: 0 });
    assert.equal(calls.length, 0);
    assert.equal((await f.outbox(requestId)).status, 'pending');
  } finally { await f.pg.close(); }
});

test('successful send marks the row sent with a Gmail API request built from the outbox', async () => {
  const f = await fixture();
  try {
    const requestId = await f.addRequest();
    await enqueueEditIntake(f.db, CONFIG, fieldsFor(requestId));
    const calls = [];
    const result = await processEditIntakeOutbox(f.db, CONFIG, fetcherReturning({ calls }));
    assert.deepEqual(result, { sent: 1, failed: 0 });
    const row = await f.outbox(requestId);
    assert.equal(row.status, 'sent');
    assert.ok(row.sent_at);
    assert.equal(calls.length, 2);
    assert.ok(String(calls[0].url).includes('oauth2.googleapis.com/token'));
    assert.ok(String(calls[1].url).includes('gmail.googleapis.com/gmail/v1/users/me/messages/send'));
    const raw = JSON.parse(calls[1].init.body).raw;
    const message = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    assert.ok(message.includes('To: intake@example.com'));
    assert.ok(message.includes('From: sender@example.com'));
    assert.ok(!message.includes(CONFIG.clientSecret) && !message.includes(CONFIG.refreshToken));
    assert.equal(calls[1].init.headers.authorization, 'Bearer at');
    // A second run has nothing left to send.
    const again = await processEditIntakeOutbox(f.db, CONFIG, fetcherReturning({ calls: [] }));
    assert.deepEqual(again, { sent: 0, failed: 0 });
  } finally { await f.pg.close(); }
});

test('failed sends retry with attempts counted and are marked failed after the cap', async () => {
  const f = await fixture();
  try {
    const requestId = await f.addRequest();
    await enqueueEditIntake(f.db, CONFIG, fieldsFor(requestId));
    for (let i = 0; i < 4; i++) {
      const result = await processEditIntakeOutbox(f.db, CONFIG, fetcherReturning({ sendStatus: 500 }));
      assert.deepEqual(result, { sent: 0, failed: 1 });
      assert.equal((await f.outbox(requestId)).status, 'pending');
    }
    await processEditIntakeOutbox(f.db, CONFIG, fetcherReturning({ sendStatus: 500 }));
    const row = await f.outbox(requestId);
    assert.equal(row.attempts, 5);
    assert.equal(row.status, 'failed');
    assert.equal(row.last_error, 'gmail_send_http_500');
    // Exhausted rows are no longer picked up.
    const result = await processEditIntakeOutbox(f.db, CONFIG, fetcherReturning({ sendStatus: 200 }));
    assert.deepEqual(result, { sent: 0, failed: 0 });
  } finally { await f.pg.close(); }
});

test('token refresh failure is recorded as a coded error without credentials', async () => {
  const f = await fixture();
  try {
    const requestId = await f.addRequest();
    await enqueueEditIntake(f.db, CONFIG, fieldsFor(requestId));
    await processEditIntakeOutbox(f.db, CONFIG, fetcherReturning({ tokenStatus: 401 }));
    const row = await f.outbox(requestId);
    assert.equal(row.status, 'pending');
    assert.equal(row.last_error, 'token_refresh_http_401');
    assert.ok(!String(row.last_error).includes(CONFIG.clientSecret));
  } finally { await f.pg.close(); }
});

test('a claimed row is not sent twice concurrently and a killed sender is reclaimed after the stale window', async () => {
  const f = await fixture();
  try {
    const requestId = await f.addRequest();
    await enqueueEditIntake(f.db, CONFIG, fieldsFor(requestId));
    // First worker claims the row (then "dies" before finishing).
    const first = await claimEditIntakeBatch(f.db);
    assert.equal(first.length, 1);
    assert.equal((await f.outbox(requestId)).status, 'sending');
    assert.equal(Number(first[0].attempts), 1);
    // A concurrent worker must not pick the freshly claimed row.
    assert.equal((await claimEditIntakeBatch(f.db)).length, 0);
    const calls = [];
    const blocked = await processEditIntakeOutbox(f.db, CONFIG, fetcherReturning({ calls }));
    assert.deepEqual(blocked, { sent: 0, failed: 0 });
    assert.equal(calls.length, 0);
    // After the stale window the row becomes claimable and is sent.
    await f.backdate(requestId, 11);
    const result = await processEditIntakeOutbox(f.db, CONFIG, fetcherReturning({ calls }));
    assert.deepEqual(result, { sent: 1, failed: 0 });
    const row = await f.outbox(requestId);
    assert.equal(row.status, 'sent');
    assert.equal(row.attempts, 2);
  } finally { await f.pg.close(); }
});

test('a zero processing budget leaves rows pending and never calls the network', async () => {
  const f = await fixture();
  try {
    const requestId = await f.addRequest();
    await enqueueEditIntake(f.db, CONFIG, fieldsFor(requestId));
    const calls = [];
    const result = await processEditIntakeOutbox(f.db, CONFIG, fetcherReturning({ calls }), 0);
    assert.deepEqual(result, { sent: 0, failed: 0 });
    assert.equal(calls.length, 0);
    assert.equal((await f.outbox(requestId)).status, 'pending');
  } finally { await f.pg.close(); }
});

test('raw message rejects header injection and encodes UTF-8 subject', () => {
  const subject = buildIntakeSubject(fieldsFor('12345678-1234-1234-1234-123456789abc'));
  assert.equal(subject, '[factory-edit-intake] XV-TESTCODE 12345678');
  const raw = buildRawMessage(CONFIG, subject, buildIntakeBody(fieldsFor('12345678-1234-1234-1234-123456789abc')));
  assert.ok(raw.includes('Subject: =?UTF-8?B?'));
  assert.ok(raw.includes('Content-Type: text/plain; charset=UTF-8'));
  assert.throws(
    () => buildRawMessage({ ...CONFIG, to: 'a@example.com\r\nBCC: x@y.z' }, 's', 'b'),
    /invalid_address_header/,
  );
});
