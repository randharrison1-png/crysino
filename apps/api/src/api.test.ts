import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, ORIGIN, PASSWORD, fund, makeApp, signUp } from "../test/app-helpers.js";
import { testDb } from "../test/helpers.js";
import { currentStep, totpAt } from "./auth/totp.js";
import type { Db } from "./db/pool.js";
import { decryptSeed } from "./fairness/seed-crypto.js";

let db: Db;
let app: FastifyInstance;
let fairnessKey: Buffer;

beforeAll(async () => {
  db = testDb();
  ({ app, fairnessKey } = await makeApp(db));
  // Regions for these tests: Malta allowed; Brazil needs KYC; Canada allowed except Ontario (seeded);
  // Japan allowed but only Dice, and 21+. US is blocked by the seed; Germany falls to the default (block).
  await db.query(`
    INSERT INTO region_rules (country_code, subdivision, policy, min_age, games_allowed) VALUES
      ('MT', NULL, 'allow', 18, NULL),
      ('BR', NULL, 'kyc_required', 18, NULL),
      ('CA', NULL, 'allow', 19, NULL),
      ('JP', NULL, 'allow', 21, '{dice}')
    ON CONFLICT DO NOTHING`);
  await db.query("UPDATE assets SET enabled = true WHERE code = 'BTC'");
  await db.query("UPDATE games SET enabled = true WHERE code IN ('dice', 'doomsday', 'gem_grid', 'last_door')");
  await db.query(
    `INSERT INTO game_limits (game, asset, min_bet, max_bet, max_payout) VALUES
       ('dice', 'BTC', 100, 1000000, 50000000), ('doomsday', 'BTC', 100, 1000000, 50000000),
       ('gem_grid', 'BTC', 100, 1000000, 50000000), ('last_door', 'BTC', 100, 1000000, 50000000)
     ON CONFLICT DO NOTHING`,
  );
});
afterAll(async () => {
  await app.close();
  await db.end();
});

const diceBody = (stake = "1000") => ({ game: "dice", asset: "BTC", stake, params: { direction: "under", target: 50 } });

describe("health and request hygiene", () => {
  it("is up", async () => {
    expect((await new Client(app).get("/health")).body).toEqual({ ok: true });
  });

  it("refuses state-changing requests from other sites or with no origin", async () => {
    const body = { email: "a@b.co", password: PASSWORD, dateOfBirth: "1990-01-01", acceptTerms: true };
    const evil = await app.inject({ method: "POST", url: "/auth/register", payload: body, headers: { origin: "https://evil.example", "cf-ipcountry": "MT" } });
    const none = await app.inject({ method: "POST", url: "/auth/register", payload: body, headers: { "cf-ipcountry": "MT" } });
    expect([evil.statusCode, none.statusCode]).toEqual([403, 403]);
  });

  it("explains invalid input field by field", async () => {
    const res = await new Client(app).post("/auth/register", { email: "nope", password: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
    expect(res.body.error.details.fields.map((f: { path: string }) => f.path)).toEqual(
      expect.arrayContaining(["email", "password", "dateOfBirth", "acceptTerms"]),
    );
  });
});

describe("registration and region gate", () => {
  const reg = (country: string, dateOfBirth = "1990-05-05", region?: string) => {
    const c = new Client(app);
    c.country = country;
    c.region = region;
    return c.post("/auth/register", { email: `${randomUUID()}@test.local`, password: PASSWORD, dateOfBirth, acceptTerms: true });
  };

  it("blocks seeded, default-blocked, sanctioned and unknown countries", async () => {
    for (const country of ["US", "DE", "KP", "XX", "T1"]) {
      const res = await reg(country);
      expect(res.status, country).toBe(451);
      expect(res.body.error.code).toBe("region_blocked");
    }
  });

  it("a province rule overrides its country", async () => {
    expect((await reg("CA", "1990-05-05", "QC")).status).toBe(201);
    expect((await reg("CA", "1990-05-05", "ON")).status).toBe(451);
  });

  it("enforces the region's minimum age", async () => {
    const twenty = new Date();
    twenty.setUTCFullYear(twenty.getUTCFullYear() - 20);
    const dob = twenty.toISOString().slice(0, 10);
    expect((await reg("MT", dob)).status).toBe(201); // 18+ region
    const jp = await reg("JP", dob); // 21+ region
    expect(jp.status).toBe(403);
    expect(jp.body.error.code).toBe("underage");
  });

  it("creates the account, signs in, and rejects a duplicate email", async () => {
    const { client, email } = await signUp(app);
    expect((await client.get("/me")).body.user).toMatchObject({ email, kycTier: 0, totpEnabled: false });
    const dup = await new Client(app).post("/auth/register", { email, password: PASSWORD, dateOfBirth: "1990-05-05", acceptTerms: true });
    expect(dup.status).toBe(409);
  });

  it("stores the password hashed, never in plain text", async () => {
    const { userId } = await signUp(app);
    const { rows } = await db.query("SELECT password_hash FROM users WHERE id = $1", [userId]);
    expect(rows[0].password_hash).toMatch(/^scrypt\$/);
    expect(rows[0].password_hash).not.toContain(PASSWORD);
  });

  it("respects the sign-up kill switch", async () => {
    await db.query("UPDATE settings SET value = 'true' WHERE key = 'signups_paused'");
    try {
      expect((await reg("MT")).status).toBe(503);
    } finally {
      await db.query("UPDATE settings SET value = 'false' WHERE key = 'signups_paused'");
    }
  });
});

describe("login, logout and sessions", () => {
  it("logs in and out; a logged-out cookie stops working", async () => {
    const { email } = await signUp(app);
    const c = new Client(app);
    expect((await c.post("/auth/login", { email, password: PASSWORD })).status).toBe(200);
    const stolen = c.cookie;
    expect((await c.get("/me")).status).toBe(200);
    await c.post("/auth/logout");
    const replay = new Client(app);
    replay.cookie = stolen;
    expect((await replay.get("/me")).status).toBe(401);
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    const { email } = await signUp(app);
    const wrong = await new Client(app).post("/auth/login", { email, password: "wrong password!" });
    const unknown = await new Client(app).post("/auth/login", { email: "ghost@test.local", password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it("refuses login from a blocked region", async () => {
    const { email } = await signUp(app);
    const c = new Client(app);
    c.country = "US";
    expect((await c.post("/auth/login", { email, password: PASSWORD })).status).toBe(451);
  });

  it("self-excluded and closed accounts can't sign in", async () => {
    const a = await signUp(app);
    const b = await signUp(app);
    await db.query("UPDATE users SET status = 'self_excluded' WHERE id = $1", [a.userId]);
    await db.query("UPDATE users SET status = 'closed' WHERE id = $1", [b.userId]);
    expect((await new Client(app).post("/auth/login", { email: a.email, password: PASSWORD })).body.error.code).toBe("self_excluded");
    expect((await new Client(app).post("/auth/login", { email: b.email, password: PASSWORD })).status).toBe(401);
    expect((await a.client.get("/me")).status).toBe(200); // existing session still sees account (to withdraw)
    expect((await b.client.get("/me")).status).toBe(401); // closed: sessions die immediately
  });
});

describe("two-factor authentication", () => {
  it("setup → enable → login needs a fresh code → codes can't be reused", async () => {
    const { client, email } = await signUp(app);
    const setup = await client.post("/me/2fa/setup");
    expect(setup.body.otpauthUri).toContain("otpauth://totp/");
    const secret: string = setup.body.secret;

    const otherDevice = new Client(app);
    await otherDevice.post("/auth/login", { email, password: PASSWORD });

    expect((await client.post("/me/2fa/enable", { code: "000000" })).status).toBe(401);
    const step = currentStep(); // fixed once so the test can't straddle a 30-second boundary
    expect((await client.post("/me/2fa/enable", { code: totpAt(secret, step) })).status).toBe(200);

    // Turning 2FA on signs out every other device.
    expect((await otherDevice.get("/me")).status).toBe(401);

    const c = new Client(app);
    expect((await c.post("/auth/login", { email, password: PASSWORD })).body.error.code).toBe("totp_required");
    // The enabling code was already used; the next step's code works once.
    expect((await c.post("/auth/login", { email, password: PASSWORD, totp: totpAt(secret, step) })).status).toBe(401);
    const fresh = totpAt(secret, step + 1);
    expect((await c.post("/auth/login", { email, password: PASSWORD, totp: fresh })).status).toBe(200);
    expect((await new Client(app).post("/auth/login", { email, password: PASSWORD, totp: fresh })).body.error.code).toBe("invalid_totp");
  });

  it("stores the 2FA secret encrypted", async () => {
    const { client, userId } = await signUp(app);
    const { body } = await client.post("/me/2fa/setup");
    const { rows } = await db.query("SELECT totp_secret_enc FROM users WHERE id = $1", [userId]);
    expect(rows[0].totp_secret_enc.toString("latin1")).not.toContain(body.secret);
  });
});

describe("games catalogue", () => {
  it("lists playable games with odds and limits, publicly", async () => {
    const { body } = await new Client(app).get("/games");
    const doom = body.games.find((g: { code: string }) => g.code === "doomsday");
    expect(doom).toMatchObject({ status: "available", rtp: 0.96, maxMultiplier: 80 });
    expect(doom.odds.map((o: { probability: number }) => o.probability)).toEqual([0.65, 0.3, 0.042, 0.007, 0.001]);
    expect(doom.limits).toEqual([{ asset: "BTC", minBet: "100", maxBet: "1000000", maxPayout: "50000000" }]);
    expect(body.games.map((g: { code: string }) => g.code)).not.toContain("freefall"); // disabled games hidden
  });

  it("marks games not offered in the visitor's region", async () => {
    const c = new Client(app);
    c.country = "JP";
    const { body } = await c.get("/games");
    const status = Object.fromEntries(body.games.map((g: { code: string; status: string }) => [g.code, g.status]));
    expect(status).toMatchObject({ dice: "available", doomsday: "not_in_region" });
  });
});

describe("betting over HTTP", () => {
  it("places a bet, returns amounts as strings, updates balances", async () => {
    const { client, userId } = await signUp(app);
    await fund(db, userId, 10_000n);
    const res = await client.bet(diceBody());
    expect(res.status).toBe(200);
    expect(typeof res.body.round.stake).toBe("string");
    expect(res.body.round.stake).toBe("1000");
    const bal = await client.get("/balances");
    expect(bal.body.balances).toEqual([{ asset: "BTC", available: res.body.balance, pendingWithdrawal: "0" }]);
  });

  it("requires sign-in and an idempotency key", async () => {
    expect((await new Client(app).bet(diceBody())).status).toBe(401);
    const { client } = await signUp(app);
    const res = await client.post("/bets", diceBody());
    expect(res.body.error.code).toBe("idempotency_key_required");
  });

  it("a retried request is not a second bet", async () => {
    const { client, userId } = await signUp(app);
    await fund(db, userId, 10_000n);
    const key = randomUUID();
    const a = await client.bet(diceBody(), key);
    const b = await client.bet(diceBody(), key);
    expect(b.body.replayed).toBe(true);
    expect(b.body.round.id).toBe(a.body.round.id);
    expect(b.body.balance).toBe(a.body.balance);
  });

  it("checks region on every bet, not just at login", async () => {
    const { client, userId } = await signUp(app);
    await fund(db, userId, 10_000n);
    client.country = "US"; // travelled / switched VPN
    const res = await client.bet(diceBody());
    expect([res.status, res.body.error.code]).toEqual([451, "region_blocked"]);
  });

  it("KYC-required regions need a verified player", async () => {
    const { client, userId } = await signUp(app, "MT");
    await fund(db, userId, 10_000n);
    client.country = "BR";
    expect((await client.bet(diceBody())).body.error.code).toBe("kyc_required");
    await db.query("UPDATE users SET kyc_tier = 2 WHERE id = $1", [userId]);
    expect((await client.bet(diceBody())).status).toBe(200);
  });

  it("per-region game restrictions", async () => {
    const { client, userId } = await signUp(app, "MT");
    await fund(db, userId, 10_000n);
    client.country = "JP";
    expect((await client.bet({ game: "doomsday", asset: "BTC", stake: "1000" })).body.error.code).toBe("game_not_in_region");
    expect((await client.bet(diceBody())).status).toBe(200);
  });

  it("maps engine errors to clear responses", async () => {
    const { client, userId } = await signUp(app);
    await fund(db, userId, 500n);
    const poor = await client.bet(diceBody("1000"));
    expect([poor.status, poor.body.error.code]).toEqual([422, "insufficient_funds"]);
    const cap = await client.bet({ game: "dice", asset: "BTC", stake: "1000000", params: { direction: "under", target: 1 } });
    expect(cap.body.error).toMatchObject({ code: "payout_cap", details: { maxStake: "520833" } });
    expect((await client.bet({ ...diceBody(), stake: "1.5" })).status).toBe(400);
    expect((await client.bet({ ...diceBody(), stake: "-5" })).status).toBe(400);
  });
});

describe("history, verification and fairness", () => {
  it("lists rounds newest first, verifies after reveal, and hides other players' rounds", async () => {
    const { client, userId } = await signUp(app);
    await fund(db, userId, 100_000n);
    for (let i = 0; i < 3; i++) await client.bet(diceBody());
    const list = await client.get("/rounds?limit=2");
    expect(list.body.rounds).toHaveLength(2);
    expect(list.body.rounds[0].nonce).toBe(2);
    const id = list.body.rounds[0].id;

    expect((await client.get(`/rounds/${id}/verify`)).body).toEqual({ verifiable: false });

    const before = (await client.get("/fairness")).body.fairness;
    const rotated = await client.post("/fairness/rotate", { clientSeed: "my lucky seed" });
    expect(rotated.body.fairness).toMatchObject({ clientSeed: "my lucky seed", nonce: 0, serverSeedHash: before.nextServerSeedHash });
    expect(rotated.body.revealed.betsMade).toBe(3);

    expect((await client.get(`/rounds/${id}/verify`)).body).toMatchObject({ verifiable: true, matches: true });

    const stranger = (await signUp(app)).client;
    expect((await stranger.get(`/rounds/${id}`)).status).toBe(404);
    expect((await stranger.get(`/rounds/${id}/verify`)).status).toBe(404);
    expect((await stranger.get("/rounds/not-a-uuid")).status).toBe(400);
  });

  it("rejects bad client seeds", async () => {
    const { client } = await signUp(app);
    expect((await client.post("/fairness/rotate", { clientSeed: "a:b" })).status).toBe(409);
  });

  it("never exposes an unrevealed server seed anywhere", async () => {
    const { client, userId } = await signUp(app);
    await fund(db, userId, 10_000n);
    const bet = await client.bet(diceBody());
    const state = await client.get("/fairness");
    const history = await client.get("/rounds");
    const { rows } = await db.query("SELECT server_seed_enc FROM seed_pairs WHERE user_id = $1 AND status = 'active'", [userId]);
    const secret = decryptSeed(rows[0].server_seed_enc, fairnessKey);
    for (const payload of [bet.body, state.body, history.body]) {
      expect(JSON.stringify(payload)).not.toContain(secret);
      expect(JSON.stringify(payload)).not.toMatch(/"serverSeed"/);
    }
  });
});

describe("multi-step rounds over HTTP", () => {
  it("start → restore after reload → reveal → stale step refused → cash out", async () => {
    const { client, userId } = await signUp(app);
    await fund(db, userId, 100_000n);
    const started = await client.post("/rounds", { game: "gem_grid", asset: "BTC", stake: "1000", params: { mines: 3 } }, { "idempotency-key": randomUUID() });
    expect(started.status).toBe(200);
    expect(started.body.round).toMatchObject({ status: "open", step: 0, stake: "1000" });
    expect(started.body.round.result.minePositions).toBeNull();

    const active = await client.get("/rounds/active");
    expect(active.body.rounds.map((r: { id: string }) => r.id)).toEqual([started.body.round.id]);

    const id = started.body.round.id;
    const { rows } = await db.query("SELECT state FROM rounds WHERE id = $1", [id]);
    const tile = [...Array(25).keys()].find((t) => !rows[0].state.mines.includes(t));

    const step1 = await client.post(`/rounds/${id}/actions`, { action: { type: "reveal", tile }, step: 0 });
    expect(step1.body.round.step).toBe(1);
    const stale = await client.post(`/rounds/${id}/actions`, { action: { type: "cashout" }, step: 0 });
    expect([stale.status, stale.body.error.code]).toEqual([409, "stale_step"]);
    const cash = await client.post(`/rounds/${id}/actions`, { action: { type: "cashout" }, step: 1 });
    expect(cash.body).toMatchObject({ settled: true, round: { status: "cashed_out", payout: "1090" } });
    expect((await client.get("/rounds/active")).body.rounds).toEqual([]);
  });

  it("instant games can't be started as rounds, and vice versa", async () => {
    const { client, userId } = await signUp(app);
    await fund(db, userId, 100_000n);
    const a = await client.post("/rounds", { game: "dice", asset: "BTC", stake: "1000" }, { "idempotency-key": randomUUID() });
    const b = await client.bet({ game: "gem_grid", asset: "BTC", stake: "1000" });
    expect([a.body.error.code, b.body.error.code]).toEqual(["game_unavailable", "game_unavailable"]);
  });

  it("starting a round is region-checked", async () => {
    const { client, userId } = await signUp(app);
    await fund(db, userId, 100_000n);
    client.country = "US";
    const res = await client.post("/rounds", { game: "gem_grid", asset: "BTC", stake: "1000" }, { "idempotency-key": randomUUID() });
    expect(res.status).toBe(451);
  });
});

describe("live feed (WebSocket)", () => {
  const nextMessage = (ws: import("ws").WebSocket, type: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no ${type} message`)), 3000);
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) {
          clearTimeout(t);
          resolve(msg);
        }
      });
    });

  it("pushes my rounds and balance to me, and an anonymised feed to everyone", async () => {
    const { client, userId, email } = await signUp(app);
    await fund(db, userId, 10_000n);
    const mine = await app.injectWS("/ws", { headers: { origin: ORIGIN, cookie: client.cookie } });
    const anon = await app.injectWS("/ws", { headers: { origin: ORIGIN } });

    const gotRound = nextMessage(mine, "round");
    const gotBalance = nextMessage(mine, "balance");
    const gotPublic = nextMessage(anon, "live_bet");
    const res = await client.bet(diceBody());

    expect(((await gotRound).round as { id: string }).id).toBe(res.body.round.id);
    expect((await gotBalance).balance).toBe(res.body.balance);
    const pub = (await gotPublic).bet as Record<string, unknown>;
    expect(pub).toMatchObject({ game: "dice", stake: "1000" });
    expect(String(pub.player)).toMatch(/^Player [0-9a-f]{6}$/);
    expect(JSON.stringify(pub)).not.toContain(userId);
    expect(JSON.stringify(pub)).not.toContain(email);
    mine.terminate();
    anon.terminate();
  });

  it("refuses connections from other sites", async () => {
    const ws = await app.injectWS("/ws", { headers: { origin: "https://evil.example" } });
    const code = await new Promise<number>((resolve) => ws.on("close", (c) => resolve(c)));
    expect(code).toBe(1008);
  });
});

describe("rate limits", () => {
  it("throttles repeated login attempts", async () => {
    const { app: limited } = await makeApp(db, { RATE_LIMIT: "true" });
    try {
      const c = new Client(limited);
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        statuses.push((await c.post("/auth/login", { email: "x@test.local", password: "wrong password" })).status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses[11]).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
