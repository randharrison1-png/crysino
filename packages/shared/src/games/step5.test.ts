import { describe, expect, it } from "vitest";
import { FairRng } from "../fairness.js";
import {
  FLAP_FORTUNE_DEFAULT_CONFIG,
  FREEFALL_DEFAULT_CONFIG,
  GEM_GRID_DEFAULT_CONFIG,
  GameInputError,
  LAST_DOOR_DEFAULT_CONFIG,
  exactRtp,
  flapFortune,
  freefall,
  gemGrid,
  gemMultiplier,
  ladderMultiplier,
  lastDoor,
  maxMultiplier,
  rtpAtStep,
  type StatefulGame,
} from "./index.js";

const SEED = "3b1f0e2d4c6a8b9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f";
const x = (scaled: bigint) => Number(scaled) / 10_000;

function chiSquare(observed: number[], probs: number[]): number {
  const n = observed.reduce((a, b) => a + b, 0);
  return observed.reduce((s, o, i) => s + (o - n * probs[i]!) ** 2 / (n * probs[i]!), 0);
}

describe("The Last Door", () => {
  const cfg = lastDoor.parseConfig(LAST_DOOR_DEFAULT_CONFIG);

  it("matches the dossier: 96% RTP, 30x max, 1-in-100 secret chamber", () => {
    expect(exactRtp(lastDoor.odds(cfg, { door: 1 }))).toBe(0.96);
    expect(maxMultiplier(lastDoor.odds(cfg, { door: 1 }))).toBe(300_000n);
  });

  it("every layout has exactly 70 / 20 / 9 / 1 rooms", () => {
    const { result } = lastDoor.resolve(new FairRng(SEED, "layout", 0), cfg, { door: 1 });
    const counts: Record<string, number> = {};
    for (const r of result.layout) counts[r] = (counts[r] ?? 0) + 1;
    expect(counts).toEqual({ empty: 70, safe: 20, gold: 9, secret: 1 });
  });

  it("the secret chamber is equally likely behind every door", () => {
    const where = new Array(100).fill(0);
    for (let nonce = 0; nonce < 30_000; nonce++) {
      const { layout } = lastDoor.resolve(new FairRng(SEED, "where", nonce), cfg, { door: 1 }).result;
      where[layout.indexOf("secret")]++;
    }
    expect(chiSquare(where, new Array(100).fill(0.01))).toBeLessThan(148.2); // 99 df, p = 0.001
  });

  it("rejects bad doors and generous paytables", () => {
    expect(() => lastDoor.parseParams({ door: 0 }, cfg)).toThrow(GameInputError);
    expect(() => lastDoor.parseParams({ door: 101 }, cfg)).toThrow(GameInputError);
    expect(() => lastDoor.parseParams({}, cfg)).toThrow(GameInputError);
    const bad = structuredClone(LAST_DOOR_DEFAULT_CONFIG);
    bad.rooms[3]!.multiplier = 3_000_000;
    expect(() => lastDoor.parseConfig(bad)).toThrow(GameInputError);
  });
});

describe("Freefall and Flap Fortune (ladders)", () => {
  const ff = freefall.parseConfig(FREEFALL_DEFAULT_CONFIG);
  const fl = flapFortune.parseConfig(FLAP_FORTUNE_DEFAULT_CONFIG);

  it("multipliers match the dossier (to 4 decimals, rounded down)", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => x(ladderMultiplier(ff, n)))).toEqual([
      1.3714, 1.9591, 2.7988, 3.9983, 5.7119, 8.1598,
    ]);
    expect([1, 2, 3, 4, 5].map((n) => x(ladderMultiplier(fl, n)))).toEqual([1.2, 1.5, 1.875, 2.3437, 2.9296]);
  });

  it("cashing out at ANY stage returns at most 96% and at least 95.99%", () => {
    for (const [game, cfg] of [[freefall, ff], [flapFortune, fl]] as const) {
      for (const step of game.steps(cfg, {})) {
        expect(rtpAtStep(step)).toBeLessThanOrEqual(0.96 + 1e-12);
        expect(rtpAtStep(step)).toBeGreaterThanOrEqual(0.9599);
      }
    }
  });

  it("plays: advance, cash out, bust and auto-complete", () => {
    const state = { path: [true, true, false, true, true, true], position: 0, busted: false };
    let s = freefall.act(state, { type: "advance" }, ff, {});
    expect(s.outcome).toBe("continue");
    s = freefall.act(s.state, { type: "advance" }, ff, {});
    expect(freefall.multiplier(s.state, ff, {})).toBe(19_591n);
    expect(freefall.act(s.state, { type: "cashout" }, ff, {}).outcome).toBe("cashout");
    const bust = freefall.act(s.state, { type: "advance" }, ff, {});
    expect(bust.outcome).toBe("bust");
    expect(freefall.multiplier(bust.state, ff, {})).toBe(0n);
    expect(() => freefall.act(bust.state, { type: "advance" }, ff, {})).toThrow(GameInputError);

    let all = { path: [true, true, true, true, true], position: 0, busted: false };
    let outcome = "";
    for (let i = 0; i < 5; i++) ({ state: all, outcome } = flapFortune.act(all, { type: "advance" }, fl, {}));
    expect(outcome).toBe("complete");
  });

  it("can't cash out before clearing a stage", () => {
    const s = freefall.start(new FairRng(SEED, "c", 0), ff, {});
    expect(() => freefall.act(s, { type: "cashout" }, ff, {})).toThrow(GameInputError);
  });

  it("the view never shows stages not yet played", () => {
    const s = { path: [true, false, true, true, true, true], position: 1, busted: false };
    expect(freefall.view(s, ff, {}, false).path).toEqual([true]);
    expect(freefall.view(s, ff, {}, true).path).toHaveLength(6);
  });

  it("each stage passes 70% of the time over 300k fair rounds", () => {
    let passed = 0;
    for (let nonce = 0; nonce < 50_000; nonce++) {
      passed += freefall.start(new FairRng(SEED, "pass", nonce), ff, {}).path.filter(Boolean).length;
    }
    expect(passed / 300_000).toBeCloseTo(0.7, 2);
  });
});

describe("Gem Grid", () => {
  const cfg = gemGrid.parseConfig(GEM_GRID_DEFAULT_CONFIG);

  it("matches the dossier for 3 mines", () => {
    const at = (k: number) => x(gemMultiplier(cfg, 3, k));
    expect([at(1), at(3), at(5), at(10), at(15), at(22)]).toEqual([1.0909, 1.4337, 1.9368, 4.8527, 18.4, 2208]);
    const steps = gemGrid.steps(cfg, { mines: 3 });
    expect(steps.at(-1)!.probability).toBeCloseTo(1 / 2300, 12);
  });

  it("every mine count and every cash-out point returns 95.99%–96%", () => {
    for (let mines = 1; mines <= 24; mines++) {
      for (const step of gemGrid.steps(cfg, { mines })) {
        const rtp = rtpAtStep(step);
        expect(rtp, `${mines} mines, ${step.step} picks`).toBeLessThanOrEqual(0.96 + 1e-9);
        expect(rtp, `${mines} mines, ${step.step} picks`).toBeGreaterThanOrEqual(0.9599);
      }
    }
  });

  it("places exactly the chosen number of mines, uniformly", () => {
    const hits = new Array(25).fill(0);
    for (let nonce = 0; nonce < 50_000; nonce++) {
      const s = gemGrid.start(new FairRng(SEED, "mines", nonce), cfg, { mines: 3 });
      expect(new Set(s.mines).size).toBe(3);
      for (const m of s.mines) hits[m]++;
    }
    expect(chiSquare(hits, new Array(25).fill(1 / 25))).toBeLessThan(51.18); // 24 df, p = 0.001
  });

  it("plays: gem, mine, no double-picks, auto-complete on last gem", () => {
    const s0 = { mines: [0, 1, 2], picked: [], hit: null };
    const a = gemGrid.act(s0, { type: "reveal", tile: 10 }, cfg, { mines: 3 });
    expect(a.outcome).toBe("continue");
    expect(() => gemGrid.act(a.state, { type: "reveal", tile: 10 }, cfg, { mines: 3 })).toThrow(GameInputError);
    expect(gemGrid.act(a.state, { type: "reveal", tile: 1 }, cfg, { mines: 3 }).outcome).toBe("bust");

    const nearlyDone = { mines: Array.from({ length: 24 }, (_, i) => i), picked: [], hit: null };
    expect(gemGrid.act(nearlyDone, { type: "reveal", tile: 24 }, cfg, { mines: 24 }).outcome).toBe("complete");
  });

  it("hides mine positions until the round ends", () => {
    const s = { mines: [4, 9, 14], picked: [0], hit: null };
    expect(gemGrid.view(s, cfg, { mines: 3 }, false).minePositions).toBeNull();
    expect(gemGrid.view(s, cfg, { mines: 3 }, true).minePositions).toEqual([4, 9, 14]);
  });

  it("validates mine count against the admin's range", () => {
    expect(gemGrid.parseParams({}, cfg)).toEqual({ mines: 3 });
    expect(() => gemGrid.parseParams({ mines: 0 }, cfg)).toThrow(GameInputError);
    expect(() => gemGrid.parseParams({ mines: 25 }, cfg)).toThrow(GameInputError);
  });
});

describe("stateful replay is deterministic", () => {
  it("same seed + same actions = same result (what verification relies on)", () => {
    const g = gemGrid as StatefulGame<unknown, unknown, unknown, unknown>;
    const cfg = gemGrid.parseConfig(GEM_GRID_DEFAULT_CONFIG);
    const run = () => {
      let s = g.start(new FairRng(SEED, "replay", 9), cfg, { mines: 5 });
      for (const tile of [3, 7, 12]) {
        const r = g.act(s, { type: "reveal", tile }, cfg, { mines: 5 });
        s = r.state;
        if (r.outcome === "bust") break;
      }
      return g.view(s, cfg, { mines: 5 }, true);
    };
    expect(run()).toEqual(run());
  });
});
