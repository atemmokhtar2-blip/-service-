CREATE TABLE IF NOT EXISTS factory_users (
  telegram_user_id BIGINT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
