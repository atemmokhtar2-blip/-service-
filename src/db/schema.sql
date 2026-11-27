CREATE TABLE IF NOT EXISTS factory_users (
  telegram_user_id BIGINT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Account-wide free edit allowance: two requests per rolling 24-hour window.
-- The window begins on the user's first free request, not when they open the UI.
CREATE TABLE IF NOT EXISTS factory_user_edit_quotas (
  owner_telegram_id BIGINT PRIMARY KEY REFERENCES factory_users(telegram_user_id) ON DELETE CASCADE,
  free_credits INTEGER NOT NULL DEFAULT 2 CHECK (free_credits BETWEEN 0 AND 2),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS factory_instances (
  id UUID PRIMARY KEY,
  owner_telegram_id BIGINT NOT NULL REFERENCES factory_users(telegram_user_id),
  template_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'awaiting_token', 'provisioning', 'active', 'paused', 'failed')),
  request_id UUID NOT NULL UNIQUE,
  bot_id BIGINT,
  bot_username TEXT,
  encrypted_token TEXT,
  source_instance_id TEXT,
  safe_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(owner_telegram_id, template_key)
);

CREATE INDEX IF NOT EXISTS factory_instances_owner_idx
  ON factory_instances(owner_telegram_id, created_at DESC);

CREATE TABLE IF NOT EXISTS factory_pending_actions (
  telegram_user_id BIGINT PRIMARY KEY REFERENCES factory_users(telegram_user_id),
  action TEXT NOT NULL CHECK (action IN ('awaiting_token')),
  template_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Template keys are validated against the application registry, not a fixed SQL list.
ALTER TABLE factory_instances DROP CONSTRAINT IF EXISTS factory_instances_template_key_check;
ALTER TABLE factory_pending_actions DROP CONSTRAINT IF EXISTS factory_pending_actions_template_key_check;

CREATE TABLE IF NOT EXISTS factory_telegram_updates (
  update_id BIGINT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


ALTER TABLE factory_instances ADD COLUMN IF NOT EXISTS public_code TEXT;
ALTER TABLE factory_instances ADD COLUMN IF NOT EXISTS free_edit_credits INTEGER NOT NULL DEFAULT 1;
ALTER TABLE factory_instances ADD COLUMN IF NOT EXISTS free_edit_period DATE;
ALTER TABLE factory_instances ADD COLUMN IF NOT EXISTS paid_edit_credits INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS factory_instances_public_code_unique ON factory_instances(public_code) WHERE public_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS factory_edit_drafts (
  telegram_user_id BIGINT PRIMARY KEY REFERENCES factory_users(telegram_user_id) ON DELETE CASCADE,
  instance_id UUID NOT NULL REFERENCES factory_instances(id) ON DELETE CASCADE,
  request_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS factory_edit_requests (
  id UUID PRIMARY KEY,
  instance_id UUID NOT NULL REFERENCES factory_instances(id) ON DELETE CASCADE,
  owner_telegram_id BIGINT NOT NULL REFERENCES factory_users(telegram_user_id),
  public_code TEXT NOT NULL,
  request_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','in_progress','completed','rejected')),
  payment_source TEXT NOT NULL CHECK (payment_source IN ('free','paid')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  handled_by BIGINT,
  admin_note TEXT
);
ALTER TABLE factory_edit_requests ADD COLUMN IF NOT EXISTS free_credit_window_started_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS factory_edit_requests_owner_idx ON factory_edit_requests(owner_telegram_id, created_at DESC);
CREATE INDEX IF NOT EXISTS factory_edit_requests_instance_idx ON factory_edit_requests(instance_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS factory_edit_requests_one_open_per_instance ON factory_edit_requests(instance_id) WHERE status IN ('pending','in_progress');

-- Optional email intake outbox (disabled unless EDIT_INTAKE_EMAIL_ENABLED=true).
-- One row per edit request; sends are retried from this table, keyed by request_id.
CREATE TABLE IF NOT EXISTS factory_edit_intake_outbox (
  request_id UUID PRIMARY KEY REFERENCES factory_edit_requests(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

-- Optional one-time OAuth setup for the intake sender (disabled unless
-- INTAKE_SETUP_ENABLED=true). States are single-use and expire after 10 minutes;
-- factory_intake_sender_auth is a singleton holding the encrypted refresh token
-- and the granted scope evidence. Nothing reads it until a separate reviewed change.
CREATE TABLE IF NOT EXISTS factory_intake_setup_states (
  state TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS factory_intake_sender_auth (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  sender TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  granted_scope TEXT NOT NULL,
  authorized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS factory_edit_credit_ledger (
  id BIGSERIAL PRIMARY KEY,
  instance_id UUID NOT NULL REFERENCES factory_instances(id) ON DELETE CASCADE,
  owner_telegram_id BIGINT NOT NULL REFERENCES factory_users(telegram_user_id),
  delta INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('monthly_free','paid_purchase','admin_adjustment','request_consumption','refund')),
  reference_id UUID,
  actor_telegram_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
