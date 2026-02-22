/**
 * @iisl/api — Migration Runner
 * VALIDATION: [COMPILE-PENDING]
 *
 * Run with: npm run migrate (from apps/api directory)
 * Or: node -r ts-node/register src/db/migrate.ts
 */
import * as fs from "fs";
import * as path from "path";
import { pool } from "./pool";

const MIGRATIONS_DIR = path.join(__dirname, "../../../../db/migrations");

async function runMigrations(): Promise<void> {
  const client = await pool.connect();

  try {
    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Get already-applied migrations
    const result = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY filename"
    );
    const applied = new Set(result.rows.map((r) => r.filename));

    // Read and sort migration files
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let ranCount = 0;

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  [skip] ${file} (already applied)`);
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      console.log(`  [run]  ${file}`);

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file]
        );
        await client.query("COMMIT");
        ranCount++;
        console.log(`  [ok]   ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`  [fail] ${file}:`, err);
        throw err;
      }
    }

    if (ranCount === 0) {
      console.log("All migrations already applied.");
    } else {
      console.log(`\nApplied ${ranCount} migration(s).`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
