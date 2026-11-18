import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser, testDb } from "../../test/helpers.js";
import type { Db } from "../db/pool.js";
import { FairnessService } from "../fairness/service.js";
import { chain, getBalance, house, player, post, verifyLedger } from "../ledger/ledger.js";
import { BetError, GameEngine, countOpenRounds, type InstantBetRequest } from "./engine.js";

let db: Db;
let fairness: FairnessService;
let engine: GameEngine;

beforeAll(async () => {
  db = testDb();
  fairness = new FairnessService(db, randomBytes(32), countOpenRounds);
  engine = new GameEngine(db, fairness);
  await db.query("UPDATE assets SET enabled = true WHERE code IN ('BTC', 'ETH')");
  await db.query("UPDATE games SET enabled = true WHERE code IN ('dice', 'doomsday')");
  // BTC: min 100 sats, max 1,000,000 sats, max payout 50,000,000 sats (0.5 BTC)
  await db.query(
    `INSERT INTO game_limits (game, asset, min_bet, max_bet, max_payout) VALUES
       ('dice', 'BTC', 100, 1000000, 50000000), ('doomsday', 'BTC', 100, 1000000, 50000000)
     ON CONFLICT DO NOTHING`,
  );
});
afterAll(() => db.end());

async function fundedUser(amount = 10_000_000n): Promise<string> {
  const u = await createUser(db);
  await post(db, {
    type: "deposit",
    legs: [
      { account: chain("BTC"), amount: -amount },
      { account: player(u, "BTC"), amount },
    ],
  });
  return u;
}

const diceBet = (userId: string, over: Partial<InstantBetRequest> = {}): InstantBetRequest => ({
  userId,
  game: "dice",
  asset: "BTC",
  stake: 1_000n,
  params: { direction: "under", target: 50 },
  idempotencyKey: randomUUID(),
  ...over,
});

async function expectBetError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof BetError && e.code === code);
}

describe("instant bets", () => {
  it("settles a dice bet: balance, payout and round all agree", async () => {
    const u = await fundedUser(10_000n);
    const { round, balance } = await engine.placeInstantBet(diceBet(u));
    const r = round.result as { roll: number; won: boolean };
    expect(r.won).toBe(r.roll <= 49);
    expect(round.payout).toBe(r.won ? 1_920n : 0n);
    expect(round.status).toBe(r.won ? "won" : "lost");
    expect(balance).toBe(10_000n - 1_000n + round.payout);
    expect(await getBalance(db, player(u, "BTC"))).toBe(balance);
  });

  it("settles a Doomsday press", async () => {
    const u = await fundedUser();
    const { round } = await engine.placeInstantBet({
      userId: u,
      game: "doomsday",
      asset: "BTC",
      stake: 10_000n,
      idempotencyKey: randomUUID(),
    });
    const tier = (round.result as { tier: string }).tier;
    const expected = { destroyed: 0n, recovery: 20_000n, jackpot: 50_000n, override: 100_000n, miracle: 800_000n };
    expect(round.payout).toBe(expected[tier as keyof typeof expected]);
  });

  it("every round can be re-computed by the player once the seed is revealed", async () => {
    const u = await fundedUser();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await engine.placeInstantBet(diceBet(u))).round.id);
    expect(await engine.verifyRound(u, ids[0]!)).toEqual({ verifiable: false }); // not revealed yet

    await fairness.rotate(u);
    for (const id of ids) {
      const v = await engine.verifyRound(u, id);
      expect(v).toMatchObject({ verifiable: true, matches: true });
    }
  });

  it("uses consecutive nonces and records them", async () => {
    const u = await fundedUser();
    const a = await engine.placeInstantBet(diceBet(u));
    const b = await engine.placeInstantBet(diceBet(u));
    expect([a.round.nonce, b.round.nonce]).toEqual([0, 1]);
    expect(a.round.serverSeedHash).toBe(b.round.serverSeedHash);
  });

  it("a retried request returns the same round and charges once", async () => {
    const u = await fundedUser(10_000n);
    const req = diceBet(u);
    const first = await engine.placeInstantBet(req);
    const again = await engine.placeInstantBet(req);
    expect(again.replayed).toBe(true);
    expect(again.round.id).toBe(first.round.id);
    expect(await getBalance(db, player(u, "BTC"))).toBe(first.balance);
    await expectBetError(engine.placeInstantBet({ ...req, stake: 2_000n }), "idempotency_conflict");
  });

  it("simultaneous retries of one request still bet only once", async () => {
    const u = await fundedUser(10_000n);
    const req = diceBet(u);
    const results = await Promise.all(Array.from({ length: 5 }, () => engine.placeInstantBet(req)));
    expect(new Set(results.map((r) => r.round.id)).size).toBe(1);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM rounds WHERE user_id = $1", [u]);
    expect(rows[0].n).toBe(1);
  });

  it("house bankroll moves by exactly stakes minus payouts", async () => {
    const u = await fundedUser();
    const before = await getBalance(db, house("BTC"));
    let net = 0n;
    for (let i = 0; i < 20; i++) {
      const { round } = await engine.placeInstantBet(diceBet(u));
      net += round.stake - round.payout;
    }
    expect(await getBalance(db, house("BTC"))).toBe(before + net);
  });

  it("40 simultaneous bets: no overdraft, unique nonces, books balance", async () => {
    const u = await fundedUser(20_000n);
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, () => engine.placeInstantBet(diceBet(u, { stake: 1_000n }))),
    );
    const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value.round] : []));
    const failures = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
    expect(failures.every((e) => e instanceof BetError && e.code === "insufficient_funds")).toBe(true);
    expect(new Set(ok.map((r) => r.nonce)).size).toBe(ok.length);

    const finalBalance = await getBalance(db, player(u, "BTC"));
    const net = ok.reduce((s, r) => s + r.payout - r.stake, 0n);
    expect(finalBalance).toBe(20_000n + net);
    expect(finalBalance >= 0n).toBe(true);
    expect(await verifyLedger(db)).toEqual([]);
  });
});

describe("bet checks — a refused bet leaves no trace", () => {
  async function assertNoTrace(u: string, balance: bigint) {
    expect(await getBalance(db, player(u, "BTC"))).toBe(balance);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM rounds WHERE user_id = $1", [u]);
    expect(rows[0].n).toBe(0);
    expect((await fairness.getState(u)).nonce).toBe(0);
  }

  it("not enough balance", async () => {
    const u = await fundedUser(500n);
    await expectBetError(engine.placeInstantBet(diceBet(u, { stake: 600n })), "insufficient_funds");
    await assertNoTrace(u, 500n);
  });

  it("stake limits", async () => {
    const u = await fundedUser();
    await expectBetError(engine.placeInstantBet(diceBet(u, { stake: 99n })), "stake_too_low");
    await expectBetError(engine.placeInstantBet(diceBet(u, { stake: 1_000_001n })), "stake_too_high");
    await assertNoTrace(u, 10_000_000n);
  });

  it("max payout cap tells the player the largest stake allowed", async () => {
    const u = await fundedUser();
    // 1% chance pays 96x: 1,000,000 × 96 = 96,000,000 > 50,000,000 cap
    const err = await engine
      .placeInstantBet(diceBet(u, { stake: 1_000_000n, params: { direction: "under", target: 1 } }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(BetError);
    expect(err.code).toBe("payout_cap");
    expect(err.details.maxStake).toBe("520833"); // 50,000,000 / 96 rounded down
    await assertNoTrace(u, 10_000_000n);
  });

  it("invalid choices", async () => {
    const u = await fundedUser();
    await expectBetError(
      engine.placeInstantBet(diceBet(u, { params: { direction: "under", target: 0 } })),
      "invalid_params",
    );
    await assertNoTrace(u, 10_000_000n);
  });

  it("currency not set up for the game", async () => {
    const u = await fundedUser();
    await expectBetError(engine.placeInstantBet(diceBet(u, { asset: "ETH" })), "asset_not_allowed");
    await expectBetError(engine.placeInstantBet(diceBet(u, { asset: "SOL" })), "asset_not_allowed");
  });

  it("disabled, maintenance, unbuilt and unknown games", async () => {
    const u = await fundedUser();
    await db.query("UPDATE games SET maintenance = true WHERE code = 'dice'");
    try {
      await expectBetError(engine.placeInstantBet(diceBet(u)), "game_unavailable");
    } finally {
      await db.query("UPDATE games SET maintenance = false WHERE code = 'dice'");
    }
    await expectBetError(engine.placeInstantBet(diceBet(u, { game: "neon21" })), "game_unavailable");
    await expectBetError(engine.placeInstantBet(diceBet(u, { game: "nope" })), "game_unavailable");
    await assertNoTrace(u, 10_000_000n);
  });

  it("global kill switch", async () => {
    const u = await fundedUser();
    await db.query("UPDATE settings SET value = 'true' WHERE key = 'betting_paused'");
    try {
      await expectBetError(engine.placeInstantBet(diceBet(u)), "betting_paused");
    } finally {
      await db.query("UPDATE settings SET value = 'false' WHERE key = 'betting_paused'");
    }
  });

  it("frozen or self-excluded accounts", async () => {
    for (const status of ["frozen", "self_excluded", "closed"]) {
      const u = await fundedUser();
      await db.query("UPDATE users SET status = $2 WHERE id = $1", [u, status]);
      await expectBetError(engine.placeInstantBet(diceBet(u)), "account_inactive");
    }
  });
});

describe("round integrity", () => {
  it("settled rounds can't be edited or deleted", async () => {
    const u = await fundedUser();
    const { round } = await engine.placeInstantBet(diceBet(u));
    await expect(db.query("UPDATE rounds SET payout = 999999 WHERE id = $1", [round.id])).rejects.toThrow(
      /settled/,
    );
    await expect(db.query("DELETE FROM rounds WHERE id = $1", [round.id])).rejects.toThrow(/cannot be deleted/);
  });

  it("game configs are immutable versions", async () => {
    await expect(db.query("UPDATE game_configs SET rtp = 0.99 WHERE game = 'dice'")).rejects.toThrow(
      /append-only/,
    );
  });

  it("seeds can't be rotated while a round is open", async () => {
    const u = await fundedUser();
    const seed = await fairness.getState(u);
    const pair = await db.query("SELECT id FROM seed_pairs WHERE user_id = $1 AND status = 'active'", [u]);
    await db.query(
      `INSERT INTO rounds (user_id, game, config_version, seed_pair_id, nonce, asset, stake, status)
       VALUES ($1, 'dice', 1, $2, $3, 'BTC', 100, 'open')`,
      [u, pair.rows[0].id, seed.nonce],
    );
    await expect(fairness.rotate(u)).rejects.toThrow(/open rounds/);
  });
});
