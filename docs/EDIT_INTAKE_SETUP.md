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

1. `GET /api/intake-setup` with `Authorization: Bearer $INTAKE_SETUP_OWNER_TOKEN`
   creates a single-use state and 302-redirects the browser to Google's
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
  stored in `factory_intake_setup_states`, valid for 10 minutes, consumed
  atomically on first use. Unknown, expired, malformed, or replayed states
  fail; a denied consent (`?error=...`) also consumes its state.
- **One-time server-side exchange.** The authorization code is exchanged
  exactly once against `https://oauth2.googleapis.com/token`. Codes and
  tokens never appear in logs, pages, or responses; error logs carry only the
  error class.
- **Encrypted at rest.** The refresh token is never stored in plaintext.
  Re-running the flow replaces the singleton row (owner re-consent recovery);
  it never accumulates rows.
- **Scope evidence.** The granted scope string returned by Google is stored
  so a later review can confirm the authorization never exceeded
  `gmail.send`.

## What enabling this does NOT do

- It does not enable the intake. `EDIT_INTAKE_EMAIL_ENABLED` and the explicit
  `EDIT_INTAKE_ACTIVATED_AFTER` cutoff remain the operator's separate
  decisions, and the intake still reads its sender credentials from
  environment variables. Wiring the intake to consume
  `factory_intake_sender_auth` is a separate, reviewed change.
- It does not change the request flow, the webhook, or the cron.

## Operator procedure (when the time comes)

1. Confirm the OAuth client's Authorized redirect URI is exactly
   `https://<deployment>/api/intake-setup/callback` on the production domain.
2. Set `INTAKE_SETUP_OWNER_TOKEN` (generate with `openssl rand -hex 32`),
   `INTAKE_SETUP_ENABLED=true`, and the `GOOGLE_INTAKE_CLIENT_ID` /
   `GOOGLE_INTAKE_CLIENT_SECRET` / `GOOGLE_INTAKE_SENDER` values for the
   sender project.
3. Open `/api/intake-setup` with the bearer token, complete consent as the
   sender account, and confirm the success page.
4. Unset `INTAKE_SETUP_ENABLED` again. The stored token stays; the route
   closes.
5. Verify `factory_intake_sender_auth.granted_scope` is exactly
   `https://www.googleapis.com/auth/gmail.send` before any later wiring.

## Google-side notes

- The sender project uses a Personal-mode OAuth client: only the sender
  account can authorize it, and the mode cannot be switched later. That is
  the owner's accepted, recorded decision.
- Google may delete OAuth clients that stay inactive for 6 months. If the
  consent step is delayed by months, re-check the client still exists before
  relying on it.
