import { randomUUID } from "node:crypto";
import { createPool, type Db } from "../src/db/pool.js";

export function testDb(): Db {
  return createPool(process.env.TEST_DATABASE_URL);
}

/** Creates a fresh player so tests never share balances. */
export async function createUser(db: Db): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [`${randomUUID()}@test.local`],
  );
  return rows[0]!.id;
}
