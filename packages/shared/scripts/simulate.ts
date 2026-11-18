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
  FairRng,
  dice,
  doomsday,
  exactRtp,
  type InstantGame,
} from "../src/index.js";

const ROUNDS = Number(process.argv[2] ?? 2_000_000);
const Z = 3.29; // 99.9% two-sided

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function simulate(name: string, game: InstantGame<any, any, any>, rawConfig: unknown, rawParams: unknown) {
  const config = game.parseConfig(rawConfig);
  const params = game.parseParams(rawParams, config);
  const theoretical = exactRtp(game.odds(config, params));
  const serverSeed = randomBytes(32).toString("hex");

  let sum = 0;
  let sumSq = 0;
  let wins = 0;
  let best = 0;
  const started = Date.now();
  for (let nonce = 0; nonce < ROUNDS; nonce++) {
    const m = Number(game.resolve(new FairRng(serverSeed, "simulation", nonce), config, params).multiplier) / 10_000;
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
];
if (results.includes(false)) process.exitCode = 1;
