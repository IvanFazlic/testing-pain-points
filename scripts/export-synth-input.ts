/**
 * Dumps the synthesis input (same shape as run-analysis.ts stage 2 builds internally)
 * to a JSON file so an Opus subagent can read it without hitting the API itself.
 *
 * Mirrors the truncation logic in src/services/post-analysis.ts synthesizePainPoints:
 * prioritize posts with pain_points, cap serialized size at ~150 KB.
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { query, shutdown } from "../src/db/connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MS = process.argv[2] ?? "uk-industrial-iot::ex-london";
const OUT = join(__dirname, "_synth-input.json");

const { rows: msLabel } = await query<{ microsegment_label: string }>(
  `SELECT DISTINCT microsegment_label FROM contacts WHERE microsegment_id = $1 LIMIT 1`,
  [MS],
);
const label = msLabel[0]?.microsegment_label ?? MS;

const { rows: posts } = await query<{
  postUrl: string;
  authorName: string;
  authorCompany: string;
  topics: string[];
  painPoints: string[];
  sentiment: string;
  sentimentScore: number;
  keyQuotes: string[];
  postDate: string;
}>(
  `SELECT cp.post_url AS "postUrl",
          co.display_name AS "authorName",
          co.display_name AS "authorCompany",
          COALESCE(cpa.topics, '[]'::jsonb) AS topics,
          COALESCE(cpa.pain_points, '[]'::jsonb) AS "painPoints",
          COALESCE(cpa.sentiment, 'neutral') AS sentiment,
          COALESCE(cpa.sentiment_score, 0) AS "sentimentScore",
          COALESCE(cpa.key_quotes, '[]'::jsonb) AS "keyQuotes",
          COALESCE(TO_CHAR(cp.post_date, 'YYYY-MM-DD'), 'Unknown') AS "postDate"
     FROM scraped_company_posts cp
     JOIN companies co ON co.id = cp.company_id
     JOIN contacts c ON c.company_id = cp.company_id AND c.microsegment_id = $1
     JOIN company_post_analysis cpa ON cpa.company_scraped_post_id = cp.id
    WHERE cp.post_text IS NOT NULL
    GROUP BY cp.id, co.display_name, cpa.topics, cpa.pain_points, cpa.sentiment,
             cpa.sentiment_score, cpa.key_quotes, cp.post_date, cp.post_url`,
  [MS],
);

const totals = await query<{ contacts: number; companies: number }>(
  `SELECT COUNT(DISTINCT c.id)::int AS contacts,
          COUNT(DISTINCT c.company_id)::int AS companies
     FROM contacts c WHERE c.microsegment_id = $1`,
  [MS],
);

// Same prioritization as production: pain-point posts first.
const withPain = posts.filter((p) => (p.painPoints ?? []).length > 0);
const without = posts.filter((p) => (p.painPoints ?? []).length === 0);
let ordered = [...withPain, ...without];

// Opus has a larger context; we can afford a bigger slice. Cap serialized
// payload around 250 KB so the agent has room for its own reasoning.
const MAX_CHARS = 250_000;
while (JSON.stringify(ordered).length > MAX_CHARS && ordered.length > 100) {
  ordered = ordered.slice(0, ordered.length - 20);
}

const payload = {
  microsegmentId: MS,
  microsegmentLabel: label,
  totalPosts: posts.length,
  totalContacts: totals.rows[0]?.contacts ?? 0,
  totalCompanies: totals.rows[0]?.companies ?? 0,
  postsSentToSynthesis: ordered.length,
  posts: ordered,
};

writeFileSync(OUT, JSON.stringify(payload, null, 2), "utf-8");
console.log(
  `Wrote ${OUT} — ${ordered.length}/${posts.length} posts, ${(JSON.stringify(payload).length / 1024).toFixed(1)} KB`,
);
await shutdown();
