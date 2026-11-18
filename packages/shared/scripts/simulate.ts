/**
 * RTP simulation: plays millions of rounds through the real game code and fair RNG.
 *
 *   pnpm --filter @crysino/shared simulate            (default 2,000,000 rounds per scenario)
 *   pnpm --filter @crysino/shared simulate 10000000
 *
 * Reports simulated RTP with a 99.9% confidence interval and checks the exact RTP falls inside it.
 */
import { randomBytes } from "node:crypto";
import {
  DICE_DEFAULT_CONFIG,
  DOOMSDAY_DEFAULT_CONFIG,
  FLAP_FORTUNE_DEFAULT_CONFIG,
  FREEFALL_DEFAULT_CONFIG,
  FairRng,
  GEM_GRID_DEFAULT_CONFIG,
  LAST_DOOR_DEFAULT_CONFIG,
  dice,
  doomsday,
  exactRtp,
  flapFortune,
  freefall,
  gemGrid,
  lastDoor,
  rtpAtStep,
  type InstantGame,
  type StatefulGame,
} from "../src/index.js";

const ROUNDS = Number(process.argv[2] ?? 2_000_000);
const Z = 3.29; // 99.9% two-sided

/* eslint-disable @typescript-eslint/no-explicit-any */
function simulate(name: string, game: InstantGame<any, any, any>, rawConfig: unknown, rawParams: unknown) {
  const config = game.parseConfig(rawConfig);
  const params = game.parseParams(rawParams, config);
  return run(name, exactRtp(game.odds(config, params)), (rng) =>
    Number(game.resolve(rng, config, params).multiplier) / 10_000,
  );
}

/** Plays a multi-step game with the strategy "cash out after `target` successful steps". */
function simulateStrategy(
  name: string,
  game: StatefulGame<any, any, any, any>,
  rawConfig: unknown,
  rawParams: unknown,
  target: number,
  nextAction: (state: any, step: number) => unknown,
) {
  const config = game.parseConfig(rawConfig);
  const params = game.parseParams(rawParams, config);
  const theoretical = rtpAtStep(game.steps(config, params)[target - 1]!);
  return run(name, theoretical, (rng) => {
    let state = game.start(rng, config, params);
    for (let step = 0; step < target; step++) {
      const r = game.act(state, nextAction(state, step), config, params);
      state = r.state;
      if (r.outcome === "bust") return 0;
      if (r.outcome === "complete") break;
    }
    return Number(game.multiplier(state, config, params)) / 10_000;
  });
}

function run(name: string, theoretical: number, playOne: (rng: FairRng) => number) {
  const serverSeed = randomBytes(32).toString("hex");

  let sum = 0;
  let sumSq = 0;
  let wins = 0;
  let best = 0;
  const started = Date.now();
  for (let nonce = 0; nonce < ROUNDS; nonce++) {
    const m = playOne(new FairRng(serverSeed, "simulation", nonce));
    sum += m;
    sumSq += m * m;
    if (m > 0) wins++;
    if (m > best) best = m;
  }
  const mean = sum / ROUNDS;
  const sd = Math.sqrt(sumSq / ROUNDS - mean * mean);
  const half = (Z * sd) / Math.sqrt(ROUNDS);
  const inside = theoretical >= mean - half && theoretical <= mean + half;

  console.log(
    [
      name.padEnd(26),
      `exact ${(theoretical * 100).toFixed(4)}%`,
      `simulated ${(mean * 100).toFixed(3)}% ± ${(half * 100).toFixed(3)}`,
      `hit ${((wins / ROUNDS) * 100).toFixed(2)}%`,
      `best ${best}x`,
      `${((Date.now() - started) / 1000).toFixed(1)}s`,
      inside ? "OK" : "OUTSIDE INTERVAL",
    ].join("  |  "),
  );
  return inside;
}

console.log(`Simulating ${ROUNDS.toLocaleString()} rounds per scenario\n`);
const results = [
  simulate("Doomsday", doomsday, DOOMSDAY_DEFAULT_CONFIG, {}),
  simulate("Dice 100 · under 50 (50%)", dice, DICE_DEFAULT_CONFIG, { direction: "under", target: 50 }),
  simulate("Dice 100 · over 89 (10%)", dice, DICE_DEFAULT_CONFIG, { direction: "over", target: 89 }),
  simulate("Dice 100 · under 1 (1%)", dice, DICE_DEFAULT_CONFIG, { direction: "under", target: 1 }),
  simulate("The Last Door · door 37", lastDoor, LAST_DOOR_DEFAULT_CONFIG, { door: 37 }),
  simulateStrategy("Freefall · cash at stage 3", freefall, FREEFALL_DEFAULT_CONFIG, {}, 3, () => ({ type: "advance" })),
  simulateStrategy("Freefall · ride to landing", freefall, FREEFALL_DEFAULT_CONFIG, {}, 6, () => ({ type: "advance" })),
  simulateStrategy("Flap Fortune · all 5 pipes", flapFortune, FLAP_FORTUNE_DEFAULT_CONFIG, {}, 5, () => ({ type: "advance" })),
  simulateStrategy("Gem Grid · 3 mines, 5 gems", gemGrid, GEM_GRID_DEFAULT_CONFIG, { mines: 3 }, 5, (_s, step) => ({
    type: "reveal",
    tile: step, // always the same tiles: the mines are randomly placed, so any choice is equally good
  })),
  simulateStrategy("Gem Grid · 10 mines, 4 gems", gemGrid, GEM_GRID_DEFAULT_CONFIG, { mines: 10 }, 4, (_s, step) => ({
    type: "reveal",
    tile: 24 - step,
  })),
];
if (results.includes(false)) process.exitCode = 1;
