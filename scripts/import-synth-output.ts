/**
 * Replaces the cohort's pain_point_insights with the Opus synthesis output.
 *
 * ON DELETE CASCADE on post_insight_tags.insight_id means wiping the old
 * insights automatically wipes the old tags, which is what we want — the tags
 * are insight-shaped, and the insight shape has changed. We re-build tags from
 * scratch via the downstream bootstrap/fuzzy/LLM passes.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { pool, shutdown } from "../src/db/connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IN = join(__dirname, "_synth-output.json");

interface OpusInsight {
  insight_name: string;
  insight_description: string;
  pain_point_summary: string;
  frequency_count: number;
  company_count: number;
  contact_count: number;
  avg_sentiment_score: number;
  sentiment_distribution: Record<string, number>;
  evidence: Array<{
    post_url: string;
    person_name: string;
    company: string;
    quote: string;
    date: string;
  }>;
  topics: string[];
  who_feels_pain: string;
  what_triggers_it: string;
  urgency_level: "high" | "medium" | "low";
}

async function run(opts: {
  microsegment: string;
  model: string;
  promptVersion: string;
  dryRun: boolean;
}) {
  const raw = readFileSync(IN, "utf-8");
  const parsed = JSON.parse(raw) as { insights: OpusInsight[] };
  const insights = parsed.insights ?? [];
  console.log(`Parsed ${insights.length} Opus insights from ${IN}`);
  if (insights.length === 0) {
    console.log("Nothing to import — aborting.");
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (!opts.dryRun) {
      // Cascading delete removes post_insight_tags pointing at the old insights.
      const oldCount = await client.query(
        `DELETE FROM pain_point_insights WHERE microsegment_id = $1 RETURNING id`,
        [opts.microsegment],
      );
      console.log(`Removed ${oldCount.rowCount} old insights (tags cascaded).`);
    }

    let inserted = 0;
    for (const i of insights) {
      if (opts.dryRun) {
        console.log(`  [dry] ${i.urgency_level.padEnd(6)}  ${i.insight_name}`);
        continue;
      }
      await client.query(
        `INSERT INTO pain_point_insights
           (microsegment_id, insight_name, insight_description, pain_point_summary,
            frequency_count, company_count, contact_count,
            avg_sentiment_score, sentiment_distribution,
            evidence, topics, who_feels_pain, what_triggers_it, urgency_level,
            synthesis_model, prompt_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          opts.microsegment,
          i.insight_name,
          i.insight_description,
          i.pain_point_summary,
          i.frequency_count,
          i.company_count,
          i.contact_count,
          i.avg_sentiment_score,
          JSON.stringify(i.sentiment_distribution ?? {}),
          JSON.stringify(i.evidence ?? []),
          JSON.stringify(i.topics ?? []),
          i.who_feels_pain,
          i.what_triggers_it,
          i.urgency_level,
          opts.model,
          opts.promptVersion,
        ],
      );
      inserted++;
    }

    if (opts.dryRun) {
      await client.query("ROLLBACK");
      console.log(`\nDry run — ${insights.length} insights would be inserted.`);
    } else {
      await client.query("COMMIT");
      console.log(`\nCommitted: ${inserted} insights persisted.`);
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
  .name("import-synth-output")
  .description("Replace cohort insights with Opus synthesis output")
  .option("--microsegment <id>", "Microsegment ID", "uk-industrial-iot::ex-london")
  .option("--model <name>", "synthesis_model value", "claude-opus-4-7-via-agent")
  .option("--prompt-version <v>", "prompt_version value", "opus-agent-v1")
  .option("--dry-run", "Preview without writing", false)
  .action(run);

program.parse();
