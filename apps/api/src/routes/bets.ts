import type { FastifyInstance } from "fastify";
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
      const idempotencyKey = req.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !/^[\w-]{8,128}$/.test(idempotencyKey)) {
        throw new ApiError(400, "idempotency_key_required", "Send a unique Idempotency-Key header with each bet");
      }

      // Region is checked on every bet, not just at login: people travel and VPNs switch.
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
      if (region.gamesAllowed && !region.gamesAllowed.includes(body.game)) {
        throw new ApiError(451, "game_not_in_region", "This game is not available in your region");
      }
      if (region.assetsAllowed && !region.assetsAllowed.includes(body.asset)) {
        throw new ApiError(451, "asset_not_in_region", "This currency is not available in your region");
      }

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
