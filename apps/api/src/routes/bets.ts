import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { regionPermitsPlay } from "../compliance/regions.js";
import { ApiError } from "../http/errors.js";

const betBody = z.object({
  game: z.string().min(1).max(32),
  asset: z.string().min(1).max(32),
  /** Amount in the asset's smallest unit, as a string (e.g. satoshis). */
  stake: z.string().regex(/^[1-9]\d{0,77}$/, "Stake must be a positive whole number of base units"),
  params: z.unknown().optional(),
});

const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(),
  game: z.string().max(32).optional(),
});

const uuid = z.string().uuid();

const actionBody = z.object({
  action: z.unknown(),
  /** The round's current step, from the last response. Stops double-clicks applying twice. */
  step: z.number().int().min(0),
});

/** Region is checked on every bet, not just at login: people travel and VPNs switch. */
async function assertCanPlay(app: FastifyInstance, req: FastifyRequest, game: string, asset: string) {
  const region = await app.regionOf(req);
  if (!regionPermitsPlay(region, req.user!.kycTier)) {
    throw new ApiError(
      451,
      region.policy === "kyc_required" ? "kyc_required" : "region_blocked",
      region.policy === "kyc_required"
        ? "Verify your identity to play from your region"
        : "Betting is not available in your region",
    );
  }
  if (region.gamesAllowed && !region.gamesAllowed.includes(game)) {
    throw new ApiError(451, "game_not_in_region", "This game is not available in your region");
  }
  if (region.assetsAllowed && !region.assetsAllowed.includes(asset)) {
    throw new ApiError(451, "asset_not_in_region", "This currency is not available in your region");
  }
}

function idempotencyKeyOf(req: FastifyRequest): string {
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || !/^[\w-]{8,128}$/.test(key)) {
    throw new ApiError(400, "idempotency_key_required", "Send a unique Idempotency-Key header with each bet");
  }
  return key;
}

export async function betRoutes(app: FastifyInstance) {
  const { db, engine, bus } = app.deps;
  const auth = { preHandler: app.requireUser };

  app.post(
    "/bets",
    {
      preHandler: app.requireUser,
      config: {
        rateLimit: { max: 30, timeWindow: "10 seconds", keyGenerator: (req) => req.user?.userId ?? req.ip },
      },
    },
    async (req) => {
      const body = betBody.parse(req.body);
      const idempotencyKey = idempotencyKeyOf(req);

      await assertCanPlay(app, req, body.game, body.asset);
      const result = await engine.placeInstantBet({
        userId: req.user!.userId,
        game: body.game,
        asset: body.asset,
        stake: BigInt(body.stake),
        params: body.params,
        idempotencyKey,
      });
      if (!result.replayed) {
        bus.emit("round_settled", { userId: req.user!.userId, round: result.round, balance: result.balance });
      }
      return { round: result.round, balance: result.balance, replayed: result.replayed };
    },
  );

  // ── Multi-step games ──
  const playLimit = {
    preHandler: app.requireUser,
    config: { rateLimit: { max: 60, timeWindow: "10 seconds", keyGenerator: (req: FastifyRequest) => req.user?.userId ?? req.ip } },
  };

  /** Start a Freefall / Flap Fortune / Gem Grid round. */
  app.post("/rounds", playLimit, async (req) => {
    const body = betBody.parse(req.body);
    const idempotencyKey = idempotencyKeyOf(req);
    await assertCanPlay(app, req, body.game, body.asset);
    const result = await engine.startRound({
      userId: req.user!.userId,
      game: body.game,
      asset: body.asset,
      stake: BigInt(body.stake),
      params: body.params,
      idempotencyKey,
    });
    if (!result.replayed) bus.emit("round_updated", { userId: req.user!.userId, round: result.round, balance: result.balance });
    return result;
  });

  /** Advance / reveal / cash out. Allowed from anywhere once started, so a player can always cash out. */
  app.post<{ Params: { id: string } }>("/rounds/:id/actions", playLimit, async (req) => {
    const id = uuid.parse(req.params.id);
    const body = actionBody.parse(req.body);
    const result = await engine.act(req.user!.userId, id, body.action, body.step);
    bus.emit(result.settled ? "round_settled" : "round_updated", {
      userId: req.user!.userId,
      round: result.round,
      balance: result.balance,
    });
    return result;
  });

  app.get("/rounds/active", auth, async (req) => ({ rounds: await engine.listOpenRounds(req.user!.userId) }));

  app.get("/rounds", auth, async (req) => {
    const q = historyQuery.parse(req.query);
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM rounds
       WHERE user_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2) AND ($3::text IS NULL OR game = $3)
       ORDER BY created_at DESC LIMIT $4`,
      [req.user!.userId, q.before ?? null, q.game ?? null, q.limit],
    );
    const rounds = await Promise.all(rows.map((r) => engine.getRound(req.user!.userId, r.id)));
    return { rounds };
  });

  app.get<{ Params: { id: string } }>("/rounds/:id", auth, async (req) => {
    const round = await engine.getRound(req.user!.userId, uuid.parse(req.params.id));
    if (!round) throw new ApiError(404, "not_found", "Round not found");
    return { round };
  });

  app.get<{ Params: { id: string } }>("/rounds/:id/verify", auth, async (req) => {
    const id = uuid.parse(req.params.id);
    if (!(await engine.getRound(req.user!.userId, id))) throw new ApiError(404, "not_found", "Round not found");
    return engine.verifyRound(req.user!.userId, id);
  });
}
