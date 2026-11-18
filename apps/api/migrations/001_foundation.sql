-- Step 1: foundation tables — users, assets, double-entry ledger, regions, settings, admin audit.
-- Money columns are NUMERIC(78,0): whole numbers of an asset's smallest unit (fits 256-bit wei).

-- ───────────────────────── Users ─────────────────────────
CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash  TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'frozen', 'closed', 'self_excluded')),
  kyc_tier       SMALLINT NOT NULL DEFAULT 0 CHECK (kyc_tier BETWEEN 0 AND 3),
  country        CHAR(2),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────── Assets ─────────────────────────
CREATE TABLE assets (
  code              TEXT PRIMARY KEY,            -- e.g. BTC, USDT_TRC20
  symbol            TEXT NOT NULL,               -- what players see, e.g. USDT
  network           TEXT NOT NULL,               -- bitcoin, ethereum, tron, solana, litecoin
  decimals          SMALLINT NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  confirmations     INTEGER NOT NULL CHECK (confirmations >= 1),
  min_deposit       NUMERIC(78,0),
  min_withdrawal    NUMERIC(78,0),
  max_withdrawal    NUMERIC(78,0),
  withdrawal_fee    NUMERIC(78,0) NOT NULL DEFAULT 0,
  enabled           BOOLEAN NOT NULL DEFAULT false
);

INSERT INTO assets (code, symbol, network, decimals, confirmations) VALUES
  ('BTC',        'BTC',  'bitcoin',  8,  2),
  ('ETH',        'ETH',  'ethereum', 18, 12),
  ('USDT_ERC20', 'USDT', 'ethereum', 6,  12),
  ('USDT_TRC20', 'USDT', 'tron',     6,  20),
  ('USDC_ERC20', 'USDC', 'ethereum', 6,  12),
  ('USDC_SOL',   'USDC', 'solana',   6,  32),
  ('SOL',        'SOL',  'solana',   9,  32),
  ('LTC',        'LTC',  'litecoin', 8,  6);

-- ───────────────────────── Ledger ─────────────────────────
CREATE TABLE ledger_accounts (
  id              BIGSERIAL PRIMARY KEY,
  owner_type      TEXT NOT NULL CHECK (owner_type IN ('player', 'house', 'external')),
  owner_id        UUID REFERENCES users(id),
  asset           TEXT NOT NULL REFERENCES assets(code),
  kind            TEXT NOT NULL CHECK (kind IN
                    ('main', 'pending_withdrawal', 'bankroll', 'fees', 'adjustments', 'chain')),
  -- Cached sum of this account's entries, updated only by the ledger in the same transaction.
  -- Entries remain the source of truth; verify_ledger() proves they agree.
  balance         NUMERIC(78,0) NOT NULL DEFAULT 0,
  allow_negative  BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT owner_matches_type CHECK ((owner_type = 'player') = (owner_id IS NOT NULL)),
  CONSTRAINT no_overdraft CHECK (allow_negative OR balance >= 0),
  CONSTRAINT one_account_per_slot UNIQUE NULLS NOT DISTINCT (owner_type, owner_id, asset, kind)
);

CREATE TABLE ledger_txns (
  id               BIGSERIAL PRIMARY KEY,
  type             TEXT NOT NULL CHECK (type IN
                     ('deposit', 'bet', 'win', 'refund', 'withdrawal_request', 'withdrawal_complete',
                      'withdrawal_cancel', 'adjustment', 'sweep')),
  ref_type         TEXT,           -- e.g. 'round', 'chain_deposit', 'withdrawal'
  ref_id           TEXT,
  idempotency_key  TEXT UNIQUE,    -- a retried request returns the original transaction
  metadata         JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id          BIGSERIAL PRIMARY KEY,
  txn_id      BIGINT NOT NULL REFERENCES ledger_txns(id),
  account_id  BIGINT NOT NULL REFERENCES ledger_accounts(id),
  amount      NUMERIC(78,0) NOT NULL CHECK (amount <> 0),  -- positive = credit, negative = debit
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_txn_idx ON ledger_entries (txn_id);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, id);
CREATE INDEX ledger_txns_ref_idx ON ledger_txns (ref_type, ref_id);

-- Every transaction must balance to zero per asset. Checked at COMMIT, so a transaction can
-- insert its entries one by one, but can never commit unbalanced.
CREATE FUNCTION ledger_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bad_asset TEXT;
BEGIN
  SELECT a.asset INTO bad_asset
  FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
  WHERE e.txn_id = NEW.txn_id
  GROUP BY a.asset
  HAVING sum(e.amount) <> 0
  LIMIT 1;
  IF bad_asset IS NOT NULL THEN
    RAISE EXCEPTION 'ledger txn % does not balance for asset %', NEW.txn_id, bad_asset
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();

-- Append-only: history can never be rewritten. Corrections are new 'adjustment' transactions.
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER ledger_txns_append_only BEFORE UPDATE OR DELETE ON ledger_txns
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER ledger_txns_no_truncate BEFORE TRUNCATE ON ledger_txns
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- Recomputes every balance from entries and returns any account where the cache disagrees.
CREATE FUNCTION verify_ledger()
RETURNS TABLE (account_id BIGINT, cached NUMERIC, computed NUMERIC) LANGUAGE sql STABLE AS $$
  SELECT a.id, a.balance, COALESCE(sum(e.amount), 0)
  FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
  GROUP BY a.id, a.balance
  HAVING a.balance <> COALESCE(sum(e.amount), 0);
$$;

-- ───────────────────────── Regions ─────────────────────────
CREATE TABLE region_rules (
  id              BIGSERIAL PRIMARY KEY,
  country_code    CHAR(2) NOT NULL CHECK (country_code = upper(country_code)),
  subdivision     TEXT,             -- ISO 3166-2 code, e.g. 'CA-ON'; NULL = whole country
  policy          TEXT NOT NULL CHECK (policy IN ('allow', 'block', 'kyc_required')),
  min_age         SMALLINT NOT NULL DEFAULT 18 CHECK (min_age BETWEEN 18 AND 25),
  games_allowed   TEXT[],           -- NULL = all games
  assets_allowed  TEXT[],           -- NULL = all enabled assets
  locked          BOOLEAN NOT NULL DEFAULT false,  -- sanctioned: cannot be changed from the dashboard
  note            TEXT,
  updated_by      UUID,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT locked_means_blocked CHECK (NOT locked OR policy = 'block'),
  CONSTRAINT one_rule_per_region UNIQUE NULLS NOT DISTINCT (country_code, subdivision)
);

-- Sanctioned territories: blocked and locked.
INSERT INTO region_rules (country_code, subdivision, policy, locked, note) VALUES
  ('CU', NULL,    'block', true, 'Sanctioned (OFAC)'),
  ('IR', NULL,    'block', true, 'Sanctioned (OFAC)'),
  ('KP', NULL,    'block', true, 'Sanctioned (OFAC/UN)'),
  ('SY', NULL,    'block', true, 'Sanctioned (OFAC)'),
  ('UA', 'UA-43', 'block', true, 'Crimea — sanctioned'),
  ('UA', 'UA-40', 'block', true, 'Sevastopol — sanctioned'),
  ('UA', 'UA-14', 'block', true, 'Donetsk — sanctioned'),
  ('UA', 'UA-09', 'block', true, 'Luhansk — sanctioned');

-- Starting blocked list from the design spec — to be confirmed by your gaming lawyer.
INSERT INTO region_rules (country_code, subdivision, policy, note) VALUES
  ('US', NULL,    'block', 'Spec default — confirm with counsel'),
  ('GB', NULL,    'block', 'Spec default — UKGC licence required'),
  ('FR', NULL,    'block', 'Spec default — confirm with counsel'),
  ('NL', NULL,    'block', 'Spec default — confirm with counsel'),
  ('ES', NULL,    'block', 'Spec default — confirm with counsel'),
  ('IT', NULL,    'block', 'Spec default — confirm with counsel'),
  ('AU', NULL,    'block', 'Spec default — confirm with counsel'),
  ('CA', 'CA-ON', 'block', 'Spec default — Ontario iGaming licence required');

-- ───────────────────────── Settings ─────────────────────────
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  UUID,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
  ('betting_paused',        'false'),
  ('withdrawals_paused',    'false'),
  ('signups_paused',        'false'),
  -- Countries with no rule fall back to this. 'block' = allowlist model: you open countries
  -- one by one from the dashboard once counsel approves them.
  ('region_default_policy', '"block"');

-- ───────────────────────── Admins & audit ─────────────────────────
CREATE TABLE admin_users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  role        TEXT NOT NULL CHECK (role IN ('owner', 'finance', 'compliance', 'support', 'read_only')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_audit_log (
  id           BIGSERIAL PRIMARY KEY,
  admin_id     UUID REFERENCES admin_users(id),
  action       TEXT NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  before       JSONB,
  after        JSONB,
  ip           INET,
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER admin_audit_append_only BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER admin_audit_no_truncate BEFORE TRUNCATE ON admin_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
