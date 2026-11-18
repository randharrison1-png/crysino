import { z } from "zod";
import type { FairRng } from "../fairness.js";
import { GameInputError, exactRtp, type InstantGame, type OutcomeOdds } from "./types.js";

/**
 * 03 · THE LAST DOOR — 100 doors, each round the room behind every door is a fresh fair shuffle
 * of the configured room counts (dossier: 70 empty, 20 safe, 9 gold, 1 secret). The player picks a
 * door in the same request — there is no separate "open" step to infer anything from — and the
 * response includes the whole layout so the shuffle can be checked.
 */
const roomSchema = z.object({
  id: z.string().min(1).max(32),
  label: z.string().min(1).max(64),
  count: z.number().int().min(1),
  multiplier: z.number().int().min(0), // scaled by 10,000
});

export const lastDoorConfigSchema = z
  .object({ rooms: z.array(roomSchema).min(2).max(10) })
  .refine((c) => new Set(c.rooms.map((r) => r.id)).size === c.rooms.length, "Room ids must be unique")
  .refine((c) => {
    const n = c.rooms.reduce((s, r) => s + r.count, 0);
    return n >= 2 && n <= 1000;
  }, "Total doors must be 2–1000");
export type LastDoorConfig = z.infer<typeof lastDoorConfigSchema>;

export interface LastDoorParams {
  door: number; // 1-based
}

export interface LastDoorResult {
  door: number;
  room: string;
  label: string;
  /** layout[i] = room id behind door i+1, for verification and the reveal animation. */
  layout: string[];
}

export const doorCount = (c: LastDoorConfig) => c.rooms.reduce((s, r) => s + r.count, 0);

export const lastDoor: InstantGame<LastDoorConfig, LastDoorParams, LastDoorResult> = {
  code: "last_door",

  parseConfig(raw) {
    const config = lastDoorConfigSchema.parse(raw);
    const rtp = exactRtp(this.odds(config, { door: 1 }));
    if (rtp < 0.9 || rtp > 0.99) throw new GameInputError(`Room payouts give RTP ${(rtp * 100).toFixed(4)}%, outside 90–99%`);
    return config;
  },

  parseParams(raw, config) {
    const parsed = z.object({ door: z.number().int() }).safeParse(raw);
    const n = doorCount(config);
    if (!parsed.success || parsed.data.door < 1 || parsed.data.door > n) {
      throw new GameInputError(`Pick a door from 1 to ${n}`);
    }
    return parsed.data;
  },

  odds(config): OutcomeOdds[] {
    const outOf = BigInt(doorCount(config));
    return config.rooms.map((r) => ({ label: r.label, weight: BigInt(r.count), outOf, multiplier: BigInt(r.multiplier) }));
  },

  resolve(rng: FairRng, config, params) {
    const slots = config.rooms.flatMap((r) => Array<string>(r.count).fill(r.id));
    const layout = rng.shuffle(slots);
    const roomId = layout[params.door - 1]!;
    const room = config.rooms.find((r) => r.id === roomId)!;
    return {
      multiplier: BigInt(room.multiplier),
      result: { door: params.door, room: room.id, label: room.label, layout },
    };
  },
};

export const LAST_DOOR_DEFAULT_CONFIG: LastDoorConfig = {
  rooms: [
    { id: "empty", label: "Empty room", count: 70, multiplier: 0 },
    { id: "safe", label: "Safe room", count: 20, multiplier: 15_000 },
    { id: "gold", label: "Gold room", count: 9, multiplier: 40_000 },
    { id: "secret", label: "Secret chamber", count: 1, multiplier: 300_000 },
  ],
};
