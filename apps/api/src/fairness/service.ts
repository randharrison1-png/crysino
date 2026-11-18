import { randomBytes } from "node:crypto";
import { hashServerSeed, isValidClientSeed } from "@crysino/shared";
import { withTransaction, type Db, type DbClient } from "../db/pool.js";
import { decryptSeed, encryptSeed } from "./seed-crypto.js";

/** What the player sees on the Fairness tab. Never includes an unrevealed server seed. */
export interface FairnessState {
  serverSeedHash: string;
  clientSeed: string;
  nonce: number; // the nonce the NEXT bet will use
  nextServerSeedHash: string;
}

/** Handed to the game engine inside a bet transaction. Server-only. */
export interface BetSeed {
  seedPairId: string;
  serverSeed: string;
  clientSeed: string;
  nonce: number;
}

export interface RevealedSeed {
  seedPairId: string;
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  betsMade: number; // nonces 0 … betsMade-1 were used with this pair
}

export class FairnessError extends Error {}

/**
 * Counts a player's unfinished stateful rounds (Freefall, Gem Grid, Neon 21…).
 * Rotation must be refused while any are open: their whole outcome is already fixed by the
 * current seed, so revealing it would show the player what happens next.
 */
export type OpenRoundCounter = (client: DbClient, userId: string) => Promise<number>;

const newServerSeed = () => randomBytes(32).toString("hex");
const defaultClientSeed = () => randomBytes(10).toString("hex");

export class FairnessService {
  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
    private readonly countOpenRounds: OpenRoundCounter,
  ) {}

  /** Serialises seed setup/rotation for one player across concurrent requests. */
  private async lockUser(client: DbClient, userId: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('seed:' || $1))", [userId]);
  }

  private async insertNext(client: DbClient, userId: string): Promise<void> {
    const seed = newServerSeed();
    await client.query(
      `INSERT INTO seed_pairs (user_id, status, server_seed_enc, server_seed_hash)
       VALUES ($1, 'next', $2, $3)`,
      [userId, encryptSeed(seed, this.key), hashServerSeed(seed)],
    );
  }

  /** Make sure the player has an active and a next pair. Idempotent. */
  private async ensure(client: DbClient, userId: string): Promise<void> {
    const { rows } = await client.query<{ status: string }>(
      "SELECT status FROM seed_pairs WHERE user_id = $1 AND status IN ('active', 'next')",
      [userId],
    );
    const has = new Set(rows.map((r) => r.status));
    if (has.has("active") && has.has("next")) return;

    await this.lockUser(client, userId);
    const again = await client.query<{ status: string }>(
      "SELECT status FROM seed_pairs WHERE user_id = $1 AND status IN ('active', 'next')",
      [userId],
    );
    const now = new Set(again.rows.map((r) => r.status));
    if (!now.has("next")) await this.insertNext(client, userId);
    if (!now.has("active")) {
      await client.query(
        `UPDATE seed_pairs SET status = 'active', client_seed = $2, activated_at = now()
         WHERE user_id = $1 AND status = 'next'`,
        [userId, defaultClientSeed()],
      );
      await this.insertNext(client, userId);
    }
  }

  async getState(userId: string): Promise<FairnessState> {
    return withTransaction(this.db, async (client) => {
      await this.ensure(client, userId);
      const { rows } = await client.query<{
        status: string;
        server_seed_hash: string;
        client_seed: string | null;
        nonce: string;
      }>(
        `SELECT status, server_seed_hash, client_seed, nonce FROM seed_pairs
         WHERE user_id = $1 AND status IN ('active', 'next')`,
        [userId],
      );
      const active = rows.find((r) => r.status === "active")!;
      const next = rows.find((r) => r.status === "next")!;
      return {
        serverSeedHash: active.server_seed_hash,
        clientSeed: active.client_seed!,
        nonce: Number(active.nonce),
        nextServerSeedHash: next.server_seed_hash,
      };
    });
  }

  /**
   * Take the next nonce for a bet. Call INSIDE the bet's database transaction so that if the
   * bet fails, the nonce is not used up. Locks the player's active pair until commit, so
   * concurrent bets get consecutive, never duplicate, nonces.
   */
  async consumeNonce(client: DbClient, userId: string): Promise<BetSeed> {
    // Two attempts: if a rotation commits while we wait for the row lock, the row we waited on
    // is no longer active and Postgres skips it; the second read finds the newly active pair.
    let pair: { id: string; server_seed_enc: Buffer; client_seed: string; nonce: string } | undefined;
    for (let attempt = 0; attempt < 2 && !pair; attempt++) {
      await this.ensure(client, userId);
      const { rows } = await client.query<{
        id: string;
        server_seed_enc: Buffer;
        client_seed: string;
        nonce: string;
      }>(
        `SELECT id, server_seed_enc, client_seed, nonce FROM seed_pairs
         WHERE user_id = $1 AND status = 'active' FOR UPDATE`,
        [userId],
      );
      pair = rows[0];
    }
    if (!pair) throw new FairnessError("No active seed pair");
    await client.query("UPDATE seed_pairs SET nonce = nonce + 1 WHERE id = $1", [pair.id]);
    return {
      seedPairId: pair.id,
      serverSeed: decryptSeed(pair.server_seed_enc, this.key),
      clientSeed: pair.client_seed,
      nonce: Number(pair.nonce),
    };
  }

  /**
   * Reveal the current server seed and start using the pre-committed next one with a new
   * client seed (the player's choice, or random).
   */
  async rotate(
    userId: string,
    newClientSeed?: string,
  ): Promise<{ revealed: RevealedSeed; state: FairnessState }> {
    const clientSeed = newClientSeed ?? defaultClientSeed();
    if (!isValidClientSeed(clientSeed)) {
      throw new FairnessError("Client seed must be 1–64 printable characters without ':'");
    }

    const revealed = await withTransaction(this.db, async (client) => {
      await this.ensure(client, userId);
      await this.lockUser(client, userId);

      const { rows } = await client.query<{
        id: string;
        server_seed_enc: Buffer;
        server_seed_hash: string;
        client_seed: string;
        nonce: string;
      }>(
        `SELECT id, server_seed_enc, server_seed_hash, client_seed, nonce FROM seed_pairs
         WHERE user_id = $1 AND status = 'active' FOR UPDATE`,
        [userId],
      );
      const active = rows[0]!;

      if ((await this.countOpenRounds(client, userId)) > 0) {
        throw new FairnessError("Finish or cash out your open rounds before changing seeds");
      }

      const serverSeed = decryptSeed(active.server_seed_enc, this.key);
      await client.query(
        `UPDATE seed_pairs SET status = 'revealed', server_seed = $2, revealed_at = now() WHERE id = $1`,
        [active.id, serverSeed],
      );
      await client.query(
        `UPDATE seed_pairs SET status = 'active', client_seed = $2, activated_at = now()
         WHERE user_id = $1 AND status = 'next'`,
        [userId, clientSeed],
      );
      await this.insertNext(client, userId);

      return {
        seedPairId: active.id,
        serverSeed,
        serverSeedHash: active.server_seed_hash,
        clientSeed: active.client_seed,
        betsMade: Number(active.nonce),
      } satisfies RevealedSeed;
    });

    return { revealed, state: await this.getState(userId) };
  }

  /** Look up a seed pair for verification. The server seed is null until it has been revealed. */
  async getPair(seedPairId: string): Promise<{
    userId: string;
    status: string;
    serverSeedHash: string;
    serverSeed: string | null;
    clientSeed: string | null;
  } | null> {
    const { rows } = await this.db.query<{
      user_id: string;
      status: string;
      server_seed_hash: string;
      server_seed: string | null;
      client_seed: string | null;
    }>(
      "SELECT user_id, status, server_seed_hash, server_seed, client_seed FROM seed_pairs WHERE id = $1",
      [seedPairId],
    );
    const r = rows[0];
    return r
      ? {
          userId: r.user_id,
          status: r.status,
          serverSeedHash: r.server_seed_hash,
          serverSeed: r.server_seed,
          clientSeed: r.client_seed,
        }
      : null;
  }
}
