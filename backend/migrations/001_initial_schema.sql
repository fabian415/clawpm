-- ClawPM initial schema

CREATE TABLE IF NOT EXISTS teams (
  id               TEXT        PRIMARY KEY,
  name             TEXT        NOT NULL,
  workspace_folder TEXT,
  setup_completed  BOOLEAN     NOT NULL DEFAULT false,
  setup_completed_at TIMESTAMPTZ,
  setup_config     JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT        PRIMARY KEY,
  email         TEXT        UNIQUE NOT NULL,
  name          TEXT,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'user',
  team_id       TEXT        REFERENCES teams(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   TEXT        NOT NULL,
  role      TEXT        NOT NULL,
  content   TEXT        NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  extra     JSONB       NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_user_id_ts
  ON chat_messages (user_id, timestamp);

CREATE TABLE IF NOT EXISTS tasks (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id             TEXT        NOT NULL,
  created_by_user_id  TEXT        NOT NULL,
  provision_user_id   TEXT        NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  meeting_date        DATE,
  audio_file_name     TEXT        NOT NULL DEFAULT '',
  current_step        INTEGER     NOT NULL DEFAULT 1,
  status              TEXT        NOT NULL DEFAULT 'waiting',
  auto_advance_at     TIMESTAMPTZ,
  error_step          INTEGER,
  error_message       TEXT,
  step_statuses       JSONB       NOT NULL DEFAULT '{"1":"done","2":"pending","3":"pending","4":"pending","5":"pending"}',
  data                JSONB       NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_tasks_team_id_created
  ON tasks (team_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_worker
  ON tasks (status, auto_advance_at)
  WHERE status = 'waiting';

CREATE TABLE IF NOT EXISTS port_allocations (
  user_id      TEXT    PRIMARY KEY,
  gateway_port INTEGER UNIQUE NOT NULL,
  bridge_port  INTEGER UNIQUE NOT NULL,
  allocated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS container_configs (
  user_id    TEXT        PRIMARY KEY,
  config     JSONB       NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
