import { z } from "zod";
import type { FairRng } from "../fairness.js";
import type { StatefulGame, StepOdds } from "./stateful.js";
import { GameInputError } from "./types.js";

/**
 * 05 · GEM GRID — 5×5 board, the player picks how many mines (dossier baseline: 3).
 * Mine positions are a fair shuffle drawn at the start. Each safe pick raises the cash-out;
 * hitting a mine ends the round at 0x. Picking every safe tile cashes out automatically.
 *
 *   after k safe picks with S safe tiles:  RTP / ∏(i=0..k-1) (S−i)/(25−i)
 *   3 mines: 1 pick 1.0909x … 22 picks 2,208x (1 in 2,300)
 */
export const TILES = 25;

export const gemGridConfigSchema = z
  .object({
    rtpBps: z.number().int().min(9000).max(9900),
    minMines: z.number().int().min(1).max(24),
    maxMines: z.number().int().min(1).max(24),
    defaultMines: z.number().int().min(1).max(24),
  })
  .refine((c) => c.minMines <= c.defaultMines && c.defaultMines <= c.maxMines, "min ≤ default ≤ max");
export type GemGridConfig = z.infer<typeof gemGridConfigSchema>;

export interface GemGridParams {
  mines: number;
}

export interface GemGridState {
  mines: number[]; // hidden until the round ends
  picked: number[]; // safe tiles revealed, in order
  hit: number | null; // the mine that ended the round
}

export type GemGridAction = { type: "reveal"; tile: number } | { type: "cashout" };
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reveal"), tile: z.number().int().min(0).max(TILES - 1) }),
  z.object({ type: z.literal("cashout") }),
]);

/** rtpBps × ∏(25−i) ÷ ∏(S−i), exact integer arithmetic, rounded down. */
export function gemMultiplier(config: GemGridConfig, mines: number, picks: number): bigint {
  if (picks === 0) return 0n;
  const safe = TILES - mines;
  let num = BigInt(config.rtpBps);
  let den = 1n;
  for (let i = 0; i < picks; i++) {
    num *= BigInt(TILES - i);
    den *= BigInt(safe - i);
  }
  return num / den;
}

export const gemGrid: StatefulGame<GemGridConfig, GemGridParams, GemGridState, GemGridAction> = {
  code: "gem_grid",
  parseConfig: (raw) => gemGridConfigSchema.parse(raw),

  parseParams(raw, config) {
    const parsed = z.object({ mines: z.number().int() }).partial().safeParse(raw ?? {});
    if (!parsed.success) throw new GameInputError("mines must be a whole number");
    const mines = parsed.data.mines ?? config.defaultMines;
    if (mines < config.minMines || mines > config.maxMines) {
      throw new GameInputError(`Choose between ${config.minMines} and ${config.maxMines} mines`);
    }
    return { mines };
  },

  start(rng: FairRng, _config, params) {
    const board = rng.shuffle(Array.from({ length: TILES }, (_, i) => i));
    return { mines: board.slice(0, params.mines).sort((a, b) => a - b), picked: [], hit: null };
  },

  parseAction(raw) {
    const parsed = actionSchema.safeParse(raw);
    if (!parsed.success) throw new GameInputError('Action must be { type: "reveal", tile: 0–24 } or { type: "cashout" }');
    return parsed.data;
  },

  act(state, action, _config, params) {
    const safe = TILES - params.mines;
    if (state.hit !== null || state.picked.length >= safe) throw new GameInputError("Round is over");
    if (action.type === "cashout") {
      if (state.picked.length === 0) throw new GameInputError("Reveal at least one gem before cashing out");
      return { state, outcome: "cashout" };
    }
    if (state.picked.includes(action.tile)) throw new GameInputError("That tile is already revealed");
    if (state.mines.includes(action.tile)) return { state: { ...state, hit: action.tile }, outcome: "bust" };
    const picked = [...state.picked, action.tile];
    return { state: { ...state, picked }, outcome: picked.length === safe ? "complete" : "continue" };
  },

  multiplier: (s, c, p) => (s.hit !== null ? 0n : gemMultiplier(c, p.mines, s.picked.length)),
  nextMultiplier: (s, c, p) =>
    s.hit !== null || s.picked.length >= TILES - p.mines ? null : gemMultiplier(c, p.mines, s.picked.length + 1),

  steps(config, params): StepOdds[] {
    const safe = TILES - params.mines;
    const out: StepOdds[] = [];
    let survival = 1;
    for (let k = 1; k <= safe; k++) {
      survival *= (safe - k + 1) / (TILES - k + 1);
      out.push({ step: k, probability: survival, multiplier: gemMultiplier(config, params.mines, k) });
    }
    return out;
  },

  view(state, config, params, final) {
    const safe = TILES - params.mines;
    const over = state.hit !== null || state.picked.length >= safe;
    return {
      tiles: TILES,
      mines: params.mines,
      picked: state.picked,
      gems: state.picked.length,
      hit: state.hit,
      currentMultiplier: state.hit !== null ? 0 : Number(gemMultiplier(config, params.mines, state.picked.length)) / 10_000,
      nextMultiplier: over ? null : Number(gemMultiplier(config, params.mines, state.picked.length + 1)) / 10_000,
      minePositions: final ? state.mines : null,
    };
  },
};

export const GEM_GRID_DEFAULT_CONFIG: GemGridConfig = { rtpBps: 9600, minMines: 1, maxMines: 24, defaultMines: 3 };
