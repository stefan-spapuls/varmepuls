-- VärmePuls only. Schema contains no household or qualification data.
CREATE TABLE installations (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL
);

CREATE TABLE installation_config (
  installation_id TEXT PRIMARY KEY NOT NULL
    REFERENCES installations(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  config_json TEXT NOT NULL CHECK (json_valid(config_json) AND json_type(config_json) = 'object'),
  updated_at TEXT NOT NULL
);

CREATE TABLE plan_revisions (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  plan_id TEXT NOT NULL UNIQUE,
  config_revision INTEGER NOT NULL CHECK (config_revision >= 1),
  created_at TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > created_at),
  zone TEXT NOT NULL CHECK (zone IN ('SE1', 'SE2', 'SE3', 'SE4')),
  coverage_start_utc TEXT NOT NULL,
  coverage_end_utc TEXT NOT NULL CHECK (coverage_end_utc > coverage_start_utc),
  actions_json TEXT NOT NULL CHECK (json_valid(actions_json) AND json_type(actions_json) = 'array'),
  PRIMARY KEY (installation_id, revision)
);

CREATE TRIGGER plan_revisions_immutable_update
BEFORE UPDATE ON plan_revisions
BEGIN
  SELECT RAISE(ABORT, 'plan revisions are immutable');
END;

CREATE TRIGGER plan_revisions_immutable_delete
BEFORE DELETE ON plan_revisions
BEGIN
  SELECT RAISE(ABORT, 'plan revisions are immutable');
END;
