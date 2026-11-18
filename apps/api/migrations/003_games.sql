-- Step 3: games, versioned configurations, per-asset limits, and rounds.

-- One row per game. Operational switches the admin dashboard flips.
CREATE TABLE games (
  code            TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('instant', 'stateful')),
  enabled         BOOLEAN NOT NULL DEFAULT false,
  -- Maintenance: open rounds can finish, no new rounds start.
  maintenance     BOOLEAN NOT NULL DEFAULT false,
  active_version  INTEGER,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The game's maths (paytable, RTP, parameters). Never edited: a change is a new version,
-- and every round records the version it was played under.
CREATE TABLE game_configs (
  game        TEXT NOT NULL REFERENCES games(code),
  version     INTEGER NOT NULL CHECK (version >= 1),
  params      JSONB NOT NULL,
  rtp         NUMERIC(8,6) NOT NULL,          -- exact theoretical RTP, for display and drift checks
  note        TEXT,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game, version)
);
CREATE TRIGGER game_configs_append_only BEFORE UPDATE OR DELETE ON game_configs
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

ALTER TABLE games ADD CONSTRAINT games_active_version_fk
  FOREIGN KEY (code, active_version) REFERENCES game_configs (game, version);

-- Bet limits per game and asset. No row = that asset cannot be used on that game.
CREATE TABLE game_limits (
  game        TEXT NOT NULL REFERENCES games(code),
  asset       TEXT NOT NULL REFERENCES assets(code),
  min_bet     NUMERIC(78,0) NOT NULL CHECK (min_bet > 0),
  max_bet     NUMERIC(78,0) NOT NULL,
  max_payout  NUMERIC(78,0) NOT NULL,         -- cap on stake × multiplier for a single round
  updated_by  UUID,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game, asset),
  CHECK (max_bet >= min_bet),
  CHECK (max_payout >= max_bet)
);

CREATE TABLE rounds (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id),
  game             TEXT NOT NULL REFERENCES games(code),
  config_version   INTEGER NOT NULL,
  seed_pair_id     BIGINT NOT NULL REFERENCES seed_pairs(id),
  nonce            BIGINT NOT NULL,
  asset            TEXT NOT NULL REFERENCES assets(code),
  stake            NUMERIC(78,0) NOT NULL CHECK (stake > 0),
  params           JSONB NOT NULL DEFAULT '{}',   -- the player's choices
  state            JSONB,                         -- hidden server state of an open stateful round
  result           JSONB,                         -- public result
  multiplier       BIGINT,                        -- scaled by 10,000
  payout           NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (payout >= 0),
  status           TEXT NOT NULL CHECK (status IN ('open', 'won', 'lost', 'cashed_out', 'refunded')),
  idempotency_key  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at        TIMESTAMPTZ,
  FOREIGN KEY (game, config_version) REFERENCES game_configs (game, version),
  CONSTRAINT one_round_per_nonce UNIQUE (seed_pair_id, nonce),
  CONSTRAINT one_round_per_request UNIQUE (user_id, idempotency_key),
  CONSTRAINT closed_when_settled CHECK ((status = 'open') = (closed_at IS NULL))
);
CREATE INDEX rounds_user_recent ON rounds (user_id, created_at DESC);
CREATE INDEX rounds_open ON rounds (user_id) WHERE status = 'open';
CREATE INDEX rounds_game_recent ON rounds (game, created_at DESC);

-- A settled round is history: it can never change again.
CREATE FUNCTION rounds_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'rounds cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'round % is settled and cannot change', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.user_id, NEW.game, NEW.config_version, NEW.seed_pair_id, NEW.nonce, NEW.asset, NEW.stake)
     IS DISTINCT FROM
     (OLD.user_id, OLD.game, OLD.config_version, OLD.seed_pair_id, OLD.nonce, OLD.asset, OLD.stake) THEN
    RAISE EXCEPTION 'round identity cannot change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rounds_guard BEFORE UPDATE OR DELETE ON rounds
  FOR EACH ROW EXECUTE FUNCTION rounds_guard();

-- ─── Seed the seven games (all disabled until you switch them on) ───
INSERT INTO games (code, name, kind) VALUES
  ('doomsday',     'Doomsday',      'instant'),
  ('freefall',     'Freefall',      'stateful'),
  ('last_door',    'The Last Door', 'instant'),
  ('flap_fortune', 'Flap Fortune',  'stateful'),
  ('gem_grid',     'Gem Grid',      'stateful'),
  ('dice',         'Dice 100',      'instant'),
  ('neon21',       'Neon 21',       'stateful');

-- Version 1 of the two games built in this step, straight from the design dossier.
INSERT INTO game_configs (game, version, params, rtp, note) VALUES
  ('dice', 1, '{"rtpBps": 9600, "minChance": 1, "maxChance": 99}', 0.96, 'Dossier v1'),
  ('doomsday', 1, '{"tiers": [
      {"id": "destroyed", "label": "System destroyed",   "weight": 650, "multiplier": 0},
      {"id": "recovery",  "label": "Emergency recovery", "weight": 300, "multiplier": 20000},
      {"id": "jackpot",   "label": "Bunker jackpot",     "weight": 42,  "multiplier": 50000},
      {"id": "override",  "label": "Critical override",  "weight": 7,   "multiplier": 100000},
      {"id": "miracle",   "label": "Doomsday miracle",   "weight": 1,   "multiplier": 800000}
    ]}', 0.96, 'Dossier v1');

UPDATE games SET active_version = 1 WHERE code IN ('dice', 'doomsday');
