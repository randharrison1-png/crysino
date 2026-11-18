import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { verifyPassword } from "../auth/password.js";
import { revokeAllSessions } from "../auth/sessions.js";
import { newTotpSecret, totpUri, verifyTotp } from "../auth/totp.js";
import { ApiError } from "../http/errors.js";
import { decrypt, encrypt } from "../lib/secretbox.js";

const codeBody = z.object({ code: z.string().regex(/^\d{6}$/, "6-digit code") });
const disableBody = codeBody.extend({ password: z.string().min(1).max(128) });

export async function meRoutes(app: FastifyInstance) {
  const { db, appKey } = app.deps;
  const auth = { preHandler: app.requireUser };

  app.get("/me", auth, async (req) => {
    const { rows } = await db.query(
      `SELECT id, email, status, kyc_tier, totp_enabled, created_at FROM users WHERE id = $1`,
      [req.user!.userId],
    );
    const u = rows[0];
    return {
      user: {
        id: u.id,
        email: u.email,
        status: u.status,
        kycTier: u.kyc_tier,
        totpEnabled: u.totp_enabled,
        createdAt: u.created_at,
      },
    };
  });

  app.get("/balances", auth, async (req) => {
    const { rows } = await db.query<{ asset: string; kind: string; balance: string }>(
      `SELECT asset, kind, balance FROM ledger_accounts
       WHERE owner_type = 'player' AND owner_id = $1 AND kind IN ('main', 'pending_withdrawal')`,
      [req.user!.userId],
    );
    const byAsset = new Map<string, { asset: string; available: bigint; pendingWithdrawal: bigint }>();
    for (const r of rows) {
      const entry = byAsset.get(r.asset) ?? { asset: r.asset, available: 0n, pendingWithdrawal: 0n };
      if (r.kind === "main") entry.available = BigInt(r.balance);
      else entry.pendingWithdrawal = BigInt(r.balance);
      byAsset.set(r.asset, entry);
    }
    return { balances: [...byAsset.values()] };
  });

  // ── Two-factor authentication ──
  app.post("/me/2fa/setup", auth, async (req) => {
    const { rows } = await db.query<{ totp_enabled: boolean }>("SELECT totp_enabled FROM users WHERE id = $1", [
      req.user!.userId,
    ]);
    if (rows[0]?.totp_enabled) throw new ApiError(409, "totp_already_enabled", "Two-factor is already on");
    const secret = newTotpSecret();
    await db.query("UPDATE users SET totp_secret_enc = $2 WHERE id = $1", [req.user!.userId, encrypt(secret, appKey)]);
    // Shown once, for the QR code. Not active until confirmed with a code.
    return { secret, otpauthUri: totpUri(secret, req.user!.email) };
  });

  app.post("/me/2fa/enable", auth, async (req) => {
    const { code } = codeBody.parse(req.body);
    const { rows } = await db.query<{ totp_enabled: boolean; totp_secret_enc: Buffer | null }>(
      "SELECT totp_enabled, totp_secret_enc FROM users WHERE id = $1",
      [req.user!.userId],
    );
    const u = rows[0]!;
    if (u.totp_enabled) throw new ApiError(409, "totp_already_enabled", "Two-factor is already on");
    if (!u.totp_secret_enc) throw new ApiError(409, "totp_not_set_up", "Start two-factor setup first");
    const step = verifyTotp(decrypt(u.totp_secret_enc, appKey), code, null);
    if (step === null) throw new ApiError(401, "invalid_totp", "That code is incorrect");
    await db.query("UPDATE users SET totp_enabled = true, totp_last_step = $2 WHERE id = $1", [
      req.user!.userId,
      step,
    ]);
    // Any other signed-in device must now log in again with a code.
    await revokeAllSessions(db, req.user!.userId, req.user!.tokenHash);
    return { totpEnabled: true };
  });

  app.post("/me/2fa/disable", auth, async (req) => {
    const { code, password } = disableBody.parse(req.body);
    const { rows } = await db.query<{
      password_hash: string;
      totp_enabled: boolean;
      totp_secret_enc: Buffer | null;
      totp_last_step: string | null;
    }>("SELECT password_hash, totp_enabled, totp_secret_enc, totp_last_step FROM users WHERE id = $1", [
      req.user!.userId,
    ]);
    const u = rows[0]!;
    if (!u.totp_enabled) throw new ApiError(409, "totp_not_enabled", "Two-factor is not on");
    if (!(await verifyPassword(password, u.password_hash))) {
      throw new ApiError(401, "invalid_credentials", "Password is incorrect");
    }
    const lastStep = u.totp_last_step === null ? null : Number(u.totp_last_step);
    if (verifyTotp(decrypt(u.totp_secret_enc!, appKey), code, lastStep) === null) {
      throw new ApiError(401, "invalid_totp", "That code is incorrect or already used");
    }
    await db.query(
      "UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, totp_last_step = NULL WHERE id = $1",
      [req.user!.userId],
    );
    return { totpEnabled: false };
  });
}
