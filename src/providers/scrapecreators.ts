/**
 * ScrapeCreators REST API client for LinkedIn data.
 *
 * Endpoints used:
 *   GET /v1/linkedin/profile?url=<profile_url>   → profile + recentPosts[]
 *   GET /v1/linkedin/post?url=<post_url>          → full post details
 *   GET /v1/linkedin/company/posts?url=<co_url>   → company page posts
 */
import dotenv from "dotenv";
import type {
  SCProfileResponse,
  SCPostResponse,
} from "../types.js";

dotenv.config();

const BASE_URL = "https://api.scrapecreators.com";
const API_KEY = process.env.SCRAPECREATORS_API_KEY ?? "";
const RATE_DELAY_MS = Number(process.env.SCRAPECREATORS_RATE_DELAY_MS ?? 200);
const MAX_RETRIES = 3;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeUrl(u: string): string {
  return u.replace(/^http:\/\//i, "https://");
}

async function scFetch<T>(path: string, params: Record<string, string>): Promise<T> {
  if (!API_KEY) throw new Error("SCRAPECREATORS_API_KEY is not set");

  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url.toString(), {
        headers: {
          "x-api-key": API_KEY,
          "Content-Type": "application/json",
        },
      });

      if (resp.status === 401) throw new Error("Invalid ScrapeCreators API key (401)");
      if (resp.status === 402) throw new Error("ScrapeCreators credits exhausted (402)");

      if (resp.status >= 500) {
        lastError = new Error(`ScrapeCreators ${resp.status}: ${resp.statusText}`);
        if (attempt < MAX_RETRIES) {
          const backoff = 1000 * Math.pow(2, attempt - 1);
          console.warn(`  Retry ${attempt}/${MAX_RETRIES} after ${backoff}ms...`);
          await delay(backoff);
          continue;
        }
        throw lastError;
      }

      if (!resp.ok) {
        throw new Error(`ScrapeCreators ${resp.status}: ${await resp.text()}`);
      }

      return (await resp.json()) as T;
    } catch (err) {
      if (
        err instanceof Error &&
        /^ScrapeCreators 4\d\d:/.test(err.message)
      ) {
        throw err; // Client errors (4xx) — retrying won't help
      }
      lastError = err as Error;
      if (attempt < MAX_RETRIES) {
        const backoff = 1000 * Math.pow(2, attempt - 1);
        console.warn(`  Retry ${attempt}/${MAX_RETRIES} after ${backoff}ms: ${lastError.message}`);
        await delay(backoff);
      }
    }
  }
  throw lastError ?? new Error("ScrapeCreators request failed after retries");
}

/**
 * Get a LinkedIn profile including recent posts.
 */
export async function getProfile(profileUrl: string): Promise<SCProfileResponse> {
  await delay(RATE_DELAY_MS);
  return scFetch<SCProfileResponse>("/v1/linkedin/profile", { url: normalizeUrl(profileUrl) });
}

/**
 * Get full details for a single LinkedIn post.
 */
export async function getPost(postUrl: string): Promise<SCPostResponse> {
  await delay(RATE_DELAY_MS);
  return scFetch<SCPostResponse>("/v1/linkedin/post", { url: normalizeUrl(postUrl) });
}

/**
 * Get posts from a LinkedIn company page.
 */
export async function getCompanyPosts(
  companyUrl: string,
  page: number = 1,
): Promise<SCPostResponse> {
  await delay(RATE_DELAY_MS);
  return scFetch<SCPostResponse>("/v1/linkedin/company/posts", {
    url: normalizeUrl(companyUrl),
    page: String(page),
  });
}
