# Deployment and environment contract

The factory is the control plane. The three source repositories retain their
own bot runtimes and databases. Do not place customer bot polling loops on
Vercel.

## Factory Vercel project

Set these variables in the `bot-factory` Vercel project:

| Variable | Purpose |
| --- | --- |
| `FACTORY_BOT_TOKEN` | The BotFather token for the factory Telegram bot |
| `DATABASE_URL` | Neon PostgreSQL connection string for factory ownership/state |
| `TOKEN_ENCRYPTION_KEY` | 64 hex characters (32 random bytes) for AES-256-GCM |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram webhook secret, 1–256 chars from A-Z, a-z, 0-9, underscore, hyphen |
| `FACTORY_SERVICE_SECRET` | Shared HMAC secret (at least 32 random bytes) for source adapters |
| `PUBLIC_BASE_URL` | The stable production URL of this Vercel project |
| `DOWNLOAD_PROVISION_URL` | Railway API service URL + `/internal/factory/provision` |
| `PRECRIME_PROVISION_URL` | Pre-Crime Vercel URL + `/api/factory/provision` |
| `MARAYTI_PROVISION_URL` | Marayti Vercel URL + `/api/factory/provision` |
| `REQUIRED_CHANNEL_ID` | `@K_J6k` |
| `REQUIRED_CHANNEL_URL` | `https://t.me/K_J6k` |

Generate secrets outside Git and chat, for example with `openssl rand -hex 32`.
Never commit a real `.env`, token, database URL, or service secret.

After adding the factory bot token, register its webhook with:

```bash
npm run register:webhook
```

The command needs `FACTORY_BOT_TOKEN`, `PUBLIC_BASE_URL`, and
`TELEGRAM_WEBHOOK_SECRET` in its environment.

## Shared service authentication

Use the same `FACTORY_SERVICE_SECRET` in the Factory Vercel project and all
three source adapters. Requests are signed with HMAC-SHA256 over timestamp,
HTTP method, exact path, and exact raw body. Source adapters reject stale
signatures and mismatched idempotency keys.

Use distinct token-encryption keys for each project. Do not reuse
`TOKEN_ENCRYPTION_KEY` as a source repository's encryption key.

## Source project environment

### Download — Railway

Add a second Railway service from the Download repository after merging its
adapter branch. Start command:

```bash
uvicorn services.factory_api:app --host 0.0.0.0 --port $PORT
```

Keep the existing service's `python3 app.py` command unchanged. The API
service and long-running bot service must share the same PostgreSQL database
and exactly the same `BOT_SECRETS_KEY`. Set `FACTORY_SERVICE_SECRET` on the
API service. The main worker must run the updated code so its 20-second sync
worker discovers newly provisioned instances.

Each Download clone must already be an administrator of `@K_J6k`; the
provisioning endpoint checks this and refuses to activate a clone that cannot
verify channel membership.

### Pre-Crime — Vercel

Set:
- `FACTORY_SERVICE_SECRET` — shared with Factory and the other adapters.
- `MANAGED_BOT_TOKEN_ENCRYPTION_KEY_V2` — 64 hex characters.
- `MANAGED_BOT_WEBHOOK_MASTER_SECRET` — a separate random secret for per-bot webhook derivation.
- `FACTORY_MANAGER_BOT_TOKEN` — token of a bot that is an administrator in `@K_J6k`; falls back to `TELEGRAM_BOT_TOKEN`.
- Existing `DATABASE_URL` and other Pre-Crime production variables.

Do not replace the existing primary bot webhook secret merely to enable managed
bots. The managed route uses its dedicated master secret.

### Marayti — Vercel

Set:
- `FACTORY_SERVICE_SECRET` — shared with Factory and the other adapters.
- `MARAYTI_MANAGED_TOKEN_ENCRYPTION_KEY` — 64 hex characters.
- `MARAYTI_MANAGED_WEBHOOK_MASTER_SECRET` — separate random secret for managed webhook derivation.
- `FACTORY_MANAGER_BOT_TOKEN` — the factory/manager bot token with admin rights in `@K_J6k`.
- Existing `DATABASE_URL`.
- `WEBHOOK_BASE_URL` if the automatic `VERCEL_URL` value is not the stable production domain.

Managed Marayti data is isolated by PostgreSQL schema `tenant_<bot_id>`. The
public registry contains only bot identity, owner, lifecycle state, and an
AES-GCM encrypted token envelope.

## Operational limits and checks

- One owner may own one copy of each template. Each source also has a
  database-level owner/token guard.
- Download clone instances retain the Download project's existing Basic plan
  validity policy (30 days by default). This factory adapter does not silently
  bypass the source product's plan/expiry enforcement.
- The factory never claims a Download clone is running until the Download
  worker reports runtime status `running`.
- The source repositories must be deployed after their adapter PRs are merged.
  A factory environment URL alone does not create a Railway service or deploy
  source-side code.
- Telegram membership checks require the relevant manager/clone bot to have
  administrator access in `@K_J6k`. Keep that permission in place.
- Do not use the factory in production until the source adapter health checks,
  webhook delivery, token encryption, and one real test instance per template
  have been verified.
