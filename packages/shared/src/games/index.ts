import { dice } from "./dice.js";
import { doomsday } from "./doomsday.js";
import { gemGrid } from "./gem-grid.js";
import { flapFortune, freefall } from "./ladder.js";
import { lastDoor } from "./last-door.js";
import type { StatefulGame } from "./stateful.js";
import type { InstantGame } from "./types.js";

export * from "./types.js";
export * from "./stateful.js";
export * from "./dice.js";
export * from "./doomsday.js";
export * from "./last-door.js";
export * from "./ladder.js";
export * from "./gem-grid.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Single-request games. */
export const instantGames: Record<string, InstantGame<any, any, any>> = {
  [dice.code]: dice,
  [doomsday.code]: doomsday,
  [lastDoor.code]: lastDoor,
};

/** Multi-step games with an open round and cash-out. Neon 21 joins in Step 9. */
export const statefulGames: Record<string, StatefulGame<any, any, any, any>> = {
  [freefall.code]: freefall,
  [flapFortune.code]: flapFortune,
  [gemGrid.code]: gemGrid,
};
