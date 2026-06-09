-- Terminology library table: team-scoped proper noun dictionary
CREATE TABLE IF NOT EXISTS terminology (
  id         SERIAL      PRIMARY KEY,
  team_id    TEXT        NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  term       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(team_id, term)
);

CREATE INDEX IF NOT EXISTS idx_terminology_team_id
  ON terminology (team_id, term);
