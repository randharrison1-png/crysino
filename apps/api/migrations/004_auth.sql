-- Step 4: player accounts — date of birth, two-factor auth, sessions.

ALTER TABLE users
  ADD COLUMN date_of_birth    DATE,
  ADD COLUMN totp_secret_enc  BYTEA,                 -- AES-256-GCM, APP_ENCRYPTION_KEY
  ADD COLUMN totp_enabled     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN totp_last_step   BIGINT,                -- last accepted 30s step: a code can't be reused
  ADD COLUMN terms_version    TEXT,
  ADD COLUMN signup_country   CHAR(2),
  ADD COLUMN last_login_at    TIMESTAMPTZ,
  ADD CONSTRAINT totp_needs_secret CHECK (NOT totp_enabled OR totp_secret_enc IS NOT NULL);

-- Revocable sessions. Only a SHA-256 of the token is stored: a database leak can't log anyone in.
CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip            INET,
  user_agent    TEXT,
  country       CHAR(2),
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
