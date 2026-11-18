import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/pool.js";

/** Opaque random session tokens; only their SHA-256 is stored. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export interface SessionUser {
  userId: string;
  email: string;
  status: string;
  kycTier: number;
  tokenHash: string;
}

export async function createSession(
  db: Db,
  userId: string,
  meta: { ip?: string; userAgent?: string; country?: string | null },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent, country)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [hashToken(token), userId, expiresAt, meta.ip ?? null, meta.userAgent?.slice(0, 512) ?? null, meta.country ?? null],
  );
  return { token, expiresAt };
}

/** Resolves a token to its user, or null if unknown, expired, revoked, or the account is closed. */
export async function lookupSession(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token || token.length > 100) return null;
  const tokenHash = hashToken(token);
  const { rows } = await db.query<{ user_id: string; email: string; status: string; kyc_tier: number }>(
    `UPDATE sessions s SET last_seen_at = now()
     FROM users u
     WHERE s.token_hash = $1 AND u.id = s.user_id
       AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status <> 'closed'
     RETURNING u.id AS user_id, u.email, u.status, u.kyc_tier`,
    [tokenHash],
  );
  const r = rows[0];
  return r ? { userId: r.user_id, email: r.email, status: r.status, kycTier: r.kyc_tier, tokenHash } : null;
}

export async function revokeSession(db: Db, tokenHash: string): Promise<void> {
  await db.query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [tokenHash]);
}

export async function revokeAllSessions(db: Db, userId: string, exceptTokenHash?: string): Promise<void> {
  await db.query(
    `UPDATE sessions SET revoked_at = now()
     WHERE user_id = $1 AND revoked_at IS NULL AND token_hash IS DISTINCT FROM $2`,
    [userId, exceptTokenHash ?? null],
  );
}
