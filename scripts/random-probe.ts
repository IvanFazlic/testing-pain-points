/**
 * Random sample of contacts across the DB (not just top-of-id).
 * For each: probe SC and report whether profile is private, has content, or empty.
 */
import dotenv from "dotenv";
import { query, shutdown } from "../src/db/connection.js";
import { getProfile } from "../src/providers/scrapecreators.js";

dotenv.config();

const SAMPLE_SIZE = Number(process.argv[2] ?? 10);

const { rows } = await query(
  `SELECT person_linkedin_url, full_name, microsegment_label
   FROM contacts
   WHERE microsegment_id LIKE 'uk-ceo%'
   ORDER BY RANDOM()
   LIMIT $1`,
  [SAMPLE_SIZE],
);

let privates = 0;
let empty = 0;
let withArticles = 0;
let withRecentPosts = 0;
const articles: { name: string; count: number; newest?: string }[] = [];

for (const c of rows) {
  try {
    const r = await getProfile(c.person_linkedin_url);
    const articleCount = r.articles?.length ?? 0;
    const postCount = r.recentPosts?.length ?? 0;

    if (articleCount === 0 && postCount === 0) {
      empty++;
      console.log(`  empty      ${c.full_name}  (${c.microsegment_label.slice(0, 40)})`);
    } else {
      if (articleCount > 0) {
        withArticles++;
        const newest = r.articles!
          .map((a) => a.datePublished)
          .filter(Boolean)
          .sort()
          .reverse()[0];
        articles.push({ name: c.full_name, count: articleCount, newest });
        console.log(`  ✓ ${articleCount} articles  ${c.full_name}  newest=${newest?.slice(0, 10) ?? "?"}`);
      }
      if (postCount > 0) {
        withRecentPosts++;
        console.log(`  ✓ ${postCount} posts      ${c.full_name}`);
      }
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("404")) {
      privates++;
      console.log(`  private    ${c.full_name}`);
    } else {
      console.log(`  ERROR      ${c.full_name}: ${msg.slice(0, 80)}`);
    }
  }
}

console.log(`\n=== Summary over ${rows.length} random contacts ===`);
console.log(`  Private (404):          ${privates} (${((privates / rows.length) * 100).toFixed(0)}%)`);
console.log(`  Empty public:           ${empty} (${((empty / rows.length) * 100).toFixed(0)}%)`);
console.log(`  Has articles (any age): ${withArticles} (${((withArticles / rows.length) * 100).toFixed(0)}%)`);
console.log(`  Has recentPosts:        ${withRecentPosts} (${((withRecentPosts / rows.length) * 100).toFixed(0)}%)`);

if (articles.length > 0) {
  console.log(`\nArticles found:`);
  for (const a of articles) {
    console.log(`  ${a.name}: ${a.count} articles, newest=${a.newest}`);
  }
}

await shutdown();
