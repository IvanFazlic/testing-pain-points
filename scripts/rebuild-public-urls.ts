/**
 * Rebuild public LinkedIn URLs from Sales Nav lead URLs — no API needed.
 *
 * The Sales Nav URL embeds the LinkedIn member URN as the first comma-separated
 * segment after `/lead/`. LinkedIn accepts URN-based `/in/<URN>` URLs and 301s
 * to the vanity slug. LinkedIn Matched Audiences canonicalizes URLs server-side
 * via the URN, so the URN-form URL matches the same as the vanity form.
 *
 *   https://www.linkedin.com/sales/lead/ACwAAARld..._RM,NAME_SEARCH,kF-Q
 *                                       ^^^^^^^^^^^^^^^
 *                                       URN — extract this, paste under /in/
 *
 * Idempotent: skips contacts that already have public_linkedin_url set.
 */
import { Command } from "commander";
import { pool, shutdown } from "../src/db/connection.js";

const URN_FROM_SALESNAV = /\/sales\/lead\/([^,?\s/#]+)/;

export function rebuildPublicUrl(salesnavUrl: string | null | undefined): string | null {
  if (!salesnavUrl) return null;
  const m = salesnavUrl.match(URN_FROM_SALESNAV);
  if (!m || !m[1]) return null;
  // URN segment is base64-y but URL-safe; pass through unchanged.
  return `https://www.linkedin.com/in/${m[1]}`;
}

async function run(opts: { microsegment?: string; force: boolean; dryRun: boolean }) {
  const client = await pool.connect();
  try {
    const where = opts.microsegment
      ? "microsegment_id = $1 AND salesnav_lead_url IS NOT NULL"
      : "salesnav_lead_url IS NOT NULL";
    const sql = opts.force
      ? `SELECT id, salesnav_lead_url FROM contacts WHERE ${where}`
      : `SELECT id, salesnav_lead_url FROM contacts WHERE ${where} AND public_linkedin_url IS NULL`;
    const params = opts.microsegment ? [opts.microsegment] : [];

    const { rows } = await client.query<{ id: number; salesnav_lead_url: string }>(
      sql,
      params,
    );
    console.log(`Candidates: ${rows.length}`);

    let resolved = 0;
    let skipped = 0;
    let written = 0;

    if (!opts.dryRun) await client.query("BEGIN");

    for (const r of rows) {
      const url = rebuildPublicUrl(r.salesnav_lead_url);
      if (!url) {
        skipped++;
        continue;
      }
      resolved++;
      if (opts.dryRun) {
        if (resolved <= 3) {
          console.log(`  ${r.id}\n    in:  ${r.salesnav_lead_url}\n    out: ${url}`);
        }
        continue;
      }
      await client.query(
        `UPDATE contacts
            SET public_linkedin_url = $2,
                public_url_resolved_at = NOW()
          WHERE id = $1`,
        [r.id, url],
      );
      written++;
      if (written % 200 === 0) console.log(`  ${written}/${rows.length}`);
    }

    if (!opts.dryRun) await client.query("COMMIT");

    console.log(
      `\nResolved ${resolved}, skipped ${skipped}${opts.dryRun ? " (dry run)" : `, wrote ${written}`}`,
    );
  } catch (err) {
    if (!opts.dryRun) await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  await shutdown();
}

const program = new Command()
  .name("rebuild-public-urls")
  .description("Extract LinkedIn member URN from Sales Nav lead URLs and write contacts.public_linkedin_url")
  .option("--microsegment <id>", "Limit to one microsegment")
  .option("--force", "Overwrite even if public_linkedin_url is already set", false)
  .option("--dry-run", "Compute but don't write", false)
  .action(run);

program.parse();
