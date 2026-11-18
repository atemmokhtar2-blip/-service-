# Bot Factory — implementation plan and integration contract

## Product rules
- A Telegram user may own at most one live/claimed bot for each template: `download`, `pre-crime`, and `marayti`. The database unique constraint is the authority, not an in-memory check.
- The factory stores ownership, template, bot identity, lifecycle status, timestamps, and an encrypted token envelope. It never stores raw bot tokens in logs or sends them back to Telegram.
- A second attempt for the same template returns a clear message and the existing instance status. Other templates remain available.
- Every generated bot must enforce membership in `@K_J6k` before its own user-facing features. Checking membership only in the factory is insufficient.
- The user remains in the factory bot for selection, provisioning status, and management.

## Current repository integration findings
- Download is a Python long-running service. `services/instance_manager.py` runs clone Applications with long polling inside its Railway process. The existing repository contains clone-management logic, but no externally authenticated provisioning API was found in the inspected tree. Do not deploy this worker to Vercel.
- Pre-Crime is Next.js/Vercel + Neon. It already has managed-bot concepts, encrypted tokens, per-bot webhook secrets, and a one-live-bot-per-owner rule. Its current uniqueness rule is per Telegram owner, not per owner-and-template. A factory adapter and template identity need to be added without weakening its existing constraint.
- Marayti is Python on Vercel with a single configured `BOT_TOKEN` and Neon/Postgres data. No multi-tenant bot-provisioning endpoint was found. A dedicated managed-bot webhook/runtime path is required before it can safely host multiple customer tokens.

## Required service adapter contract
Each source runtime must expose a private HTTPS endpoint, authenticated with HMAC-SHA256 over timestamp + method + path + body, with replay-window validation and constant-time signature comparison.

Request:
```json
{
  "request_id": "UUID",
  "owner_telegram_id": 123456,
  "template": "download",
  "bot_token": "token supplied by the owner"
}
```

Success:
```json
{
  "request_id": "same UUID",
  "instance_id": "source-system-managed-id",
  "bot_id": 123456789,
  "bot_username": "example_bot",
  "status": "active"
}
```

The source service must validate the token with Telegram getMe, persist it using its own encryption key, create exactly one runtime/webhook/poller, and make retries idempotent by request_id. It must not start a second poller for a token already assigned elsewhere. Tokens must never appear in logs or error text.

## Provisioning order
1. Factory validates the token via Telegram getMe and confirms the token belongs to the user-submitted bot.
2. Factory reserves (owner, template) in PostgreSQL under a unique constraint and marks it `provisioning`.
3. Factory calls the matching source adapter over HTTPS with a short timeout and idempotency key.
4. Source system creates/starts the managed instance and returns its immutable instance ID.
5. Factory records source ID, bot ID/username and final status. Failed attempts are marked `failed` with safe error codes; a retry must reuse the same request_id or safely reconcile the existing reservation.
6. Factory shows progress and management options in the same Telegram chat.

## Environment setup
See `.env.example`. Never paste production credentials into source files, GitHub issues, commits, or chat. Add secrets through Vercel project environment settings. Database schema is managed by `src/db/schema.sql`; apply it once to the chosen Neon database after review.

## Important current limitation
The source adapters are not live until the matching authenticated endpoints have been implemented and deployed in Download (Railway), Pre-Crime (Vercel), and Marayti (Vercel). The factory must fail closed with a clear unavailable message instead of pretending that a bot was created.


## Extensible template engines and source contract

Template definitions live in `src/engines/template_registry.ts`; provisioning validation
lives in `src/engines/provision_contract.ts`. The catalog is data-driven rather than
a three-key switch. Each template declares its unique key, display metadata, provision
URL environment variable, contract version, readiness policy, primary-admin
attestation requirement, and whether a known legacy response is temporarily accepted.

The factory validates the template key and BotFather token before reserving an
instance. Before provisioning, adapters with an HTTP readiness policy must return
JSON with `ready: true`. The provision request carries `contract_version: 1`.
The response is accepted only when its request ID, instance ID, Telegram bot ID,
bot username, and status match the expected values. Download additionally must
attest `owner_admin_confirmed: true` and `primary_admin_id` equal to the Telegram
user who requested the copy. Provision requests do not follow HTTP redirects;
adapter URLs must use HTTPS outside loopback development.

The existing Pre-Crime and Marayti definitions temporarily opt into the explicit
legacy-response flag because their adapter contract predates version 1. This is
not the default for new templates. Once those adapters return `contract_version: 1`,
remove their compatibility flags. A new template must use strict versioned
responses by default.

Adding template #4 or #60 is a registry entry plus its source adapter and tests;
there is no longer a hard-coded SQL allow-list to edit. The application registry
is the authoritative allow-list, and duplicate/invalid registrations fail closed.
