import { promises as fs } from "node:fs";
import path from "node:path";
import { closePool, getPool } from "./pool";

async function migrate(): Promise<void> {
  const client = await getPool().connect();
  const migrationsDirectory = path.resolve(process.cwd(), "migrations");

  try {
    await client.query("SELECT pg_advisory_lock(hashtext('geest_schema_migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const files = (await fs.readdir(migrationsDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const filename of files) {
      const alreadyApplied = await client.query(
        "SELECT 1 FROM schema_migrations WHERE filename = $1",
        [filename]
      );

      if (alreadyApplied.rowCount) {
        continue;
      }

      const sql = await fs.readFile(path.join(migrationsDirectory, filename), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
        await client.query("COMMIT");
        console.info(`Applied migration: ${filename}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('geest_schema_migrations'))");
    client.release();
    await closePool();
  }
}

migrate().catch((error: unknown) => {
  console.error("Migration failed", error);
  process.exitCode = 1;
});
