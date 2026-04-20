/**
 * Seed post_insight_tags from the ground-truth evidence embedded in pain_point_insights.
 *
 * The synthesis step already wrote {post_url → insight} edges into
 * pain_point_insights.evidence (JSONB array). We mirror those edges into the
 * normalized join table so the relational queries (contacts-by-insight, audience
 * counts, exports) have a fast index to scan instead of parsing JSONB on every
 * request.
 *
 * Idempotent via the partial unique indexes on post_insight_tags.
 */
import { Command } from "commander";
import { pool, shutdown } from "../src/db/connection.js";

interface EvidenceRow {
  id: number;
  microsegment_id: string;
  evidence: unknown;
}

interface EvidenceEntry {
  post_url?: string;
}

function normalizeEvidence(raw: unknown): EvidenceEntry[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as EvidenceEntry[];
  // Some rows might store it as a string (older synthesis runs); try to JSON.parse.
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function run(opts: { microsegment?: string }) {
  const client = await pool.connect();
  let edgesAttempted = 0;
  let edgesInserted = 0;
  let edgesMissingPost = 0;
  try {
    const sql = opts.microsegment
      ? `SELECT id, microsegment_id, evidence FROM pain_point_insights WHERE microsegment_id = $1`
      : `SELECT id, microsegment_id, evidence FROM pain_point_insights`;
    const params = opts.microsegment ? [opts.microsegment] : [];
    const { rows } = await client.query<EvidenceRow>(sql, params);
    console.log(`Loading ${rows.length} insights…`);

    await client.query("BEGIN");
    for (const insight of rows) {
      const entries = normalizeEvidence(insight.evidence);
      for (const e of entries) {
        if (!e.post_url) continue;
        edgesAttempted++;

        // Try the company-posts table first (that's where our Sales-Nav HTML posts live),
        // then fall back to individual-contact posts if present.
        const companyHit = await client.query<{ id: number }>(
          `SELECT id FROM scraped_company_posts WHERE post_url = $1 LIMIT 1`,
          [e.post_url],
        );
        if (companyHit.rows.length > 0) {
          const r = await client.query<{ id: number }>(
            `INSERT INTO post_insight_tags
               (company_scraped_post_id, insight_id, microsegment_id, score, source)
             VALUES ($1, $2, $3, $4, 'evidence')
             ON CONFLICT (company_scraped_post_id, insight_id)
               WHERE company_scraped_post_id IS NOT NULL
               DO NOTHING
             RETURNING id`,
            [companyHit.rows[0].id, insight.id, insight.microsegment_id, 1.0],
          );
          if (r.rows.length) edgesInserted++;
          continue;
        }

        const indivHit = await client.query<{ id: number }>(
          `SELECT id FROM scraped_posts WHERE post_url = $1 LIMIT 1`,
          [e.post_url],
        );
        if (indivHit.rows.length > 0) {
          const r = await client.query<{ id: number }>(
            `INSERT INTO post_insight_tags
               (scraped_post_id, insight_id, microsegment_id, score, source)
             VALUES ($1, $2, $3, $4, 'evidence')
             ON CONFLICT (scraped_post_id, insight_id)
               WHERE scraped_post_id IS NOT NULL
               DO NOTHING
             RETURNING id`,
            [indivHit.rows[0].id, insight.id, insight.microsegment_id, 1.0],
          );
          if (r.rows.length) edgesInserted++;
          continue;
        }

        edgesMissingPost++;
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  console.log(
    `Evidence bootstrap: ${edgesInserted} new tags inserted, ` +
      `${edgesAttempted - edgesInserted - edgesMissingPost} already present, ` +
      `${edgesMissingPost} evidence entries had no matching post row`,
  );
  await shutdown();
}

const program = new Command()
  .name("bootstrap-tags-from-evidence")
  .description("Seed post_insight_tags from pain_point_insights.evidence (source='evidence', score=1.0)")
  .option("--microsegment <id>", "Limit to one microsegment")
  .action(run);

program.parse();
