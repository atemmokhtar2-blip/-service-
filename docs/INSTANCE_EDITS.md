# User-level daily editing credits

## Customer experience

After a template instance is provisioned, the factory shows its dedicated management screen with an immutable public instance code, lifecycle status, account-wide daily free-edit balance, paid-edit balance, and an **Edit your copy** action. The code is an identifier for support and admin routing only; authorization always uses the Telegram owner ID plus the internal instance UUID.

The customer submits a 20–2,000 character change request, reviews it, and explicitly confirms sending it. The factory checks ownership and channel membership, allows at most one open request per instance, and records the request with its payment source.

## Daily free credits

Each Telegram user receives two free edit requests shared across all of their bot instances. The 24-hour window starts when the user sends their first free request in a new window. The allowance resets to two after 24 hours from that start time; unused credits do not roll over. Opening the management screen does not start or reset the timer. Paid credits remain separate, instance-scoped, and do not expire through the daily reset.

## Admin workflow

Set `FACTORY_ADMIN_IDS` to a comma-separated list of numeric Telegram user IDs. Each request is delivered to those accounts with the instance code, template, bot username, owner Telegram ID, request UUID, payment source, and requested change. Admin actions can mark it in progress, completed, or rejected. The customer receives a status notification.

For a paid order, verify payment outside the bot and then issue `/grant_edits XV-INSTANCE-CODE 5` from an admin account to add five paid credits. This is a manual crediting workflow; an automated payment provider is not configured by this repository. Optionally set `FACTORY_SUPPORT_USERNAME` to show the support account in the purchase prompt.

## Data and safeguards

- `factory_instances.public_code` is unique and generated from cryptographically secure random bytes.
- Requests are scoped by both Telegram owner ID and internal instance UUID.
- A partial unique index prevents more than one `pending` or `in_progress` request per instance.
- The account-wide quota row serializes free-credit consumption across all instances. Credit debit, request creation, draft removal, and ledger insertion happen in one SQL statement. A rejected free request is refunded only while its original 24-hour window is still active; paid credits are refunded separately.
- `factory_edit_credit_ledger` records credit consumption and paid-credit grants.
- Bot tokens are not included in edit-request messages or ledger records.
