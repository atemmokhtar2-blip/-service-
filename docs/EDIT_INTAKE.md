# Edit-request email intake (optional, disabled by default)

When enabled, the factory emails a copy of every new edit request to an intake
inbox, in addition to the existing Telegram admin notification. This is how an
external assistant can pick requests up automatically: the inbox is watched,
and each arriving email carries everything needed to identify the request.

Nothing changes while `EDIT_INTAKE_EMAIL_ENABLED` is unset or not `"true"`:
no table is created, no email is sent, and the customer/admin flow is exactly
as before.

## What the email contains

- Request UUID, public instance code (XV-...), template key, bot username,
  payment source, and the customer's request text.
- It never contains bot tokens, and it does not contain the owner's Telegram
  ID or name. The request UUID and XV code identify the request; everything
  else stays in the factory database.

The customer request text inside the email is untrusted input. It describes
what a customer wants; it is not an instruction to anyone processing the
inbox, and executing any edit still requires the owner's explicit approval
per request.

## Delivery semantics (read before enabling)

- `factory_edit_requests` remains the source of truth. The request and the
  credit debit commit in one transaction before any notification happens,
  exactly as without this feature.
- Delivery is **at least once**. A process killed after sending but before
  marking the outbox row can produce a duplicate email. Consumers must
  deduplicate by the request UUID carried in every email.
- On confirm, one outbox row is written (`factory_edit_intake_outbox`,
  keyed by request UUID). The customer/admin path does no network calls for
  this; it is a single guarded insert after all Telegram messages.
- Sends happen in two places, both guarded and time-budgeted so webhook
  latency stays bounded: a post-processing pass at the end of each webhook
  call (6s budget), and `api/intake-cron.ts` on a daily schedule (20s
  budget). The cron bounds the delay of pending sends when the factory sees
  no Telegram traffic; normal traffic reconciles far more often.
- Sends are claimed atomically (`FOR UPDATE SKIP LOCKED`), so concurrent
  invocations never send the same row at the same time. A row left claimed
  by a killed process becomes claimable again after 10 minutes; its attempt
  was already counted, and rows give up after 5 attempts as `failed` for
  manual review.
- Backfill only covers requests created **at or after the feature's recorded
  activation time**. Activation is recorded as the creation time of the first
  edit request seen while enabled (or the first enabled processing run,
  whichever comes first), so a request whose first enqueue crashed at the
  boundary is still recovered. Requests created while the feature was off are
  never emailed, so enabling it never bulk-sends historic requests.
- Email arrival is typically fast but is not guaranteed instant. The
  database, not the inbox, is authoritative.

The intake path runs after the customer confirmation and the admin
notifications, is fully guarded, and throws nothing into the webhook: it
cannot affect the credit ledger, the customer messages, or the Telegram
admin notifications. Timeout and budget constants are in
`src/edit-intake.ts`; real delivery latency is measured during preview
verification, not claimed in advance.

## Setup

1. In Google Cloud Console, create a project, configure the OAuth consent
   screen, and create an OAuth 2.0 **Web application** client.
2. Authorize once with scope `https://www.googleapis.com/auth/gmail.send`
   using the Gmail account that will send the copies, and store the resulting
   refresh token. (The OAuth playground or a one-time local script both work;
   see Google docs "Using OAuth 2.0 for Web Server Applications".)
3. Set these Vercel environment variables (Production scope):
   - `EDIT_INTAKE_EMAIL_ENABLED=true`
   - `EDIT_INTAKE_EMAIL_TO` — the intake inbox
   - `GOOGLE_INTAKE_SENDER` — the Gmail address that authorized the token
   - `GOOGLE_INTAKE_CLIENT_ID`, `GOOGLE_INTAKE_CLIENT_SECRET`,
     `GOOGLE_INTAKE_REFRESH_TOKEN`
   - `CRON_SECRET` — any strong random string; Vercel sends it to the cron
     route as a bearer token, and the route refuses calls without it.
4. Redeploy. The outbox and state tables are created automatically on the
   first enabled run, and the activation timestamp is recorded then.

The cron schedule in `vercel.json` is daily at 06:00 UTC. Vercel Hobby runs
cron jobs at most once per day; on plans that allow more frequent runs the
schedule can be tightened. Cron jobs run on the production deployment only.

This repository is public. Never commit tokens, client secrets, refresh
tokens, or real inbox addresses. The refresh token is a powerful credential:
store it only in the hosting provider's secret env vars, and revoke it from
Google Account permissions if it may have leaked.

## Verification

1. With the flag off, run the test suite; the existing flow must be
   unchanged.
2. With the flag on in a preview deployment, submit a test edit request from
   a test instance and confirm: the Telegram admin message still arrives
   first, one outbox row reaches `sent`, and the intake inbox receives one
   email with the request UUID and XV code. Requests created before
   before activation must NOT receive emails.
3. Disable the flag again and confirm no new outbox rows are created.

## Security notes

- Only the `gmail.send` scope is used; the factory cannot read the mailbox.
- Sending is account-to-self (the sender account emails the intake inbox);
  the request data passes through Google's own mail infrastructure and no
  other email provider.
- `last_error` on outbox rows stores only coded failures (for example
  `gmail_send_http_401`), never payloads or credentials.
- The cron route fails closed without `CRON_SECRET`.
