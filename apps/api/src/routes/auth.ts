import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { SESSION_COOKIE } from "../app.js";
import { burnPasswordTime, hashPassword, verifyPassword } from "../auth/password.js";
import { createSession, revokeSession } from "../auth/sessions.js";
import { verifyTotp } from "../auth/totp.js";
import { ageOn } from "../compliance/regions.js";
import { ApiError } from "../http/errors.js";
import { decrypt } from "../lib/secretbox.js";

const email = z.string().trim().toLowerCase().email().max(254);

const registerBody = z.object({
  email,
  password: z.string().min(10, "Use at least 10 characters").max(128),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  acceptTerms: z.literal(true, { errorMap: () => ({ message: "You must accept the terms" }) }),
});

const loginBody = z.object({
  email,
  password: z.string().min(1).max(128),
  totp: z.string().optional(),
});

const REGION_BLOCKED = () =>
  new ApiError(451, "region_blocked", "Crysino is not available in your region");

export async function authRoutes(app: FastifyInstance) {
  const { db, config, appKey } = app.deps;

  function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date) {
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: "lax",
      path: "/",
      domain: config.COOKIE_DOMAIN,
      expires: expiresAt,
    });
  }

  app.post(
    "/auth/register",
    { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      const body = registerBody.parse(req.body);

      const paused = await db.query<{ value: boolean }>("SELECT value FROM settings WHERE key = 'signups_paused'");
      if (paused.rows[0]?.value === true) throw new ApiError(503, "signups_paused", "Sign-ups are paused");

      const geo = app.geoOf(req);
      const region = await app.regionOf(req);
      if (region.policy === "block") throw REGION_BLOCKED();

      const dob = new Date(`${body.dateOfBirth}T00:00:00Z`);
      if (Number.isNaN(dob.getTime()) || dob.getUTCFullYear() < 1900 || dob > new Date()) {
        throw new ApiError(400, "invalid_request", "Invalid date of birth");
      }
      if (ageOn(dob) < region.minAge) {
        throw new ApiError(403, "underage", `You must be ${region.minAge} or older to play`);
      }

      const passwordHash = await hashPassword(body.password);
      let userId: string;
      try {
        const { rows } = await db.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, date_of_birth, terms_version, signup_country, country)
           VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
          [body.email, passwordHash, body.dateOfBirth, config.TERMS_VERSION, geo.country],
        );
        userId = rows[0]!.id;
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new ApiError(409, "email_taken", "An account with this email already exists");
        }
        throw err;
      }

      const session = await createSession(db, userId, {
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        country: geo.country,
      });
      setSessionCookie(reply, session.token, session.expiresAt);
      return reply.status(201).send({ user: { id: userId, email: body.email, kycTier: 0, totpEnabled: false } });
    },
  );

  app.post(
    "/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = loginBody.parse(req.body);
      const geo = app.geoOf(req);
      if ((await app.regionOf(req)).policy === "block") throw REGION_BLOCKED();

      const { rows } = await db.query<{
        id: string;
        password_hash: string;
        status: string;
        kyc_tier: number;
        totp_enabled: boolean;
        totp_secret_enc: Buffer | null;
        totp_last_step: string | null;
      }>(
        `SELECT id, password_hash, status, kyc_tier, totp_enabled, totp_secret_enc, totp_last_step
         FROM users WHERE email = $1`,
        [body.email],
      );
      const user = rows[0];
      const invalid = new ApiError(401, "invalid_credentials", "Email or password is incorrect");
      if (!user) {
        await burnPasswordTime(body.password);
        throw invalid;
      }
      if (!(await verifyPassword(body.password, user.password_hash)) || user.status === "closed") throw invalid;
      if (user.status === "self_excluded") {
        throw new ApiError(403, "self_excluded", "This account is self-excluded. Contact support for withdrawals.");
      }

      if (user.totp_enabled) {
        if (!body.totp) throw new ApiError(401, "totp_required", "Enter the code from your authenticator app");
        const secret = decrypt(user.totp_secret_enc!, appKey);
        const lastStep = user.totp_last_step === null ? null : Number(user.totp_last_step);
        const step = verifyTotp(secret, body.totp, lastStep);
        // Conditional update: two simultaneous logins can't both use the same code.
        const claimed =
          step !== null &&
          (
            await db.query(
              `UPDATE users SET totp_last_step = $2
               WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)`,
              [user.id, step],
            )
          ).rowCount === 1;
        if (!claimed) throw new ApiError(401, "invalid_totp", "That code is incorrect or already used");
      }

      await db.query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
      const session = await createSession(db, user.id, {
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        country: geo.country,
      });
      setSessionCookie(reply, session.token, session.expiresAt);
      return { user: { id: user.id, email: body.email, kycTier: user.kyc_tier, totpEnabled: user.totp_enabled } };
    },
  );

  app.post("/auth/logout", async (req, reply) => {
    if (req.user) await revokeSession(db, req.user.tokenHash);
    reply.clearCookie(SESSION_COOKIE, { path: "/", domain: config.COOKIE_DOMAIN });
    return { ok: true };
  });
}
