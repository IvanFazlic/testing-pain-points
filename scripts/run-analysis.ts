/**
 * Orchestrates Claude-powered post analysis.
 *
 * Stage 1: Per-post extraction (Haiku) → post_analysis table
 * Stage 2: Cross-post synthesis (Sonnet) → pain_point_insights table
 */
import { Command } from "commander";
import dotenv from "dotenv";
import { query, shutdown } from "../src/db/connection.js";
import {
  extractPostInsights,
  synthesizePainPoints,
  EXTRACTION_MODEL,
  SYNTHESIS_MODEL,
  EXTRACTION_PROMPT_VERSION,
  SYNTHESIS_PROMPT_VERSION,
} from "../src/services/post-analysis.js";

dotenv.config();

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runStage1(microsegmentId: string, concurrency: number, limit?: number) {
  console.log(`\n=== Stage 1: Per-post extraction (${EXTRACTION_MODEL}) ===`);

  // Find unanalyzed posts for this microsegment
  let sql = `
    SELECT sp.id, sp.post_url, sp.post_text, sp.post_date, sp.like_count, sp.comment_count,
           c.full_name, c.first_name, c.title AS author_title, c.microsegment_label,
           co.display_name AS company_name
    FROM scraped_posts sp
    JOIN contacts c ON sp.contact_id = c.id
    LEFT JOIN companies co ON c.company_id = co.id
    WHERE c.microsegment_id = $1
      AND sp.post_text IS NOT NULL
      AND sp.post_text != ''
      AND sp.id NOT IN (SELECT scraped_post_id FROM post_analysis)
    ORDER BY sp.id
  `;
  const params: any[] = [microsegmentId];
  if (limit) {
    sql += ` LIMIT $2`;
    params.push(limit);
  }

  const { rows: posts } = await query(sql, params);
  console.log(`Found ${posts.length} unanalyzed posts`);

  if (posts.length === 0) {
    console.log("Nothing to analyze.");
    return;
  }

  // Create run record
  await query(
    `INSERT INTO scrape_runs (stage, microsegment_id, status) VALUES ('analysis', $1, 'running')`,
    [microsegmentId],
  );

  let analyzed = 0;
  let errors = 0;

  // Process in batches with concurrency
  for (let i = 0; i < posts.length; i += concurrency) {
    const batch = posts.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(async (post) => {
        const { result, tokenUsage } = await extractPostInsights({
          postText: post.post_text,
          authorName: post.full_name ?? post.first_name ?? "Unknown",
          authorTitle: post.author_title ?? "Unknown",
          authorCompany: post.company_name ?? "Unknown",
          postDate: post.post_date
            ? new Date(post.post_date).toISOString().split("T")[0]
            : "Unknown",
          likeCount: post.like_count,
          commentCount: post.comment_count,
          microsegmentLabel: post.microsegment_label ?? microsegmentId,
        });

        await query(
          `INSERT INTO post_analysis
             (scraped_post_id, topics, pain_points, sentiment, sentiment_score,
              intent_signals, key_quotes, analysis_model, prompt_version, token_usage)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (scraped_post_id) DO NOTHING`,
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
      if (r.status === "fulfilled") {
        analyzed++;
      } else {
        errors++;
        console.error(`  [ERR] ${r.reason?.message ?? r.reason}`);
      }
    }

    if ((i + batch.length) % 20 === 0 || i + batch.length >= posts.length) {
      console.log(`  Progress: ${analyzed + errors}/${posts.length} (${errors} errors)`);
    }

    // Small delay between batches to be polite
    if (i + concurrency < posts.length) await delay(100);
  }

  // Finalize run
  await query(
    `UPDATE scrape_runs SET status = 'completed', completed_at = NOW(), posts_analyzed = $1
     WHERE microsegment_id = $2 AND stage = 'analysis' AND status = 'running'`,
    [analyzed, microsegmentId],
  );

  console.log(`Stage 1 complete: ${analyzed} analyzed, ${errors} errors`);
}

async function runStage2(microsegmentId: string) {
  console.log(`\n=== Stage 2: Pain point synthesis (${SYNTHESIS_MODEL}) ===`);

  // Load all analyzed posts for this microsegment: both individual + company-page posts
  const { rows: posts } = await query(
    `SELECT post_url, post_date, full_name, company_name,
            topics, pain_points, sentiment, sentiment_score, key_quotes
     FROM (
       SELECT sp.post_url, sp.post_date,
              COALESCE(c.full_name, c.first_name) AS full_name,
              co.display_name AS company_name,
              pa.topics, pa.pain_points, pa.sentiment, pa.sentiment_score, pa.key_quotes
       FROM post_analysis pa
       JOIN scraped_posts sp ON pa.scraped_post_id = sp.id
       JOIN contacts c ON sp.contact_id = c.id
       LEFT JOIN companies co ON c.company_id = co.id
       WHERE c.microsegment_id = $1
       UNION ALL
       SELECT cp.post_url, cp.post_date,
              co.display_name AS full_name,
              co.display_name AS company_name,
              cpa.topics, cpa.pain_points, cpa.sentiment, cpa.sentiment_score, cpa.key_quotes
       FROM company_post_analysis cpa
       JOIN scraped_company_posts cp ON cpa.company_scraped_post_id = cp.id
       JOIN companies co ON cp.company_id = co.id
       WHERE EXISTS (
         SELECT 1 FROM contacts c
         WHERE c.company_id = co.id AND c.microsegment_id = $1
       )
     ) u`,
    [microsegmentId],
  );

  if (posts.length === 0) {
    console.log("No analyzed posts found. Run Stage 1 first.");
    return;
  }

  // Get microsegment label
  const { rows: labelRows } = await query(
    `SELECT DISTINCT microsegment_label FROM contacts WHERE microsegment_id = $1 LIMIT 1`,
    [microsegmentId],
  );
  const msLabel = labelRows[0]?.microsegment_label ?? microsegmentId;

  // Count unique contacts and companies across both sources
  const { rows: countRows } = await query(
    `SELECT
       (SELECT COUNT(DISTINCT c.id)
        FROM post_analysis pa
        JOIN scraped_posts sp ON pa.scraped_post_id = sp.id
        JOIN contacts c ON sp.contact_id = c.id
        WHERE c.microsegment_id = $1) AS contacts,
       (SELECT COUNT(DISTINCT co.id)
        FROM companies co
        JOIN contacts c ON c.company_id = co.id
        WHERE c.microsegment_id = $1) AS companies`,
    [microsegmentId],
  );

  const postsForSynthesis = posts.map((p) => ({
    postUrl: p.post_url,
    authorName: p.full_name ?? "Unknown",
    authorCompany: p.company_name ?? "Unknown",
    topics: p.topics ?? [],
    painPoints: p.pain_points ?? [],
    sentiment: p.sentiment,
    sentimentScore: p.sentiment_score,
    keyQuotes: p.key_quotes ?? [],
    postDate: p.post_date
      ? new Date(p.post_date).toISOString().split("T")[0]
      : "Unknown",
  }));

  console.log(
    `Synthesizing ${posts.length} posts from ${countRows[0]?.contacts} contacts, ${countRows[0]?.companies} companies`,
  );

  // Create run record
  await query(
    `INSERT INTO scrape_runs (stage, microsegment_id, status) VALUES ('synthesis', $1, 'running')`,
    [microsegmentId],
  );

  const { insights, tokenUsage } = await synthesizePainPoints({
    microsegmentId,
    microsegmentLabel: msLabel,
    totalPosts: posts.length,
    totalContacts: Number(countRows[0]?.contacts ?? 0),
    totalCompanies: Number(countRows[0]?.companies ?? 0),
    posts: postsForSynthesis,
  });

  console.log(`  Generated ${insights.length} pain point insights`);
  console.log(`  Tokens: ${tokenUsage.input_tokens} in / ${tokenUsage.output_tokens} out`);

  // Upsert insights
  for (const insight of insights) {
    await query(
      `INSERT INTO pain_point_insights
         (microsegment_id, insight_name, insight_description, pain_point_summary,
          frequency_count, company_count, contact_count, avg_sentiment_score,
          sentiment_distribution, evidence, topics, who_feels_pain, what_triggers_it,
          urgency_level, synthesis_model, prompt_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (microsegment_id, insight_name)
       DO UPDATE SET
         insight_description = EXCLUDED.insight_description,
         pain_point_summary = EXCLUDED.pain_point_summary,
         frequency_count = EXCLUDED.frequency_count,
         company_count = EXCLUDED.company_count,
         contact_count = EXCLUDED.contact_count,
         avg_sentiment_score = EXCLUDED.avg_sentiment_score,
         sentiment_distribution = EXCLUDED.sentiment_distribution,
         evidence = EXCLUDED.evidence,
         topics = EXCLUDED.topics,
         who_feels_pain = EXCLUDED.who_feels_pain,
         what_triggers_it = EXCLUDED.what_triggers_it,
         urgency_level = EXCLUDED.urgency_level,
         synthesis_model = EXCLUDED.synthesis_model,
         prompt_version = EXCLUDED.prompt_version,
         synthesized_at = NOW(),
         version = pain_point_insights.version + 1`,
      [
        microsegmentId,
        insight.insight_name,
        insight.insight_description,
        insight.pain_point_summary,
        insight.frequency_count,
        insight.company_count,
        insight.contact_count,
        insight.avg_sentiment_score,
        JSON.stringify(insight.sentiment_distribution),
        JSON.stringify(insight.evidence),
        JSON.stringify(insight.topics),
        insight.who_feels_pain,
        insight.what_triggers_it,
        insight.urgency_level,
        SYNTHESIS_MODEL,
        SYNTHESIS_PROMPT_VERSION,
      ],
    );
  }

  // Finalize run
  await query(
    `UPDATE scrape_runs SET status = 'completed', completed_at = NOW(), insights_produced = $1
     WHERE microsegment_id = $2 AND stage = 'synthesis' AND status = 'running'`,
    [insights.length, microsegmentId],
  );

  console.log(`Stage 2 complete: ${insights.length} insights persisted`);
}

async function run(opts: {
  microsegment: string;
  stage: string;
  concurrency: number;
  limit?: string;
}) {
  const stages = opts.stage === "all" ? ["1", "2"] : [opts.stage];

  for (const stage of stages) {
    if (stage === "1") {
      await runStage1(opts.microsegment, opts.concurrency, opts.limit ? Number(opts.limit) : undefined);
    } else if (stage === "2") {
      await runStage2(opts.microsegment);
    } else {
      console.error(`Unknown stage: ${stage}`);
    }
  }

  await shutdown();
}

const program = new Command()
  .name("run-analysis")
  .description("Run Claude-powered analysis on scraped LinkedIn posts")
  .requiredOption("--microsegment <id>", "Microsegment ID to analyze")
  .option("--stage <n>", "Stage to run: 1, 2, or all", "all")
  .option("--concurrency <n>", "Concurrent API calls (Stage 1)", "10")
  .option("--limit <n>", "Max posts to analyze (for testing)")
  .action((opts) =>
    run({
      ...opts,
      concurrency: Number(opts.concurrency),
    }),
  );

program.parse();
