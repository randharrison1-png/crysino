import type { Db, DbClient } from "../db/pool.js";

/**
 * Region gate (design spec §2, layers 1–2). Decides from the visitor's country (and, where a
 * rule exists, their state/province) whether they may use the site.
 *
 *   1. A rule for the subdivision (e.g. CA-ON) wins over
 *   2. a rule for the whole country, which wins over
 *   3. the region_default_policy setting ('block' = allowlist model).
 *
 * An unknown country is always blocked. VPN/proxy detection and KYC-country checks plug in
 * on top of this in Step 10.
 */
export type RegionPolicy = "allow" | "block" | "kyc_required";

export interface Geo {
  country: string | null; // ISO 3166-1 alpha-2, upper case
  subdivision: string | null; // ISO 3166-2, e.g. "CA-ON"
}

export interface RegionDecision {
  policy: RegionPolicy;
  minAge: number;
  gamesAllowed: string[] | null; // null = all
  assetsAllowed: string[] | null;
  source: "subdivision" | "country" | "default" | "unknown_country";
}

// Cloudflare uses XX (unknown) and T1 (Tor). Neither is a real place.
const NOT_A_COUNTRY = new Set(["XX", "T1", "A1", "A2", "O1", "EU", "AP"]);

export async function decideRegion(db: Db | DbClient, geo: Geo): Promise<RegionDecision> {
  const country = geo.country?.toUpperCase() ?? null;
  if (!country || !/^[A-Z]{2}$/.test(country) || NOT_A_COUNTRY.has(country)) {
    return { policy: "block", minAge: 18, gamesAllowed: null, assetsAllowed: null, source: "unknown_country" };
  }

  const { rows } = await db.query<{
    subdivision: string | null;
    policy: RegionPolicy;
    min_age: number;
    games_allowed: string[] | null;
    assets_allowed: string[] | null;
  }>(
    `SELECT subdivision, policy, min_age, games_allowed, assets_allowed FROM region_rules
     WHERE country_code = $1 AND (subdivision IS NULL OR subdivision = $2)
     ORDER BY subdivision NULLS LAST LIMIT 1`,
    [country, geo.subdivision?.toUpperCase() ?? null],
  );
  const rule = rows[0];
  if (rule) {
    return {
      policy: rule.policy,
      minAge: rule.min_age,
      gamesAllowed: rule.games_allowed,
      assetsAllowed: rule.assets_allowed,
      source: rule.subdivision ? "subdivision" : "country",
    };
  }

  const def = await db.query<{ value: RegionPolicy }>(
    "SELECT value FROM settings WHERE key = 'region_default_policy'",
  );
  return {
    policy: def.rows[0]?.value ?? "block",
    minAge: 18,
    gamesAllowed: null,
    assetsAllowed: null,
    source: "default",
  };
}

/** May this person play here right now? 'kyc_required' regions need ID-verified (tier 2+) players. */
export function regionPermitsPlay(decision: RegionDecision, kycTier: number): boolean {
  if (decision.policy === "allow") return true;
  if (decision.policy === "kyc_required") return kycTier >= 2;
  return false;
}

export function ageOn(dateOfBirth: Date, today = new Date()): number {
  let age = today.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const m = today.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (m < 0 || (m === 0 && today.getUTCDate() < dateOfBirth.getUTCDate())) age--;
  return age;
}
