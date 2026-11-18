import pg from "pg";

// Return NUMERIC (oid 1700) and BIGINT (oid 20) as strings; the ledger converts them to bigint.
pg.types.setTypeParser(1700, (v) => v);
pg.types.setTypeParser(20, (v) => v);

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;

export function createPool(connectionString = process.env.DATABASE_URL): Db {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new pg.Pool({ connectionString, max: 20 });
}

/**
 * Run `fn` inside a transaction. Rolls back on any error.
 * Serialization failures / deadlocks are retried a few times, which is the correct
 * response under concurrency, not an error the caller should see.
 */
export async function withTransaction<T>(
  db: Db,
  fn: (client: DbClient) => Promise<T>,
  retries = 3,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      const code = (err as { code?: string }).code;
      const retryable = code === "40001" || code === "40P01";
      if (!retryable || attempt >= retries) throw err;
    } finally {
      client.release();
    }
  }
}
