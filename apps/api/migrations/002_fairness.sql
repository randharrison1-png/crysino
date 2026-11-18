-- Step 2: provably fair seed pairs (design spec §4).
--
-- Each player always has:
--   one ACTIVE pair  — server seed hash shown, client seed chosen by the player, nonce counting bets
--   one NEXT pair    — server seed already generated and its hash shown, so when the player rotates
--                      and picks a new client seed, the server seed was fixed BEFORE that choice.
-- Rotating reveals the active server seed (status REVEALED) so every bet made with it can be verified.

CREATE TABLE seed_pairs (
  id                BIGSERIAL PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES users(id),
  status            TEXT NOT NULL CHECK (status IN ('next', 'active', 'revealed')),
  server_seed_enc   BYTEA NOT NULL,          -- AES-256-GCM; only the fairness service holds the key
  server_seed_hash  TEXT NOT NULL,           -- SHA-256 hex commitment, public from creation
  server_seed       TEXT,                    -- plaintext, filled ONLY when revealed
  client_seed       TEXT,
  nonce             BIGINT NOT NULL DEFAULT 0 CHECK (nonce >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at      TIMESTAMPTZ,
  revealed_at       TIMESTAMPTZ,
  CONSTRAINT revealed_has_seed CHECK ((status = 'revealed') = (server_seed IS NOT NULL)),
  CONSTRAINT in_use_has_client_seed CHECK (status = 'next' OR client_seed IS NOT NULL),
  CONSTRAINT next_unused CHECK (status <> 'next' OR nonce = 0)
);

CREATE UNIQUE INDEX seed_pairs_one_active ON seed_pairs (user_id) WHERE status = 'active';
CREATE UNIQUE INDEX seed_pairs_one_next   ON seed_pairs (user_id) WHERE status = 'next';
CREATE INDEX seed_pairs_user_idx ON seed_pairs (user_id, id DESC);

-- The database itself guarantees fairness invariants, whatever the application does:
-- commitments never change, nonces never go backwards, a revealed seed must match its
-- commitment, and revealed pairs are frozen forever.
CREATE FUNCTION seed_pairs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'seed_pairs rows cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'revealed' THEN
    RAISE EXCEPTION 'revealed seed pair % is frozen', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.server_seed_hash <> OLD.server_seed_hash OR NEW.server_seed_enc <> OLD.server_seed_enc
     OR NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'seed commitment cannot change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.nonce < OLD.nonce THEN
    RAISE EXCEPTION 'nonce cannot decrease' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'next' THEN
    RAISE EXCEPTION 'active pair cannot go back to next' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'active' AND NEW.client_seed IS DISTINCT FROM OLD.client_seed THEN
    RAISE EXCEPTION 'client seed of an active pair cannot change; rotate instead' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.server_seed IS NOT NULL
     AND encode(sha256(convert_to(NEW.server_seed, 'UTF8')), 'hex') <> NEW.server_seed_hash THEN
    RAISE EXCEPTION 'revealed seed does not match its commitment' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER seed_pairs_guard BEFORE UPDATE OR DELETE ON seed_pairs
  FOR EACH ROW EXECUTE FUNCTION seed_pairs_guard();
