/**
 * Fuzzy post → pain_point_insight tagging via pg_trgm.
 *
 * For each analyzed post, compare its extracted `pain_points[]` + `topics[]` strings
 * against each insight's `insight_name` and `topics[]`. If the max pairwise similarity
 * clears the threshold, record it as a tag with source='fuzzy'.
 *
 * Runs entirely in Postgres — no API cost, no external calls. Bulk-upserts so it can
 * be re-run with different thresholds and the unique index keeps it idempotent.
 */
import { Command } from "commander";
import { pool, shutdown } from "../src/db/connection.js";

async function run(opts: { microsegment?: string; threshold: number }) {
  const client = await pool.connect();
  const threshold = opts.threshold;
  try {
    // Build the scoring CTE: cartesian join each (post, post_token) against
    // each (insight, insight_token), keep the max similarity per (post, insight).
    // Then insert the winners that clear the threshold.
    const sql = `
      WITH post_tokens AS (
        SELECT cp.id AS post_id,
               cp.company_id,
               cpa.id AS analysis_id,
               ${opts.microsegment ? "$2::text" : "(SELECT microsegment_id FROM contacts c WHERE c.company_id = cp.company_id LIMIT 1)"} AS microsegment_id,
               lower(trim(elem)) AS token
          FROM scraped_company_posts cp
          JOIN company_post_analysis cpa ON cpa.company_scraped_post_id = cp.id
          ${opts.microsegment ? `JOIN contacts c ON c.company_id = cp.company_id AND c.microsegment_id = $2` : ""}
          CROSS JOIN LATERAL (
            SELECT jsonb_array_elements_text(COALESCE(cpa.pain_points, '[]'::jsonb)
                                             || COALESCE(cpa.topics, '[]'::jsonb)) AS elem
          ) AS t
          WHERE trim(elem) <> ''
      ),
      insight_tokens AS (
        SELECT pi.id AS insight_id,
               pi.microsegment_id,
               lower(trim(elem)) AS token
          FROM pain_point_insights pi
          CROSS JOIN LATERAL (
            SELECT pi.insight_name AS elem
            UNION ALL
            SELECT jsonb_array_elements_text(COALESCE(pi.topics, '[]'::jsonb))
          ) AS t
          WHERE trim(elem) <> ''
          ${opts.microsegment ? "AND pi.microsegment_id = $2" : ""}
      ),
      scored AS (
        SELECT pt.post_id,
               pt.microsegment_id,
               it.insight_id,
               MAX(similarity(pt.token, it.token)) AS score
          FROM post_tokens pt
          JOIN insight_tokens it ON it.microsegment_id = pt.microsegment_id
         GROUP BY pt.post_id, pt.microsegment_id, it.insight_id
      )
      INSERT INTO post_insight_tags
        (company_scraped_post_id, insight_id, microsegment_id, score, source)
      SELECT post_id, insight_id, microsegment_id, score, 'fuzzy'
        FROM scored
       WHERE score >= $1
      ON CONFLICT (company_scraped_post_id, insight_id)
        WHERE company_scraped_post_id IS NOT NULL
        DO NOTHING
      RETURNING id
    `;
    const params: any[] = [threshold];
    if (opts.microsegment) params.push(opts.microsegment);
    const t0 = Date.now();
    const { rowCount } = await client.query(sql, params);
    const ms = Date.now() - t0;
    console.log(`Fuzzy pass complete: ${rowCount} new tags (threshold=${threshold}) in ${ms}ms`);

    // Distribution report
    const dist = await client.query(
      `SELECT pi.insight_name, COUNT(*)::int AS n
         FROM post_insight_tags pit
         JOIN pain_point_insights pi ON pi.id = pit.insight_id
        WHERE pit.source = 'fuzzy'
          ${opts.microsegment ? "AND pit.microsegment_id = $1" : ""}
        GROUP BY pi.insight_name
        ORDER BY n DESC LIMIT 10`,
      opts.microsegment ? [opts.microsegment] : [],
    );
    console.log("\nTop insights by fuzzy-tag count:");
    for (const r of dist.rows) console.log(`  ${r.n.toString().padStart(5)}  ${r.insight_name}`);
  } finally {
    client.release();
  }
  await shutdown();
}

const program = new Command()
  .name("run-fuzzy-tagging")
  .description("Tag posts against pain-point insights via pg_trgm similarity")
  .option("--microsegment <id>", "Limit to one microsegment")
  .option("--threshold <n>", "Similarity threshold (0..1)", "0.45")
  .action((opts) => run({ ...opts, threshold: Number(opts.threshold) }));

program.parse();
