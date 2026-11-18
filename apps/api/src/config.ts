import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1),
  FAIRNESS_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "64 hex chars"),
  APP_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "64 hex chars"),
  /** Comma-separated origins allowed to call the API with cookies, e.g. https://crysino.com */
  WEB_ORIGINS: z.string().default("http://localhost:3000"),
  /** Set true only behind Cloudflare, which strips and re-sets these headers. */
  TRUST_CF_GEO_HEADERS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Development only: pretend every visitor is in this country (e.g. MT). Ignored in production. */
  DEV_COUNTRY: z.string().length(2).optional(),
  COOKIE_DOMAIN: z.string().optional(),
  TERMS_VERSION: z.string().default("2026-11-01"),
  /** Per-IP / per-user rate limits. Only ever turned off in automated tests. */
  RATE_LIMIT: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

export type Config = z.infer<typeof schema> & { webOrigins: string[]; secureCookies: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  if (parsed.NODE_ENV === "production" && parsed.DEV_COUNTRY) {
    throw new Error("DEV_COUNTRY must not be set in production");
  }
  if (parsed.NODE_ENV === "production" && !parsed.RATE_LIMIT) {
    throw new Error("RATE_LIMIT cannot be disabled in production");
  }
  return {
    ...parsed,
    webOrigins: parsed.WEB_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
    secureCookies: parsed.NODE_ENV === "production",
  };
}
