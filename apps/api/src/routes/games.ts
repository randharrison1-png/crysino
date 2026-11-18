import { exactRtp, instantGames, maxMultiplier } from "@crysino/shared";
import type { FastifyInstance } from "fastify";

/**
 * Public game catalogue: what's playable, the full paytable/odds (published by design — the
 * dossier's build checklist requires exact odds to be shown), and bet limits per currency.
 */
export async function gameRoutes(app: FastifyInstance) {
  const { db } = app.deps;

  app.get("/games", async (req) => {
    const region = await app.regionOf(req);
    const { rows } = await db.query<{
      code: string;
      name: string;
      kind: string;
      maintenance: boolean;
      active_version: number;
      params: unknown;
      rtp: string;
    }>(
      `SELECT g.code, g.name, g.kind, g.maintenance, g.active_version, c.params, c.rtp
       FROM games g JOIN game_configs c ON c.game = g.code AND c.version = g.active_version
       WHERE g.enabled ORDER BY g.code`,
    );
    const limits = await db.query<{ game: string; asset: string; min_bet: string; max_bet: string; max_payout: string }>(
      `SELECT l.game, l.asset, l.min_bet, l.max_bet, l.max_payout
       FROM game_limits l JOIN assets a ON a.code = l.asset AND a.enabled`,
    );

    return {
      games: rows.map((g) => {
        const impl = instantGames[g.code];
        const config = impl?.parseConfig(g.params);
        // Instant games with fixed odds (Doomsday) publish their full table; parameterised games
        // (Dice) publish their config and the client computes odds for the chosen bet.
        let odds = null;
        let maxMultiplierX = null;
        if (impl && g.code === "doomsday") {
          const table = impl.odds(config, {});
          odds = table.map((o) => ({
            label: o.label,
            probability: Number(o.weight) / Number(o.outOf),
            multiplier: Number(o.multiplier) / 10_000,
          }));
          maxMultiplierX = Number(maxMultiplier(table)) / 10_000;
        }
        const allowedHere = region.gamesAllowed === null || region.gamesAllowed.includes(g.code);
        return {
          code: g.code,
          name: g.name,
          kind: g.kind,
          status: !impl ? "coming_soon" : g.maintenance ? "maintenance" : allowedHere ? "available" : "not_in_region",
          configVersion: g.active_version,
          rtp: Number(g.rtp),
          maxMultiplier: maxMultiplierX,
          config: g.params,
          odds,
          limits: limits.rows
            .filter((l) => l.game === g.code)
            .filter((l) => region.assetsAllowed === null || region.assetsAllowed.includes(l.asset))
            .map((l) => ({ asset: l.asset, minBet: l.min_bet, maxBet: l.max_bet, maxPayout: l.max_payout })),
        };
      }),
    };
  });

  app.get("/assets", async () => {
    const { rows } = await db.query(
      `SELECT code, symbol, network, decimals FROM assets WHERE enabled ORDER BY code`,
    );
    return { assets: rows };
  });

  // Startup sanity check: a fixed paytable must match the RTP stored beside it.
  const dd = instantGames.doomsday!;
  const { rows: cfgs } = await db.query<{ version: number; params: unknown; rtp: string }>(
    "SELECT version, params, rtp FROM game_configs WHERE game = 'doomsday'",
  );
  for (const r of cfgs) {
    const actual = exactRtp(dd.odds(dd.parseConfig(r.params), {}));
    if (Math.abs(actual - Number(r.rtp)) > 1e-6) {
      throw new Error(`doomsday v${r.version}: stored RTP ${r.rtp} but paytable gives ${actual}`);
    }
  }
}
