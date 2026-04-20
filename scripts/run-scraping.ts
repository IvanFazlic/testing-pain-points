/**
 * Orchestrates LinkedIn post scraping via ScrapeCreators.
 *
 * Per contact:
 *   1. GET /v1/linkedin/profile → extract recentPosts[].link
 *   2. For each post link → GET /v1/linkedin/post → full text + engagement
 *   3. Follow moreArticles[].link for one hop of additional posts
 *   4. Filter by datePublished within 6-month window
 *   5. UPSERT into scraped_posts
 */
import { Command } from "commander";
import dotenv from "dotenv";
import { pool, query, shutdown } from "../src/db/connection.js";
import { getProfile, getPost } from "../src/providers/scrapecreators.js";
import type { ContactRow, SCPostResponse } from "../src/types.js";

dotenv.config();

const WINDOW_MONTHS = Number(process.env.SCRAPE_WINDOW_MONTHS ?? 12);
const WINDOW_START = new Date();
WINDOW_START.setMonth(WINDOW_START.getMonth() - WINDOW_MONTHS);

function isWithinWindow(dateStr: string | undefined | null): boolean {
  if (!dateStr) return true; // Keep posts with unknown dates
  try {
    return new Date(dateStr) >= WINDOW_START;
  } catch {
    return true;
  }
}

async function upsertPost(
  contactId: number,
  personUrl: string,
  postResp: SCPostResponse,
  batchId: string,
): Promise<boolean> {
  if (!postResp.success || !postResp.url) return false;

  try {
    await query(
      `INSERT INTO scraped_posts
         (contact_id, person_linkedin_url, post_url, post_title, post_text, post_date,
          like_count, comment_count, post_type, comments_json, raw_json, scrape_batch_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (post_url) DO NOTHING`,
      [
        contactId,
        personUrl,
        postResp.url,
        postResp.name ?? postResp.headline ?? null,
        postResp.description ?? null,
        postResp.datePublished ? new Date(postResp.datePublished) : null,
        postResp.likeCount ?? 0,
        postResp.commentCount ?? 0,
        postResp.url?.includes("/pulse/") ? "article" : "original",
        postResp.comments ? JSON.stringify(postResp.comments) : null,
        JSON.stringify(postResp),
        batchId,
      ],
    );
    return true;
  } catch (err) {
    console.error(`  Failed to upsert post ${postResp.url}:`, (err as Error).message);
    return false;
  }
}

async function scrapeContact(
  contact: ContactRow,
  batchId: string,
  stats: { posts: number; errors: number },
): Promise<void> {
  const label = `${contact.full_name ?? contact.first_name ?? "?"} (${contact.person_linkedin_url})`;

  // Step 1: Get profile → recent post links
  let profileResp;
  try {
    profileResp = await getProfile(contact.person_linkedin_url);
  } catch (err) {
    console.error(`  [SKIP] Profile fetch failed for ${label}: ${(err as Error).message}`);
    stats.errors++;
    return;
  }

  const postLinks = new Set<string>();
  if (profileResp.recentPosts) {
    for (const rp of profileResp.recentPosts) {
      if (rp.link) postLinks.add(rp.link);
    }
  }
  if (profileResp.articles) {
    for (const art of profileResp.articles) {
      if (art.url && isWithinWindow(art.datePublished)) {
        postLinks.add(art.url);
      }
    }
  }

  if (postLinks.size === 0) {
    console.log(`  [SKIP] No recent posts or articles for ${label}`);
    return;
  }

  // Step 2: Fetch full post details for each link
  const allPostUrls = new Set<string>(postLinks);

  for (const postUrl of postLinks) {
    try {
      const postResp = await getPost(postUrl);

      if (isWithinWindow(postResp.datePublished)) {
        const inserted = await upsertPost(contact.id, contact.person_linkedin_url, postResp, batchId);
        if (inserted) stats.posts++;
      }

      // Step 3: Follow moreArticles for one hop
      if (postResp.moreArticles) {
        for (const article of postResp.moreArticles) {
          if (article.link && !allPostUrls.has(article.link) && isWithinWindow(article.datePublished)) {
            allPostUrls.add(article.link);
          }
        }
      }
    } catch (err) {
      console.error(`  [ERR] Post fetch failed ${postUrl}: ${(err as Error).message}`);
      stats.errors++;
    }
  }

  // Fetch additional discovered posts (one hop from moreArticles)
  const extraLinks = [...allPostUrls].filter((u) => !postLinks.has(u));
  for (const extraUrl of extraLinks) {
    try {
      const postResp = await getPost(extraUrl);
      if (isWithinWindow(postResp.datePublished)) {
        const inserted = await upsertPost(contact.id, contact.person_linkedin_url, postResp, batchId);
        if (inserted) stats.posts++;
      }
    } catch (err) {
      console.error(`  [ERR] Extra post fetch failed ${extraUrl}: ${(err as Error).message}`);
      stats.errors++;
    }
  }
}

async function run(opts: {
  microsegment: string;
  concurrency: number;
  dryRun: boolean;
  limit?: string;
}) {
  const batchId = `scrape-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  console.log(`Batch: ${batchId}`);
  console.log(`Microsegment: ${opts.microsegment}`);
  console.log(`${WINDOW_MONTHS}-month window: ${WINDOW_START.toISOString()}`);

  // Load contacts for this microsegment
  let contactQuery = `
    SELECT c.* FROM contacts c
    WHERE c.microsegment_id = $1
      AND c.person_linkedin_url IS NOT NULL
    ORDER BY c.id
  `;
  const params: any[] = [opts.microsegment];

  if (opts.limit) {
    contactQuery += ` LIMIT $2`;
    params.push(Number(opts.limit));
  }

  const { rows: contacts } = await query<ContactRow>(contactQuery, params);
  console.log(`Found ${contacts.length} contacts to scrape`);

  if (opts.dryRun) {
    console.log("Dry run — listing first 10 contacts:");
    for (const c of contacts.slice(0, 10)) {
      console.log(`  ${c.full_name} — ${c.title} — ${c.person_linkedin_url}`);
    }
    await shutdown();
    return;
  }

  // Check which contacts already have posts in this batch (resume-safe)
  const { rows: alreadyScraped } = await query<{ person_linkedin_url: string }>(
    `SELECT DISTINCT person_linkedin_url FROM scraped_posts WHERE scrape_batch_id = $1`,
    [batchId],
  );
  const alreadyDone = new Set(alreadyScraped.map((r) => r.person_linkedin_url));

  const remaining = contacts.filter((c) => !alreadyDone.has(c.person_linkedin_url));
  console.log(`${alreadyDone.size} already scraped, ${remaining.length} remaining`);

  // Create scrape run record
  await query(
    `INSERT INTO scrape_runs (stage, microsegment_id, status, contacts_processed)
     VALUES ('scrape', $1, 'running', 0)`,
    [opts.microsegment],
  );

  const stats = { posts: 0, errors: 0 };

  // Process contacts with concurrency limit
  let processed = 0;
  for (let i = 0; i < remaining.length; i += opts.concurrency) {
    const batch = remaining.slice(i, i + opts.concurrency);
    await Promise.all(batch.map((c) => scrapeContact(c, batchId, stats)));
    processed += batch.length;

    if (processed % 50 === 0 || processed === remaining.length) {
      console.log(
        `Progress: ${processed}/${remaining.length} contacts | ${stats.posts} posts | ${stats.errors} errors`,
      );
    }

    // Update run record
    await query(
      `UPDATE scrape_runs SET contacts_processed = $1, posts_scraped = $2
       WHERE microsegment_id = $3 AND stage = 'scrape' AND status = 'running'`,
      [processed, stats.posts, opts.microsegment],
    );
  }

  // Finalize run
  await query(
    `UPDATE scrape_runs SET status = 'completed', completed_at = NOW(),
       contacts_processed = $1, posts_scraped = $2
     WHERE microsegment_id = $3 AND stage = 'scrape' AND status = 'running'`,
    [processed, stats.posts, opts.microsegment],
  );

  console.log(`\nDone: ${stats.posts} posts scraped, ${stats.errors} errors`);
  await shutdown();
}

const program = new Command()
  .name("run-scraping")
  .description("Scrape LinkedIn posts for contacts in a microsegment")
  .requiredOption("--microsegment <id>", "Microsegment ID to scrape")
  .option("--concurrency <n>", "Concurrent scrape requests", "5")
  .option("--limit <n>", "Max contacts to scrape (for testing)")
  .option("--dry-run", "List contacts without scraping", false)
  .action((opts) =>
    run({
      ...opts,
      concurrency: Number(opts.concurrency),
    }),
  );

program.parse();
