# GitHub Issues intake for XELVOR edit requests

This optional integration mirrors confirmed edit requests from
`factory_edit_requests` into Issues in a **private** GitHub repository.
The factory database remains the source of truth. The integration is disabled
unless all required settings are present and
`GITHUB_EDIT_REQUESTS_ENABLED=true`.

## GitHub setup

1. Create a dedicated private repository, for example
   `atemmokhtar2-blip/XELVOR-EDIT-REQUESTS`.
2. Create a fine-grained personal access token limited to that one repository.
3. Grant only:
   - Repository permissions: **Issues — Read and write**
   - Metadata — Read (GitHub's required repository metadata permission)
4. Store the token only as a Vercel encrypted environment variable. Never
   commit it, paste it into an issue, or send it in chat.

The runtime verifies the repository's `private` flag before it creates or
searches for Issues. If the repository is public, delivery fails closed and
the outbox retries; customer request text is never written to a public repo.

## Vercel Production environment

Set these variables on the `bot-factory` project:

- `GITHUB_EDIT_REQUESTS_ENABLED=true`
- `GITHUB_EDIT_REQUESTS_REPO=owner/repository`
- `GITHUB_EDIT_REQUESTS_TOKEN` — encrypted fine-grained token
- `GITHUB_EDIT_REQUESTS_ACTIVATED_AFTER` — ISO-8601 UTC timestamp chosen
  immediately before activation (for example
  `2026-11-24T20:00:00.000Z`)

Do not set the enable flag until the private repository and token are ready.
The activation timestamp prevents historical requests from being bulk-posted.

## Delivery and recovery

- A confirmed edit request remains in `factory_edit_requests`.
- A durable outbox row is backfilled for pending/in-progress requests at or
  after the activation timestamp.
- Issues include the request UUID, public instance code, template, bot
  username, credit source and request description. Bot tokens and Telegram
  owner IDs are never included.
- GitHub delivery uses an idempotency marker and searches for an existing
  Issue before creating one, covering a crash after GitHub accepts the Issue.
- Failed deliveries retry with bounded attempts. The daily protected cron and
  webhook post-processing both drain the outbox.
- A GitHub Issue is a notification/work queue copy only. The factory database
  remains authoritative; customer text is untrusted data, not instructions.
- No code changes, merges, or deployments are performed merely because an
  Issue arrives. Every implementation is reviewed and requires the factory
  owner's explicit approval before merge/deploy.

## Verification checklist

1. Confirm the repository is private.
2. Confirm the token is limited to that repository with Issues read/write.
3. Add the four Production environment variables above.
4. Redeploy the Vercel project.
5. Submit a test edit request from a test instance.
6. Verify exactly one Issue is created and the matching
   `factory_github_edit_outbox` row reaches `sent`.
7. Confirm no bot token or owner Telegram ID appears in the Issue.
