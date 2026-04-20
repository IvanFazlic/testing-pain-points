/**
 * LLM tagging pass — residual posts that evidence + fuzzy didn't tag.
 *
 * For each untagged post we send the post text plus a menu of all insights for its
 * microsegment to Haiku 4.5, expecting back {matches:[{insight_id, confidence}]}.
 * Tags are upserted with source='llm'.
 *
 * Designed to be cheap: Haiku, max_tokens 512, concurrency 10, only runs on posts
 * with zero tags, short post text slice. Typical residual ~2k posts ≈ $1–2.
 */
import { Command } from "commander";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { pool, shutdown } from "../src/db/connection.js";
import {
  POST_INSIGHT_CLASSIFY_SYSTEM,
  POST_INSIGHT_CLASSIFY_USER,
  POST_INSIGHT_CLASSIFY_PROMPT_VERSION,
  type InsightMenuEntry,
} from "../src/prompts/post-insight-classify.js";

dotenv.config();

const CLASSIFY_MODEL = "claude-haiku-4-5-20251001";

const anthropic = new Anthropic({
  authToken: process.env.ANTHROPIC_AUTH_TOKEN,
  defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
});

interface UntaggedPost {
  post_id: number;
  microsegment_id: string;
  company_name: string | null;
  industry: string | null;
  post_text: string;
}

interface ClassifyResult {
  matches: Array<{ insight_id: number; confidence: number }>;
}

function parseClassifyResponse(text: string): ClassifyResult {
  // Tolerate the model wrapping JSON in whitespace / fences. Same pattern as post-analysis.ts.
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Unparseable classify response: ${text.slice(0, 200)}`);
  }
}

async function classifyOne(
  post: UntaggedPost,
  menu: InsightMenuEntry[],
): Promise<{ matches: Array<{ insight_id: number; confidence: number }>; tokenUsage: any }> {
  const resp = await anthropic.messages.create({
    model: CLASSIFY_MODEL,
    max_tokens: 512,
    system: POST_INSIGHT_CLASSIFY_SYSTEM,
    messages: [
      {
        role: "user",
        content: POST_INSIGHT_CLASSIFY_USER({
          postText: post.post_text,
          companyName: post.company_name ?? "Unknown",
          industry: post.industry,
          menu,
        }),
      },
    ],
  });
  const text = resp.content[0].type === "text" ? resp.content[0].text : "";
  const parsed = parseClassifyResponse(text);
  const validIds = new Set(menu.map((m) => m.id));
  const matches = (parsed.matches ?? []).filter(
    (m) => validIds.has(m.insight_id) && m.confidence >= 0.4,
  );
  return {
    matches,
    tokenUsage: {
      input_tokens: resp.usage.input_tokens,
      output_tokens: resp.usage.output_tokens,
    },
  };
}

async function run(opts: { microsegment: string; concurrency: number; limit?: number }) {
  const client = await pool.connect();
  try {
    const menuRes = await client.query<InsightMenuEntry>(
      `SELECT id, insight_name AS name, pain_point_summary AS summary
         FROM pain_point_insights
        WHERE microsegment_id = $1
        ORDER BY id`,
      [opts.microsegment],
    );
    const menu = menuRes.rows;
    if (menu.length === 0) {
      console.log("No insights for this microsegment — nothing to classify against");
      return;
    }
    console.log(`Menu: ${menu.length} insights`);

    let sql = `
      SELECT cp.id AS post_id,
             c.microsegment_id,
             co.display_name AS company_name,
             co.normalized_industry AS industry,
             cp.post_text
        FROM scraped_company_posts cp
        JOIN companies co ON co.id = cp.company_id
        JOIN contacts c ON c.company_id = co.id
       WHERE c.microsegment_id = $1
         AND cp.post_text IS NOT NULL AND cp.post_text <> ''
         AND NOT EXISTS (
           SELECT 1 FROM post_insight_tags pit
            WHERE pit.company_scraped_post_id = cp.id
         )
       GROUP BY cp.id, c.microsegment_id, co.display_name, co.normalized_industry, cp.post_text
       ORDER BY cp.id
    `;
    const params: any[] = [opts.microsegment];
    if (opts.limit) {
      sql += ` LIMIT $2`;
      params.push(opts.limit);
    }
    const postsRes = await client.query<UntaggedPost>(sql, params);
    const posts = postsRes.rows;
    console.log(`Untagged posts to classify: ${posts.length}`);
    if (posts.length === 0) return;

    let done = 0;
    let errors = 0;
    let inserted = 0;
    let totalIn = 0;
    let totalOut = 0;

    for (let i = 0; i < posts.length; i += opts.concurrency) {
      const batch = posts.slice(i, i + opts.concurrency);
      const results = await Promise.allSettled(
        batch.map(async (p) => {
          const { matches, tokenUsage } = await classifyOne(p, menu);
          totalIn += tokenUsage.input_tokens ?? 0;
          totalOut += tokenUsage.output_tokens ?? 0;
          for (const m of matches) {
            const r = await client.query<{ id: number }>(
              `INSERT INTO post_insight_tags
                 (company_scraped_post_id, insight_id, microsegment_id, score, source)
               VALUES ($1, $2, $3, $4, 'llm')
               ON CONFLICT (company_scraped_post_id, insight_id)
                 WHERE company_scraped_post_id IS NOT NULL
                 DO NOTHING
               RETURNING id`,
              [p.post_id, m.insight_id, p.microsegment_id, m.confidence],
            );
            if (r.rows.length) inserted++;
          }
          return matches.length;
        }),
      );
      for (const r of results) {
        if (r.status === "fulfilled") done++;
        else {
          errors++;
          const msg = (r.reason as Error)?.message ?? String(r.reason);
          console.error(`  [ERR] ${msg.slice(0, 140)}`);
        }
      }
      if ((i + batch.length) % 20 === 0 || i + batch.length >= posts.length) {
        console.log(
          `  Progress: ${done + errors}/${posts.length} (${errors} errors, ${inserted} tags, ` +
            `tokens: ${totalIn} in / ${totalOut} out)`,
        );
      }
    }
    console.log(
      `\nLLM classify complete: ${done} posts, ${errors} errors, ${inserted} tags inserted ` +
        `(prompt ${POST_INSIGHT_CLASSIFY_PROMPT_VERSION}, model ${CLASSIFY_MODEL})`,
    );
  } finally {
    client.release();
  }
  await shutdown();
}

const program = new Command()
  .name("run-llm-tagging")
  .description("Classify untagged posts against the microsegment's insight menu via Haiku 4.5")
  .requiredOption("--microsegment <id>", "Microsegment ID")
  .option("--concurrency <n>", "Concurrent API calls", "10")
  .option("--limit <n>", "Max posts (for smoke tests)")
  .action((opts) =>
    run({
      microsegment: opts.microsegment,
      concurrency: Number(opts.concurrency),
      limit: opts.limit ? Number(opts.limit) : undefined,
    }),
  );

program.parse();
