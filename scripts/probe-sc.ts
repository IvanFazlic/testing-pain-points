/**
 * One-off probe: inspect raw ScrapeCreators /profile response for a known-active profile
 * to understand whether recentPosts is populated as expected.
 */
import dotenv from "dotenv";
import { getProfile } from "../src/providers/scrapecreators.js";

dotenv.config();

const target = process.argv[2] ?? "https://www.linkedin.com/in/rbranson";
console.log(`Probing: ${target}\n`);

const resp = await getProfile(target);

console.log("=== Top-level keys ===");
console.log(Object.keys(resp));

console.log("\n=== Summary ===");
console.log(`success: ${resp.success}`);
console.log(`name: ${resp.name}`);
console.log(`location: ${resp.location}`);
console.log(`followers: ${resp.followers}`);
console.log(`connections: ${resp.connections}`);
console.log(`about: ${resp.about?.slice(0, 120)}...`);
console.log(`recentPosts count: ${resp.recentPosts?.length ?? "undefined"}`);
console.log(`experience count: ${resp.experience?.length ?? "undefined"}`);
console.log(`articles count: ${resp.articles?.length ?? "undefined"}`);
console.log(`activity count: ${resp.activity?.length ?? "undefined"}`);

if (resp.recentPosts && resp.recentPosts.length > 0) {
  console.log("\n=== First recent post ===");
  console.log(JSON.stringify(resp.recentPosts[0], null, 2));
}

if (resp.activity && resp.activity.length > 0) {
  console.log("\n=== First activity entry ===");
  console.log(JSON.stringify(resp.activity[0], null, 2));
}

console.log("\n=== Simulated scrape (recentPosts + articles) ===");
const links = new Set<string>();
if (resp.recentPosts) for (const rp of resp.recentPosts) if (rp.link) links.add(rp.link);
if (resp.articles) for (const art of resp.articles) if (art.url) links.add(art.url);
console.log(`Total unique post/article URLs: ${links.size}`);
for (const l of links) console.log(`  ${l}`);
