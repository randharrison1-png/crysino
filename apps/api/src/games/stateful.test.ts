import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser, testDb } from "../../test/helpers.js";
import type { Db } from "../db/pool.js";
import { FairnessService } from "../fairness/service.js";
import { chain, getBalance, player, post, verifyLedger } from "../ledger/ledger.js";
import { BetError, GameEngine, countOpenRounds } from "./engine.js";

let db: Db;
let fairness: FairnessService;
let engine: GameEngine;

beforeAll(async () => {
  db = testDb();
  fairness = new FairnessService(db, randomBytes(32), countOpenRounds);
  engine = new GameEngine(db, fairness);
  await db.query("UPDATE assets SET enabled = true WHERE code IN ('BTC', 'ETH')");
  await db.query("UPDATE games SET enabled = true WHERE code IN ('last_door', 'freefall', 'flap_fortune', 'gem_grid')");
  await db.query(`
    INSERT INTO game_limits (game, asset, min_bet, max_bet, max_payout) VALUES
      ('last_door', 'BTC', 100, 1000000, 50000000),
      ('freefall', 'BTC', 100, 1000000, 50000000),
      ('flap_fortune', 'BTC', 100, 1000000, 50000000),
      ('gem_grid', 'BTC', 100, 1000000, 50000000),
      ('gem_grid', 'ETH', 100, 1000, 1500)       -- tiny cap to test auto cash-out
    ON CONFLICT DO NOTHING`);
});
afterAll(() => db.end());

async function fundedUser(amount = 1_000_000n, asset = "BTC") {
  const u = await createUser(db);
  await post(db, { type: "deposit", legs: [{ account: chain(asset), amount: -amount }, { account: player(u, asset), amount }] });
  return u;
}

const start = (userId: string, game: string, params?: unknown, stake = 1_000n, asset = "BTC") =>
  engine.startRound({ userId, game, asset, stake, params, idempotencyKey: randomUUID() });

/** Test-only peek at the hidden state, to drive rounds deterministically. */
async function hidden<T>(roundId: string): Promise<T> {
  const { rows } = await db.query("SELECT state FROM rounds WHERE id = $1", [roundId]);
  return rows[0].state as T;
}

const code = (e: unknown) => (e instanceof BetError ? e.code : String(e));

describe("The Last Door", () => {
  it("opens one door from a full 100-door layout and pays the room", async () => {
    const u = await fundedUser();
    const { round } = await engine.placeInstantBet({
      userId: u, game: "last_door", asset: "BTC", stake: 10_000n, params: { door: 42 }, idempotencyKey: randomUUID(),
    });
    const r = round.result as { door: number; room: string; layout: string[] };
    expect(r.door).toBe(42);
    expect(r.layout).toHaveLength(100);
    expect(r.layout[41]).toBe(r.room);
    const pays = { empty: 0n, safe: 15_000n, gold: 40_000n, secret: 300_000n };
    expect(round.payout).toBe(pays[r.room as keyof typeof pays]);
  });
});

describe("Freefall", () => {
  it("takes the stake at start and hides the future", async () => {
    const u = await fundedUser(10_000n);
    const { round, balance } = await start(u, "freefall");
    expect(balance).toBe(9_000n);
    expect(round.status).toBe("open");
    expect(round.step).toBe(0);
    expect((round.result as { path: boolean[] }).path).toEqual([]);
    expect(Object.keys(round)).not.toContain("state");
  });

  it("advance until a planned stage, cash out, get paid the right multiplier", async () => {
    const u = await fundedUser();
    // Start rounds until one lets us pass 2 stages, so the test is deterministic.
    for (;;) {
      const { round } = await start(u, "freefall");
      const { path } = await hidden<{ path: boolean[] }>(round.id);
      if (path[0] && path[1]) {
        let r = await engine.act(u, round.id, { type: "advance" }, 0);
        r = await engine.act(u, round.id, { type: "advance" }, 1);
        expect((r.round.result as { path: boolean[] }).path).toEqual([true, true]);
        const before = await getBalance(db, player(u, "BTC"));
        r = await engine.act(u, round.id, { type: "cashout" }, 2);
        expect(r.settled).toBe(true);
        expect(r.round.status).toBe("cashed_out");
        expect(r.round.payout).toBe(1_959n); // 1,000 × 1.9591x, rounded down
        expect(await getBalance(db, player(u, "BTC"))).toBe(before + 1_959n);
        expect((r.round.result as { path: boolean[] }).path).toHaveLength(6); // full path revealed at the end
        return;
      }
      // Not the path we want: bust it out to close the round.
      const fail = path.indexOf(false);
      if (fail === -1) {
        for (let s = 0; s < 6; s++) await engine.act(u, round.id, { type: "advance" }, s);
      } else {
        for (let s = 0; s <= fail; s++) await engine.act(u, round.id, { type: "advance" }, s);
      }
    }
  });

  it("a failed stage loses the stake", async () => {
    const u = await fundedUser();
    for (;;) {
      const { round } = await start(u, "freefall");
      const { path } = await hidden<{ path: boolean[] }>(round.id);
      const fail = path.indexOf(false);
      if (fail === -1) {
        for (let s = 0; s < 6; s++) await engine.act(u, round.id, { type: "advance" }, s);
        continue;
      }
      let r;
      for (let s = 0; s <= fail; s++) r = await engine.act(u, round.id, { type: "advance" }, s);
      expect(r!.round.status).toBe("lost");
      expect(r!.round.payout).toBe(0n);
      return;
    }
  });

  it("a double-click can't apply an action twice", async () => {
    const u = await fundedUser();
    const { round } = await start(u, "freefall");
    const results = await Promise.allSettled([
      engine.act(u, round.id, { type: "advance" }, 0),
      engine.act(u, round.id, { type: "advance" }, 0),
    ]);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    // "stale_step", or "round_closed" if the first click busted the round — refused either way.
    expect(["stale_step", "round_closed"]).toContain(code((rejected[0] as PromiseRejectedResult).reason));
    const { rows } = await db.query("SELECT count(*)::int AS n FROM round_actions WHERE round_id = $1", [round.id]);
    expect(rows[0].n).toBe(1);
  });

  it("rules: no cash-out before a stage, one open round per game, owner only, closed is closed", async () => {
    const u = await fundedUser();
    const other = await fundedUser();
    const { round } = await start(u, "freefall");
    expect(code(await engine.act(u, round.id, { type: "cashout" }, 0).catch((e) => e))).toBe("invalid_params");
    expect(code(await start(u, "freefall").catch((e) => e))).toBe("round_already_open");
    await expect(start(u, "flap_fortune")).resolves.toBeTruthy(); // different game is fine
    expect(code(await engine.act(other, round.id, { type: "advance" }, 0).catch((e) => e))).toBe("round_not_found");
    expect(code(await engine.act(u, round.id, { type: "jump" }, 0).catch((e) => e))).toBe("invalid_params");
  });

  it("seeds can't be rotated while a round is open", async () => {
    const u = await fundedUser();
    await start(u, "freefall");
    await expect(fairness.rotate(u)).rejects.toThrow(/open rounds/);
  });
});

describe("Gem Grid", () => {
  it("reveal gems, cash out; mines stay hidden until the end", async () => {
    const u = await fundedUser();
    const { round } = await start(u, "gem_grid", { mines: 3 });
    const { mines } = await hidden<{ mines: number[] }>(round.id);
    const safe = [...Array(25).keys()].filter((t) => !mines.includes(t));

    let r = await engine.act(u, round.id, { type: "reveal", tile: safe[0] }, 0);
    expect((r.round.result as { minePositions: unknown }).minePositions).toBeNull();
    expect(r.round.multiplier).toBe(10_909n);
    r = await engine.act(u, round.id, { type: "reveal", tile: safe[1] }, 1);
    r = await engine.act(u, round.id, { type: "cashout" }, 2);
    expect(r.round.payout).toBe(1_246n); // 1,000 × 0.96 × (25·24)/(22·21) = 1.2467x, rounded down
    expect((r.round.result as { minePositions: number[] }).minePositions).toEqual(mines);
  });

  it("hitting a mine loses and reveals the board", async () => {
    const u = await fundedUser();
    const { round } = await start(u, "gem_grid", { mines: 5 });
    const { mines } = await hidden<{ mines: number[] }>(round.id);
    const r = await engine.act(u, round.id, { type: "reveal", tile: mines[0] }, 0);
    expect(r.round.status).toBe("lost");
    expect((r.round.result as { hit: number }).hit).toBe(mines[0]);
  });

  it("auto cash-out at the max payout, with the payout capped", async () => {
    const u = await fundedUser(100_000n, "ETH");
    // 24 mines: the one safe tile pays 24x = 24,000 on a 1,000 stake; ETH cap here is 1,500.
    const { round } = await start(u, "gem_grid", { mines: 24 }, 1_000n, "ETH");
    const { mines } = await hidden<{ mines: number[] }>(round.id);
    const safeTile = [...Array(25).keys()].find((t) => !mines.includes(t))!;
    const r = await engine.act(u, round.id, { type: "reveal", tile: safeTile }, 0);
    expect(r.round.status).toBe("cashed_out");
    expect(r.round.payout).toBe(1_500n);
    expect((r.round.result as { capped: boolean }).capped).toBe(true);
  });

  it("validates the chosen mine count", async () => {
    const u = await fundedUser();
    expect(code(await start(u, "gem_grid", { mines: 0 }).catch((e) => e))).toBe("invalid_params");
    expect(code(await start(u, "gem_grid", { mines: 25 }).catch((e) => e))).toBe("invalid_params");
  });
});

describe("idle rounds", () => {
  it("refunds untouched rounds and cashes out rounds with progress", async () => {
    const u1 = await fundedUser(10_000n);
    const { round: untouched } = await start(u1, "gem_grid", { mines: 3 });

    const u2 = await fundedUser(10_000n);
    const { round: progressed } = await start(u2, "gem_grid", { mines: 3 });
    const { mines } = await hidden<{ mines: number[] }>(progressed.id);
    const tile = [...Array(25).keys()].find((t) => !mines.includes(t))!;
    await engine.act(u2, progressed.id, { type: "reveal", tile }, 0);

    await db.query("UPDATE rounds SET updated_at = now() - interval '2 days' WHERE id IN ($1, $2)", [untouched.id, progressed.id]);
    const res = await engine.resolveIdleRounds(24 * 3600 * 1000);
    expect(res.refunded).toBeGreaterThanOrEqual(1);
    expect(res.cashedOut).toBeGreaterThanOrEqual(1);

    expect((await engine.getRound(u1, untouched.id))!.status).toBe("refunded");
    expect(await getBalance(db, player(u1, "BTC"))).toBe(10_000n);
    const p = (await engine.getRound(u2, progressed.id))!;
    expect(p.status).toBe("cashed_out");
    expect(p.payout).toBe(1_090n);
  });
});

describe("verification by replay", () => {
  it("every settled multi-step round re-computes exactly after the seed is revealed", async () => {
    const u = await fundedUser();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { round } = await start(u, "gem_grid", { mines: 4 });
      const { mines } = await hidden<{ mines: number[] }>(round.id);
      const safe = [...Array(25).keys()].filter((t) => !mines.includes(t));
      await engine.act(u, round.id, { type: "reveal", tile: safe[0] }, 0);
      if (i % 2) await engine.act(u, round.id, { type: "cashout" }, 1);
      else await engine.act(u, round.id, { type: "reveal", tile: mines[0] }, 1);
      ids.push(round.id);
    }
    for (let i = 0; i < 3; i++) {
      const { round } = await start(u, "freefall");
      const { path } = await hidden<{ path: boolean[] }>(round.id);
      let s = 0;
      while (true) {
        const r = await engine.act(u, round.id, { type: "advance" }, s++);
        if (r.settled) break;
        if (s === 2 && path[1]) {
          await engine.act(u, round.id, { type: "cashout" }, s);
          break;
        }
      }
      ids.push(round.id);
    }
    await fairness.rotate(u);
    for (const id of ids) {
      expect(await engine.verifyRound(u, id), id).toMatchObject({ verifiable: true, matches: true });
    }
  });

  it("the books still balance", async () => {
    expect(await verifyLedger(db)).toEqual([]);
  });
});
