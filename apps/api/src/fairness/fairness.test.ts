import { randomBytes } from "node:crypto";
import { FairRng, hashServerSeed } from "@crysino/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser, testDb } from "../../test/helpers.js";
import { withTransaction, type Db } from "../db/pool.js";
import { decryptSeed, encryptSeed } from "./seed-crypto.js";
import { FairnessError, FairnessService } from "./service.js";

const KEY = randomBytes(32);
let db: Db;
let openRounds = 0; // stand-in until the rounds table exists (Step 3)
let fairness: FairnessService;

beforeAll(() => {
  db = testDb();
  fairness = new FairnessService(db, KEY, async () => openRounds);
});
afterAll(() => db.end());

describe("seed encryption", () => {
  it("round-trips and detects tampering", () => {
    const blob = encryptSeed("secret-seed", KEY);
    expect(decryptSeed(blob, KEY)).toBe("secret-seed");
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => decryptSeed(tampered, KEY)).toThrow();
    expect(() => decryptSeed(blob, randomBytes(32))).toThrow();
  });
});

describe("fairness service", () => {
  it("gives a new player an active pair and a pre-committed next pair", async () => {
    const u = await createUser(db);
    const s = await fairness.getState(u);
    expect(s.serverSeedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.nextServerSeedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.serverSeedHash).not.toBe(s.nextServerSeedHash);
    expect(s.nonce).toBe(0);
    expect(await fairness.getState(u)).toEqual(s); // stable across calls
  });

  it("never stores an unrevealed seed in plaintext", async () => {
    const u = await createUser(db);
    await fairness.getState(u);
    const { rows } = await db.query(
      "SELECT server_seed FROM seed_pairs WHERE user_id = $1 AND status <> 'revealed'",
      [u],
    );
    expect(rows.every((r) => r.server_seed === null)).toBe(true);
  });

  it("hands out consecutive nonces, one per bet", async () => {
    const u = await createUser(db);
    const a = await withTransaction(db, (c) => fairness.consumeNonce(c, u));
    const b = await withTransaction(db, (c) => fairness.consumeNonce(c, u));
    expect([a.nonce, b.nonce]).toEqual([0, 1]);
    expect(hashServerSeed(a.serverSeed)).toBe((await fairness.getState(u)).serverSeedHash);
    expect((await fairness.getState(u)).nonce).toBe(2);
  });

  it("does not use up a nonce when the bet rolls back", async () => {
    const u = await createUser(db);
    await expect(
      withTransaction(db, async (c) => {
        await fairness.consumeNonce(c, u);
        throw new Error("bet failed");
      }),
    ).rejects.toThrow("bet failed");
    expect((await fairness.getState(u)).nonce).toBe(0);
  });

  it("never duplicates a nonce under 25 simultaneous bets", async () => {
    const u = await createUser(db);
    await fairness.getState(u);
    const seeds = await Promise.all(
      Array.from({ length: 25 }, () => withTransaction(db, (c) => fairness.consumeNonce(c, u))),
    );
    expect(seeds.map((s) => s.nonce).sort((x, y) => x - y)).toEqual([...Array(25).keys()]);
  });

  it("rotation reveals a seed that matches what was committed, and verifies past bets", async () => {
    const u = await createUser(db);
    const before = await fairness.getState(u);
    const bet = await withTransaction(db, (c) => fairness.consumeNonce(c, u));
    const outcome = new FairRng(bet.serverSeed, bet.clientSeed, bet.nonce).int(100);

    const { revealed, state } = await fairness.rotate(u, "my new seed");

    // What the player can now check for themselves:
    expect(hashServerSeed(revealed.serverSeed)).toBe(before.serverSeedHash);
    expect(revealed.clientSeed).toBe(before.clientSeed);
    expect(revealed.betsMade).toBe(1);
    expect(new FairRng(revealed.serverSeed, revealed.clientSeed, 0).int(100)).toBe(outcome);

    // The next server seed was fixed before the player chose their client seed:
    expect(state.serverSeedHash).toBe(before.nextServerSeedHash);
    expect(state.clientSeed).toBe("my new seed");
    expect(state.nonce).toBe(0);
    expect(state.nextServerSeedHash).not.toBe(before.nextServerSeedHash);
  });

  it("refuses to rotate while a round is open", async () => {
    const u = await createUser(db);
    await fairness.getState(u);
    openRounds = 1;
    try {
      await expect(fairness.rotate(u)).rejects.toBeInstanceOf(FairnessError);
    } finally {
      openRounds = 0;
    }
    const pair = await db.query("SELECT count(*)::int AS n FROM seed_pairs WHERE user_id = $1 AND status = 'revealed'", [u]);
    expect(pair.rows[0].n).toBe(0);
  });

  it("rejects invalid client seeds", async () => {
    const u = await createUser(db);
    await expect(fairness.rotate(u, "bad:seed")).rejects.toBeInstanceOf(FairnessError);
    await expect(fairness.rotate(u, "")).rejects.toBeInstanceOf(FairnessError);
  });

  it("bets racing a rotation all get a valid, unique (pair, nonce)", async () => {
    const u = await createUser(db);
    await fairness.getState(u);
    const bets = Array.from({ length: 10 }, () => withTransaction(db, (c) => fairness.consumeNonce(c, u)));
    const [results] = await Promise.all([Promise.all(bets), fairness.rotate(u)]);
    const keys = results.map((r) => `${r.seedPairId}:${r.nonce}`);
    expect(new Set(keys).size).toBe(10);
  });
});

describe("database guarantees", () => {
  it("blocks changing a commitment, rewinding a nonce, faking a reveal, or deleting", async () => {
    const u = await createUser(db);
    await fairness.getState(u);
    const where = "WHERE user_id = $1 AND status = 'active'";
    await expect(db.query(`UPDATE seed_pairs SET server_seed_hash = 'x' ${where}`, [u])).rejects.toThrow(
      /commitment/,
    );
    await db.query(`UPDATE seed_pairs SET nonce = 5 ${where}`, [u]);
    await expect(db.query(`UPDATE seed_pairs SET nonce = 4 ${where}`, [u])).rejects.toThrow(/nonce/);
    await expect(
      db.query(`UPDATE seed_pairs SET status = 'revealed', server_seed = 'not-the-seed' ${where}`, [u]),
    ).rejects.toThrow(/does not match/);
    await expect(db.query(`DELETE FROM seed_pairs ${where}`, [u])).rejects.toThrow(/cannot be deleted/);
  });

  it("freezes revealed pairs", async () => {
    const u = await createUser(db);
    await fairness.rotate(u);
    await expect(
      db.query("UPDATE seed_pairs SET nonce = nonce + 1 WHERE user_id = $1 AND status = 'revealed'", [u]),
    ).rejects.toThrow(/frozen/);
  });
});
