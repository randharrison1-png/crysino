import { z } from "zod";
import type { FairRng } from "../fairness.js";
import type { StatefulGame, StepOdds } from "./stateful.js";
import { GameInputError } from "./types.js";

/**
 * Risk-ladder games: 02 · FREEFALL (6 stages, 70% each) and 04 · FLAP FORTUNE (5 pipes, 80% each).
 *
 * Each stage passes independently with probability passPercent. Pass/fail for every stage is
 * drawn at the start; the player advances one stage at a time and may cash out after any passed
 * stage. Reaching the last stage cashes out automatically.
 *
 *   cash-out after n stages = RTP / p^n  (rounded down to 4 decimals)
 *   e.g. Freefall: 1.3714x, 1.9591x, 2.7988x, 3.9983x, 5.7119x, 8.1598x
 */

export const ladderConfigSchema = z
  .object({
    stages: z.number().int().min(2).max(20),
    passPercent: z.number().int().min(1).max(99),
    rtpBps: z.number().int().min(9000).max(9900),
    stageNames: z.array(z.string().min(1).max(32)),
  })
  .refine((c) => c.stageNames.length === c.stages, "One name per stage");
export type LadderConfig = z.infer<typeof ladderConfigSchema>;
export type LadderParams = Record<string, never>;

export interface LadderState {
  path: boolean[]; // hidden until the round ends
  position: number; // stages passed
  busted: boolean;
}

export type LadderAction = { type: "advance" } | { type: "cashout" };
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("advance") }),
  z.object({ type: z.literal("cashout") }),
]);

/** RTP / p^n scaled by 10,000: rtpBps × 100^n ÷ pass^n, exact integer arithmetic. */
export function ladderMultiplier(config: LadderConfig, n: number): bigint {
  if (n === 0) return 0n;
  return (BigInt(config.rtpBps) * 100n ** BigInt(n)) / BigInt(config.passPercent) ** BigInt(n);
}

function makeLadder(code: string): StatefulGame<LadderConfig, LadderParams, LadderState, LadderAction> {
  return {
    code,
    parseConfig: (raw) => ladderConfigSchema.parse(raw),

    parseParams(raw) {
      if (raw !== undefined && raw !== null && (typeof raw !== "object" || Object.keys(raw).length > 0)) {
        throw new GameInputError("This game takes no options");
      }
      return {};
    },

    start(rng: FairRng, config) {
      const path = Array.from({ length: config.stages }, () => rng.int(100) < config.passPercent);
      return { path, position: 0, busted: false };
    },

    parseAction(raw) {
      const parsed = actionSchema.safeParse(raw);
      if (!parsed.success) throw new GameInputError('Action must be { type: "advance" } or { type: "cashout" }');
      return parsed.data;
    },

    act(state, action, config) {
      if (state.busted || state.position >= config.stages) throw new GameInputError("Round is over");
      if (action.type === "cashout") {
        if (state.position === 0) throw new GameInputError("Clear at least one stage before cashing out");
        return { state, outcome: "cashout" };
      }
      if (!state.path[state.position]) return { state: { ...state, busted: true }, outcome: "bust" };
      const position = state.position + 1;
      return { state: { ...state, position }, outcome: position === config.stages ? "complete" : "continue" };
    },

    multiplier: (s, c) => (s.busted ? 0n : ladderMultiplier(c, s.position)),
    nextMultiplier: (s, c) => (s.busted || s.position >= c.stages ? null : ladderMultiplier(c, s.position + 1)),

    steps(config): StepOdds[] {
      return Array.from({ length: config.stages }, (_, i) => ({
        step: i + 1,
        probability: (config.passPercent / 100) ** (i + 1),
        multiplier: ladderMultiplier(config, i + 1),
      }));
    },

    view(state, config, _params, final) {
      return {
        stages: config.stages,
        stageNames: config.stageNames,
        passPercent: config.passPercent,
        position: state.position,
        busted: state.busted,
        currentMultiplier: state.busted ? 0 : Number(ladderMultiplier(config, state.position)) / 10_000,
        nextMultiplier:
          state.busted || state.position >= config.stages
            ? null
            : Number(ladderMultiplier(config, state.position + 1)) / 10_000,
        // Only stages already played are shown; the full path is revealed when the round ends.
        path: final ? state.path : state.path.slice(0, state.position),
      };
    },
  };
}

export const freefall = makeLadder("freefall");
export const flapFortune = makeLadder("flap_fortune");

export const FREEFALL_DEFAULT_CONFIG: LadderConfig = {
  stages: 6,
  passPercent: 70,
  rtpBps: 9600,
  stageNames: ["Clouds", "Storm", "Jet stream", "Skyline", "Rooftops", "Landing"],
};

export const FLAP_FORTUNE_DEFAULT_CONFIG: LadderConfig = {
  stages: 5,
  passPercent: 80,
  rtpBps: 9600,
  stageNames: ["Pipe 1", "Pipe 2", "Pipe 3", "Pipe 4", "Pipe 5"],
};
