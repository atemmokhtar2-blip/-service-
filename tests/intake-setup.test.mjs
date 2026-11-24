import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import {
  intakeSetupConfigFromEnv,
  ensureIntakeSetupSchema,
  createSetupState,
  consumeSetupState,
  buildConsentUrl,
  exchangeCodeForTokens,
  storeSenderAuth,
  INTAKE_SETUP_SCOPE, browserVerifier, setupCookie, hashState, loadSenderRefreshToken, validOrigin,
} from '../src/intake-setup.ts';
import { encryptToken, decryptToken } from '../src/security.ts';

process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);

const ENV_OK = {
  INTAKE_SETUP_ENABLED: 'true',
  TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
  INTAKE_SETUP_OWNER_TOKEN: 'o'.repeat(32),
  GOOGLE_INTAKE_CLIENT_ID: 'cid.apps.googleusercontent.com',
  GOOGLE_INTAKE_CLIENT_SECRET: 'csecret',
  GOOGLE_INTAKE_SENDER: 'sender@example.com',
  PUBLIC_BASE_URL: 'https://factory.example.com',
};
const CONFIG = intakeSetupConfigFromEnv(ENV_OK);

async function fixture() {
  const pg = new PGlite();
  const db = async (strings, ...values) => {
    const text = strings.reduce((s, part, i) => s + part + (i < values.length ? '$' + (i + 1) : ''), '');
    return (await pg.query(text, values)).rows;
  };
  await ensureIntakeSetupSchema(db);
  return db;
}

test('config is null unless explicitly enabled with a full environment', () => {
  assert.equal(intakeSetupConfigFromEnv({}), null);
  assert.equal(intakeSetupConfigFromEnv({ ...ENV_OK, INTAKE_SETUP_ENABLED: 'false' }), null);
  assert.equal(intakeSetupConfigFromEnv({ ...ENV_OK, INTAKE_SETUP_OWNER_TOKEN: 'short' }), null);
  assert.equal(intakeSetupConfigFromEnv({ ...ENV_OK, GOOGLE_INTAKE_CLIENT_ID: '' }), null);
  assert.equal(intakeSetupConfigFromEnv({ ...ENV_OK, PUBLIC_BASE_URL: 'http://insecure.example.com' }), null);
  assert.ok(CONFIG);
  assert.equal(CONFIG.redirectUri, 'https://factory.example.com/api/intake-setup/callback');
});

test('state is created once and consumed atomically exactly once', async () => {
  const db = await fixture();
  const state = await createSetupState(db);
  assert.match(state, /^[a-f0-9]{64}$/);
  assert.equal(await consumeSetupState(db, state), true);
  assert.equal(await consumeSetupState(db, state), false, 'replay must fail');
  assert.equal(await consumeSetupState(db, 'f'.repeat(64)), false, 'unknown state must fail');
  assert.equal(await consumeSetupState(db, 'not-a-state'), false, 'malformed state must fail');
});

test('consent URL carries offline access, consent prompt, scope and state', () => {
  const url = new URL(buildConsentUrl(CONFIG, 's'.repeat(64), 'a'.repeat(64)));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), CONFIG.clientId);
  assert.equal(url.searchParams.get('redirect_uri'), CONFIG.redirectUri);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), INTAKE_SETUP_SCOPE);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('state'), 's'.repeat(64));
  assert.equal(url.searchParams.get('client_secret'), null, 'secret never leaves the server');
});

test('code exchange posts once and returns the refresh token and granted scope', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, body: init.body });
    return { ok: true, json: async () => ({ refresh_token: 'rtoken', scope: INTAKE_SETUP_SCOPE, access_token: 'at' }) };
  };
  const result = await exchangeCodeForTokens(CONFIG, 'authcode', 'a'.repeat(64), fetcher);
  assert.equal(result.refreshToken, 'rtoken');
  assert.equal(result.grantedScope, INTAKE_SETUP_SCOPE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  const body = new URLSearchParams(calls[0].body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'authcode');
  assert.equal(body.get('redirect_uri'), CONFIG.redirectUri);
  assert.equal(body.get('client_id'), CONFIG.clientId);
  assert.equal(body.get('client_secret'), CONFIG.clientSecret);
});

test('code exchange fails closed on HTTP errors, missing refresh token and bad codes', async () => {
  const httpError = async () => ({ ok: false, status: 400, json: async () => ({}) });
  await assert.rejects(exchangeCodeForTokens(CONFIG, 'authcode', 'a'.repeat(64), httpError), /token_exchange_http_400/);
  const noRefresh = async () => ({ ok: true, json: async () => ({ access_token: 'at' }) });
  await assert.rejects(exchangeCodeForTokens(CONFIG, 'authcode', 'a'.repeat(64), noRefresh), /token_exchange_no_refresh_token/);
  await assert.rejects(exchangeCodeForTokens(CONFIG, '', 'a'.repeat(64), async () => { throw new Error('must not fetch'); }), /invalid_code/);
  await assert.rejects(exchangeCodeForTokens(CONFIG, 'a\nb', 'a'.repeat(64), async () => { throw new Error('must not fetch'); }), /invalid_code/);
});

test('sender auth stores encrypted, round-trips, and re-setup replaces the singleton row', async () => {
  const db = await fixture();
  const encrypted1 = encryptToken('refresh-one');
  await storeSenderAuth(db, { sender: 'sender@example.com', encryptedRefreshToken: encrypted1, grantedScope: INTAKE_SETUP_SCOPE });
  let rows = await db`SELECT * FROM factory_intake_sender_auth`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sender, 'sender@example.com');
  assert.notEqual(rows[0].encrypted_refresh_token, 'refresh-one', 'never stored in plaintext');
  assert.equal(decryptToken(rows[0].encrypted_refresh_token), 'refresh-one');
  assert.equal(rows[0].granted_scope, INTAKE_SETUP_SCOPE);
  await storeSenderAuth(db, { sender: 'sender@example.com', encryptedRefreshToken: encryptToken('refresh-two'), grantedScope: INTAKE_SETUP_SCOPE });
  rows = await db`SELECT * FROM factory_intake_sender_auth`;
  assert.equal(rows.length, 1, 'singleton: re-setup replaces, never accumulates');
  assert.equal(decryptToken(rows[0].encrypted_refresh_token), 'refresh-two');
});

test('browser binding rejects missing, malformed, duplicate and mismatched cookies', () => {
  const state = 'a'.repeat(64), verifier = 'b'.repeat(64);
  const cookie = setupCookie(state, verifier).split(';')[0];
  assert.equal(browserVerifier(cookie, state), verifier);
  assert.equal(browserVerifier('', state), null);
  assert.equal(browserVerifier(cookie, 'c'.repeat(64)), null);
  assert.equal(browserVerifier(cookie + '; ' + cookie, state), null);
  assert.equal(browserVerifier(cookie, 'bad'), null);
});
test('state storage is hashed, expired states fail, concurrent use wins only once', async () => {
  const db = await fixture();
  const state = await createSetupState(db);
  const rows = await db`SELECT state FROM factory_intake_setup_states`;
  assert.equal(rows[0].state, hashState(state));
  assert.notEqual(rows[0].state, state);
  await db`UPDATE factory_intake_setup_states SET created_at = NOW() - INTERVAL '11 minutes'`;
  assert.equal(await consumeSetupState(db, state), false);
  const fresh = await createSetupState(db);
  const results = await Promise.all([consumeSetupState(db, fresh), consumeSetupState(db, fresh)]);
  assert.equal(results.filter(Boolean).length, 1);
});
test('unexpected or missing scope is rejected before tokens can be stored', async () => {
  for (const scope of [undefined, '', INTAKE_SETUP_SCOPE + ' openid']) {
    await assert.rejects(exchangeCodeForTokens(CONFIG, 'code', 'a'.repeat(64), async () => ({ok:true,json:async()=>({refresh_token:'rt',scope})})), /scope_rejected/);
  }
});
test('origin and encryption config fail closed', () => {
  for (const origin of ['http://example.com', 'https://u:p@example.com', 'https://example.com/a', 'https://example.com?x=1', 'https://example.com:123']) assert.equal(validOrigin(origin), false);
  assert.equal(validOrigin('https://example.com'), true);
  assert.equal(intakeSetupConfigFromEnv({...ENV_OK,TOKEN_ENCRYPTION_KEY:''}), null);
});
test('stored sender auth is consumed only for matching sender and exact scope', async () => {
  const db = await fixture();
  await assert.rejects(loadSenderRefreshToken(db, 'sender@example.com', decryptToken), /sender_auth_invalid/);
  await storeSenderAuth(db, {sender:'sender@example.com',encryptedRefreshToken:encryptToken('rt'),grantedScope:INTAKE_SETUP_SCOPE});
  assert.equal(await loadSenderRefreshToken(db, 'sender@example.com', decryptToken), 'rt');
  await assert.rejects(loadSenderRefreshToken(db, 'other@example.com', decryptToken), /sender_auth_invalid/);
});
