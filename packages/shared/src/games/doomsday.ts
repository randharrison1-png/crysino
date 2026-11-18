import { z } from "zod";
import type { FairRng } from "../fairness.js";
import { GameInputError, exactRtp, type InstantGame, type OutcomeOdds } from "./types.js";

/**
 * 01 · DOOMSDAY — press the button, one instant result from a weighted paytable.
 * Draws one integer in [0, totalWeight) and walks the tiers in order. With the dossier's
 * weights out of 1,000 the odds are exact: 65% / 30% / 4.2% / 0.7% / 0.1%.
 */

const tierSchema = z.object({
  id: z.string().min(1).max(32),
  label: z.string().min(1).max(64),
  weight: z.number().int().min(1),
  multiplier: z.number().int().min(0), // scaled by 10,000
});

export const doomsdayConfigSchema = z
  .object({ tiers: z.array(tierSchema).min(2).max(20) })
  .refine((c) => new Set(c.tiers.map((t) => t.id)).size === c.tiers.length, "Tier ids must be unique");
export type DoomsdayConfig = z.infer<typeof doomsdayConfigSchema>;

export type DoomsdayParams = Record<string, never>;

export interface DoomsdayResult {
  /** The integer drawn, 0 … totalWeight-1 — lets the player verify which tier it maps to. */
  draw: number;
  tier: string;
  label: string;
}

const totalWeight = (c: DoomsdayConfig) => c.tiers.reduce((s, t) => s + t.weight, 0);

export const doomsday: InstantGame<DoomsdayConfig, DoomsdayParams, DoomsdayResult> = {
  code: "doomsday",

  parseConfig(raw) {
    const config = doomsdayConfigSchema.parse(raw);
    // Guard rail for the admin editor: a typo must not create a paytable that pays out more
    // than it takes in, or a predatory one.
    const rtp = exactRtp(this.odds(config, {}));
    if (rtp < 0.9 || rtp > 0.99) throw new GameInputError(`Paytable RTP ${(rtp * 100).toFixed(4)}% is outside 90–99%`);
    return config;
  },

  parseParams(raw) {
    if (raw !== undefined && raw !== null && (typeof raw !== "object" || Object.keys(raw).length > 0)) {
      throw new GameInputError("Doomsday takes no options");
    }
    return {};
  },

  odds(config): OutcomeOdds[] {
    const outOf = BigInt(totalWeight(config));
    return config.tiers.map((t) => ({
      label: t.label,
      weight: BigInt(t.weight),
      outOf,
      multiplier: BigInt(t.multiplier),
    }));
  },

  resolve(rng: FairRng, config) {
    const draw = rng.int(totalWeight(config));
    let cumulative = 0;
    for (const t of config.tiers) {
      cumulative += t.weight;
      if (draw < cumulative) {
        return { multiplier: BigInt(t.multiplier), result: { draw, tier: t.id, label: t.label } };
      }
    }
    throw new Error("unreachable: draw outside paytable");
  },
};

/** The dossier's paytable: 96% RTP, max 80x. */
export const DOOMSDAY_DEFAULT_CONFIG: DoomsdayConfig = {
  tiers: [
    { id: "destroyed", label: "System destroyed", weight: 650, multiplier: 0 },
    { id: "recovery", label: "Emergency recovery", weight: 300, multiplier: 20_000 },
    { id: "jackpot", label: "Bunker jackpot", weight: 42, multiplier: 50_000 },
    { id: "override", label: "Critical override", weight: 7, multiplier: 100_000 },
    { id: "miracle", label: "Doomsday miracle", weight: 1, multiplier: 800_000 },
  ],
};
