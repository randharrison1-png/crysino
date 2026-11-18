/**
 * Provably fair randomness (design spec §4).
 *
 * This file runs unchanged on the server and in the player's browser, so anyone can
 * re-compute any round from (serverSeed, clientSeed, nonce). Do not import Node-only APIs here.
 *
 * Byte stream:   HMAC-SHA256(key = serverSeed, msg = `${clientSeed}:${nonce}:${cursor}`)
 *                cursor = 0, 1, 2… each block gives 32 bytes = 8 big-endian uint32 values.
 * Integers:      int(n) uses rejection sampling, so every outcome has EXACTLY 1/n probability
 *                (no modulo bias). This is what makes the paytable odds exact.
 * Floats:        float() = uint32 / 2^32, in [0, 1). For display/animation only, never for outcomes.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

const TWO_POW_32 = 2 ** 32;

export const CLIENT_SEED_MAX_LENGTH = 64;

/** The public commitment shown to the player before they bet. */
export function hashServerSeed(serverSeed: string): string {
  return bytesToHex(sha256(utf8ToBytes(serverSeed)));
}

/** Client seeds: 1–64 printable ASCII characters, no colon (it separates the HMAC message). */
export function isValidClientSeed(seed: string): boolean {
  return /^[\x20-\x39\x3b-\x7e]{1,64}$/.test(seed);
}

export class FairRng {
  private cursor = 0;
  private block: Uint8Array = new Uint8Array(0);
  private offset = 32; // forces the first block to be generated
  /** How many uint32 values have been drawn — recorded so a round can be audited. */
  draws = 0;

  constructor(
    readonly serverSeed: string,
    readonly clientSeed: string,
    readonly nonce: number,
  ) {
    if (!isValidClientSeed(clientSeed)) throw new Error("Invalid client seed");
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("Invalid nonce");
  }

  /** Next raw 32-bit value from the stream. */
  nextUint32(): number {
    if (this.offset >= 32) {
      const msg = utf8ToBytes(`${this.clientSeed}:${this.nonce}:${this.cursor}`);
      this.block = hmac(sha256, utf8ToBytes(this.serverSeed), msg);
      this.cursor++;
      this.offset = 0;
    }
    const b = this.block;
    const o = this.offset;
    this.offset += 4;
    this.draws++;
    return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
  }

  /** Uniform integer in [0, n) with exact probability 1/n each. */
  int(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > TWO_POW_32) throw new Error(`int(n): bad n ${n}`);
    const limit = TWO_POW_32 - (TWO_POW_32 % n); // largest multiple of n ≤ 2^32
    for (;;) {
      const u = this.nextUint32();
      if (u < limit) return u % n;
    }
  }

  /** Float in [0, 1). Animation/visual use only — outcomes must use int(). */
  float(): number {
    return this.nextUint32() / TWO_POW_32;
  }

  /** Fisher–Yates shuffle, returns a new array. Every permutation equally likely. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}
