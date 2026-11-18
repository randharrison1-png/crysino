import { describe, expect, it } from "vitest";
import { FairRng } from "../fairness.js";
import {
  DICE_DEFAULT_CONFIG,
  DOOMSDAY_DEFAULT_CONFIG,
  dice,
  diceMultiplier,
  doomsday,
  exactRtp,
  GameInputError,
  maxMultiplier,
} from "./index.js";

const SEED = "7c1e0b3f9d2a4c6e8f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60";

/** A fake rng that returns chosen values, to test every possible draw. */
const fixedRng = (value: number) => ({ int: () => value }) as unknown as FairRng;

function chiSquare(observed: number[], expectedProbs: number[]): number {
  const n = observed.reduce((a, b) => a + b, 0);
  return observed.reduce((s, o, i) => s + (o - n * expectedProbs[i]!) ** 2 / (n * expectedProbs[i]!), 0);
}

describe("Doomsday", () => {
  const cfg = doomsday.parseConfig(DOOMSDAY_DEFAULT_CONFIG);

  it("matches the dossier exactly: 96% RTP, 80x max", () => {
    expect(exactRtp(doomsday.odds(cfg, {}))).toBe(0.96);
    expect(maxMultiplier(doomsday.odds(cfg, {}))).toBe(800_000n);
  });

  it("maps every one of the 1,000 draws to the right tier", () => {
    const counts: Record<string, number> = {};
    for (let draw = 0; draw < 1000; draw++) {
      const { result } = doomsday.resolve(fixedRng(draw), cfg, {});
      counts[result.tier] = (counts[result.tier] ?? 0) + 1;
    }
    expect(counts).toEqual({ destroyed: 650, recovery: 300, jackpot: 42, override: 7, miracle: 1 });
  });

  it("hits each tier at the stated rate over 500k fair rounds", () => {
    const tiers = cfg.tiers.map((t) => t.id);
    const seen = new Array(tiers.length).fill(0);
    for (let nonce = 0; nonce < 500_000; nonce++) {
      const { result } = doomsday.resolve(new FairRng(SEED, "sim", nonce), cfg, {});
      seen[tiers.indexOf(result.tier)]++;
    }
    // 4 degrees of freedom: 18.47 is the p = 0.001 critical value
    expect(chiSquare(seen, [0.65, 0.3, 0.042, 0.007, 0.001])).toBeLessThan(18.47);
  });

  it("rejects paytables an admin typo could make dangerous", () => {
    const generous = structuredClone(DOOMSDAY_DEFAULT_CONFIG);
    generous.tiers[4]!.multiplier = 8_000_000; // 800x instead of 80x → RTP 168%
    expect(() => doomsday.parseConfig(generous)).toThrow(GameInputError);
    expect(() => doomsday.parseConfig({ tiers: [] })).toThrow();
  });

  it("takes no player options", () => {
    expect(doomsday.parseParams({}, cfg)).toEqual({});
    expect(doomsday.parseParams(undefined, cfg)).toEqual({});
    expect(() => doomsday.parseParams({ cheat: 1 }, cfg)).toThrow(GameInputError);
  });
});

describe("Dice 100", () => {
  const cfg = dice.parseConfig(DICE_DEFAULT_CONFIG);

  it("matches the dossier payouts", () => {
    expect(diceMultiplier(cfg, 50)).toBe(19_200n); // 1.92x
    expect(diceMultiplier(cfg, 25)).toBe(38_400n); // 3.84x
    expect(diceMultiplier(cfg, 10)).toBe(96_000n); // 9.60x
    expect(diceMultiplier(cfg, 5)).toBe(192_000n); // 19.20x
    expect(diceMultiplier(cfg, 1)).toBe(960_000n); // 96.00x
  });

  it("every possible bet returns between 95.99% and 96% — never more", () => {
    for (const direction of ["under", "over"] as const) {
      for (let target = 0; target <= 99; target++) {
        let params;
        try {
          params = dice.parseParams({ direction, target }, cfg);
        } catch {
          continue; // 0% win chance bets are rejected
        }
        const rtp = exactRtp(dice.odds(cfg, params));
        expect(rtp).toBeLessThanOrEqual(0.96);
        expect(rtp).toBeGreaterThanOrEqual(0.9599);
      }
    }
  });

  it("wins on exactly the advertised range", () => {
    const under50 = dice.parseParams({ direction: "under", target: 50 }, cfg);
    const over49 = dice.parseParams({ direction: "over", target: 49 }, cfg);
    let underWins = 0;
    let overWins = 0;
    for (let roll = 0; roll < 100; roll++) {
      const u = dice.resolve(fixedRng(roll), cfg, under50).result;
      const o = dice.resolve(fixedRng(roll), cfg, over49).result;
      if (u.won) underWins++;
      if (o.won) overWins++;
      expect(u.won).toBe(roll <= 49);
      expect(o.won).toBe(roll >= 50);
    }
    expect([underWins, overWins]).toEqual([50, 50]);
    expect(dice.resolve(fixedRng(0), cfg, under50).result.winRange).toEqual([0, 49]);
  });

  it("rejects impossible or out-of-policy bets", () => {
    expect(() => dice.parseParams({ direction: "under", target: 0 }, cfg)).toThrow(GameInputError);
    expect(() => dice.parseParams({ direction: "over", target: 99 }, cfg)).toThrow(GameInputError);
    expect(() => dice.parseParams({ direction: "sideways", target: 50 }, cfg)).toThrow(GameInputError);
    expect(() => dice.parseParams({ direction: "under", target: 50.5 }, cfg)).toThrow(GameInputError);
    const strict = dice.parseConfig({ rtpBps: 9600, minChance: 2, maxChance: 98 });
    expect(() => dice.parseParams({ direction: "under", target: 1 }, strict)).toThrow(GameInputError);
  });
});
