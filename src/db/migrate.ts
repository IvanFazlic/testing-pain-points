import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool, shutdown } from "./connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate() {
  console.log("Running migration against Railway PostgreSQL...");

  const schemaPath = join(__dirname, "schema.sql");
  const sql = readFileSync(schemaPath, "utf-8");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("Migration complete — all tables created.");

    // Verify tables
    const result = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    console.log(
      "Tables:",
      result.rows.map((r) => r.table_name),
    );
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    throw err;
  } finally {
    client.release();
  }

  await shutdown();
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
