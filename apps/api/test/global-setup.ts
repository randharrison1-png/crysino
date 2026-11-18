import pg from "pg";
import { migrate } from "../src/db/migrate.js";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://crysino:crysino@localhost:5432/crysino_test";

/** Wipes the test database and applies all migrations once before the test run. */
export default async function setup(): Promise<void> {
  process.env.TEST_DATABASE_URL = TEST_DATABASE_URL;
  const db = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  try {
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(db);
  } finally {
    await db.end();
  }
}
