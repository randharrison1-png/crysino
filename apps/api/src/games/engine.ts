import { randomUUID } from "node:crypto";
import {
  FairRng,
  GameInputError,
  MULTIPLIER_SCALE,
  applyMultiplier,
  instantGames,
  maxMultiplier,
  statefulGames,
  type StepOutcome,
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
  | "idempotency_conflict"
  | "round_already_open"
  | "round_not_found"
  | "round_closed"
  | "stale_step";

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
  /** Actions applied so far (multi-step games). Send it back with the next action. */
  step: number;
  maxPayout: bigint | null;
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
  step: number;
  max_payout: string | null;
  created_at: Date;
}

interface StatefulRow {
  id: string;
  user_id: string;
  game: string;
  config_version: number;
  asset: string;
  stake: string;
  params: unknown;
  state: unknown;
  status: string;
  step: number;
  max_payout: string | null;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

const ROUND_SELECT = `
  SELECT r.id, r.game, r.config_version, r.asset, r.stake, r.params, r.result, r.multiplier,
         r.payout, r.status, r.seed_pair_id, s.server_seed_hash, s.client_seed, r.nonce, r.step,
         r.max_payout, r.created_at
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
    step: r.step,
    maxPayout: r.max_payout === null ? null : BigInt(r.max_payout),
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
      const { config, configVersion, limits } = await this.checkBet(client, req, "instant");
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

  // ─────────────────────── Multi-step games (Freefall, Flap Fortune, Gem Grid) ───────────────────────

  /**
   * Starts a round: takes the stake and fixes the whole outcome from the fair RNG, stored hidden.
   * The player then reveals it step by step with act().
   */
  async startRound(req: InstantBetRequest): Promise<{ round: RoundView; balance: bigint; replayed: boolean }> {
    if (!req.idempotencyKey || req.idempotencyKey.length > 128) {
      throw new BetError("invalid_params", "Missing or invalid idempotency key");
    }
    return withTransaction(this.db, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('bet:' || $1 || ':' || $2))", [
        req.userId,
        req.idempotencyKey,
      ]);
      const prior = await client.query<RoundRow>(`${ROUND_SELECT} WHERE r.user_id = $1 AND r.idempotency_key = $2`, [
        req.userId,
        req.idempotencyKey,
      ]);
      if (prior.rows[0]) {
        const round = toView(prior.rows[0]);
        if (round.game !== req.game || round.asset !== req.asset || round.stake !== req.stake) {
          throw new BetError("idempotency_conflict", "This request id was already used for a different bet");
        }
        return { round, balance: await this.balance(client, req.userId, req.asset), replayed: true };
      }

      const { config, configVersion, limits } = await this.checkBet(client, req, "stateful");
      const game = statefulGames[req.game]!;

      const open = await client.query<{ id: string }>(
        "SELECT id FROM rounds WHERE user_id = $1 AND game = $2 AND status = 'open'",
        [req.userId, req.game],
      );
      if (open.rows[0]) {
        throw new BetError("round_already_open", "Finish your current round first", { roundId: open.rows[0].id });
      }

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

      const seed = await this.fairness.consumeNonce(client, req.userId);
      const state = game.start(new FairRng(seed.serverSeed, seed.clientSeed, seed.nonce), config, params);
      const roundId = randomUUID();

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

      await client.query(
        `INSERT INTO rounds (id, user_id, game, config_version, seed_pair_id, nonce, asset, stake, params,
                             state, result, multiplier, max_payout, status, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, 'open', $13)`,
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
          JSON.stringify(state),
          JSON.stringify(game.view(state, config, params, false)),
          limits.maxPayout.toString(),
          req.idempotencyKey,
        ],
      );
      const { rows } = await client.query<RoundRow>(`${ROUND_SELECT} WHERE r.id = $1`, [roundId]);
      return { round: toView(rows[0]!), balance, replayed: false };
    });
  }

  /**
   * One player action on an open round. `expectedStep` must equal the round's current step, so a
   * double-click or a retried request can never apply the same action twice.
   */
  async act(
    userId: string,
    roundId: string,
    rawAction: unknown,
    expectedStep: number,
  ): Promise<{ round: RoundView; balance: bigint; settled: boolean }> {
    return withTransaction(this.db, async (client) => {
      const { rows } = await client.query<StatefulRow>(
        `SELECT id, user_id, game, config_version, asset, stake, params, state, status, step, max_payout
         FROM rounds WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [roundId, userId],
      );
      const row = rows[0];
      if (!row) throw new BetError("round_not_found", "Round not found");
      if (row.status !== "open") throw new BetError("round_closed", "This round is already finished");
      if (row.step !== expectedStep) {
        throw new BetError("stale_step", "The round moved on — refresh it", { step: String(row.step) });
      }
      const { game, config, params } = await this.statefulContext(client, row);

      let next: { state: unknown; outcome: StepOutcome };
      let action: unknown;
      try {
        action = game.parseAction(rawAction);
        next = game.act(row.state, action, config, params);
      } catch (err) {
        if (err instanceof GameInputError) throw new BetError("invalid_params", err.message);
        throw err;
      }

      await this.recordAction(client, row, action, false);
      return this.applyOutcome(client, row, next.state, next.outcome);
    });
  }

  /** The player's unfinished rounds — the website restores these on page load. */
  async listOpenRounds(userId: string): Promise<RoundView[]> {
    const { rows } = await this.db.query<RoundRow>(
      `${ROUND_SELECT} WHERE r.user_id = $1 AND r.status = 'open' ORDER BY r.created_at`,
      [userId],
    );
    return rows.map(toView);
  }

  /**
   * Settles rounds left idle (design spec §5: 24h). Cashes out at the current multiplier, or
   * refunds the stake if no step was cleared. Run on a schedule.
   */
  async resolveIdleRounds(idleMs: number): Promise<{ cashedOut: number; refunded: number }> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT r.id FROM rounds r JOIN games g ON g.code = r.game AND g.kind = 'stateful'
       WHERE r.status = 'open' AND r.updated_at < now() - make_interval(secs => $1)`,
      [idleMs / 1000],
    );
    let cashedOut = 0;
    let refunded = 0;
    for (const { id } of rows) {
      const outcome = await withTransaction(this.db, async (client) => {
        const r = await client.query<StatefulRow>(
          `SELECT id, user_id, game, config_version, asset, stake, params, state, status, step, max_payout
           FROM rounds WHERE id = $1 AND status = 'open' FOR UPDATE`,
          [id],
        );
        const row = r.rows[0];
        if (!row) return null; // settled meanwhile
        const { game, config, params } = await this.statefulContext(client, row);
        if (game.multiplier(row.state, config, params) > 0n) {
          await this.recordAction(client, row, { type: "cashout" }, true);
          await this.applyOutcome(client, row, row.state, "cashout");
          return "cashout";
        }
        await postWithClient(client, {
          type: "refund",
          refType: "round",
          refId: row.id,
          idempotencyKey: `round:${row.id}:refund`,
          legs: [
            { account: house(row.asset), amount: -BigInt(row.stake) },
            { account: player(row.user_id, row.asset), amount: BigInt(row.stake) },
          ],
        });
        await client.query(
          `UPDATE rounds SET status = 'refunded', payout = stake, multiplier = 0, closed_at = now(), updated_at = now(),
                  result = $2 WHERE id = $1`,
          [row.id, JSON.stringify(game.view(row.state, config, params, true))],
        );
        return "refund";
      });
      if (outcome === "cashout") cashedOut++;
      if (outcome === "refund") refunded++;
    }
    return { cashedOut, refunded };
  }

  private async statefulContext(client: DbClient, row: StatefulRow) {
    const game = statefulGames[row.game];
    if (!game) throw new BetError("game_unavailable", "This game is not available right now");
    const cfg = await client.query<{ params: unknown }>(
      "SELECT params FROM game_configs WHERE game = $1 AND version = $2",
      [row.game, row.config_version],
    );
    const config = game.parseConfig(cfg.rows[0]!.params);
    return { game, config, params: game.parseParams(row.params, config) };
  }

  private async recordAction(client: DbClient, row: StatefulRow, action: unknown, automatic: boolean) {
    row.step += 1;
    await client.query("INSERT INTO round_actions (round_id, seq, action, automatic) VALUES ($1, $2, $3, $4)", [
      row.id,
      row.step,
      JSON.stringify(action),
      automatic,
    ]);
  }

  /** Persists the new state; pays out and closes the round when it ends. */
  private async applyOutcome(
    client: DbClient,
    row: StatefulRow,
    state: unknown,
    outcome: StepOutcome,
  ): Promise<{ round: RoundView; balance: bigint; settled: boolean }> {
    const { game, config, params } = await this.statefulContext(client, row);
    const stake = BigInt(row.stake);
    const maxPayout = BigInt(row.max_payout!);
    const multiplier = game.multiplier(state, config, params);

    // Max-payout rule: once the cash-out value reaches the cap there is no upside left in
    // continuing, so the round cashes out automatically (shown in the UI before each step).
    if (outcome === "continue" && applyMultiplier(stake, multiplier) >= maxPayout) {
      await this.recordAction(client, row, { type: "cashout" }, true);
      outcome = "cashout";
    }

    let balance: bigint;
    if (outcome === "continue") {
      await client.query(
        `UPDATE rounds SET state = $2, result = $3, multiplier = $4, step = $5, updated_at = now() WHERE id = $1`,
        [row.id, JSON.stringify(state), JSON.stringify(game.view(state, config, params, false)), multiplier.toString(), row.step],
      );
      balance = await this.balance(client, row.user_id, row.asset);
    } else {
      const won = outcome === "cashout" || outcome === "complete";
      const payout = won ? min(applyMultiplier(stake, multiplier), maxPayout) : 0n;
      if (payout > 0n) {
        const win = await postWithClient(client, {
          type: "win",
          refType: "round",
          refId: row.id,
          idempotencyKey: `round:${row.id}:win`,
          legs: [
            { account: house(row.asset), amount: -payout },
            { account: player(row.user_id, row.asset), amount: payout },
          ],
        });
        balance = win.balances.get(`player:${row.user_id}:${row.asset}:main`)!;
      } else {
        balance = await this.balance(client, row.user_id, row.asset);
      }
      const view = { ...game.view(state, config, params, true), capped: won && applyMultiplier(stake, multiplier) > maxPayout };
      await client.query(
        `UPDATE rounds SET state = $2, result = $3, multiplier = $4, payout = $5, status = $6, step = $7,
                closed_at = now(), updated_at = now() WHERE id = $1`,
        [
          row.id,
          JSON.stringify(state),
          JSON.stringify(view),
          (won ? multiplier : 0n).toString(),
          payout.toString(),
          won ? "cashed_out" : "lost",
          row.step,
        ],
      );
    }
    const { rows } = await client.query<RoundRow>(`${ROUND_SELECT} WHERE r.id = $1`, [row.id]);
    return { round: toView(rows[0]!), balance, settled: outcome !== "continue" };
  }

  private async checkBet(
    client: DbClient,
    req: { userId: string; game: string; asset: string },
    kind: "instant" | "stateful",
  ) {
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
    const impl = kind === "instant" ? instantGames[req.game] : statefulGames[req.game];
    if (!row || !impl || row.kind !== kind || !row.enabled || row.maintenance || row.active_version === null) {
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

    const cfg = await this.db.query<{ params: unknown }>(
      "SELECT params FROM game_configs WHERE game = $1 AND version = $2",
      [round.game, round.configVersion],
    );
    const rng = new FairRng(pair.serverSeed, round.clientSeed, round.nonce);
    let matches: boolean;

    const instant = instantGames[round.game];
    const stateful = statefulGames[round.game];
    if (instant) {
      const config = instant.parseConfig(cfg.rows[0]!.params);
      const replay = instant.resolve(rng, config, instant.parseParams(round.params, config));
      matches = replay.multiplier === round.multiplier && canonical(replay.result) === canonical(round.result);
    } else if (stateful) {
      if (round.status === "open") return { verifiable: false };
      // Replay: same seed fixes the same hidden outcome; apply the recorded actions in order.
      const config = stateful.parseConfig(cfg.rows[0]!.params);
      const params = stateful.parseParams(round.params, config);
      let state = stateful.start(rng, config, params);
      const actions = await this.db.query<{ action: unknown; automatic: boolean }>(
        "SELECT action, automatic FROM round_actions WHERE round_id = $1 ORDER BY seq",
        [round.id],
      );
      for (const a of actions.rows) {
        if (a.automatic) continue; // automatic cash-outs don't change the state
        const r = stateful.act(state, stateful.parseAction(a.action), config, params);
        state = r.state;
        if (r.outcome !== "continue") break;
      }
      const replayView = stateful.view(state, config, params, true);
      const { capped: _capped, ...stored } = round.result as Record<string, unknown>;
      const expectedMultiplier = round.status === "lost" || round.status === "refunded" ? 0n : stateful.multiplier(state, config, params);
      matches = canonical(replayView) === canonical(stored) && expectedMultiplier === round.multiplier;
    } else {
      return { verifiable: false };
    }
    return { verifiable: true, matches, serverSeed: pair.serverSeed };
  }
}
