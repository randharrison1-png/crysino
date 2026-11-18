import type { FairRng } from "../fairness.js";

/**
 * A multi-step game (Freefall, Flap Fortune, Gem Grid).
 *
 * The WHOLE outcome is fixed by the fair RNG when the round starts (start()), stored hidden on
 * the server, and revealed one player action at a time. Because nothing random happens after
 * start(), the round can be verified later by replaying the recorded actions — and the player's
 * choices of when to stop can't change the odds of any step.
 *
 *   C = config   P = player's choices at start   S = hidden state   A = an action
 */
export type StepOutcome = "continue" | "bust" | "cashout" | "complete";

export interface StepOdds {
  step: number;
  /** Chance of reaching this step from the start. */
  probability: number;
  /** Cash-out multiplier at this step, scaled by 10,000. */
  multiplier: bigint;
}

export interface StatefulGame<C, P, S, A> {
  code: string;
  parseConfig(raw: unknown): C;
  parseParams(raw: unknown, config: C): P;
  /** Fixes the full outcome. Uses only rng.int()/rng.shuffle(). */
  start(rng: FairRng, config: C, params: P): S;
  parseAction(raw: unknown): A;
  /** Pure: applies one action. Throws GameInputError for an illegal action. */
  act(state: S, action: A, config: C, params: P): { state: S; outcome: StepOutcome };
  /** What cashing out right now would pay (0 if nothing to cash out yet, or bust). */
  multiplier(state: S, config: C, params: P): bigint;
  /** What the next successful step would pay, or null if there is no next step. */
  nextMultiplier(state: S, config: C, params: P): bigint | null;
  /** Odds/payout of every step — the game's Odds tab. */
  steps(config: C, params: P): StepOdds[];
  /** What the player sees. `final` = round is over: reveal everything. */
  view(state: S, config: C, params: P, final: boolean): Record<string, unknown>;
}

/** Exact RTP for "always cash out at step n", from a step table. */
export function rtpAtStep(step: StepOdds): number {
  return (step.probability * Number(step.multiplier)) / 10_000;
}
