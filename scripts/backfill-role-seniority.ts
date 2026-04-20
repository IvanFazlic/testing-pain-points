/**
 * One-off: populate contacts.role_seniority from contacts.title using the shared
 * roleBucket() classifier. Idempotent — re-runs safely because it overwrites with
 * the classifier's latest output.
 *
 * After this runs, the /api/insights/:msId/contact-stats endpoint can GROUP BY
 * role_seniority directly instead of repeating the classification in SQL, and the
 * contacts query can filter on the indexed column.
 */
import { Command } from "commander";
import { pool, shutdown } from "../src/db/connection.js";
import { roleBucket } from "../src/lib/role-bucket.js";

async function run(opts: { microsegment?: string }) {
  const client = await pool.connect();
  try {
    const sql = opts.microsegment
      ? `SELECT id, title FROM contacts WHERE microsegment_id = $1`
      : `SELECT id, title FROM contacts`;
    const params = opts.microsegment ? [opts.microsegment] : [];
    const { rows } = await client.query<{ id: number; title: string | null }>(
      sql,
      params,
    );
    console.log(`Backfilling role_seniority for ${rows.length} contacts…`);

    await client.query("BEGIN");
    let updated = 0;
    for (const r of rows) {
      const bucket = roleBucket(r.title);
      await client.query(
        `UPDATE contacts SET role_seniority = $2 WHERE id = $1`,
        [r.id, bucket],
      );
      updated++;
      if (updated % 500 === 0) console.log(`  ${updated}/${rows.length}`);
    }
    await client.query("COMMIT");

    const dist = await client.query(
      `SELECT role_seniority, COUNT(*)::int AS n
         FROM contacts
        ${opts.microsegment ? "WHERE microsegment_id = $1" : ""}
        GROUP BY role_seniority ORDER BY n DESC`,
      params,
    );
    console.log(`\nBackfill complete: ${updated} rows`);
    console.log("Distribution:");
    for (const d of dist.rows) {
      console.log(`  ${(d.role_seniority ?? "null").padEnd(18)} ${d.n}`);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  await shutdown();
}

const program = new Command()
  .name("backfill-role-seniority")
  .description("Populate contacts.role_seniority from contacts.title via shared roleBucket()")
  .option("--microsegment <id>", "Limit to one microsegment")
  .action(run);

program.parse();
