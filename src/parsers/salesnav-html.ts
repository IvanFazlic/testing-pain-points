/**
 * Parsers for LinkedIn Sales Navigator scraped HTML.
 *
 * Two shapes:
 *   - Company account page:   `scraped html/company_<id>_page.html`
 *   - Decision-makers search: `scraped html/company_<id>_decision_makers.html`
 *
 * All structured data sits on `[data-anonymize="…"]` attributes. No JSON payload
 * is embedded in the HTML, so we rely purely on DOM selectors via cheerio.
 */
import { load, type CheerioAPI, type Cheerio } from "cheerio";
import type { Element } from "domhandler";

export interface ParsedCompany {
  linkedin_company_id: string | null;
  display_name: string | null;
  industry: string | null;
  headquarters: string | null;
  raw_employee_count: string | null;
  employee_count_band: string | null;
  revenue_band: string | null;
  about_text: string | null;
}

export interface ParsedDecisionMaker {
  person_name: string | null;
  title: string | null;
  location: string | null;
  bio: string | null;
  tenure_in_role: string | null;
  connection_degree: string | null;
  salesnav_lead_url: string | null;
}

export interface ParsedCompanyPost {
  alert_id: string;
  post_id: string | null;
  post_text: string;
  post_date: string | null;
  alert_headline: string | null;
}

function textOrNull($: CheerioAPI, root: Cheerio<Element>, sel: string): string | null {
  const el = root.find(sel).first();
  if (!el.length) return null;
  const t = el.text().trim();
  return t.length ? t : null;
}

function normalizeBand(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/(\d[\d,]*)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (Number.isNaN(n)) return null;
  if (n <= 10) return "1-10";
  if (n <= 50) return "11-50";
  if (n <= 200) return "51-200";
  if (n <= 500) return "201-500";
  if (n <= 1000) return "501-1000";
  if (n <= 5000) return "1001-5000";
  return "5001+";
}

export function parseCompanyPage(html: string, linkedinCompanyId?: string): ParsedCompany {
  const $ = load(html);
  const root = $.root() as unknown as Cheerio<Element>;

  // The main account page has a single primary header block. The `[data-x--account--name]`
  // attribute is set only on that header's `company-name` node, which disambiguates it from
  // the related-companies cards farther down the page.
  const primary = $('[data-anonymize="company-name"][data-x--account--name]').first();
  const displayName = primary.length
    ? primary.text().trim() || null
    : textOrNull($, root, '[data-anonymize="company-name"]');

  // Fields near the header share the same enclosing lockup; if `primary` is missing we
  // fall back to the first occurrence across the document (still the main company block).
  const headerScope: Cheerio<Element> = primary.length
    ? (primary.closest(".artdeco-entity-lockup") as unknown as Cheerio<Element>)
    : root;

  const industry = textOrNull($, headerScope, '[data-anonymize="industry"]');
  const headquarters = textOrNull($, headerScope, '[data-anonymize="location"]');
  const rawSize = textOrNull($, headerScope, '[data-anonymize="company-size"]');
  const revenue = textOrNull($, headerScope, '[data-anonymize="revenue"]');

  // The About blurb lives inside the main `about` section, not the related-companies cards.
  const aboutScope: Cheerio<Element> = ($("#about").first() as unknown as Cheerio<Element>);
  const rawAbout = aboutScope.length
    ? textOrNull($, aboutScope, '[data-anonymize="company-blurb"]')
    : textOrNull($, root, '[data-anonymize="company-blurb"]');
  // Sales Nav clamps long About sections with a "… Show more" affordance that ends up in the
  // DOM text. Trim it plus runs of whitespace so the stored copy reads cleanly.
  const aboutText = rawAbout
    ? rawAbout.replace(/\s*…\s*Show more\s*$/i, "").replace(/\s{2,}/g, " ").trim() || null
    : null;

  return {
    linkedin_company_id: linkedinCompanyId ?? null,
    display_name: displayName,
    industry,
    headquarters,
    raw_employee_count: rawSize,
    employee_count_band: normalizeBand(rawSize),
    revenue_band: revenue,
    about_text: aboutText,
  };
}

export function parseDecisionMakers(html: string): ParsedDecisionMaker[] {
  const $ = load(html);
  const results: ParsedDecisionMaker[] = [];
  const seen = new Set<string>();

  $('[data-anonymize="person-name"]').each((_, el) => {
    // Walk up to the enclosing list item so sibling fields resolve inside the same card.
    let card = $(el).closest("li.artdeco-list__item");
    if (!card.length) {
      // Some layouts wrap the person in a generic search-result container.
      card = $(el).closest('[data-lead-search-result], [data-view-name*="search-result"], li');
    }
    if (!card.length) card = $(el).parent();

    const person_name = $(el).text().trim() || null;
    const title = card.find('[data-anonymize="title"]').first().text().trim() || null;
    const location = card.find('[data-anonymize="location"]').first().text().trim() || null;
    const tenure = card.find('[data-anonymize="job-title"]').first().text().trim() || null;
    // Person bios are clamped in the visible DOM; the full text lives in the title attribute.
    const bioEl = card.find('[data-anonymize="person-blurb"]').first();
    const bioRaw = bioEl.attr("title") || bioEl.text();
    const bio = bioRaw ? bioRaw.replace(/\s{2,}/g, " ").trim() || null : null;

    const leadAnchor = card
      .find('a[href^="/sales/lead/"]')
      .first();
    const leadHref = leadAnchor.attr("href") ?? null;
    const salesnav_lead_url = leadHref
      ? (leadHref.startsWith("http") ? leadHref : `https://www.linkedin.com${leadHref.split("?")[0]}`)
      : null;

    // Connection degree shows in Sales Nav as "1st", "2nd", "3rd", "3rd+" — but it may sit inside
    // a longer accessibility-text span (e.g. "1st degree connection"). Match the leading token
    // anywhere in the card text rather than requiring the entire node text to be the badge.
    let connection_degree: string | null = null;
    const cardText = card.text();
    const degMatch = cardText.match(/\b(1st|2nd|3rd\+?)\b/);
    if (degMatch) connection_degree = degMatch[1];

    // Dedupe on Sales Nav URL when available, otherwise name+title+location.
    const key = salesnav_lead_url ?? `${person_name}|${title}|${location}`;
    if (seen.has(key)) return;
    seen.add(key);

    results.push({
      person_name,
      title,
      location,
      bio,
      tenure_in_role: tenure,
      connection_degree,
      salesnav_lead_url,
    });
  });

  return results;
}

/**
 * Sales Nav company pages embed the company's recent posts as `<article class="alert-card">`
 * blocks, with the full post text in the `title` attribute of the `general-blurb` element.
 * Extracting these gives us company-page posts without spending ScrapeCreators credits.
 */
export function parseCompanyPagePosts(
  html: string,
  linkedinCompanyId: string,
): ParsedCompanyPost[] {
  const $ = load(html);
  const results: ParsedCompanyPost[] = [];
  const seen = new Set<string>();

  $("article.alert-card").each((_, el) => {
    const article = $(el);
    const alertIdAttr = article.attr("data-alert-id") ?? "";
    // alert-id format: urn:li:fs_salesEntityAlert:(urn:li:fs_salesCompany:<co>,<postId>,<TYPE>)
    const idMatch = alertIdAttr.match(/fs_salesCompany:(\d+),(\d+),([A-Z_]+)/);
    if (!idMatch) return;
    const [, urnCo, postId] = idMatch;
    if (urnCo !== linkedinCompanyId) return; // safety: only posts about this company

    const blurbEl = article.find('[data-anonymize="general-blurb"]').first();
    if (!blurbEl.length) return;
    // Prefer the title attribute (full unclamped text); fall back to inner text.
    const rawText = blurbEl.attr("title") || blurbEl.text();
    const post_text = rawText
      ? rawText.replace(/\u00a0/g, " ").replace(/\s{2,}/g, " ").trim()
      : "";
    if (!post_text) return;

    const timeEl = article.find("time[datetime]").first();
    const post_date = timeEl.attr("datetime") || null;

    // The "Globus Metal Powders posted a new photo." headline tells us post type/intent.
    const alert_headline = article.find("h3 strong").first().text().trim() || null;

    const alert_id = alertIdAttr;
    if (seen.has(alert_id)) return;
    seen.add(alert_id);

    results.push({
      alert_id,
      post_id: postId,
      post_text,
      post_date,
      alert_headline,
    });
  });

  return results;
}

export function extractLinkedinCompanyIdFromFilename(filename: string): string | null {
  const m = filename.match(/company_(\d+)_/);
  return m ? m[1] : null;
}

export function extractLinkedinCompanyIdFromSalesnavUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/sales\/company\/(\d+)/);
  return m ? m[1] : null;
}
