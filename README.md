# Crysino

Seven-game crypto casino: player site, back end and admin dashboard.
Design spec: "Crysino — Platform Design Spec" doc.

## Layout

```
apps/api         Back end (Fastify + Postgres) — ledger, games, wallets, compliance
apps/web         Player website            (later step)
apps/admin       Admin dashboard           (later step)
packages/shared  Types and money helpers shared by all apps
```

## Run it locally

Needs Node 22+, pnpm and Docker.

```bash
cp .env.example .env
pnpm install
pnpm db:up        # Postgres + Redis in Docker
pnpm migrate      # create tables
pnpm test         # run all tests
pnpm --filter @crysino/api dev   # API on http://localhost:4000
```

New databases block every country by default. For local play, allow your DEV_COUNTRY:
`INSERT INTO region_rules (country_code, policy) VALUES ('MT', 'allow');`

## Player API

| Method | Path | |
|---|---|---|
| POST | /auth/register | email, password, dateOfBirth, acceptTerms |
| POST | /auth/login | email, password, totp (if 2FA on) |
| POST | /auth/logout | |
| GET | /me · /balances | |
| POST | /me/2fa/setup · /me/2fa/enable · /me/2fa/disable | |
| GET | /games · /assets | public |
| POST | /bets | game, asset, stake (base units, string), params + `Idempotency-Key` header |
| POST | /rounds | start a multi-step round (Freefall, Flap Fortune, Gem Grid) + `Idempotency-Key` |
| POST | /rounds/:id/actions | `{ action, step }` — advance / reveal / cashout; `step` from the last response |
| GET | /rounds/active | unfinished rounds, to restore after a reload |
| GET | /rounds · /rounds/:id · /rounds/:id/verify | |
| GET / POST | /fairness · /fairness/rotate | |
| WS | /ws | live_bet, big_win (public); round, balance (signed in) |

Amounts are always strings of base units. Errors are `{ error: { code, message, details? } }`.
Every POST must come from an origin in `WEB_ORIGINS` (CSRF protection).

## Build progress

- [x] **Step 1 — Foundation:** monorepo, schema, double-entry ledger
- [x] **Step 2 — Provably fair seeds:** shared RNG (runs in browser too), encrypted seed pairs, nonce, rotate & reveal
- [x] **Step 3 — Game engine:** atomic bets, versioned configs, limits, payout cap; Dice 100 and Doomsday
- [x] **Step 4 — Player API:** sign-up/login, 2FA, sessions, region gate, bets, history, fairness, live WebSocket
- [x] **Step 5 — Four more games:** The Last Door; Freefall, Flap Fortune, Gem Grid with open rounds, cash-out, auto cash-out at max payout, idle-round settlement
- [ ] Step 6 — Wallet service (testnets first)
- [ ] Step 7 — Admin API + dashboard (treasury, regions, games)
- [ ] Step 8 — Player website
- [ ] Step 9 — Neon 21 (blackjack)
- [ ] Step 10 — Compliance integrations, hardening, audits

## Checking the game maths

```bash
pnpm --filter @crysino/shared simulate 5000000   # plays 5M rounds per scenario through the real code
```

## Scheduled job (to wire up in deployment)

`engine.resolveIdleRounds(24h)` settles rounds left open for a day: cash-out at the current
multiplier, or a refund if no step was cleared. Run it every few minutes.

## Known scaling item

Every bet updates the house bankroll row, so bets across all players queue on that one row.
Fine for launch volumes; if it ever becomes a bottleneck, split the bankroll into several
sub-accounts per asset and spread bets across them.

## Money rules

- Amounts are whole numbers of an asset's smallest unit (satoshi, wei…), `bigint` in code,
  `NUMERIC(78,0)` in Postgres. Never JS numbers.
- Every balance change goes through `apps/api/src/ledger/ledger.ts`. Transactions must sum to
  zero per asset; the database refuses to commit one that doesn't.
- Ledger and audit tables are append-only. Mistakes are fixed with a new `adjustment`, never an edit.
