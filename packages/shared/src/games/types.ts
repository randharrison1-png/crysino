import type { FairRng } from "../fairness.js";

/**
 * Multipliers are integers scaled by 10,000 (MULTIPLIER_SCALE): 1.92x = 19200n.
 * The 4th decimal is always rounded DOWN, matching the dossier's tables.
 */
export type ScaledMultiplier = bigint;

/** One possible outcome and its exact probability (numerator / denominator). */
export interface OutcomeOdds {
  label: string;
  weight: bigint;
  outOf: bigint;
  multiplier: ScaledMultiplier;
}

/**
 * A single-request game (Dice 100, Doomsday, The Last Door).
 * Everything here is pure: the same code resolves bets on the server and verifies them
 * in the player's browser.
 *
 *   C = game configuration (admin-set, versioned)   P = the player's choices for one bet
 *   R = public result shown to the player
 */
export interface InstantGame<C, P, R> {
  code: string;
  /** Validates a configuration before an admin can save it as a new version. Throws if invalid. */
  parseConfig(raw: unknown): C;
  /** Validates the player's choices for one bet. Throws GameInputError if invalid. */
  parseParams(raw: unknown, config: C): P;
  /** Every outcome with exact odds — drives the Odds tab, exposure checks and RTP checks. */
  odds(config: C, params: P): OutcomeOdds[];
  /** Turns the fair random stream into the result. Must only use rng.int()/rng.shuffle(). */
  resolve(rng: FairRng, config: C, params: P): { multiplier: ScaledMultiplier; result: R };
}

export class GameInputError extends Error {}

/** Exact return-to-player as a fraction of 1 (e.g. 0.96), computed from the odds table. */
export function exactRtp(odds: OutcomeOdds[]): number {
  if (odds.length === 0) return 0;
  const outOf = odds[0]!.outOf;
  let sum = 0n;
  for (const o of odds) {
    if (o.outOf !== outOf) throw new Error("Outcomes must share one denominator");
    sum += o.weight * o.multiplier;
  }
  const total = odds.reduce((s, o) => s + o.weight, 0n);
  if (total !== outOf) throw new Error(`Outcome weights sum to ${total}, expected ${outOf}`);
  return Number(sum) / Number(outOf * 10_000n);
}

export function maxMultiplier(odds: OutcomeOdds[]): ScaledMultiplier {
  return odds.reduce((m, o) => (o.multiplier > m ? o.multiplier : m), 0n);
}
