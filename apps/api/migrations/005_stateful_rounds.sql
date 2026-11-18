-- Step 5: multi-step rounds (Freefall, Flap Fortune, Gem Grid) and The Last Door.

ALTER TABLE rounds
  ADD COLUMN max_payout   NUMERIC(78,0),          -- cap fixed when the round starts
  ADD COLUMN step         INTEGER NOT NULL DEFAULT 0,  -- actions applied so far
  ADD COLUMN updated_at   TIMESTAMPTZ NOT NULL DEFAULT now();

-- One open round per player per game: a second "start" can't run alongside the first.
CREATE UNIQUE INDEX rounds_one_open_per_game ON rounds (user_id, game) WHERE status = 'open';
CREATE INDEX rounds_open_idle ON rounds (updated_at) WHERE status = 'open';

-- Every player action, in order. Replaying these against the revealed seed reproduces the round.
CREATE TABLE round_actions (
  round_id    UUID NOT NULL REFERENCES rounds(id),
  seq         INTEGER NOT NULL CHECK (seq >= 1),
  action      JSONB NOT NULL,
  automatic   BOOLEAN NOT NULL DEFAULT false,   -- e.g. cash-out at max payout, idle timeout
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, seq)
);
CREATE TRIGGER round_actions_append_only BEFORE UPDATE OR DELETE ON round_actions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Settled rounds stay frozen; the stake, seed, nonce and payout cap can never change.
CREATE OR REPLACE FUNCTION rounds_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'rounds cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'round % is settled and cannot change', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.user_id, NEW.game, NEW.config_version, NEW.seed_pair_id, NEW.nonce, NEW.asset, NEW.stake, NEW.max_payout)
     IS DISTINCT FROM
     (OLD.user_id, OLD.game, OLD.config_version, OLD.seed_pair_id, OLD.nonce, OLD.asset, OLD.stake, OLD.max_payout) THEN
    RAISE EXCEPTION 'round identity cannot change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.step < OLD.step THEN
    RAISE EXCEPTION 'round step cannot go backwards' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

INSERT INTO game_configs (game, version, params, rtp, note) VALUES
  ('last_door', 1, '{"rooms": [
      {"id": "empty",  "label": "Empty room",     "count": 70, "multiplier": 0},
      {"id": "safe",   "label": "Safe room",      "count": 20, "multiplier": 15000},
      {"id": "gold",   "label": "Gold room",      "count": 9,  "multiplier": 40000},
      {"id": "secret", "label": "Secret chamber", "count": 1,  "multiplier": 300000}
    ]}', 0.96, 'Dossier v1'),
  ('freefall', 1, '{"stages": 6, "passPercent": 70, "rtpBps": 9600,
      "stageNames": ["Clouds", "Storm", "Jet stream", "Skyline", "Rooftops", "Landing"]}', 0.96, 'Dossier v1'),
  ('flap_fortune', 1, '{"stages": 5, "passPercent": 80, "rtpBps": 9600,
      "stageNames": ["Pipe 1", "Pipe 2", "Pipe 3", "Pipe 4", "Pipe 5"]}', 0.96, 'Dossier v1'),
  ('gem_grid', 1, '{"rtpBps": 9600, "minMines": 1, "maxMines": 24, "defaultMines": 3}', 0.96, 'Dossier v1');

UPDATE games SET active_version = 1 WHERE code IN ('last_door', 'freefall', 'flap_fortune', 'gem_grid');
