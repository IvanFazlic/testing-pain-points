/**
 * Seed companies + contacts from a LinkedIn Sales Navigator scrape bundle.
 *
 * Input bundle (default: the sibling `linkedin_account/linkedin_account` folder):
 *   - `upload_UK ex-London Industrial IoT Sensing and Monitoring.csv`  (seed list, 559 rows)
 *   - `linkedin_sales_nav_*.csv`                                        (Sales Nav export, 511 rows)
 *   - `scraped html/company_<id>_page.html`                             (215 company pages)
 *   - `scraped html/company_<id>_decision_makers.html`                  (215 DM snapshots)
 *
 * Writes:
 *   - `companies` rows (keyed on linkedin_company_id; primary_domain + enrichment populated)
 *   - `contacts`  rows (person_linkedin_url = salesnav lead URL; tagged with the cohort microsegment)
 *
 * The downstream pipeline (`npm run scrape:companies` → `analyze:companies` → `analyze`) then
 * scrapes company-page posts and produces pain-point insights for this microsegment.
 */
import { Command } from "commander";
import { parse as parseCsv } from "csv-parse/sync";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { pool, shutdown } from "../src/db/connection.js";
import {
  parseCompanyPage,
  parseDecisionMakers,
  parseCompanyPagePosts,
  extractLinkedinCompanyIdFromSalesnavUrl,
  type ParsedCompany,
  type ParsedDecisionMaker,
  type ParsedCompanyPost,
} from "../src/parsers/salesnav-html.js";
import { rebuildPublicUrl } from "./rebuild-public-urls.js";
import { roleBucket } from "../src/lib/role-bucket.js";

const DEFAULT_DATA_DIR =
  "C:/Users/fazli/Desktop/MxD/pain_points analysis/linkedin_account/linkedin_account";
const DEFAULT_MICROSEGMENT_ID = "uk-industrial-iot::ex-london";
const DEFAULT_MICROSEGMENT_LABEL = "UK Industrial IoT — ex-London";

interface SeedCsvRow {
  companyname: string;
  companywebsite: string;
  companyemaildomain: string;
  linkedincompanypageurl: string;
  stocksymbol: string;
  industry: string;
  city: string;
  state: string;
  companycountry: string;
  zipcode: string;
}

interface SalesNavCsvRow {
  /** Raw first column: "<Company Name> <Industry Phrase>" concatenated. */
  Company: string;
  "Company URL": string;
  "Connection paths": string;
  "Connection paths URL": string;
  Alerts: string;
  "Alerts URL": string;
  "Lead recommendations CEO - UK": string;
  "Lead recommendations CEO - UK URL": string;
}

interface MergedCompany {
  linkedin_company_id: string;
  display_name: string;
  primary_domain: string | null;
  company_linkedin_url: string | null;
  normalized_industry: string | null;
  employee_count_band: string | null;
  raw_employee_count: string | null;
  revenue_band: string | null;
  headquarters: string | null;
  about_text: string | null;
}

function findSeedCsv(dir: string): string {
  const files = readdirSync(dir).filter(
    (f) => f.startsWith("upload_") && f.endsWith(".csv"),
  );
  if (files.length === 0) {
    throw new Error(`No upload_*.csv seed file found in ${dir}`);
  }
  return join(dir, files[0]);
}

function findSalesNavCsv(dir: string): string {
  const files = readdirSync(dir).filter(
    (f) => f.startsWith("linkedin_sales_nav") && f.endsWith(".csv"),
  );
  if (files.length === 0) {
    throw new Error(`No linkedin_sales_nav*.csv file found in ${dir}`);
  }
  return join(dir, files[0]);
}

function findHtmlDir(dir: string): string {
  const candidate = join(dir, "scraped html");
  if (!existsSync(candidate)) {
    throw new Error(`Expected 'scraped html' folder at ${candidate}`);
  }
  return candidate;
}

function splitNameAndIndustry(raw: string): { name: string; industry: string | null } {
  // Sales Nav exports the first column as "<name> <industry>" with no delimiter. We trim any
  // trailing industry phrase that we recognise; otherwise we keep the whole string as the name.
  const INDUSTRY_PHRASES = [
    "Appliances, Electrical, and Electronics Manufacturing",
    "Industrial Machinery Manufacturing",
    "Automation Machinery Manufacturing",
    "Medical Equipment Manufacturing",
    "Computer Hardware Manufacturing",
    "Computers and Electronics Manufacturing",
    "Semiconductor Manufacturing",
    "Machinery Manufacturing",
    "Measuring and Control Instrument Manufacturing",
    "Mechanical Or Industrial Engineering",
    "Aviation and Aerospace Component Manufacturing",
    "Motor Vehicle Parts Manufacturing",
    "Pharmaceutical Manufacturing",
    "Chemical Manufacturing",
    "Renewable Energy Equipment Manufacturing",
    "Electrical Equipment Manufacturing",
    "Industrial Automation",
    "Technology, Information and Internet",
    "Defense and Space Manufacturing",
    "Biotechnology Research",
    "Nanotechnology Research",
    "Consumer Electronics",
    "Research Services",
    "Telecommunications",
    "Plastics Manufacturing",
  ];
  for (const phrase of INDUSTRY_PHRASES) {
    if (raw.endsWith(phrase)) {
      const name = raw.slice(0, raw.length - phrase.length).trim();
      return { name: name || raw, industry: phrase };
    }
  }
  return { name: raw, industry: null };
}

function domainFromSite(site: string | undefined): string | null {
  if (!site) return null;
  const cleaned = site.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return cleaned || null;
}

interface DataSources {
  seedByDomain: Map<string, SeedCsvRow>;
  seedByName: Map<string, SeedCsvRow>;
  salesNavById: Map<string, { displayName: string; industry: string | null; salesNavUrl: string }>;
  parsedPages: Map<string, ParsedCompany>;
  parsedDms: Map<string, ParsedDecisionMaker[]>;
  parsedPosts: Map<string, ParsedCompanyPost[]>;
}

function loadSources(dataDir: string): DataSources {
  const seedPath = findSeedCsv(dataDir);
  const salesNavPath = findSalesNavCsv(dataDir);
  const htmlDir = findHtmlDir(dataDir);

  console.log(`Seed CSV:      ${basename(seedPath)}`);
  console.log(`Sales Nav CSV: ${basename(salesNavPath)}`);
  console.log(`HTML dir:      ${htmlDir}`);

  const seedRaw = readFileSync(seedPath, "utf-8");
  const seedRows = parseCsv(seedRaw, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
    bom: true,
  }) as SeedCsvRow[];

  const seedByDomain = new Map<string, SeedCsvRow>();
  const seedByName = new Map<string, SeedCsvRow>();
  for (const row of seedRows) {
    const domain = (row.companyemaildomain || row.companywebsite || "").toLowerCase().trim();
    if (domain) seedByDomain.set(domain, row);
    if (row.companyname) seedByName.set(row.companyname.toLowerCase().trim(), row);
  }

  const salesNavRaw = readFileSync(salesNavPath, "utf-8");
  const salesNavRows = parseCsv(salesNavRaw, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
    bom: true,
  }) as SalesNavCsvRow[];

  const salesNavById = new Map<string, { displayName: string; industry: string | null; salesNavUrl: string }>();
  for (const row of salesNavRows) {
    const id = extractLinkedinCompanyIdFromSalesnavUrl(row["Company URL"]);
    if (!id) continue;
    const { name, industry } = splitNameAndIndustry((row.Company ?? "").trim());
    salesNavById.set(id, { displayName: name, industry, salesNavUrl: row["Company URL"] });
  }

  const htmlFiles = readdirSync(htmlDir);
  const parsedPages = new Map<string, ParsedCompany>();
  const parsedDms = new Map<string, ParsedDecisionMaker[]>();
  const parsedPosts = new Map<string, ParsedCompanyPost[]>();
  let postCount = 0;

  for (const f of htmlFiles) {
    const idMatch = f.match(/^company_(\d+)_/);
    if (!idMatch) continue;
    const id = idMatch[1];
    const full = join(htmlDir, f);
    const html = readFileSync(full, "utf-8");
    if (f.includes("_page.html")) {
      parsedPages.set(id, parseCompanyPage(html, id));
      const posts = parseCompanyPagePosts(html, id);
      if (posts.length) {
        parsedPosts.set(id, posts);
        postCount += posts.length;
      }
    } else if (f.includes("_decision_makers")) {
      parsedDms.set(id, parseDecisionMakers(html));
    }
  }

  console.log(
    `Loaded: ${seedByDomain.size} seed domains, ${salesNavById.size} Sales Nav companies, ` +
      `${parsedPages.size} parsed pages, ${parsedDms.size} parsed DM files, ${postCount} embedded posts`,
  );
  return { seedByDomain, seedByName, salesNavById, parsedPages, parsedDms, parsedPosts };
}

function mergeCompany(id: string, sources: DataSources): MergedCompany | null {
  const sn = sources.salesNavById.get(id);
  const page = sources.parsedPages.get(id);
  const displayName = page?.display_name ?? sn?.displayName ?? null;
  if (!displayName) return null;

  // Domain lookup — try matching by name against the seed CSV.
  let seed = sources.seedByName.get(displayName.toLowerCase().trim());
  if (!seed && sn) {
    seed = sources.seedByName.get(sn.displayName.toLowerCase().trim());
  }
  const primary_domain = seed
    ? domainFromSite(seed.companyemaildomain || seed.companywebsite)
    : null;
  const company_linkedin_url = seed?.linkedincompanypageurl?.trim() || null;

  return {
    linkedin_company_id: id,
    display_name: displayName,
    primary_domain,
    company_linkedin_url,
    normalized_industry: page?.industry ?? sn?.industry ?? null,
    employee_count_band: page?.employee_count_band ?? null,
    raw_employee_count: page?.raw_employee_count ?? null,
    revenue_band: page?.revenue_band ?? null,
    headquarters: page?.headquarters ?? null,
    about_text: page?.about_text ?? null,
  };
}

async function upsertCompany(
  client: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> },
  co: MergedCompany,
): Promise<number> {
  // Prefer linkedin_company_id as the dedupe key because it's reliable across all sources.
  const existing = await client.query(
    `SELECT id FROM companies WHERE linkedin_company_id = $1 LIMIT 1`,
    [co.linkedin_company_id],
  );
  if (existing.rows.length > 0) {
    const id = existing.rows[0].id;
    await client.query(
      `UPDATE companies SET
         display_name = $2,
         primary_domain = COALESCE($3, primary_domain),
         company_linkedin_url = COALESCE($4, company_linkedin_url),
         normalized_industry = COALESCE($5, normalized_industry),
         employee_count_band = COALESCE($6, employee_count_band),
         revenue_band = COALESCE($7, revenue_band),
         headquarters = COALESCE($8, headquarters),
         about_text = COALESCE($9, about_text),
         raw_employee_count = COALESCE($10, raw_employee_count)
       WHERE id = $1`,
      [
        id,
        co.display_name,
        co.primary_domain,
        co.company_linkedin_url,
        co.normalized_industry,
        co.employee_count_band,
        co.revenue_band,
        co.headquarters,
        co.about_text,
        co.raw_employee_count,
      ],
    );
    return id;
  }

  // Fall back to matching by primary_domain for pre-existing rows from other seeds.
  if (co.primary_domain) {
    const byDomain = await client.query(
      `SELECT id FROM companies WHERE primary_domain = $1 LIMIT 1`,
      [co.primary_domain],
    );
    if (byDomain.rows.length > 0) {
      const id = byDomain.rows[0].id;
      await client.query(
        `UPDATE companies SET
           display_name = $2,
           linkedin_company_id = COALESCE($3, linkedin_company_id),
           company_linkedin_url = COALESCE($4, company_linkedin_url),
           normalized_industry = COALESCE($5, normalized_industry),
           employee_count_band = COALESCE($6, employee_count_band),
           revenue_band = COALESCE($7, revenue_band),
           headquarters = COALESCE($8, headquarters),
           about_text = COALESCE($9, about_text),
           raw_employee_count = COALESCE($10, raw_employee_count)
         WHERE id = $1`,
        [
          id,
          co.display_name,
          co.linkedin_company_id,
          co.company_linkedin_url,
          co.normalized_industry,
          co.employee_count_band,
          co.revenue_band,
          co.headquarters,
          co.about_text,
          co.raw_employee_count,
        ],
      );
      return id;
    }
  }

  const inserted = await client.query(
    `INSERT INTO companies
       (display_name, primary_domain, linkedin_company_id, company_linkedin_url,
        normalized_industry, employee_count_band, revenue_band, headquarters, about_text,
        raw_employee_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      co.display_name,
      co.primary_domain,
      co.linkedin_company_id,
      co.company_linkedin_url,
      co.normalized_industry,
      co.employee_count_band,
      co.revenue_band,
      co.headquarters,
      co.about_text,
      co.raw_employee_count,
    ],
  );
  return inserted.rows[0].id;
}

async function upsertContact(
  client: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> },
  dm: ParsedDecisionMaker,
  companyId: number,
  microsegmentId: string,
  microsegmentLabel: string,
): Promise<void> {
  if (!dm.person_name || !dm.salesnav_lead_url) return;
  const [first, ...rest] = dm.person_name.split(/\s+/);
  const last = rest.join(" ") || null;

  const publicUrl = rebuildPublicUrl(dm.salesnav_lead_url);
  const seniority = roleBucket(dm.title);
  await client.query(
    `INSERT INTO contacts
       (person_linkedin_url, first_name, last_name, full_name, title, company_id,
        microsegment_id, microsegment_label, salesnav_lead_url, tenure_in_role, connection_degree,
        location, bio, public_linkedin_url, public_url_resolved_at, role_seniority)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             CASE WHEN $14 IS NOT NULL THEN NOW() ELSE NULL END, $15)
     ON CONFLICT (person_linkedin_url)
     DO UPDATE SET
       title = COALESCE(EXCLUDED.title, contacts.title),
       company_id = COALESCE(EXCLUDED.company_id, contacts.company_id),
       microsegment_id = EXCLUDED.microsegment_id,
       microsegment_label = EXCLUDED.microsegment_label,
       salesnav_lead_url = COALESCE(EXCLUDED.salesnav_lead_url, contacts.salesnav_lead_url),
       tenure_in_role = COALESCE(EXCLUDED.tenure_in_role, contacts.tenure_in_role),
       connection_degree = COALESCE(EXCLUDED.connection_degree, contacts.connection_degree),
       location = COALESCE(EXCLUDED.location, contacts.location),
       bio = COALESCE(EXCLUDED.bio, contacts.bio),
       public_linkedin_url = COALESCE(EXCLUDED.public_linkedin_url, contacts.public_linkedin_url),
       public_url_resolved_at = COALESCE(EXCLUDED.public_url_resolved_at, contacts.public_url_resolved_at),
       role_seniority = COALESCE(EXCLUDED.role_seniority, contacts.role_seniority)`,
    [
      dm.salesnav_lead_url,
      first ?? null,
      last,
      dm.person_name,
      dm.title,
      companyId,
      microsegmentId,
      microsegmentLabel,
      dm.salesnav_lead_url,
      dm.tenure_in_role,
      dm.connection_degree,
      dm.location,
      dm.bio,
      publicUrl,
      seniority,
    ],
  );
}

async function upsertCompanyPosts(
  client: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> },
  posts: ParsedCompanyPost[],
  companyId: number,
  linkedinCompanyId: string,
  batchId: string,
): Promise<number> {
  let inserted = 0;
  // Synthesize a stable post_url since these come from the Sales Nav HTML, not the public feed.
  // Using a salesnav:// scheme keeps them dedupe-keyable without colliding with real LinkedIn URLs.
  for (const p of posts) {
    const post_url = `salesnav://company/${linkedinCompanyId}/alert/${p.post_id ?? p.alert_id}`;
    const company_linkedin_url = `https://www.linkedin.com/company/${linkedinCompanyId}`;
    const res = await client.query(
      `INSERT INTO scraped_company_posts
         (company_id, company_linkedin_url, post_url, post_id, post_text, post_date,
          raw_json, scrape_batch_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (post_url) DO NOTHING
       RETURNING id`,
      [
        companyId,
        company_linkedin_url,
        post_url,
        p.post_id,
        p.post_text,
        p.post_date ? new Date(p.post_date) : null,
        JSON.stringify({ source: "salesnav-html", alert_id: p.alert_id, headline: p.alert_headline }),
        batchId,
      ],
    );
    if (res.rows.length > 0) inserted++;
  }
  return inserted;
}

async function run(opts: {
  dataDir: string;
  microsegmentId: string;
  microsegmentLabel: string;
  dryRun: boolean;
  limit?: string;
}) {
  const sources = loadSources(opts.dataDir);

  // The set of companies we actually seed = every linkedin_company_id observed across Sales Nav
  // and scraped pages. Seed-only rows (no Sales Nav / no page) aren't actionable without a LI id.
  const ids = new Set<string>([
    ...sources.salesNavById.keys(),
    ...sources.parsedPages.keys(),
  ]);
  const idList = Array.from(ids);
  const limit = opts.limit ? Number(opts.limit) : idList.length;
  const targetIds = idList.slice(0, limit);

  const merged: MergedCompany[] = [];
  for (const id of targetIds) {
    const co = mergeCompany(id, sources);
    if (co) merged.push(co);
  }
  console.log(`\nMerged ${merged.length} companies`);

  const dmTotal = merged.reduce(
    (sum, co) => sum + (sources.parsedDms.get(co.linkedin_company_id)?.length ?? 0),
    0,
  );
  console.log(`Decision-makers to upsert: ${dmTotal}`);

  if (opts.dryRun) {
    console.log("\n--- dry run sample ---");
    for (const co of merged.slice(0, 3)) {
      console.log(JSON.stringify(co, null, 2));
      const dms = sources.parsedDms.get(co.linkedin_company_id) ?? [];
      console.log(`  ${dms.length} decision-makers`);
      for (const dm of dms.slice(0, 3)) console.log(`    - ${dm.person_name} — ${dm.title}`);
    }
    await shutdown();
    return;
  }

  const client = await pool.connect();
  const batchId = `salesnav-html-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  let companyCount = 0;
  let contactCount = 0;
  let postCount = 0;
  try {
    await client.query("BEGIN");
    for (const co of merged) {
      const companyId = await upsertCompany(client, co);
      companyCount++;
      const dms = sources.parsedDms.get(co.linkedin_company_id) ?? [];
      for (const dm of dms) {
        await upsertContact(
          client,
          dm,
          companyId,
          opts.microsegmentId,
          opts.microsegmentLabel,
        );
        contactCount++;
      }
      const posts = sources.parsedPosts.get(co.linkedin_company_id) ?? [];
      if (posts.length) {
        postCount += await upsertCompanyPosts(
          client,
          posts,
          companyId,
          co.linkedin_company_id,
          batchId,
        );
      }
      if (companyCount % 50 === 0) {
        console.log(
          `  ...${companyCount} companies, ${contactCount} contacts, ${postCount} posts`,
        );
      }
    }
    await client.query("COMMIT");
    console.log(
      `\nSeed complete: ${companyCount} companies, ${contactCount} contacts, ${postCount} posts (batch ${batchId})`,
    );
    console.log(`Microsegment: ${opts.microsegmentId}`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Seed failed:", err);
    throw err;
  } finally {
    client.release();
  }

  await shutdown();
}

const program = new Command()
  .name("seed-from-linkedin-salesnav")
  .description("Seed companies + contacts from LinkedIn Sales Nav scrape bundle")
  .option("--data-dir <path>", "Folder containing CSVs + 'scraped html'", DEFAULT_DATA_DIR)
  .option("--microsegment-id <id>", "Microsegment ID to tag contacts with", DEFAULT_MICROSEGMENT_ID)
  .option("--microsegment-label <label>", "Human-readable label", DEFAULT_MICROSEGMENT_LABEL)
  .option("--limit <n>", "Only process the first N companies")
  .option("--dry-run", "Parse + merge but do not write to PG", false)
  .action(run);

program.parse();
