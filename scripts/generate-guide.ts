/**
 * Generates a Markdown pain point guide from pain_point_insights.
 * Output: artifacts/pain-point-guide-YYYY-MM-DD.md
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { Command } from "commander";
import dotenv from "dotenv";
import { query, shutdown } from "../src/db/connection.js";

dotenv.config();

async function generate(opts: { output?: string }) {
  const date = new Date().toISOString().split("T")[0];
  const outPath = opts.output ?? `artifacts/pain-point-guide-${date}.md`;
  mkdirSync("artifacts", { recursive: true });

  // Fetch all insights grouped by microsegment
  const { rows: insights } = await query(`
    SELECT pi.*, c_agg.segment_label
    FROM pain_point_insights pi
    LEFT JOIN LATERAL (
      SELECT DISTINCT microsegment_label AS segment_label
      FROM contacts WHERE microsegment_id = pi.microsegment_id LIMIT 1
    ) c_agg ON TRUE
    ORDER BY pi.microsegment_id, pi.frequency_count DESC
  `);

  // Fetch totals (individual + company posts)
  const { rows: totals } = await query(`
    SELECT
      (SELECT COUNT(*) FROM scraped_posts) + (SELECT COUNT(*) FROM scraped_company_posts) AS total_posts,
      (SELECT COUNT(*) FROM post_analysis) + (SELECT COUNT(*) FROM company_post_analysis) AS total_analyzed,
      (SELECT COUNT(DISTINCT microsegment_id) FROM pain_point_insights) AS segments_with_insights,
      (SELECT COUNT(*) FROM pain_point_insights) AS total_insights
  `);
  const t = totals[0];

  // Group insights by segment
  const bySegment = new Map<string, typeof insights>();
  for (const row of insights) {
    const key = row.microsegment_id;
    if (!bySegment.has(key)) bySegment.set(key, []);
    bySegment.get(key)!.push(row);
  }

  // Build Markdown
  const lines: string[] = [];
  lines.push(`# LinkedIn Decision-Maker Pain Point Guide`);
  lines.push(`\n*Generated: ${date}*\n`);

  // Executive summary
  lines.push(`## Executive Summary\n`);
  lines.push(`- **${t.total_posts}** LinkedIn posts scraped from decision-makers`);
  lines.push(`- **${t.total_analyzed}** posts analyzed with Claude AI`);
  lines.push(`- **${t.total_insights}** pain point insights identified across **${t.segments_with_insights}** segments\n`);

  // Top pain points across all segments
  const allSorted = [...insights].sort(
    (a, b) => (b.frequency_count ?? 0) - (a.frequency_count ?? 0),
  );
  const top5 = allSorted.slice(0, 5);
  if (top5.length > 0) {
    lines.push(`### Top 5 Pain Points (Cross-Segment)\n`);
    for (const [i, ins] of top5.entries()) {
      lines.push(
        `${i + 1}. **${ins.insight_name}** (${ins.urgency_level} urgency) — ${ins.pain_point_summary ?? ""}`,
      );
      lines.push(
        `   - ${ins.frequency_count} mentions, ${ins.company_count} companies, ${ins.contact_count} contacts`,
      );
      lines.push(`   - Segment: ${ins.segment_label ?? ins.microsegment_id}`);
    }
    lines.push("");
  }

  // Per-segment sections
  lines.push(`---\n`);
  lines.push(`## Per-Segment Analysis\n`);

  for (const [msId, segInsights] of bySegment) {
    const label = segInsights[0]?.segment_label ?? msId;
    lines.push(`### ${label}\n`);
    lines.push(`*${segInsights.length} pain points identified*\n`);

    for (const ins of segInsights) {
      lines.push(`#### ${ins.insight_name}\n`);
      lines.push(`- **Urgency:** ${ins.urgency_level}`);
      lines.push(`- **Summary:** ${ins.pain_point_summary ?? "—"}`);
      lines.push(`- **Frequency:** ${ins.frequency_count} mentions across ${ins.company_count} companies`);
      if (ins.who_feels_pain) lines.push(`- **Who feels this:** ${ins.who_feels_pain}`);
      if (ins.what_triggers_it) lines.push(`- **Trigger:** ${ins.what_triggers_it}`);
      if (ins.insight_description) lines.push(`\n${ins.insight_description}`);

      // Evidence quotes
      const evidence = ins.evidence ?? [];
      if (evidence.length > 0) {
        lines.push(`\n**Evidence:**\n`);
        for (const e of evidence.slice(0, 3)) {
          lines.push(
            `> "${e.quote}" — *${e.person_name}, ${e.company}* ([source](${e.post_url}))`,
          );
        }
      }

      // Topics
      const topics = ins.topics ?? [];
      if (topics.length > 0) {
        lines.push(`\n**Related topics:** ${topics.join(", ")}`);
      }
      lines.push("");
    }
    lines.push(`---\n`);
  }

  // Appendix
  lines.push(`## Appendix\n`);
  lines.push(`- **Analysis tool:** Claude AI (Haiku for extraction, Sonnet for synthesis)`);
  lines.push(`- **Data source:** ScrapeCreators LinkedIn API`);
  lines.push(`- **Time window:** Last 6 months`);
  lines.push(`- **Date generated:** ${date}`);

  const md = lines.join("\n");
  writeFileSync(outPath, md, "utf-8");
  console.log(`Guide written to ${outPath} (${md.length} chars)`);

  await shutdown();
}

const program = new Command()
  .name("generate-guide")
  .description("Generate Markdown pain point guide from insights")
  .option("--output <path>", "Output file path")
  .action(generate);

program.parse();
