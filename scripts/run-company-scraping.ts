/**
 * Scrapes posts from LinkedIn company pages via ScrapeCreators.
 *
 * Per company with linkedin_company_id:
 *   GET /v1/linkedin/company/posts?url=https://www.linkedin.com/company/<id>
 *   → posts[] with {url, id, datePublished, text}
 *
 * Public data — no privacy gates like individual profiles.
 */
import { Command } from "commander";
import dotenv from "dotenv";
import { query, shutdown } from "../src/db/connection.js";
import { getCompanyPosts } from "../src/providers/scrapecreators.js";

dotenv.config();

const WINDOW_MONTHS = Number(process.env.SCRAPE_WINDOW_MONTHS ?? 12);
const WINDOW_START = new Date();
WINDOW_START.setMonth(WINDOW_START.getMonth() - WINDOW_MONTHS);

function isWithinWindow(dateStr: string | undefined | null): boolean {
  if (!dateStr) return true;
  try {
    return new Date(dateStr) >= WINDOW_START;
  } catch {
    return true;
  }
}

interface CompanyRow {
  id: number;
  display_name: string;
  linkedin_company_id: string;
  company_linkedin_url: string | null;
}

interface CompanyPostResponse {
  success: boolean;
  credits_remaining?: number;
  posts?: Array<{
    url?: string;
    id?: string;
    datePublished?: string;
    text?: string;
  }>;
}

async function scrapeCompany(
  company: CompanyRow,
  batchId: string,
  stats: { posts: number; errors: number; companiesWithPosts: number },
): Promise<void> {
  // ScrapeCreators rejects numeric-id URLs (returns 500). Use the slug-based URL when we have one.
  if (!company.company_linkedin_url) {
    console.log(`  [SKIP] ${company.display_name} — no slug-based linkedin URL (only numeric id)`);
    return;
  }
  const companyUrl = company.company_linkedin_url;
  let resp: CompanyPostResponse;
  try {
    resp = (await getCompanyPosts(companyUrl)) as CompanyPostResponse;
  } catch (err) {
    console.error(`  [ERR] ${company.display_name}: ${(err as Error).message.slice(0, 100)}`);
    stats.errors++;
    return;
  }

  if (!resp.posts || resp.posts.length === 0) {
    console.log(`  [SKIP] ${company.display_name} — no posts`);
    return;
  }

  let inserted = 0;
  for (const p of resp.posts) {
    if (!p.url) continue;
    if (!isWithinWindow(p.datePublished)) continue;
    try {
      const res = await query(
        `INSERT INTO scraped_company_posts
           (company_id, company_linkedin_url, post_url, post_id, post_text, post_date, raw_json, scrape_batch_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (post_url) DO NOTHING
         RETURNING id`,
        [
          company.id,
          companyUrl,
          p.url,
          p.id ?? null,
          p.text ?? null,
          p.datePublished ? new Date(p.datePublished) : null,
          JSON.stringify(p),
          batchId,
        ],
      );
      if (res.rows.length > 0) inserted++;
    } catch (err) {
      console.error(`  Failed insert ${p.url}: ${(err as Error).message}`);
    }
  }
  stats.posts += inserted;
  if (inserted > 0) stats.companiesWithPosts++;
  console.log(`  ${company.display_name}: ${inserted} posts inserted (credits: ${resp.credits_remaining ?? "?"})`);
}

async function run(opts: { microsegment?: string; limit?: string; dryRun: boolean }) {
  const batchId = `co-scrape-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  console.log(`Batch: ${batchId}`);
  console.log(`Window: ${WINDOW_MONTHS} months (from ${WINDOW_START.toISOString()})`);

  let sql = `
    SELECT DISTINCT co.id, co.display_name, co.linkedin_company_id, co.company_linkedin_url
    FROM companies co
    ${opts.microsegment ? `JOIN contacts c ON c.company_id = co.id AND c.microsegment_id = $1` : ``}
    WHERE co.linkedin_company_id IS NOT NULL AND co.linkedin_company_id != ''
    ORDER BY co.id
  `;
  const params: any[] = opts.microsegment ? [opts.microsegment] : [];
  if (opts.limit) {
    sql += ` LIMIT $${params.length + 1}`;
    params.push(Number(opts.limit));
  }

  const { rows: companies } = await query<CompanyRow>(sql, params);
  console.log(`Found ${companies.length} companies to scrape`);

  if (opts.dryRun) {
    for (const c of companies.slice(0, 10)) {
      console.log(`  ${c.id}: ${c.display_name} (${c.linkedin_company_id})`);
    }
    await shutdown();
    return;
  }

  const stats = { posts: 0, errors: 0, companiesWithPosts: 0 };
  for (const [i, company] of companies.entries()) {
    await scrapeCompany(company, batchId, stats);
    if ((i + 1) % 25 === 0) {
      console.log(`Progress: ${i + 1}/${companies.length} | ${stats.posts} posts | ${stats.companiesWithPosts} productive | ${stats.errors} errors`);
    }
  }

  console.log(`\nDone: ${stats.posts} posts from ${stats.companiesWithPosts}/${companies.length} companies, ${stats.errors} errors`);
  await shutdown();
}

const program = new Command()
  .name("run-company-scraping")
  .description("Scrape LinkedIn company-page posts for companies")
  .option("--microsegment <id>", "Limit to companies with contacts in this microsegment")
  .option("--limit <n>", "Max companies to scrape")
  .option("--dry-run", "List companies without scraping", false)
  .action(run);

program.parse();
