import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FairRng, hashServerSeed, isValidClientSeed } from "./fairness.js";

const SERVER = "a3f1c9d2e8b7465f9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b";

/** Chi-square statistic for observed counts against a uniform expectation. */
function chiSquare(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  const expected = total / counts.length;
  return counts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
}

describe("fairness", () => {
  it("commitment is plain SHA-256 of the seed (checkable with any tool)", () => {
    expect(hashServerSeed(SERVER)).toBe(createHash("sha256").update(SERVER).digest("hex"));
  });

  it("stream matches an independent HMAC-SHA256 implementation", () => {
    const rng = new FairRng(SERVER, "lucky", 7);
    const expected: number[] = [];
    for (const cursor of [0, 1]) {
      const block = createHmac("sha256", SERVER).update(`lucky:7:${cursor}`).digest();
      for (let i = 0; i < 32; i += 4) expected.push(block.readUInt32BE(i));
    }
    const actual = Array.from({ length: 16 }, () => rng.nextUint32());
    expect(actual).toEqual(expected);
  });

  it("is deterministic for the same inputs and different for any change", () => {
    const draw = (s: string, c: string, n: number) => {
      const r = new FairRng(s, c, n);
      return [r.int(1000), r.int(1000), r.int(1000)];
    };
    expect(draw(SERVER, "x", 1)).toEqual(draw(SERVER, "x", 1));
    expect(draw(SERVER, "x", 1)).not.toEqual(draw(SERVER, "x", 2));
    expect(draw(SERVER, "x", 1)).not.toEqual(draw(SERVER, "y", 1));
  });

  it("int(100) is uniform (chi-square, 200k draws)", () => {
    const rng = new FairRng(SERVER, "dist", 0);
    const counts = new Array(100).fill(0);
    for (let i = 0; i < 200_000; i++) counts[rng.int(100)]++;
    // 99 degrees of freedom: 148.2 is the p = 0.001 critical value
    expect(chiSquare(counts)).toBeLessThan(148.2);
  });

  it("int() rejects biased values instead of using them", () => {
    // n = 3·2^30: a quarter of raw values fall above the limit and must be redrawn.
    const n = 3 * 2 ** 30;
    const rng = new FairRng(SERVER, "reject", 0);
    for (let i = 0; i < 1000; i++) {
      const v = rng.int(n);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(n);
    }
    expect(rng.draws).toBeGreaterThan(1000); // some draws were rejected
  });

  it("shuffle is a permutation and every ordering is equally likely", () => {
    const seen = new Map<string, number>();
    for (let nonce = 0; nonce < 60_000; nonce++) {
      const key = new FairRng(SERVER, "shuffle", nonce).shuffle([0, 1, 2]).join("");
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    expect(seen.size).toBe(6);
    // 5 degrees of freedom: 20.5 is the p = 0.001 critical value
    expect(chiSquare([...seen.values()])).toBeLessThan(20.5);

    const deck = Array.from({ length: 312 }, (_, i) => i);
    const shuffled = new FairRng(SERVER, "deck", 1).shuffle(deck);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(deck);
    expect(shuffled).not.toEqual(deck);
  });

  it("floats stay in [0, 1)", () => {
    const rng = new FairRng(SERVER, "float", 0);
    for (let i = 0; i < 10_000; i++) {
      const f = rng.float();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });

  it("validates client seeds", () => {
    expect(isValidClientSeed("my seed 123")).toBe(true);
    expect(isValidClientSeed("")).toBe(false);
    expect(isValidClientSeed("has:colon")).toBe(false);
    expect(isValidClientSeed("x".repeat(65))).toBe(false);
    expect(isValidClientSeed("émoji")).toBe(false);
    expect(() => new FairRng(SERVER, "bad:seed", 0)).toThrow();
    expect(() => new FairRng(SERVER, "ok", -1)).toThrow();
  });
});
