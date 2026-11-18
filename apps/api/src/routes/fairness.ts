import type { FastifyInstance } from "fastify";
import { z } from "zod";

const rotateBody = z.object({ clientSeed: z.string().optional() }).default({});

export async function fairnessRoutes(app: FastifyInstance) {
  const { fairness } = app.deps;
  const auth = { preHandler: app.requireUser };

  /** Current commitment, client seed and nonce — the Fairness tab. */
  app.get("/fairness", auth, async (req) => ({ fairness: await fairness.getState(req.user!.userId) }));

  /** Reveal the current server seed and switch to the pre-committed next one. */
  app.post("/fairness/rotate", auth, async (req) => {
    const { clientSeed } = rotateBody.parse(req.body ?? {});
    const { revealed, state } = await fairness.rotate(req.user!.userId, clientSeed);
    return { revealed, fairness: state };
  });
}
