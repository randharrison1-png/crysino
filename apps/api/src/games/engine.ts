import { randomUUID } from "node:crypto";
import {
  FairRng,
  GameInputError,
  MULTIPLIER_SCALE,
  applyMultiplier,
  instantGames,
  maxMultiplier,
} from "@crysino/shared";
import { withTransaction, type Db, type DbClient } from "../db/pool.js";
import type { FairnessService, OpenRoundCounter } from "../fairness/service.js";
import { InsufficientFundsError, house, player, postWithClient } from "../ledger/ledger.js";

/**
 * Game engine (design spec §3, "Life of a bet").
 * A bet is ONE database transaction: checks → nonce → outcome → stake debit → win credit → round.
 * If anything fails, nothing happened: no money moved, no nonce used, no round recorded.
 */

export type BetErrorCode =
  | "betting_paused"
  | "account_inactive"
  | "game_unavailable"
  | "asset_not_allowed"
  | "stake_too_low"
  | "stake_too_high"
  | "payout_cap"
  | "invalid_params"
  | "insufficient_funds"
  | "idempotency_conflict";

export class BetError extends Error {
  constructor(
    readonly code: BetErrorCode,
    message: string,
    readonly details: Record<string, string> = {},
  ) {
    super(message);
  }
}

export interface InstantBetRequest {
  userId: string;
  game: string;
  asset: string;
  stake: bigint;
  params?: unknown;
  /** Client-generated per bet click. A retried request returns the original round. */
  idempotencyKey: string;
}

/** What the player (and the website) sees. Never includes hidden server state. */
export interface RoundView {
  id: string;
  game: string;
  configVersion: number;
  asset: string;
  stake: bigint;
  params: unknown;
  result: unknown;
  multiplier: bigint | null;
  payout: bigint;
  status: string;
  seedPairId: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  createdAt: Date;
}

interface RoundRow {
  id: string;
  game: string;
  config_version: number;
  asset: string;
  stake: string;
  params: unknown;
  result: unknown;
  multiplier: string | null;
  payout: string;
  status: string;
  seed_pair_id: string;
  server_seed_hash: string;
  client_seed: string;
  nonce: string;
  created_at: Date;
}

const ROUND_SELECT = `
  SELECT r.id, r.game, r.config_version, r.asset, r.stake, r.params, r.result, r.multiplier,
         r.payout, r.status, r.seed_pair_id, s.server_seed_hash, s.client_seed, r.nonce, r.created_at
  FROM rounds r JOIN seed_pairs s ON s.id = r.seed_pair_id`;

function toView(r: RoundRow): RoundView {
  return {
    id: r.id,
    game: r.game,
    configVersion: r.config_version,
    asset: r.asset,
    stake: BigInt(r.stake),
    params: r.params,
    result: r.result,
    multiplier: r.multiplier === null ? null : BigInt(r.multiplier),
    payout: BigInt(r.payout),
    status: r.status,
    seedPairId: r.seed_pair_id,
    serverSeedHash: r.server_seed_hash,
    clientSeed: r.client_seed,
    nonce: Number(r.nonce),
    createdAt: r.created_at,
  };
}

/** JSON with sorted keys — Postgres JSONB does not preserve key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/** Wire this into FairnessService so seeds can't be rotated mid-round. */
export const countOpenRounds: OpenRoundCounter = async (client, userId) => {
  const { rows } = await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM rounds WHERE user_id = $1 AND status = 'open'",
    [userId],
  );
  return rows[0]!.n;
};

export class GameEngine {
  constructor(
    private readonly db: Db,
    private readonly fairness: FairnessService,
  ) {}

  async placeInstantBet(
    req: InstantBetRequest,
  ): Promise<{ round: RoundView; balance: bigint; replayed: boolean }> {
    if (!req.idempotencyKey || req.idempotencyKey.length > 128) {
      throw new BetError("invalid_params", "Missing or invalid idempotency key");
    }
    return withTransaction(this.db, async (client) => {
      // 1. Same request seen before? Return it instead of betting again.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('bet:' || $1 || ':' || $2))", [
        req.userId,
        req.idempotencyKey,
      ]);
      const prior = await client.query<RoundRow>(
        `${ROUND_SELECT} WHERE r.user_id = $1 AND r.idempotency_key = $2`,
        [req.userId, req.idempotencyKey],
      );
      if (prior.rows[0]) {
        const round = toView(prior.rows[0]);
        if (round.game !== req.game || round.asset !== req.asset || round.stake !== req.stake) {
          throw new BetError("idempotency_conflict", "This request id was already used for a different bet");
        }
        return { round, balance: await this.balance(client, req.userId, req.asset), replayed: true };
      }

      // 2. Platform, account, game and asset checks.
      const { config, configVersion, limits } = await this.checkBet(client, req);
      const game = instantGames[req.game]!;

      // 3. Player's choices and stake.
      let params: unknown;
      try {
        params = game.parseParams(req.params, config);
      } catch (err) {
        if (err instanceof GameInputError) throw new BetError("invalid_params", err.message);
        throw err;
      }
      if (req.stake < limits.minBet) {
        throw new BetError("stake_too_low", "Stake is below the minimum", { min: limits.minBet.toString() });
      }
      if (req.stake > limits.maxBet) {
        throw new BetError("stake_too_high", "Stake is above the maximum", { max: limits.maxBet.toString() });
      }
      const topMultiplier = maxMultiplier(game.odds(config, params));
      if (applyMultiplier(req.stake, topMultiplier) > limits.maxPayout) {
        const maxStake = topMultiplier > 0n ? (limits.maxPayout * MULTIPLIER_SCALE) / topMultiplier : 0n;
        throw new BetError("payout_cap", "Potential win is above the maximum payout for this game", {
          maxStake: maxStake.toString(),
        });
      }

      // 4. Fair outcome.
      const seed = await this.fairness.consumeNonce(client, req.userId);
      const rng = new FairRng(seed.serverSeed, seed.clientSeed, seed.nonce);
      const { multiplier, result } = game.resolve(rng, config, params);
      const payout = applyMultiplier(req.stake, multiplier);
      const roundId = randomUUID();

      // 5. Money: stake to the bankroll, then any win back to the player.
      let balance: bigint;
      try {
        const bet = await postWithClient(client, {
          type: "bet",
          refType: "round",
          refId: roundId,
          idempotencyKey: `round:${roundId}:bet`,
          legs: [
            { account: player(req.userId, req.asset), amount: -req.stake },
            { account: house(req.asset), amount: req.stake },
          ],
        });
        balance = bet.balances.get(`player:${req.userId}:${req.asset}:main`)!;
      } catch (err) {
        if (err instanceof InsufficientFundsError) throw new BetError("insufficient_funds", "Not enough balance");
        throw err;
      }
      if (payout > 0n) {
        const win = await postWithClient(client, {
          type: "win",
          refType: "round",
          refId: roundId,
          idempotencyKey: `round:${roundId}:win`,
          legs: [
            { account: house(req.asset), amount: -payout },
            { account: player(req.userId, req.asset), amount: payout },
          ],
        });
        balance = win.balances.get(`player:${req.userId}:${req.asset}:main`)!;
      }

      // 6. Record the settled round.
      await client.query(
        `INSERT INTO rounds (id, user_id, game, config_version, seed_pair_id, nonce, asset, stake,
                             params, result, multiplier, payout, status, idempotency_key, closed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())`,
        [
          roundId,
          req.userId,
          req.game,
          configVersion,
          seed.seedPairId,
          seed.nonce,
          req.asset,
          req.stake.toString(),
          JSON.stringify(params),
          JSON.stringify(result),
          multiplier.toString(),
          payout.toString(),
          payout > 0n ? "won" : "lost",
          req.idempotencyKey,
        ],
      );

      const { rows } = await client.query<RoundRow>(`${ROUND_SELECT} WHERE r.id = $1`, [roundId]);
      return { round: toView(rows[0]!), balance, replayed: false };
    });
  }

  private async checkBet(client: DbClient, req: InstantBetRequest) {
    const paused = await client.query<{ value: boolean }>(
      "SELECT value FROM settings WHERE key = 'betting_paused'",
    );
    if (paused.rows[0]?.value === true) throw new BetError("betting_paused", "Betting is paused");

    const user = await client.query<{ status: string }>("SELECT status FROM users WHERE id = $1", [req.userId]);
    if (user.rows[0]?.status !== "active") throw new BetError("account_inactive", "Account cannot place bets");

    const g = await client.query<{ enabled: boolean; maintenance: boolean; kind: string; active_version: number | null; params: unknown }>(
      `SELECT g.enabled, g.maintenance, g.kind, g.active_version, c.params
       FROM games g LEFT JOIN game_configs c ON c.game = g.code AND c.version = g.active_version
       WHERE g.code = $1`,
      [req.game],
    );
    const row = g.rows[0];
    const impl = instantGames[req.game];
    if (!row || !impl || row.kind !== "instant" || !row.enabled || row.maintenance || row.active_version === null) {
      throw new BetError("game_unavailable", "This game is not available right now");
    }

    const lim = await client.query<{ min_bet: string; max_bet: string; max_payout: string }>(
      `SELECT l.min_bet, l.max_bet, l.max_payout FROM game_limits l
       JOIN assets a ON a.code = l.asset AND a.enabled
       WHERE l.game = $1 AND l.asset = $2`,
      [req.game, req.asset],
    );
    const l = lim.rows[0];
    if (!l) throw new BetError("asset_not_allowed", "This currency can't be used on this game");

    return {
      config: impl.parseConfig(row.params),
      configVersion: row.active_version,
      limits: { minBet: BigInt(l.min_bet), maxBet: BigInt(l.max_bet), maxPayout: BigInt(l.max_payout) },
    };
  }

  private async balance(client: DbClient, userId: string, asset: string): Promise<bigint> {
    const { rows } = await client.query<{ balance: string }>(
      `SELECT balance FROM ledger_accounts
       WHERE owner_type = 'player' AND owner_id = $1 AND asset = $2 AND kind = 'main'`,
      [userId, asset],
    );
    return rows[0] ? BigInt(rows[0].balance) : 0n;
  }

  async getRound(userId: string, roundId: string): Promise<RoundView | null> {
    const { rows } = await this.db.query<RoundRow>(`${ROUND_SELECT} WHERE r.id = $1 AND r.user_id = $2`, [
      roundId,
      userId,
    ]);
    return rows[0] ? toView(rows[0]) : null;
  }

  /**
   * Re-computes a settled round from its revealed seed with the same shared code the website uses.
   * Before the seed is revealed the round can't be verified yet (that's the point of the commitment).
   */
  async verifyRound(
    userId: string,
    roundId: string,
  ): Promise<{ verifiable: false } | { verifiable: true; matches: boolean; serverSeed: string }> {
    const round = await this.getRound(userId, roundId);
    if (!round) throw new BetError("invalid_params", "Round not found");
    const pair = await this.fairness.getPair(round.seedPairId);
    if (!pair?.serverSeed) return { verifiable: false };

    const impl = instantGames[round.game];
    if (!impl) return { verifiable: false };
    const cfg = await this.db.query<{ params: unknown }>(
      "SELECT params FROM game_configs WHERE game = $1 AND version = $2",
      [round.game, round.configVersion],
    );
    const config = impl.parseConfig(cfg.rows[0]!.params);
    const replay = impl.resolve(
      new FairRng(pair.serverSeed, round.clientSeed, round.nonce),
      config,
      impl.parseParams(round.params, config),
    );
    const matches =
      replay.multiplier === round.multiplier && canonical(replay.result) === canonical(round.result);
    return { verifiable: true, matches, serverSeed: pair.serverSeed };
  }
}
