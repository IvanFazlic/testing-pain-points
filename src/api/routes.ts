import type { Express, Request, Response } from "express";
import { query } from "../db/connection.js";
import { sendAudienceCsv, type AudienceRow } from "../services/audience-export.js";

// Parse a comma-separated query param into a string[] or null (meaning "no filter").
function parseCsvParam(raw: unknown): string[] | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : null;
}

function parseIntListParam(raw: unknown): number[] | null {
  const s = parseCsvParam(raw);
  if (!s) return null;
  const nums = s.map((v) => Number(v)).filter((n) => Number.isFinite(n));
  return nums.length > 0 ? nums : null;
}

// Parse a recency window like "30d", "90d", "365d", "12m". Returns days (int) or null.
// For LinkedIn ads, fresher pain-points convert better; this lets the builder exclude
// stale signal without re-tagging anything.
function parseSinceParam(raw: unknown): number | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const m = raw.trim().match(/^(\d+)\s*([dm])$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (!Number.isFinite(n) || n <= 0) return null;
  return unit === "m" ? n * 30 : n;
}

// Shared audience-filter parser used by /contacts, /audiences/preview, /audiences/export.
// Returns clauses + params; caller owns the "microsegment" clause since the param index
// depends on whether it's required.
interface AudienceFilters {
  insightIds: number[] | null;
  industries: string[] | null;
  seniorities: string[] | null;
  degrees: string[] | null;
  hasBio: boolean;
  sinceDays: number | null;
}

function parseAudienceFilters(req: Request): AudienceFilters {
  return {
    insightIds: parseIntListParam(req.query.insight_id),
    industries: parseCsvParam(req.query.industry),
    seniorities: parseCsvParam(req.query.seniority),
    degrees: parseCsvParam(req.query.degree),
    hasBio: req.query.has_bio === "true",
    sinceDays: parseSinceParam(req.query.since),
  };
}

function applyAudienceFilters(
  f: AudienceFilters,
  clauses: string[],
  params: any[],
): void {
  if (f.industries) {
    params.push(f.industries);
    clauses.push(`co.normalized_industry = ANY($${params.length}::text[])`);
  }
  if (f.seniorities) {
    params.push(f.seniorities);
    clauses.push(`c.role_seniority = ANY($${params.length}::text[])`);
  }
  if (f.degrees) {
    params.push(f.degrees);
    clauses.push(`c.connection_degree = ANY($${params.length}::text[])`);
  }
  if (f.hasBio) clauses.push(`c.bio IS NOT NULL AND c.bio <> ''`);

  // Recency narrows to companies that have *a relevant recent post*. If an insight
  // filter is also set, the EXISTS below handles both; otherwise we just require any
  // post inside the window.
  if (f.insightIds || f.sinceDays) {
    const existsClauses: string[] = ["cp.company_id = c.company_id"];
    if (f.insightIds) {
      params.push(f.insightIds);
      existsClauses.push(`pit.insight_id = ANY($${params.length}::int[])`);
    }
    if (f.sinceDays) {
      params.push(f.sinceDays);
      existsClauses.push(`cp.post_date >= NOW() - ($${params.length}::int * INTERVAL '1 day')`);
    }
    const join = f.insightIds
      ? `JOIN post_insight_tags pit ON pit.company_scraped_post_id = cp.id`
      : "";
    clauses.push(
      `EXISTS (SELECT 1 FROM scraped_company_posts cp ${join} WHERE ${existsClauses.join(" AND ")})`,
    );
  }
}

export function registerRoutes(app: Express) {
  // ---- Overview ----
  app.get("/api/overview", async (_req: Request, res: Response) => {
    const { rows: segments } = await query(`
      SELECT
        ms.microsegment_id,
        ms.microsegment_label,
        ms.contact_count,
        COALESCE(indiv.post_count, 0) + COALESCE(comp.post_count, 0) AS post_count,
        COALESCE(indiv.analyzed_count, 0) + COALESCE(comp.analyzed_count, 0) AS analyzed_count,
        COALESCE(ins.insight_count, 0) AS insight_count
      FROM (
        SELECT microsegment_id, microsegment_label, COUNT(*) AS contact_count
        FROM contacts WHERE microsegment_id IS NOT NULL
        GROUP BY microsegment_id, microsegment_label
      ) ms
      LEFT JOIN (
        SELECT c.microsegment_id,
               COUNT(DISTINCT sp.id) AS post_count,
               COUNT(DISTINCT pa.id) AS analyzed_count
        FROM contacts c
        JOIN scraped_posts sp ON sp.contact_id = c.id
        LEFT JOIN post_analysis pa ON pa.scraped_post_id = sp.id
        GROUP BY c.microsegment_id
      ) indiv ON indiv.microsegment_id = ms.microsegment_id
      LEFT JOIN (
        SELECT c.microsegment_id,
               COUNT(DISTINCT cp.id) AS post_count,
               COUNT(DISTINCT cpa.id) AS analyzed_count
        FROM contacts c
        JOIN scraped_company_posts cp ON cp.company_id = c.company_id
        LEFT JOIN company_post_analysis cpa ON cpa.company_scraped_post_id = cp.id
        GROUP BY c.microsegment_id
      ) comp ON comp.microsegment_id = ms.microsegment_id
      LEFT JOIN (
        SELECT microsegment_id, COUNT(*) AS insight_count
        FROM pain_point_insights GROUP BY microsegment_id
      ) ins ON ins.microsegment_id = ms.microsegment_id
      ORDER BY ms.contact_count DESC
    `);

    const { rows: totals } = await query(`
      SELECT
        (SELECT COUNT(*) FROM contacts) AS total_contacts,
        (SELECT COUNT(*) FROM companies) AS total_companies,
        (SELECT COUNT(*) FROM scraped_posts) + (SELECT COUNT(*) FROM scraped_company_posts) AS total_posts,
        (SELECT COUNT(*) FROM post_analysis) + (SELECT COUNT(*) FROM company_post_analysis) AS total_analyzed,
        (SELECT COUNT(*) FROM pain_point_insights) AS total_insights
    `);

    res.json({ totals: totals[0], segments });
  });

  // ---- Insights for a microsegment ----
  app.get("/api/insights/:msId", async (req: Request, res: Response) => {
    const { msId } = req.params;

    const { rows: insights } = await query(
      `SELECT * FROM pain_point_insights WHERE microsegment_id = $1 ORDER BY frequency_count DESC`,
      [msId],
    );

    const { rows: stats } = await query(
      `SELECT
         (SELECT COUNT(*) FROM contacts WHERE microsegment_id = $1) AS contact_count,
         (SELECT COUNT(DISTINCT co.id) FROM companies co
          JOIN contacts c ON c.company_id = co.id
          WHERE c.microsegment_id = $1) AS company_count,
         (SELECT COUNT(*) FROM contacts c
          JOIN scraped_posts sp ON sp.contact_id = c.id
          WHERE c.microsegment_id = $1)
         + (SELECT COUNT(*) FROM contacts c
            JOIN scraped_company_posts cp ON cp.company_id = c.company_id
            WHERE c.microsegment_id = $1) AS post_count,
         (SELECT COUNT(*) FROM contacts c
          JOIN scraped_posts sp ON sp.contact_id = c.id
          JOIN post_analysis pa ON pa.scraped_post_id = sp.id
          WHERE c.microsegment_id = $1)
         + (SELECT COUNT(*) FROM contacts c
            JOIN scraped_company_posts cp ON cp.company_id = c.company_id
            JOIN company_post_analysis cpa ON cpa.company_scraped_post_id = cp.id
            WHERE c.microsegment_id = $1) AS analyzed_count,
         (SELECT AVG(x.sentiment_score) FROM (
            SELECT pa.sentiment_score
            FROM contacts c
            JOIN scraped_posts sp ON sp.contact_id = c.id
            JOIN post_analysis pa ON pa.scraped_post_id = sp.id
            WHERE c.microsegment_id = $1
            UNION ALL
            SELECT cpa.sentiment_score
            FROM contacts c
            JOIN scraped_company_posts cp ON cp.company_id = c.company_id
            JOIN company_post_analysis cpa ON cpa.company_scraped_post_id = cp.id
            WHERE c.microsegment_id = $1
          ) x) AS avg_sentiment`,
      [msId],
    );

    const { rows: labelRows } = await query(
      `SELECT DISTINCT microsegment_label FROM contacts WHERE microsegment_id = $1 LIMIT 1`,
      [msId],
    );

    res.json({
      microsegment_id: msId,
      microsegment_label: labelRows[0]?.microsegment_label ?? msId,
      stats: stats[0],
      insights,
    });
  });

  // ---- Posts for a microsegment (paginated) ----
  app.get("/api/insights/:msId/posts", async (req: Request, res: Response) => {
    const { msId } = req.params;
    const page = Math.max(1, Number(req.query.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)));
    const offset = (page - 1) * limit;
    const topicFilter = req.query.topic as string | undefined;
    const sentimentFilter = req.query.sentiment as string | undefined;

    let where = `c.microsegment_id = $1`;
    const params: any[] = [msId];
    let paramIdx = 2;

    if (topicFilter) {
      where += ` AND pa.topics::text ILIKE $${paramIdx}`;
      params.push(`%${topicFilter}%`);
      paramIdx++;
    }
    if (sentimentFilter) {
      where += ` AND pa.sentiment = $${paramIdx}`;
      params.push(sentimentFilter);
      paramIdx++;
    }

    const { rows: posts } = await query(
      `SELECT * FROM (
         SELECT sp.id, sp.post_url, sp.post_title, sp.post_text, sp.post_date,
                sp.like_count, sp.comment_count,
                c.full_name, c.first_name, c.title AS author_title,
                co.display_name AS company_name, 'individual' AS source,
                pa.topics, pa.pain_points, pa.sentiment, pa.sentiment_score,
                pa.intent_signals, pa.key_quotes
         FROM scraped_posts sp
         JOIN contacts c ON sp.contact_id = c.id
         LEFT JOIN companies co ON c.company_id = co.id
         LEFT JOIN post_analysis pa ON pa.scraped_post_id = sp.id
         WHERE ${where}
         UNION ALL
         SELECT cp.id, cp.post_url, NULL AS post_title, cp.post_text, cp.post_date,
                0 AS like_count, 0 AS comment_count,
                co.display_name AS full_name, NULL AS first_name, 'Company Page' AS author_title,
                co.display_name AS company_name, 'company' AS source,
                cpa.topics, cpa.pain_points, cpa.sentiment, cpa.sentiment_score,
                cpa.intent_signals, cpa.key_quotes
         FROM scraped_company_posts cp
         JOIN companies co ON cp.company_id = co.id
         LEFT JOIN company_post_analysis cpa ON cpa.company_scraped_post_id = cp.id
         WHERE EXISTS (SELECT 1 FROM contacts c WHERE c.company_id = co.id AND c.microsegment_id = $1)
       ) u
       ORDER BY post_date DESC NULLS LAST
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset],
    );

    const { rows: countRows } = await query(
      `SELECT
         ((SELECT COUNT(*) FROM scraped_posts sp
           JOIN contacts c ON sp.contact_id = c.id
           LEFT JOIN post_analysis pa ON pa.scraped_post_id = sp.id
           WHERE ${where})
          + (SELECT COUNT(*) FROM scraped_company_posts cp
             JOIN companies co ON cp.company_id = co.id
             WHERE EXISTS (SELECT 1 FROM contacts c WHERE c.company_id = co.id AND c.microsegment_id = $1))
         ) AS total`,
      params,
    );

    res.json({
      page,
      limit,
      total: Number(countRows[0]?.total ?? 0),
      posts,
    });
  });

  // ---- Company breakdown for a microsegment (enrichment from Sales Nav seed) ----
  app.get("/api/insights/:msId/company-breakdown", async (req: Request, res: Response) => {
    const { msId } = req.params;

    async function topN(field: string, limit = 10) {
      const { rows } = await query(
        `SELECT co.${field} AS label, COUNT(*)::int AS count
           FROM companies co
           JOIN contacts c ON c.company_id = co.id
          WHERE c.microsegment_id = $1
            AND co.${field} IS NOT NULL
            AND co.${field} <> ''
          GROUP BY co.${field}
          ORDER BY count DESC, label ASC
          LIMIT ${limit}`,
        [msId],
      );
      return rows;
    }

    const [industries, revenue_bands, employee_bands, hq_locations] = await Promise.all([
      topN("normalized_industry"),
      topN("revenue_band"),
      topN("employee_count_band"),
      topN("headquarters"),
    ]);

    res.json({ industries, revenue_bands, employee_bands, hq_locations });
  });

  // ---- Decision-maker stats for a microsegment ----
  // Powers the "Decision Makers" panel: role bucket counts, connection-degree
  // distribution, top contact locations, and bio coverage.
  app.get("/api/insights/:msId/contact-stats", async (req: Request, res: Response) => {
    const { msId } = req.params;

    const [roles, degrees, locations, bioCoverage] = await Promise.all([
      query(
        // role_seniority is populated by scripts/backfill-role-seniority.ts from the
        // shared src/lib/role-bucket.ts classifier.
        `SELECT COALESCE(role_seniority, 'Other') AS label, COUNT(*)::int AS count
           FROM contacts WHERE microsegment_id = $1
          GROUP BY label ORDER BY count DESC`,
        [msId],
      ),
      query(
        `SELECT connection_degree AS label, COUNT(*)::int AS count
           FROM contacts WHERE microsegment_id = $1 AND connection_degree IS NOT NULL
          GROUP BY connection_degree ORDER BY label`,
        [msId],
      ),
      query(
        `SELECT location AS label, COUNT(*)::int AS count
           FROM contacts WHERE microsegment_id = $1 AND location IS NOT NULL AND location <> ''
          GROUP BY location ORDER BY count DESC LIMIT 10`,
        [msId],
      ),
      query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(bio)::int AS with_bio,
           COUNT(salesnav_lead_url)::int AS with_lead_url
         FROM contacts WHERE microsegment_id = $1`,
        [msId],
      ),
    ]);

    res.json({
      roles: roles.rows,
      degrees: degrees.rows,
      locations: locations.rows,
      coverage: bioCoverage.rows[0] ?? { total: 0, with_bio: 0, with_lead_url: 0 },
    });
  });

  // ---- Topic frequency for a microsegment ----
  app.get("/api/insights/:msId/topics", async (req: Request, res: Response) => {
    const { msId } = req.params;

    const { rows } = await query(
      `SELECT topic, COUNT(*) AS count
       FROM (
         SELECT jsonb_array_elements_text(pa.topics) AS topic
         FROM post_analysis pa
         JOIN scraped_posts sp ON pa.scraped_post_id = sp.id
         JOIN contacts c ON sp.contact_id = c.id
         WHERE c.microsegment_id = $1
       ) sub
       GROUP BY topic
       ORDER BY count DESC
       LIMIT 30`,
      [msId],
    );

    res.json({ topics: rows });
  });

  // ---- Evidence for a specific insight ----
  app.get("/api/insights/:msId/evidence/:insightId", async (req: Request, res: Response) => {
    const { insightId } = req.params;

    const { rows } = await query(
      `SELECT * FROM pain_point_insights WHERE id = $1`,
      [insightId],
    );

    if (rows.length === 0) {
      res.status(404).json({ error: "Insight not found" });
      return;
    }

    const insight = rows[0];
    const evidenceUrls: string[] = (insight.evidence ?? []).map((e: any) => e.post_url);

    // Fetch full post details for evidence
    let evidencePosts: any[] = [];
    if (evidenceUrls.length > 0) {
      const placeholders = evidenceUrls.map((_, i) => `$${i + 1}`).join(",");
      const { rows: posts } = await query(
        `SELECT sp.*, c.full_name, c.first_name, c.title AS author_title,
                co.display_name AS company_name,
                pa.topics, pa.pain_points, pa.sentiment, pa.sentiment_score, pa.key_quotes
         FROM scraped_posts sp
         JOIN contacts c ON sp.contact_id = c.id
         LEFT JOIN companies co ON c.company_id = co.id
         LEFT JOIN post_analysis pa ON pa.scraped_post_id = sp.id
         WHERE sp.post_url IN (${placeholders})`,
        evidenceUrls,
      );
      evidencePosts = posts;
    }

    res.json({ insight, evidence_posts: evidencePosts });
  });

  // ---- CSV export ----
  app.get("/api/export/csv/:msId", async (req: Request, res: Response) => {
    const { msId } = req.params;

    const { rows: insights } = await query(
      `SELECT * FROM pain_point_insights WHERE microsegment_id = $1 ORDER BY frequency_count DESC`,
      [msId],
    );

    const header = [
      "insight_name",
      "pain_point_summary",
      "urgency_level",
      "frequency_count",
      "company_count",
      "contact_count",
      "avg_sentiment_score",
      "who_feels_pain",
      "what_triggers_it",
      "topics",
    ].join(",");

    const rows = insights.map((i) =>
      [
        `"${(i.insight_name ?? "").replace(/"/g, '""')}"`,
        `"${(i.pain_point_summary ?? "").replace(/"/g, '""')}"`,
        i.urgency_level,
        i.frequency_count,
        i.company_count,
        i.contact_count,
        i.avg_sentiment_score?.toFixed(2) ?? "",
        `"${(i.who_feels_pain ?? "").replace(/"/g, '""')}"`,
        `"${(i.what_triggers_it ?? "").replace(/"/g, '""')}"`,
        `"${(i.topics ?? []).join("; ")}"`,
      ].join(","),
    );

    const csv = [header, ...rows].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=pain-points-${msId}.csv`);
    res.send(csv);
  });

  // ---- Contacts list with full filter set ----
  // Filters: microsegment, insight_id (any-of match via post_insight_tags),
  // industry, seniority, degree, has_bio. Each filter is independent and optional;
  // missing filters leave the axis wide open.
  app.get("/api/contacts", async (req: Request, res: Response) => {
    const msId = req.query.microsegment as string | undefined;
    const filters = parseAudienceFilters(req);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const limit = Math.min(100, Number(req.query.limit ?? 50));
    const offset = (page - 1) * limit;

    const clauses: string[] = ["1=1"];
    const params: any[] = [];
    if (msId) {
      params.push(msId);
      clauses.push(`c.microsegment_id = $${params.length}`);
    }
    applyAudienceFilters(filters, clauses, params);

    const where = clauses.join(" AND ");

    const { rows: contacts } = await query(
      `SELECT c.*, co.display_name AS company_name,
              co.normalized_industry AS company_industry,
              (SELECT COUNT(*) FROM scraped_posts sp WHERE sp.contact_id = c.id) AS post_count,
              (SELECT COUNT(*) FROM scraped_posts sp
               JOIN post_analysis pa ON pa.scraped_post_id = sp.id
               WHERE sp.contact_id = c.id) AS analyzed_count
       FROM contacts c
       LEFT JOIN companies co ON c.company_id = co.id
       WHERE ${where}
       ORDER BY c.full_name
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );

    res.json({ page, limit, contacts });
  });

  // ---- Audience preview (counts by filter, for the builder UI) ----
  // Same filter semantics as /api/contacts but returns aggregates instead of rows.
  app.get("/api/audiences/preview", async (req: Request, res: Response) => {
    const msId = req.query.microsegment as string | undefined;
    if (!msId) {
      res.status(400).json({ error: "microsegment param is required" });
      return;
    }
    const filters = parseAudienceFilters(req);
    const clauses: string[] = ["c.microsegment_id = $1"];
    const params: any[] = [msId];
    applyAudienceFilters(filters, clauses, params);
    const where = clauses.join(" AND ");

    const [totalRes, byRoleRes, byIndustryRes] = await Promise.all([
      query(
        `SELECT COUNT(DISTINCT c.id)::int AS count
           FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
          WHERE ${where}`,
        params,
      ),
      query(
        `SELECT COALESCE(c.role_seniority, 'Other') AS label,
                COUNT(DISTINCT c.id)::int AS count
           FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
          WHERE ${where}
          GROUP BY label ORDER BY count DESC`,
        params,
      ),
      query(
        `SELECT co.normalized_industry AS label,
                COUNT(DISTINCT c.id)::int AS count
           FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
          WHERE ${where} AND co.normalized_industry IS NOT NULL
          GROUP BY label ORDER BY count DESC LIMIT 10`,
        params,
      ),
    ]);

    res.json({
      count: totalRes.rows[0]?.count ?? 0,
      by_role: byRoleRes.rows,
      by_industry: byIndustryRes.rows,
    });
  });

  // ---- Audience export (LinkedIn Matched Audiences CSV) ----
  // Same filter surface as /audiences/preview. Emits a URL-only CSV
  // (first_name,last_name,email,company,job_title,country,linkedin_url)
  // with X-Audience-Size header so the UI can show "Exporting N contacts".
  app.get("/api/audiences/export", async (req: Request, res: Response) => {
    const msId = req.query.microsegment as string | undefined;
    if (!msId) {
      res.status(400).json({ error: "microsegment param is required" });
      return;
    }
    const filters = parseAudienceFilters(req);
    const clauses: string[] = ["c.microsegment_id = $1"];
    const params: any[] = [msId];
    applyAudienceFilters(filters, clauses, params);
    const where = clauses.join(" AND ");

    const { rows } = await query<AudienceRow>(
      `SELECT DISTINCT ON (c.id)
              c.first_name, c.last_name, c.title AS job_title, c.location,
              c.public_linkedin_url, c.salesnav_lead_url, c.person_linkedin_url,
              co.display_name AS company
         FROM contacts c
         LEFT JOIN companies co ON co.id = c.company_id
        WHERE ${where}
        ORDER BY c.id`,
      params,
    );

    const insightSuffix = filters.insightIds ? `-i${filters.insightIds.join("_")}` : "";
    const sinceSuffix = filters.sinceDays ? `-${filters.sinceDays}d` : "";
    const filename = `audience-${msId}${insightSuffix}${sinceSuffix}.csv`;
    sendAudienceCsv(res, rows, filename);
  });
}
