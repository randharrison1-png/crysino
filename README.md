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
```

## Build progress

- [x] **Step 1 — Foundation:** monorepo, schema, double-entry ledger
- [x] **Step 2 — Provably fair seeds:** shared RNG (runs in browser too), encrypted seed pairs, nonce, rotate & reveal
- [ ] Step 3 — Game engine + Dice 100 and Doomsday
- [ ] Step 4 — Player API (auth, bets, WebSocket)
- [ ] Step 5 — Remaining instant games
- [ ] Step 6 — Wallet service (testnets first)
- [ ] Step 7 — Admin API + dashboard (treasury, regions, games)
- [ ] Step 8 — Player website
- [ ] Step 9 — Neon 21 (blackjack)
- [ ] Step 10 — Compliance integrations, hardening, audits

## Money rules

- Amounts are whole numbers of an asset's smallest unit (satoshi, wei…), `bigint` in code,
  `NUMERIC(78,0)` in Postgres. Never JS numbers.
- Every balance change goes through `apps/api/src/ledger/ledger.ts`. Transactions must sum to
  zero per asset; the database refuses to commit one that doesn't.
- Ledger and audit tables are append-only. Mistakes are fixed with a new `adjustment`, never an edit.
