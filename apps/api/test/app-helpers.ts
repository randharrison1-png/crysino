import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Db } from "../src/db/pool.js";
import { EventBus } from "../src/events/bus.js";
import { FairnessService } from "../src/fairness/service.js";
import { countOpenRounds, GameEngine } from "../src/games/engine.js";
import { chain, player, post } from "../src/ledger/ledger.js";

export const ORIGIN = "https://crysino.test";

export async function makeApp(db: Db, env: Record<string, string> = {}) {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    FAIRNESS_KEY: randomBytes(32).toString("hex"),
    APP_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    WEB_ORIGINS: ORIGIN,
    TRUST_CF_GEO_HEADERS: "true",
    RATE_LIMIT: "false",
    ...env,
  });
  const fairness = new FairnessService(db, Buffer.from(config.FAIRNESS_KEY, "hex"), countOpenRounds);
  const engine = new GameEngine(db, fairness);
  const bus = new EventBus();
  const app = await buildApp({
    db,
    config,
    fairness,
    engine,
    bus,
    appKey: Buffer.from(config.APP_ENCRYPTION_KEY, "hex"),
  });
  await app.ready();
  return { app, fairness, engine, bus, fairnessKey: Buffer.from(config.FAIRNESS_KEY, "hex") };
}

/** A tiny client that remembers the session cookie and sends the right origin/country headers. */
export class Client {
  cookie = "";
  country = "MT";
  region: string | undefined;

  constructor(private app: FastifyInstance) {}

  async req(method: "GET" | "POST", url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res: LightMyRequestResponse = await this.app.inject({
      method,
      url,
      payload: body as object | undefined,
      headers: {
        origin: ORIGIN,
        "cf-ipcountry": this.country,
        ...(this.region ? { "cf-region-code": this.region } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
    });
    const set = res.cookies.find((c) => c.name === "crysino_session");
    if (set) this.cookie = set.value ? `crysino_session=${set.value}` : "";
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }

  get = (url: string) => this.req("GET", url);
  post = (url: string, body?: unknown, headers?: Record<string, string>) => this.req("POST", url, body ?? {}, headers);

  bet(body: unknown, key = randomUUID()) {
    return this.post("/bets", body, { "idempotency-key": key });
  }
}

export const PASSWORD = "correct horse battery";

export async function signUp(app: FastifyInstance, country = "MT") {
  const c = new Client(app);
  c.country = country;
  const email = `${randomUUID()}@test.local`;
  const res = await c.post("/auth/register", { email, password: PASSWORD, dateOfBirth: "1990-05-05", acceptTerms: true });
  if (res.status !== 201) throw new Error(`signUp failed: ${JSON.stringify(res.body)}`);
  return { client: c, email, userId: res.body.user.id as string };
}

export async function fund(db: Db, userId: string, amount: bigint, asset = "BTC") {
  await post(db, {
    type: "deposit",
    legs: [
      { account: chain(asset), amount: -amount },
      { account: player(userId, asset), amount },
    ],
  });
}
