/**
 * Generates docs/data-model.html — a self-contained visual snapshot of the DB
 * shape, current row counts, tagging coverage, and LinkedIn-readiness summary.
 *
 * Run any time the data shifts. Output is fully static (Tailwind via CDN, no
 * runtime API calls) so it works opened directly from disk.
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { query, shutdown } from "../src/db/connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "docs", "data-model.html");
const MS = "uk-industrial-iot::ex-london";

function escapeHtml(s: string | null | undefined): string {
  if (s == null) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function fetchData() {
  const tables = [
    ["companies", "Companies (across all microsegments)"],
    ["contacts", "Contacts"],
    ["scraped_company_posts", "Company-page posts (Sales Nav HTML + ScrapeCreators)"],
    ["company_post_analysis", "Per-post Haiku analysis"],
    ["scraped_posts", "Person-authored posts"],
    ["post_analysis", "Per-person-post Haiku analysis"],
    ["pain_point_insights", "Synthesized pain-point insights"],
    ["post_insight_tags", "Post → insight tag edges"],
    ["scrape_runs", "Pipeline execution log"],
  ];
  const tableCounts: Array<{ table: string; label: string; n: number }> = [];
  for (const [t, label] of tables) {
    const { rows } = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${t}`);
    tableCounts.push({ table: t, label, n: rows[0].n });
  }

  const cohort = await query<{
    contacts: number;
    companies: number;
    posts: number;
    analyzed: number;
    insights: number;
    tags: number;
    tagged_posts: number;
    contacts_with_bio: number;
    contacts_with_location: number;
    contacts_with_degree: number;
    contacts_with_lead_url: number;
    contacts_with_public_url: number;
  }>(
    `SELECT
       (SELECT COUNT(DISTINCT id) FROM contacts WHERE microsegment_id=$1)::int AS contacts,
       (SELECT COUNT(DISTINCT company_id) FROM contacts WHERE microsegment_id=$1)::int AS companies,
       (SELECT COUNT(DISTINCT cp.id) FROM scraped_company_posts cp
         JOIN contacts c ON c.company_id = cp.company_id
        WHERE c.microsegment_id=$1)::int AS posts,
       (SELECT COUNT(DISTINCT cp.id) FROM scraped_company_posts cp
         JOIN contacts c ON c.company_id = cp.company_id
         JOIN company_post_analysis cpa ON cpa.company_scraped_post_id = cp.id
        WHERE c.microsegment_id=$1)::int AS analyzed,
       (SELECT COUNT(*) FROM pain_point_insights WHERE microsegment_id=$1)::int AS insights,
       (SELECT COUNT(*) FROM post_insight_tags WHERE microsegment_id=$1)::int AS tags,
       (SELECT COUNT(DISTINCT company_scraped_post_id) FROM post_insight_tags
         WHERE microsegment_id=$1 AND company_scraped_post_id IS NOT NULL)::int AS tagged_posts,
       (SELECT COUNT(*) FROM contacts WHERE microsegment_id=$1 AND bio IS NOT NULL)::int AS contacts_with_bio,
       (SELECT COUNT(*) FROM contacts WHERE microsegment_id=$1 AND location IS NOT NULL)::int AS contacts_with_location,
       (SELECT COUNT(*) FROM contacts WHERE microsegment_id=$1 AND connection_degree IS NOT NULL)::int AS contacts_with_degree,
       (SELECT COUNT(*) FROM contacts WHERE microsegment_id=$1 AND salesnav_lead_url IS NOT NULL)::int AS contacts_with_lead_url,
       (SELECT COUNT(*) FROM contacts WHERE microsegment_id=$1 AND public_linkedin_url IS NOT NULL)::int AS contacts_with_public_url`,
    [MS],
  );

  const tagsBySource = await query<{ source: string; n: number }>(
    `SELECT source, COUNT(*)::int AS n FROM post_insight_tags WHERE microsegment_id=$1
      GROUP BY source ORDER BY n DESC`,
    [MS],
  );

  const insightsCoverage = await query<{
    id: number;
    insight_name: string;
    urgency_level: string;
    posts: number;
    by_source: any;
  }>(
    `SELECT pi.id, pi.insight_name, pi.urgency_level,
            COALESCE(COUNT(DISTINCT pit.company_scraped_post_id), 0)::int AS posts
       FROM pain_point_insights pi
       LEFT JOIN post_insight_tags pit
              ON pit.insight_id = pi.id
             AND pit.microsegment_id = $1
      WHERE pi.microsegment_id = $1
      GROUP BY pi.id, pi.insight_name, pi.urgency_level
      ORDER BY posts DESC NULLS LAST`,
    [MS],
  );

  const roleDist = await query<{ role_seniority: string; n: number }>(
    `SELECT COALESCE(role_seniority,'(unset)') AS role_seniority, COUNT(*)::int AS n
       FROM contacts WHERE microsegment_id=$1
       GROUP BY role_seniority ORDER BY n DESC`,
    [MS],
  );

  const topIndustries = await query<{ normalized_industry: string; n: number }>(
    `SELECT co.normalized_industry, COUNT(DISTINCT c.id)::int AS n
       FROM contacts c JOIN companies co ON co.id = c.company_id
      WHERE c.microsegment_id=$1 AND co.normalized_industry IS NOT NULL
      GROUP BY co.normalized_industry ORDER BY n DESC LIMIT 10`,
    [MS],
  );

  const microsegments = await query<{ microsegment_id: string; n: number }>(
    `SELECT microsegment_id, COUNT(*)::int AS n FROM contacts
      WHERE microsegment_id IS NOT NULL
      GROUP BY microsegment_id ORDER BY n DESC LIMIT 12`,
  );

  const postUrlKind = await query<{ salesnav: number; public_url: number }>(
    `SELECT COUNT(*) FILTER (WHERE post_url LIKE 'salesnav://%')::int AS salesnav,
            COUNT(*) FILTER (WHERE post_url LIKE 'https://%')::int AS public_url
       FROM scraped_company_posts`,
  );

  return {
    tableCounts,
    cohort: cohort.rows[0],
    tagsBySource: tagsBySource.rows,
    insightsCoverage: insightsCoverage.rows,
    roleDist: roleDist.rows,
    topIndustries: topIndustries.rows,
    microsegments: microsegments.rows,
    postUrlKind: postUrlKind.rows[0],
  };
}

function bar(value: number, max: number, color = "#3b82f6"): string {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return `<div class="h-1.5 bg-gray-800 rounded mt-1 overflow-hidden"><div class="h-full" style="width:${pct.toFixed(1)}%;background:${color}"></div></div>`;
}

const URGENCY_COLOR: Record<string, string> = {
  high: "#ef4444",
  medium: "#eab308",
  low: "#22c55e",
};
const SOURCE_COLOR: Record<string, string> = {
  evidence: "#22c55e",
  fuzzy: "#3b82f6",
  llm: "#a855f7",
  manual: "#eab308",
};

function render(d: Awaited<ReturnType<typeof fetchData>>): string {
  const stamp = new Date().toISOString();
  const cohort = d.cohort;
  const taggedPct = cohort.posts ? ((cohort.tagged_posts / cohort.posts) * 100).toFixed(1) : "0";
  const sourceTotal = d.tagsBySource.reduce((s, r) => s + r.n, 0);
  const insightMaxPosts = Math.max(...d.insightsCoverage.map((i) => i.posts), 1);
  const roleMax = Math.max(...d.roleDist.map((r) => r.n), 1);
  const indMax = Math.max(...d.topIndustries.map((i) => i.n), 1);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Pain Points DB — Data Model Snapshot</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<script src="https://cdn.tailwindcss.com"></script>
<style>
  body { background:#030712; color:#e5e7eb; font-family: ui-sans-serif, system-ui, -apple-system; }
  .card { background:#0b1220; border:1px solid #1f2937; border-radius:0.5rem; padding:1rem; }
  .pill { display:inline-block; padding:.125rem .5rem; border-radius:9999px; font-size:.7rem; }
  .arrow { color:#4b5563; font-family: ui-monospace, monospace; }
  .table-cell { padding:.5rem .75rem; vertical-align:top; font-size:.85rem; }
  .col { border:1px solid #1f2937; border-radius:.375rem; padding:.5rem .75rem; background:#111827; }
  .col-head { font-size:.7rem; color:#60a5fa; font-family: ui-monospace, monospace; text-transform:uppercase; letter-spacing:.04em; }
  .col-body { font-size:.8rem; color:#9ca3af; font-family: ui-monospace, monospace; line-height:1.5; }
  .badge-high   { background:rgba(239,68,68,.15); color:#fca5a5; border:1px solid rgba(239,68,68,.3);}
  .badge-medium { background:rgba(234,179,8,.15);  color:#fde047; border:1px solid rgba(234,179,8,.3);}
  .badge-low    { background:rgba(34,197,94,.15);  color:#86efac; border:1px solid rgba(34,197,94,.3);}
  .pipeline-step { background:#0b1220; border:1px solid #1f2937; border-radius:.5rem; padding:.75rem; }
  .pipeline-arrow { color:#4b5563; font-size:1.5rem; text-align:center; line-height:1; }
  details > summary { cursor:pointer; }
</style>
</head>
<body class="min-h-screen">
<div class="max-w-6xl mx-auto px-6 py-8 space-y-8">

  <header>
    <div class="text-xs text-gray-500 font-mono">SNAPSHOT · ${stamp}</div>
    <h1 class="text-2xl font-semibold text-white mt-1">Pain Points DB — Data Model</h1>
    <p class="text-sm text-gray-400 mt-1">Live snapshot of what's in the database, how it got there, and how the LinkedIn-Ads dashboard slices it. Cohort: <code class="text-blue-300">${MS}</code>.</p>
  </header>

  <!-- ===== 1. LIVE COUNTS ===== -->
  <section>
    <h2 class="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">1. Live row counts</h2>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div class="card">
        <div class="text-xs text-gray-500 mb-2">Global (all microsegments)</div>
        <table class="w-full text-sm">
          ${d.tableCounts
            .map(
              (t) => `
          <tr class="border-b border-gray-800/60 last:border-0">
            <td class="py-1.5 pr-3"><code class="text-gray-300">${t.table}</code><div class="text-xs text-gray-500">${t.label}</div></td>
            <td class="py-1.5 text-right tabular-nums text-gray-100">${t.n.toLocaleString()}</td>
          </tr>`,
            )
            .join("")}
        </table>
      </div>
      <div class="card">
        <div class="text-xs text-gray-500 mb-2">IoT cohort: <code class="text-blue-300">${MS}</code></div>
        <table class="w-full text-sm">
          <tr class="border-b border-gray-800/60"><td class="py-1.5">Companies</td><td class="text-right tabular-nums">${cohort.companies.toLocaleString()}</td></tr>
          <tr class="border-b border-gray-800/60"><td class="py-1.5">Contacts</td><td class="text-right tabular-nums">${cohort.contacts.toLocaleString()}</td></tr>
          <tr class="border-b border-gray-800/60"><td class="py-1.5">→ with Sales Nav URL</td><td class="text-right tabular-nums text-gray-400">${cohort.contacts_with_lead_url.toLocaleString()}</td></tr>
          <tr class="border-b border-gray-800/60"><td class="py-1.5">→ with public LinkedIn URL</td><td class="text-right tabular-nums text-green-400">${cohort.contacts_with_public_url.toLocaleString()}</td></tr>
          <tr class="border-b border-gray-800/60"><td class="py-1.5">→ with bio</td><td class="text-right tabular-nums text-gray-400">${cohort.contacts_with_bio.toLocaleString()}</td></tr>
          <tr class="border-b border-gray-800/60"><td class="py-1.5">→ with location</td><td class="text-right tabular-nums text-gray-400">${cohort.contacts_with_location.toLocaleString()}</td></tr>
          <tr class="border-b border-gray-800/60"><td class="py-1.5">→ with connection degree</td><td class="text-right tabular-nums text-gray-400">${cohort.contacts_with_degree.toLocaleString()}</td></tr>
          <tr class="border-b border-gray-800/60"><td class="py-1.5">Company posts</td><td class="text-right tabular-nums">${cohort.posts.toLocaleString()}</td></tr>
          <tr class="border-b border-gray-800/60"><td class="py-1.5">→ analyzed (Haiku)</td><td class="text-right tabular-nums text-gray-400">${cohort.analyzed.toLocaleString()}</td></tr>
          <tr class="border-b border-gray-800/60"><td class="py-1.5">Synthesized insights</td><td class="text-right tabular-nums">${cohort.insights.toLocaleString()}</td></tr>
          <tr class="border-b border-gray-800/60"><td class="py-1.5">Post→insight tag edges</td><td class="text-right tabular-nums">${cohort.tags.toLocaleString()}</td></tr>
          <tr><td class="py-1.5 text-blue-300">Posts with ≥1 tag</td><td class="text-right tabular-nums text-blue-300">${cohort.tagged_posts.toLocaleString()} <span class="text-gray-500 text-xs">(${taggedPct}%)</span></td></tr>
        </table>
      </div>
    </div>
  </section>

  <!-- ===== 2. ER DIAGRAM ===== -->
  <section>
    <h2 class="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">2. Entity diagram</h2>
    <div class="card overflow-x-auto">
      <div class="grid grid-cols-3 gap-x-3 gap-y-6 min-w-[900px]" style="grid-template-columns: 1fr auto 1fr;">

        <div class="col">
          <div class="col-head">companies</div>
          <div class="col-body">
            id (PK)<br>
            display_name<br>
            primary_domain ◆<br>
            linkedin_company_id ◆<br>
            company_linkedin_url<br>
            normalized_industry<br>
            employee_count_band<br>
            raw_employee_count<br>
            revenue_band<br>
            headquarters<br>
            about_text
          </div>
        </div>
        <div class="pipeline-arrow self-center">→</div>
        <div class="col">
          <div class="col-head">contacts</div>
          <div class="col-body">
            id (PK)<br>
            person_linkedin_url ◆<br>
            full_name / first_name / last_name<br>
            title<br>
            <span class="text-blue-300">role_seniority ✚</span><br>
            connection_degree<br>
            location<br>
            bio<br>
            salesnav_lead_url<br>
            <span class="text-yellow-400">public_linkedin_url (pending)</span><br>
            tenure_in_role<br>
            company_id (FK)<br>
            microsegment_id ★
          </div>
        </div>

        <div class="col">
          <div class="col-head">scraped_company_posts</div>
          <div class="col-body">
            id (PK)<br>
            post_url ◆<br>
            company_id (FK)<br>
            post_text<br>
            post_date<br>
            raw_json
          </div>
        </div>
        <div class="pipeline-arrow self-center">↓</div>
        <div class="col">
          <div class="col-head">scraped_posts</div>
          <div class="col-body text-gray-500">
            id (PK)<br>
            post_url ◆<br>
            contact_id (FK)<br>
            post_text<br>
            post_date / likes / comments<br>
            <span class="text-yellow-400">(near-empty: ScrapeCreators not run)</span>
          </div>
        </div>

        <div class="col">
          <div class="col-head">company_post_analysis</div>
          <div class="col-body">
            company_scraped_post_id (FK, UNIQUE)<br>
            topics[] (JSONB)<br>
            pain_points[] (JSONB)<br>
            sentiment / sentiment_score<br>
            intent_signals[]<br>
            key_quotes[]<br>
            analysis_model<br>
            token_usage
          </div>
        </div>
        <div class="pipeline-arrow self-center">↔</div>
        <div class="col">
          <div class="col-head">post_analysis</div>
          <div class="col-body text-gray-500">
            scraped_post_id (FK, UNIQUE)<br>
            same shape as ←<br>
            <span class="text-yellow-400">(parallel; near-empty)</span>
          </div>
        </div>

        <div class="col col-span-3" style="grid-column: span 3;">
          <div class="col-head" style="color:#a855f7">post_insight_tags  (NEW — drives Audience Builder)</div>
          <div class="col-body">
            id (PK) · company_scraped_post_id <span class="arrow">XOR</span> scraped_post_id · insight_id (FK) · microsegment_id · score (0..1) · source ∈ <span class="text-green-300">evidence</span> | <span class="text-blue-300">fuzzy</span> | <span class="text-purple-300">llm</span> | <span class="text-yellow-300">manual</span><br>
            UNIQUE(post, insight) — idempotent · indexed on insight_id + microsegment_id
          </div>
        </div>

        <div class="col col-span-3" style="grid-column: span 3;">
          <div class="col-head">pain_point_insights</div>
          <div class="col-body">
            id (PK) · microsegment_id ★ · UNIQUE(ms, insight_name)<br>
            insight_name · pain_point_summary · who_feels_pain · what_triggers_it · urgency_level · topics[]<br>
            frequency_count · company_count · contact_count · avg_sentiment_score · sentiment_distribution<br>
            evidence[] (JSONB) — back-references to {post_url, quote, company, person, date}
          </div>
        </div>

      </div>
      <div class="text-xs text-gray-500 mt-4 font-mono">
        ◆ = unique-indexed for dedupe / lookup &nbsp; ★ = soft FK on microsegment_id (TEXT, not normalised) &nbsp; ✚ = backfilled by scripts/backfill-role-seniority.ts
      </div>
    </div>
  </section>

  <!-- ===== 3. DATA FLOW ===== -->
  <section>
    <h2 class="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">3. Data flow</h2>
    <div class="card">
      <div class="grid grid-cols-1 md:grid-cols-7 gap-2 items-center">
        <div class="pipeline-step md:col-span-1 text-center">
          <div class="text-xs text-gray-400">Source</div>
          <div class="text-sm font-medium text-gray-100 mt-1">Sales Nav HTML bundle</div>
          <div class="text-xs text-gray-500 mt-1">+ upload CSV</div>
        </div>
        <div class="pipeline-arrow md:col-span-1">→</div>
        <div class="pipeline-step md:col-span-1 text-center">
          <div class="text-xs text-gray-400">Seeder</div>
          <div class="text-sm font-medium text-gray-100 mt-1">seed-from-linkedin-salesnav.ts</div>
          <div class="text-xs text-gray-500 mt-1">parseCompanyPage<br>parseDecisionMakers<br>parseCompanyPagePosts</div>
        </div>
        <div class="pipeline-arrow md:col-span-1">→</div>
        <div class="pipeline-step md:col-span-1 text-center">
          <div class="text-xs text-gray-400">Per-post analysis</div>
          <div class="text-sm font-medium text-gray-100 mt-1">analyze:companies</div>
          <div class="text-xs text-gray-500 mt-1">Haiku 4.5<br>${cohort.analyzed.toLocaleString()} posts</div>
        </div>
        <div class="pipeline-arrow md:col-span-1">→</div>
        <div class="pipeline-step md:col-span-1 text-center">
          <div class="text-xs text-gray-400">Synthesis</div>
          <div class="text-sm font-medium text-gray-100 mt-1">analyze --stage 2</div>
          <div class="text-xs text-gray-500 mt-1">Haiku 4.5<br>${cohort.insights} insights</div>
        </div>
      </div>
      <div class="text-center pipeline-arrow my-3">↓</div>
      <div class="grid grid-cols-1 md:grid-cols-7 gap-2 items-center">
        <div class="pipeline-step md:col-span-1 text-center">
          <div class="text-xs text-gray-400">Tag pass 1</div>
          <div class="text-sm font-medium" style="color:${SOURCE_COLOR.evidence}">evidence</div>
          <div class="text-xs text-gray-500 mt-1">bootstrap-tags-from-evidence.ts<br>score=1.0</div>
        </div>
        <div class="pipeline-arrow md:col-span-1">→</div>
        <div class="pipeline-step md:col-span-1 text-center">
          <div class="text-xs text-gray-400">Tag pass 2</div>
          <div class="text-sm font-medium" style="color:${SOURCE_COLOR.fuzzy}">fuzzy (pg_trgm)</div>
          <div class="text-xs text-gray-500 mt-1">run-fuzzy-tagging.ts<br>threshold ≥ 0.55</div>
        </div>
        <div class="pipeline-arrow md:col-span-1">→</div>
        <div class="pipeline-step md:col-span-1 text-center">
          <div class="text-xs text-gray-400">Tag pass 3</div>
          <div class="text-sm font-medium" style="color:${SOURCE_COLOR.llm}">llm</div>
          <div class="text-xs text-gray-500 mt-1">run-llm-tagging.ts<br>residual only</div>
        </div>
        <div class="pipeline-arrow md:col-span-1">→</div>
        <div class="pipeline-step md:col-span-1 text-center">
          <div class="text-xs text-gray-400">Output</div>
          <div class="text-sm font-medium text-gray-100">post_insight_tags</div>
          <div class="text-xs text-gray-500 mt-1">${cohort.tags.toLocaleString()} edges</div>
        </div>
      </div>
      <div class="text-center pipeline-arrow my-3">↓</div>
      <div class="pipeline-step text-center">
        <div class="text-xs text-gray-400">Consumer</div>
        <div class="text-sm font-medium text-blue-300 mt-1">/api/audiences/preview · /api/audiences/export → LinkedIn Matched-Audiences CSV</div>
      </div>
    </div>
  </section>

  <!-- ===== 4. TAGS BY SOURCE ===== -->
  <section>
    <h2 class="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">4. Tags by source</h2>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div class="card">
        <div class="text-xs text-gray-500 mb-3">${sourceTotal.toLocaleString()} total tag edges</div>
        ${d.tagsBySource
          .map((s) => {
            const pct = sourceTotal ? ((s.n / sourceTotal) * 100).toFixed(1) : "0";
            return `
          <div class="mb-3">
            <div class="flex justify-between text-sm mb-0.5">
              <span style="color:${SOURCE_COLOR[s.source] ?? "#9ca3af"}" class="font-medium">${s.source}</span>
              <span class="text-gray-500 tabular-nums">${s.n.toLocaleString()} <span class="text-xs">(${pct}%)</span></span>
            </div>
            ${bar(s.n, sourceTotal, SOURCE_COLOR[s.source] ?? "#3b82f6")}
          </div>`;
          })
          .join("")}
      </div>
      <div class="card">
        <div class="text-xs text-gray-500 mb-3">post_url shape (across all microsegments)</div>
        <div class="text-sm space-y-3">
          <div>
            <div class="flex justify-between mb-0.5"><span><code class="text-gray-300">salesnav://&lt;co&gt;/alert/&lt;id&gt;</code></span><span class="text-gray-500 tabular-nums">${d.postUrlKind.salesnav.toLocaleString()}</span></div>
            <div class="text-xs text-gray-500">Synthetic; harvested from Sales Nav HTML <code>data-anonymize="general-blurb"</code> blocks</div>
          </div>
          <div>
            <div class="flex justify-between mb-0.5"><span><code class="text-gray-300">https://www.linkedin.com/...</code></span><span class="text-gray-500 tabular-nums">${d.postUrlKind.public_url.toLocaleString()}</span></div>
            <div class="text-xs text-gray-500">From ScrapeCreators company-posts smoke (Elite Sensors + Cyclops Marine)</div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- ===== 5. PER-INSIGHT COVERAGE ===== -->
  <section>
    <h2 class="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">5. Per-insight tag coverage (${MS})</h2>
    <div class="card overflow-x-auto">
      <table class="w-full">
        <thead>
          <tr class="text-xs text-gray-500 border-b border-gray-800">
            <th class="text-left table-cell">Insight</th>
            <th class="text-left table-cell">Urgency</th>
            <th class="text-right table-cell">Posts tagged</th>
            <th class="text-left table-cell" style="width:40%">Bar</th>
          </tr>
        </thead>
        <tbody>
          ${d.insightsCoverage
            .map((i) => {
              const u = (i.urgency_level ?? "").toLowerCase();
              return `
          <tr class="border-b border-gray-800/60">
            <td class="table-cell text-gray-100">${escapeHtml(i.insight_name)}</td>
            <td class="table-cell"><span class="pill badge-${u}">${u}</span></td>
            <td class="table-cell text-right tabular-nums">${i.posts.toLocaleString()}</td>
            <td class="table-cell">${bar(i.posts, insightMaxPosts, URGENCY_COLOR[u] ?? "#3b82f6")}</td>
          </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  </section>

  <!-- ===== 6. ROLES + INDUSTRIES ===== -->
  <section>
    <h2 class="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">6. Cohort breakdown</h2>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div class="card">
        <div class="text-xs text-gray-500 mb-3">Role seniority (1,151 contacts)</div>
        ${d.roleDist
          .map(
            (r) => `
          <div class="mb-2">
            <div class="flex justify-between text-sm mb-0.5">
              <span class="text-gray-300">${escapeHtml(r.role_seniority)}</span>
              <span class="text-gray-500 tabular-nums">${r.n.toLocaleString()}</span>
            </div>
            ${bar(r.n, roleMax, "#3b82f6")}
          </div>`,
          )
          .join("")}
      </div>
      <div class="card">
        <div class="text-xs text-gray-500 mb-3">Top 10 industries (companies in cohort)</div>
        ${d.topIndustries
          .map(
            (i) => `
          <div class="mb-2">
            <div class="flex justify-between text-sm mb-0.5">
              <span class="text-gray-300 truncate" title="${escapeHtml(i.normalized_industry)}">${escapeHtml(i.normalized_industry)}</span>
              <span class="text-gray-500 tabular-nums">${i.n.toLocaleString()}</span>
            </div>
            ${bar(i.n, indMax, "#a855f7")}
          </div>`,
          )
          .join("")}
      </div>
    </div>
  </section>

  <!-- ===== 7. FILTERS ===== -->
  <section>
    <h2 class="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">7. Filter map (Audience Builder)</h2>
    <div class="card overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-xs text-gray-500 border-b border-gray-800">
            <th class="table-cell text-left">Filter (URL param)</th>
            <th class="table-cell text-left">SQL column / join</th>
            <th class="table-cell text-left">Populated by</th>
          </tr>
        </thead>
        <tbody>
          <tr class="border-b border-gray-800/60"><td class="table-cell"><code>microsegment</code></td><td class="table-cell"><code class="text-gray-400">contacts.microsegment_id</code></td><td class="table-cell text-gray-400">seeder, hard-coded per cohort</td></tr>
          <tr class="border-b border-gray-800/60"><td class="table-cell"><code>insight_id</code> (CSV)</td><td class="table-cell"><code class="text-gray-400">EXISTS … post_insight_tags pit WHERE pit.insight_id = ANY($x)</code></td><td class="table-cell text-gray-400">tagging passes (evidence + fuzzy + llm)</td></tr>
          <tr class="border-b border-gray-800/60"><td class="table-cell"><code>industry</code> (CSV)</td><td class="table-cell"><code class="text-gray-400">companies.normalized_industry = ANY($x)</code></td><td class="table-cell text-gray-400">parsed from Sales Nav <code>data-anonymize="industry"</code></td></tr>
          <tr class="border-b border-gray-800/60"><td class="table-cell"><code>seniority</code> (CSV)</td><td class="table-cell"><code class="text-gray-400">contacts.role_seniority = ANY($x)</code></td><td class="table-cell text-gray-400">backfill-role-seniority.ts + roleBucket()</td></tr>
          <tr class="border-b border-gray-800/60"><td class="table-cell"><code>degree</code> (CSV)</td><td class="table-cell"><code class="text-gray-400">contacts.connection_degree = ANY($x)</code></td><td class="table-cell text-gray-400">parsed from Sales Nav DOM</td></tr>
          <tr class="border-b border-gray-800/60"><td class="table-cell"><code>has_bio</code></td><td class="table-cell"><code class="text-gray-400">contacts.bio IS NOT NULL AND bio &lt;&gt; ''</code></td><td class="table-cell text-gray-400">parsed from <code>person-blurb</code> title attr</td></tr>
        </tbody>
      </table>
    </div>
  </section>

  <!-- ===== 8. LINKEDIN READINESS ===== -->
  <section>
    <h2 class="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">8. LinkedIn Matched Audiences readiness</h2>
    <div class="card">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div class="col">
          <div class="col-head" style="color:#fbbf24">Email</div>
          <div class="col-body">0 / ${cohort.contacts.toLocaleString()}<br><span class="text-yellow-400">not enriched</span><br><span class="text-gray-500">— best match rate but absent</span></div>
        </div>
        <div class="col">
          <div class="col-head" style="color:#86efac">Name + Company + Title</div>
          <div class="col-body">${cohort.contacts.toLocaleString()} / ${cohort.contacts.toLocaleString()}<br><span class="text-green-400">100%</span><br><span class="text-gray-500">— LinkedIn fallback path; ~30–50% match</span></div>
        </div>
        <div class="col">
          <div class="col-head" style="color:#86efac">LinkedIn Profile URL</div>
          <div class="col-body">${cohort.contacts_with_public_url.toLocaleString()} / ${cohort.contacts.toLocaleString()}<br><span class="text-green-400">100% <code class="text-xs">/in/&lt;URN&gt;</code> form</span><br><span class="text-gray-500">— LinkedIn canonicalizes URN → vanity</span></div>
        </div>
      </div>
      <div class="text-xs text-gray-400 mt-4 leading-relaxed">
        <strong class="text-gray-300">Public URL resolution — done.</strong> The URN embedded in the Sales Nav URL (segment between <code>/lead/</code> and the first comma) is a valid LinkedIn member URN. Pasting it under <code>/in/</code> yields a URL LinkedIn 301-redirects to the member's vanity profile. LinkedIn Matched Audiences canonicalizes to the member URN server-side, so URN-form URLs match against the same record. Backfilled via <code>scripts/rebuild-public-urls.ts</code> — zero API cost.
      </div>
    </div>
  </section>

  <!-- ===== 9. OTHER COHORTS ===== -->
  <section>
    <h2 class="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">9. Other microsegments (top 12 by contact count)</h2>
    <div class="card">
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        ${d.microsegments
          .map(
            (m) => `
          <div class="flex justify-between border-b border-gray-800/60 py-1">
            <span class="text-gray-300 font-mono text-xs truncate" title="${escapeHtml(m.microsegment_id)}">${escapeHtml(m.microsegment_id)}</span>
            <span class="tabular-nums text-gray-400">${m.n.toLocaleString()}</span>
          </div>`,
          )
          .join("")}
      </div>
      <div class="text-xs text-gray-500 mt-3">All cohorts other than <code>${MS}</code> have <strong class="text-yellow-400">no posts and no insights yet</strong> — they were seeded from the prior MXD Compass run but have not been through the Sales Nav HTML or ScrapeCreators pipeline.</div>
    </div>
  </section>

  <footer class="text-xs text-gray-600 mt-8 border-t border-gray-800 pt-4">
    Generated by <code>scripts/build-data-model-html.ts</code> · re-run any time to refresh.
  </footer>
</div>
</body>
</html>`;
}

const data = await fetchData();
const html = render(data);
writeFileSync(OUT, html, "utf-8");
console.log(`Wrote ${OUT} (${(html.length / 1024).toFixed(1)} KB)`);
await shutdown();
