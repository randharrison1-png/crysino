import { dice } from "./dice.js";
import { doomsday } from "./doomsday.js";
import type { InstantGame } from "./types.js";

export * from "./types.js";
export * from "./dice.js";
export * from "./doomsday.js";

/** Registry of single-request games. Stateful games (Freefall, Gem Grid…) get their own registry. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const instantGames: Record<string, InstantGame<any, any, any>> = {
  [dice.code]: dice,
  [doomsday.code]: doomsday,
};
