import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { lookupSession, type SessionUser } from "./auth/sessions.js";
import { decideRegion, type Geo, type RegionDecision } from "./compliance/regions.js";
import type { Config } from "./config.js";
import type { Db } from "./db/pool.js";
import type { EventBus } from "./events/bus.js";
import type { FairnessService } from "./fairness/service.js";
import type { GameEngine } from "./games/engine.js";
import { ApiError, errorHandler } from "./http/errors.js";
import { authRoutes } from "./routes/auth.js";
import { betRoutes } from "./routes/bets.js";
import { fairnessRoutes } from "./routes/fairness.js";
import { gameRoutes } from "./routes/games.js";
import { meRoutes } from "./routes/me.js";
import { wsRoutes } from "./routes/ws.js";

export interface AppDeps {
  db: Db;
  config: Config;
  fairness: FairnessService;
  engine: GameEngine;
  bus: EventBus;
  appKey: Buffer; // APP_ENCRYPTION_KEY
}

export const SESSION_COOKIE = "crysino_session";

declare module "fastify" {
  interface FastifyInstance {
    deps: AppDeps;
    /** preHandler: 401 unless signed in. */
    requireUser: (req: FastifyRequest) => Promise<void>;
    geoOf: (req: FastifyRequest) => Geo;
    regionOf: (req: FastifyRequest) => Promise<RegionDecision>;
  }
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

/** bigint → string in every JSON response (amounts can exceed JavaScript's safe integer range). */
const jsonReplacer = (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger: config.NODE_ENV === "test" ? false : { level: "info", redact: ["req.headers.cookie"] },
    trustProxy: config.TRUST_CF_GEO_HEADERS,
    bodyLimit: 64 * 1024,
  });

  app.decorate("deps", deps);
  app.decorateRequest("user", null);
  app.setReplySerializer((payload) => JSON.stringify(payload, jsonReplacer));
  app.setErrorHandler(errorHandler);

  await app.register(cookie);
  await app.register(cors, { origin: config.webOrigins, credentials: true });
  if (config.RATE_LIMIT) await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(websocket, { options: { maxPayload: 4096 } });

  // Cookie sessions + CSRF protection: any state-changing request must come from our own site.
  app.addHook("onRequest", async (req) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      if (!origin || !config.webOrigins.includes(origin)) {
        throw new ApiError(403, "bad_origin", "Request origin not allowed");
      }
    }
    req.user = await lookupSession(deps.db, req.cookies[SESSION_COOKIE]);
  });

  app.decorate("requireUser", async (req: FastifyRequest) => {
    if (!req.user) throw new ApiError(401, "unauthenticated", "Please sign in");
  });

  app.decorate("geoOf", (req: FastifyRequest): Geo => {
    if (config.TRUST_CF_GEO_HEADERS) {
      const country = (req.headers["cf-ipcountry"] as string | undefined)?.toUpperCase() ?? null;
      const region = (req.headers["cf-region-code"] as string | undefined)?.toUpperCase();
      return { country, subdivision: country && region ? `${country}-${region}` : null };
    }
    if (config.NODE_ENV !== "production" && config.DEV_COUNTRY) {
      return { country: config.DEV_COUNTRY.toUpperCase(), subdivision: null };
    }
    return { country: null, subdivision: null }; // unknown → blocked
  });

  app.decorate("regionOf", (req: FastifyRequest) => decideRegion(deps.db, app.geoOf(req)));

  app.get("/health", async () => {
    await deps.db.query("SELECT 1");
    return { ok: true };
  });

  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(gameRoutes);
  await app.register(betRoutes);
  await app.register(fairnessRoutes);
  await app.register(wsRoutes);

  return app;
}
