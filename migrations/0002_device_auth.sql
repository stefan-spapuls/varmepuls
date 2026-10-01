-- VärmePuls device authentication only. Local candidate; do not apply remotely.
-- Controller private keys and plaintext enrollment capabilities are never stored.
CREATE TABLE devices (
  device_id TEXT PRIMARY KEY NOT NULL CHECK (length(device_id) BETWEEN 8 AND 80),
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE CHECK (length(credential_id) BETWEEN 8 AND 80),
  public_key_b64url TEXT NOT NULL CHECK (length(public_key_b64url) = 43),
  credential_version INTEGER NOT NULL CHECK (credential_version >= 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  pending_credential_id TEXT UNIQUE CHECK (pending_credential_id IS NULL OR length(pending_credential_id) BETWEEN 8 AND 80),
  pending_public_key_b64url TEXT CHECK (pending_public_key_b64url IS NULL OR length(pending_public_key_b64url) = 43),
  pending_version INTEGER CHECK (pending_version IS NULL OR pending_version >= 2),
  pending_expires_at TEXT,
  CHECK ((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL)),
  CHECK (
    (pending_credential_id IS NULL AND pending_public_key_b64url IS NULL AND pending_version IS NULL AND pending_expires_at IS NULL)
    OR
    (pending_credential_id IS NOT NULL AND pending_public_key_b64url IS NOT NULL AND
     pending_version = credential_version + 1 AND pending_expires_at IS NOT NULL AND
     pending_credential_id <> credential_id AND pending_public_key_b64url <> public_key_b64url)
  )
);
CREATE INDEX devices_installation ON devices(installation_id, status);
CREATE INDEX devices_current_credential ON devices(credential_id, status);
CREATE INDEX devices_pending_credential ON devices(pending_credential_id, status);

CREATE TABLE enrollment_capabilities (
  enrollment_id TEXT PRIMARY KEY NOT NULL CHECK (length(enrollment_id) BETWEEN 8 AND 80),
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  verifier_sha256 TEXT NOT NULL CHECK (length(verifier_sha256) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > created_at),
  consumed_at TEXT,
  consumed_device_id TEXT UNIQUE,
  CHECK ((consumed_at IS NULL AND consumed_device_id IS NULL) OR
         (consumed_at IS NOT NULL AND consumed_device_id IS NOT NULL))
);
CREATE INDEX enrollment_expiry ON enrollment_capabilities(expires_at, consumed_at);

CREATE TRIGGER enrollment_capability_cannot_reopen
BEFORE UPDATE OF consumed_at, consumed_device_id ON enrollment_capabilities
WHEN OLD.consumed_at IS NOT NULL AND
     (NEW.consumed_at IS NULL OR NEW.consumed_device_id IS NOT OLD.consumed_device_id)
BEGIN
  SELECT RAISE(ABORT, 'consumed enrollment capability cannot be reopened');
END;

CREATE TABLE auth_challenges (
  challenge_id TEXT PRIMARY KEY NOT NULL CHECK (length(challenge_id) BETWEEN 8 AND 80),
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL CHECK (length(credential_id) BETWEEN 8 AND 80),
  credential_version INTEGER NOT NULL CHECK (credential_version >= 1),
  nonce_sha256 TEXT NOT NULL CHECK (length(nonce_sha256) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > created_at),
  consumed_at TEXT
);
CREATE INDEX auth_challenges_outstanding
  ON auth_challenges(device_id, credential_id, credential_version, expires_at, consumed_at);
CREATE INDEX auth_challenges_expiry ON auth_challenges(expires_at, consumed_at);

CREATE TRIGGER consumed_auth_challenge_cannot_reopen
BEFORE UPDATE OF consumed_at ON auth_challenges
WHEN OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'consumed challenge cannot be reopened');
END;
