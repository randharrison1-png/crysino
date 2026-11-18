import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";

/**
 * Live feed over one WebSocket (/ws).
 *   Everyone:        live_bet (anonymised), big_win (≥ 10x)
 *   Signed-in only:  round (their own full round), balance (their new balance)
 * Server → client only; anything the client sends is ignored except "ping".
 */
const BIG_WIN_MULTIPLIER = 100_000n; // 10x, scaled

/** Stable, non-reversible public label — never the email or user id. */
const publicLabel = (userId: string) => `Player ${createHash("sha256").update(`label:${userId}`).digest("hex").slice(0, 6)}`;

const send = (socket: WebSocket, msg: unknown) => {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  }
};

export async function wsRoutes(app: FastifyInstance) {
  const { bus, config } = app.deps;
  const sockets = new Set<{ socket: WebSocket; userId: string | null }>();

  bus.on("round_settled", ({ userId, round, balance }) => {
    const pub = {
      game: round.game,
      asset: round.asset,
      stake: round.stake,
      multiplier: round.multiplier,
      payout: round.payout,
      player: publicLabel(userId),
      at: round.createdAt,
    };
    const big = round.multiplier !== null && round.multiplier >= BIG_WIN_MULTIPLIER;
    for (const client of sockets) {
      send(client.socket, { type: "live_bet", bet: pub });
      if (big) send(client.socket, { type: "big_win", bet: pub });
      if (client.userId === userId) {
        send(client.socket, { type: "round", round });
        send(client.socket, { type: "balance", asset: round.asset, balance });
      }
    }
  });

  app.get("/ws", { websocket: true }, (socket, req) => {
    // Browsers always send Origin on WebSocket upgrades; refuse other sites (cross-site hijacking).
    if (!req.headers.origin || !config.webOrigins.includes(req.headers.origin)) {
      socket.close(1008, "origin not allowed");
      return;
    }
    const client = { socket, userId: req.user?.userId ?? null };
    sockets.add(client);
    send(socket, { type: "hello", signedIn: client.userId !== null });

    socket.on("message", (data) => {
      if (data.toString() === "ping") send(socket, { type: "pong" });
    });
    socket.on("close", () => sockets.delete(client));
  });
}
