import { describe, expect, it } from "vitest";
import { applyMultiplier, formatUnits, parseUnits } from "./money.js";

describe("money", () => {
  it("parses and formats round trip", () => {
    expect(parseUnits("1.5", 8)).toBe(150_000_000n);
    expect(formatUnits(150_000_000n, 8)).toBe("1.5");
    expect(formatUnits(1n, 18)).toBe("0.000000000000000001");
    expect(formatUnits(0n, 6)).toBe("0");
  });

  it("rejects bad input", () => {
    expect(() => parseUnits("1.123", 2)).toThrow();
    expect(() => parseUnits("-1", 8)).toThrow();
    expect(() => parseUnits("abc", 8)).toThrow();
  });

  it("rounds payouts down", () => {
    // 1.37143x on a 3-unit stake = 4.11429 -> 4
    expect(applyMultiplier(3n, 13714n)).toBe(4n);
    expect(applyMultiplier(100_000_000n, 20_000n)).toBe(200_000_000n);
  });
});
