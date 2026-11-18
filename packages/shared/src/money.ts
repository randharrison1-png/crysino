/**
 * Money is always an integer count of an asset's smallest unit (satoshi, wei, lamport...).
 * Never use JS numbers for amounts: wei values overflow them. Use bigint everywhere.
 */

/** "1.5" with 8 decimals -> 150000000n. Rejects more decimals than the asset supports. */
export function parseUnits(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid amount: "${value}"`);
  }
  const [whole, frac = ""] = trimmed.split(".") as [string, string?];
  if (frac.length > decimals) {
    throw new Error(`Amount "${value}" has more than ${decimals} decimal places`);
  }
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

/** 150000000n with 8 decimals -> "1.5". */
export function formatUnits(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/**
 * Multiply an amount by a multiplier expressed in basis points of 1/10_000
 * (e.g. 1.37143x -> 13714n), rounding DOWN so the house never overpays by a fraction.
 */
export const MULTIPLIER_SCALE = 10_000n;

export function applyMultiplier(stake: bigint, multiplierScaled: bigint): bigint {
  return (stake * multiplierScaled) / MULTIPLIER_SCALE;
}
