import { z } from "zod";
import type { FairRng } from "../fairness.js";
import { GameInputError, type InstantGame, type OutcomeOdds } from "./types.js";

/**
 * 06 · DICE 100 — roll an integer 00–99; the player picks over/under a target.
 *
 *   under T  → wins on rolls 00 … T-1      win chance T%        (T = 1 … 99)
 *   over  T  → wins on rolls T+1 … 99      win chance (99-T)%   (T = 0 … 98)
 *   payout   = RTP / win chance, rounded down to 4 decimals      (50% → 1.92x, 1% → 96x)
 */

export const diceConfigSchema = z
  .object({
    rtpBps: z.number().int().min(9000).max(9900), // RTP in basis points of 10,000 (9600 = 96%)
    minChance: z.number().int().min(1).max(99),
    maxChance: z.number().int().min(1).max(99),
  })
  .refine((c) => c.minChance <= c.maxChance, "minChance must be ≤ maxChance");
export type DiceConfig = z.infer<typeof diceConfigSchema>;

const paramsSchema = z.object({
  direction: z.enum(["under", "over"]),
  target: z.number().int().min(0).max(99),
});
export type DiceParams = z.infer<typeof paramsSchema>;

export interface DiceResult {
  roll: number;
  direction: "under" | "over";
  target: number;
  winChance: number;
  /** Inclusive winning range shown before and after the bet, e.g. [0, 49]. */
  winRange: [number, number];
  won: boolean;
}

export function diceWinChance(p: DiceParams): number {
  return p.direction === "under" ? p.target : 99 - p.target;
}

export function diceWinRange(p: DiceParams): [number, number] {
  return p.direction === "under" ? [0, p.target - 1] : [p.target + 1, 99];
}

/** (RTP / chance) scaled by 10,000 and rounded down: rtpBps × 100 / chance. */
export function diceMultiplier(config: DiceConfig, winChance: number): bigint {
  return (BigInt(config.rtpBps) * 100n) / BigInt(winChance);
}

export const dice: InstantGame<DiceConfig, DiceParams, DiceResult> = {
  code: "dice",

  parseConfig: (raw) => diceConfigSchema.parse(raw),

  parseParams(raw, config) {
    const parsed = paramsSchema.safeParse(raw);
    if (!parsed.success) throw new GameInputError("Choose over or under and a target from 0 to 99");
    const chance = diceWinChance(parsed.data);
    if (chance < config.minChance || chance > config.maxChance) {
      throw new GameInputError(`Win chance must be between ${config.minChance}% and ${config.maxChance}%`);
    }
    return parsed.data;
  },

  odds(config, params): OutcomeOdds[] {
    const chance = BigInt(diceWinChance(params));
    return [
      { label: "win", weight: chance, outOf: 100n, multiplier: diceMultiplier(config, Number(chance)) },
      { label: "lose", weight: 100n - chance, outOf: 100n, multiplier: 0n },
    ];
  },

  resolve(rng: FairRng, config, params) {
    const roll = rng.int(100);
    const [lo, hi] = diceWinRange(params);
    const won = roll >= lo && roll <= hi;
    const winChance = diceWinChance(params);
    return {
      multiplier: won ? diceMultiplier(config, winChance) : 0n,
      result: { roll, direction: params.direction, target: params.target, winChance, winRange: [lo, hi], won },
    };
  },
};

export const DICE_DEFAULT_CONFIG: DiceConfig = { rtpBps: 9600, minChance: 1, maxChance: 99 };
