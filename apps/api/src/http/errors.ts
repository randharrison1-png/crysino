import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { FairnessError } from "../fairness/service.js";
import { BetError, type BetErrorCode } from "../games/engine.js";

/** Every error response looks like: { error: { code, message, details? } } */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const BET_STATUS: Record<BetErrorCode, number> = {
  betting_paused: 503,
  account_inactive: 403,
  game_unavailable: 409,
  asset_not_allowed: 422,
  stake_too_low: 422,
  stake_too_high: 422,
  payout_cap: 422,
  invalid_params: 422,
  insufficient_funds: 422,
  idempotency_conflict: 409,
  round_already_open: 409,
  round_not_found: 404,
  round_closed: 409,
  stale_step: 409,
};

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof ApiError) {
    return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof BetError) {
    return reply
      .status(BET_STATUS[err.code])
      .send({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof FairnessError) {
    return reply.status(409).send({ error: { code: "fairness_conflict", message: err.message } });
  }
  if (err instanceof ZodError) {
    return reply.status(400).send({
      error: {
        code: "invalid_request",
        message: "Some fields are missing or invalid",
        details: { fields: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      },
    });
  }
  const status = (err as FastifyError).statusCode;
  if (status === 429) {
    return reply.status(429).send({ error: { code: "rate_limited", message: "Too many requests, slow down" } });
  }
  if (status && status >= 400 && status < 500) {
    return reply.status(status).send({ error: { code: "bad_request", message: err.message } });
  }
  req.log.error({ err }, "unhandled error");
  return reply.status(500).send({ error: { code: "internal", message: "Something went wrong" } });
}
