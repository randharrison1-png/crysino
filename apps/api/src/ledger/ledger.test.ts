import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser, testDb } from "../../test/helpers.js";
import type { Db } from "../db/pool.js";
import {
  IdempotencyConflictError,
  InsufficientFundsError,
  UnbalancedTransactionError,
  chain,
  getBalance,
  house,
  player,
  post,
  verifyLedger,
} from "./ledger.js";

let db: Db;
beforeAll(() => {
  db = testDb();
});
afterAll(() => db.end());

async function deposit(userId: string, amount: bigint, asset = "BTC") {
  return post(db, {
    type: "deposit",
    legs: [
      { account: chain(asset), amount: -amount },
      { account: player(userId, asset), amount },
    ],
  });
}

describe("ledger", () => {
  it("credits a deposit and debits the outside world", async () => {
    const u = await createUser(db);
    await deposit(u, 100_000n);
    expect(await getBalance(db, player(u, "BTC"))).toBe(100_000n);
  });

  it("runs a full bet: stake to bankroll, win back to player", async () => {
    const u = await createUser(db);
    await deposit(u, 1_000n);
    const bankrollBefore = await getBalance(db, house("BTC"));

    await post(db, {
      type: "bet",
      refType: "round",
      refId: "r1",
      legs: [
        { account: player(u, "BTC"), amount: -100n },
        { account: house("BTC"), amount: 100n },
      ],
    });
    await post(db, {
      type: "win",
      refType: "round",
      refId: "r1",
      legs: [
        { account: house("BTC"), amount: -200n },
        { account: player(u, "BTC"), amount: 200n },
      ],
    });

    expect(await getBalance(db, player(u, "BTC"))).toBe(1_100n);
    expect(await getBalance(db, house("BTC"))).toBe(bankrollBefore - 100n);
  });

  it("refuses to overdraw a player and leaves nothing behind", async () => {
    const u = await createUser(db);
    await deposit(u, 50n);
    await expect(
      post(db, {
        type: "bet",
        legs: [
          { account: player(u, "BTC"), amount: -51n },
          { account: house("BTC"), amount: 51n },
        ],
      }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await getBalance(db, player(u, "BTC"))).toBe(50n);
  });

  it("rejects unbalanced transactions in code", async () => {
    const u = await createUser(db);
    await expect(
      post(db, {
        type: "adjustment",
        legs: [
          { account: house("BTC", "adjustments"), amount: -10n },
          { account: player(u, "BTC"), amount: 11n },
        ],
      }),
    ).rejects.toBeInstanceOf(UnbalancedTransactionError);
  });

  it("rejects unbalanced entries at the database level too", async () => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO ledger_txns (type) VALUES ('adjustment') RETURNING id",
      );
      const acct = await client.query<{ id: string }>(
        `INSERT INTO ledger_accounts (owner_type, asset, kind, allow_negative)
         VALUES ('house', 'ETH', 'adjustments', true)
         ON CONFLICT ON CONSTRAINT one_account_per_slot DO UPDATE SET kind = EXCLUDED.kind
         RETURNING id`,
      );
      await client.query("INSERT INTO ledger_entries (txn_id, account_id, amount) VALUES ($1, $2, 5)", [
        rows[0]!.id,
        acct.rows[0]!.id,
      ]);
      await expect(client.query("COMMIT")).rejects.toThrow(/does not balance/);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

  it("never moves money twice for the same idempotency key", async () => {
    const u = await createUser(db);
    await deposit(u, 500n);
    const key = randomUUID();
    const bet = {
      type: "bet" as const,
      idempotencyKey: key,
      legs: [
        { account: player(u, "BTC"), amount: -100n },
        { account: house("BTC"), amount: 100n },
      ],
    };
    const first = await post(db, bet);
    const second = await post(db, bet);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.txnId).toBe(first.txnId);
    expect(await getBalance(db, player(u, "BTC"))).toBe(400n);
  });

  it("rejects a reused idempotency key with different contents", async () => {
    const u = await createUser(db);
    await deposit(u, 500n);
    const key = randomUUID();
    const legs = (n: bigint) => [
      { account: player(u, "BTC"), amount: -n },
      { account: house("BTC"), amount: n },
    ];
    await post(db, { type: "bet", idempotencyKey: key, legs: legs(100n) });
    await expect(post(db, { type: "bet", idempotencyKey: key, legs: legs(200n) })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it("does not overspend under 30 simultaneous bets", async () => {
    const u = await createUser(db);
    await deposit(u, 100n);
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, () =>
        post(db, {
          type: "bet",
          legs: [
            { account: player(u, "BTC"), amount: -10n },
            { account: house("BTC"), amount: 10n },
          ],
        }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof InsufficientFundsError,
    ).length;
    expect(ok).toBe(10);
    expect(rejected).toBe(20);
    expect(await getBalance(db, player(u, "BTC"))).toBe(0n);
  });

  it("keeps assets separate", async () => {
    const u = await createUser(db);
    await deposit(u, 10n, "BTC");
    await deposit(u, 7n, "SOL");
    expect(await getBalance(db, player(u, "BTC"))).toBe(10n);
    expect(await getBalance(db, player(u, "SOL"))).toBe(7n);
  });

  it("handles 18-decimal amounts beyond 64-bit range", async () => {
    const u = await createUser(db);
    const big = 123_456_789_000_000_000_000_000n; // 123,456.789 ETH in wei
    await deposit(u, big, "ETH");
    expect(await getBalance(db, player(u, "ETH"))).toBe(big);
  });

  it("history is append-only", async () => {
    await expect(db.query("UPDATE ledger_entries SET amount = amount * 2")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM ledger_txns")).rejects.toThrow(/append-only/);
    await expect(db.query("TRUNCATE ledger_entries CASCADE")).rejects.toThrow(/append-only/);
  });

  it("cached balances always match the entries", async () => {
    expect(await verifyLedger(db)).toEqual([]);
  });
});
