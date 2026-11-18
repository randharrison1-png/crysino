import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { EventBus } from "./events/bus.js";
import { FairnessService } from "./fairness/service.js";
import { countOpenRounds, GameEngine } from "./games/engine.js";
import { loadKey } from "./lib/secretbox.js";

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const fairness = new FairnessService(db, loadKey("FAIRNESS_KEY", config.FAIRNESS_KEY), countOpenRounds);
const engine = new GameEngine(db, fairness);
const bus = new EventBus();

const app = await buildApp({
  db,
  config,
  fairness,
  engine,
  bus,
  appKey: loadKey("APP_ENCRYPTION_KEY", config.APP_ENCRYPTION_KEY),
});

await app.listen({ port: config.PORT, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await db.end();
    process.exit(0);
  });
}
