/**
 * Stage 1 extraction on company posts.
 * Parallel to run-analysis.ts but reads scraped_company_posts → company_post_analysis.
 */
import { Command } from "commander";
import dotenv from "dotenv";
import { query, shutdown } from "../src/db/connection.js";
import {
  extractPostInsights,
  EXTRACTION_MODEL,
  EXTRACTION_PROMPT_VERSION,
} from "../src/services/post-analysis.js";

dotenv.config();

async function run(opts: { microsegment?: string; concurrency: number; limit?: number }) {
  console.log(`\n=== Company posts Stage 1 (${EXTRACTION_MODEL}) ===`);

  // Find unanalyzed company posts. For each, derive a representative microsegment via its company's contacts.
  let sql = `
    SELECT cp.id, cp.post_url, cp.post_text, cp.post_date,
           co.display_name AS company_name,
           (
             SELECT c.microsegment_label
             FROM contacts c
             WHERE c.company_id = cp.company_id
               ${opts.microsegment ? `AND c.microsegment_id = $1` : ``}
             LIMIT 1
           ) AS microsegment_label
    FROM scraped_company_posts cp
    LEFT JOIN companies co ON cp.company_id = co.id
    WHERE cp.post_text IS NOT NULL
      AND cp.post_text != ''
      AND cp.id NOT IN (SELECT company_scraped_post_id FROM company_post_analysis)
  `;
  const params: any[] = [];
  if (opts.microsegment) {
    sql += ` AND EXISTS (SELECT 1 FROM contacts c WHERE c.company_id = cp.company_id AND c.microsegment_id = $1)`;
    params.push(opts.microsegment);
  }
  sql += ` ORDER BY cp.id`;
  if (opts.limit) {
    sql += ` LIMIT $${params.length + 1}`;
    params.push(opts.limit);
  }

  const { rows: posts } = await query(sql, params);
  console.log(`Found ${posts.length} unanalyzed company posts`);
  if (posts.length === 0) {
    await shutdown();
    return;
  }

  let analyzed = 0;
  let errors = 0;
  for (let i = 0; i < posts.length; i += opts.concurrency) {
    const batch = posts.slice(i, i + opts.concurrency);
    const results = await Promise.allSettled(
      batch.map(async (post) => {
        const { result, tokenUsage } = await extractPostInsights({
          postText: post.post_text,
          authorName: post.company_name ?? "Unknown Company",
          authorTitle: "Company Page",
          authorCompany: post.company_name ?? "Unknown",
          postDate: post.post_date ? new Date(post.post_date).toISOString().split("T")[0] : "Unknown",
          likeCount: 0,
          commentCount: 0,
          microsegmentLabel: post.microsegment_label ?? "Unknown",
        });
        await query(
          `INSERT INTO company_post_analysis
             (company_scraped_post_id, topics, pain_points, sentiment, sentiment_score,
              intent_signals, key_quotes, analysis_model, prompt_version, token_usage)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (company_scraped_post_id) DO NOTHING`,
          [
            post.id,
            JSON.stringify(result.topics),
            JSON.stringify(result.pain_points),
            result.sentiment,
            result.sentiment_score,
            JSON.stringify(result.intent_signals),
            JSON.stringify(result.key_quotes),
            EXTRACTION_MODEL,
            EXTRACTION_PROMPT_VERSION,
            JSON.stringify(tokenUsage),
          ],
        );
        return result;
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled") analyzed++;
      else {
        errors++;
        console.error(`  [ERR] ${r.reason?.message?.slice(0, 120) ?? r.reason}`);
      }
    }
    if ((i + batch.length) % 20 === 0 || i + batch.length >= posts.length) {
      console.log(`  Progress: ${analyzed + errors}/${posts.length} (${errors} errors)`);
    }
  }
  console.log(`Stage 1 complete: ${analyzed} analyzed, ${errors} errors`);
  await shutdown();
}

const program = new Command()
  .name("run-company-analysis")
  .description("Run Claude Stage-1 extraction on scraped company posts")
  .option("--microsegment <id>", "Filter to company posts whose companies have contacts in this microsegment")
  .option("--concurrency <n>", "Concurrent API calls", "5")
  .option("--limit <n>", "Max posts to analyze")
  .action((opts) =>
    run({
      ...opts,
      concurrency: Number(opts.concurrency),
      limit: opts.limit ? Number(opts.limit) : undefined,
    }),
  );

program.parse();
