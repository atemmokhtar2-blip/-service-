# Edit-intake sender setup (one-time OAuth)

This document covers the optional, disabled-by-default setup flow that
authorizes the Gmail sender for the edit-request intake. Read
[EDIT_INTAKE.md](EDIT_INTAKE.md) first: that document owns the intake feature
itself. Nothing here enables the intake.

## What this is

The intake sends mail through the Gmail API with an OAuth2 refresh token
(scope `https://www.googleapis.com/auth/gmail.send` only). The setup flow lets
the owner complete Google's consent screen once, instead of handling the
refresh token by hand:

1. `GET /api/intake-setup` shows a minimal owner-key password form.
   Its same-origin POST validates a Strict browser nonce cookie and the key,
   creates a single-use state and 303-redirects the browser to Google's
   consent screen.
2. Google returns the browser to
   `GET /api/intake-setup/callback?state=...&code=...`, which consumes the
   state, exchanges the code exactly once, and stores the refresh token
   AES-256-GCM-encrypted (the same `TOKEN_ENCRYPTION_KEY` scheme as bot
   tokens) in the singleton row of `factory_intake_sender_auth`, together
   with the scope Google actually granted.

## Security properties

- **Disabled by default.** Unless `INTAKE_SETUP_ENABLED="true"`, both routes
  answer 404 and no table is created. Deployments that never set the variable
  expose nothing.
- **Owner-only start.** Without the owner bearer token (at least 32 random
  bytes), no consent flow can begin. The token is compared in constant time.
- **Server-side single-use state.** States are random 32-byte hex strings
  stored as SHA-256 digests in `factory_intake_setup_states`, valid for 10 minutes, consumed
  atomically on first use. Unknown, expired, malformed, or replayed states
  fail; a denied consent (`?error=...`) also consumes its state.
- **Browser binding and PKCE.** A Secure, HttpOnly, SameSite=Lax cookie binds
  the callback to the initiating browser and carries the PKCE verifier.
  The authorization URL carries only its S256 challenge. Missing, duplicate
  or mismatched cookies fail before state consumption or token exchange.
- **One-time server-side exchange.** The authorization code is exchanged
  exactly once against `https://oauth2.googleapis.com/token`. Codes and
  tokens never appear in logs, pages, or responses; error logs carry only the
  error class.
- **Encrypted at rest.** The refresh token is never stored in plaintext.
  Re-running the flow replaces the singleton row (owner re-consent recovery);
  it never accumulates rows.
- **Strict scope check.** The exchange rejects absent or unexpected scopes before storage. Only the exact `gmail.send` scope is accepted.

## What enabling this does NOT do

- It does not enable the intake. `EDIT_INTAKE_EMAIL_ENABLED` and the explicit
  `EDIT_INTAKE_ACTIVATED_AFTER` cutoff remain the operator's separate
  decisions. With `GOOGLE_INTAKE_AUTH_SOURCE=database`, the sender reads
  and decrypts the singleton token only during send processing. It rejects
  sender/scope mismatches. Without this explicit selector, existing env-token
  behavior is unchanged. Enqueueing remains database-only.
- It does not change the request flow, the webhook, or the cron.

## Operator procedure (when the time comes)

1. Confirm the OAuth client's Authorized redirect URI is exactly
   `https://<deployment>/api/intake-setup/callback` on the production domain.
2. Set `INTAKE_SETUP_OWNER_TOKEN` (generate with `openssl rand -hex 32`),
   `INTAKE_SETUP_ENABLED=true`, and the `GOOGLE_INTAKE_CLIENT_ID` /
   `GOOGLE_INTAKE_CLIENT_SECRET` / `GOOGLE_INTAKE_SENDER` values for the
   sender project.
3. Open `/api/intake-setup` in the consent browser. Fill the owner setup key
   through secure secret handling, never chat or a URL. Submit the form,
   complete consent as the sender account, and confirm the success page.
4. Unset `INTAKE_SETUP_ENABLED` again. The stored token stays; the route
   closes.
5. Select `GOOGLE_INTAKE_AUTH_SOURCE=database` for stored-token consumption.
   Keep `EDIT_INTAKE_EMAIL_ENABLED=false` until receiver deduplication,
   subscription, cutoff and an approved end-to-end test are ready.
6. Verify `factory_intake_sender_auth.granted_scope` is exactly
   `https://www.googleapis.com/auth/gmail.send` before any later wiring.

## Google-side notes

- The sender project uses a Personal-mode OAuth client: only the sender
  account can authorize it, and the mode cannot be switched later. That is
  the owner's accepted, recorded decision.
- Google may delete OAuth clients that stay inactive for 6 months. If the
  consent step is delayed by months, re-check the client still exists before
  relying on it.
