/**
 * LinkedIn Matched Audiences export helpers.
 *
 * LinkedIn Campaign Manager accepts either a list of hashed emails OR a list of
 * profile URLs. We export URL-only for now (contacts have no emails). Column order
 * matches LinkedIn's template:
 *
 *   first_name,last_name,email,company,job_title,country,linkedin_url
 */

import type { Response } from "express";

export interface AudienceRow {
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  job_title: string | null;
  location: string | null;
  // Preferred for LinkedIn Matched Audiences URL match — URN-form /in/<URN>
  // (built by rebuild-public-urls.ts from the Sales Nav lead URL).
  public_linkedin_url: string | null;
  salesnav_lead_url: string | null;
  person_linkedin_url: string | null;
}

/** Map a `contacts.location` string ("Sheffield, England, United Kingdom") to an ISO-ish country name. */
export function countryFromLocation(location: string | null): string {
  if (!location) return "";
  const last = location.split(",").pop()?.trim() ?? "";
  // Normalize the most common variants. LinkedIn accepts full country names; the
  // exact ISO code isn't required. Keep this table small — anything we don't know
  // falls through as the raw tail.
  const norm = last.toLowerCase();
  if (/united kingdom|england|scotland|wales|northern ireland/.test(norm)) return "United Kingdom";
  if (/united states|usa|\bus\b/.test(norm)) return "United States";
  if (/ireland/.test(norm)) return "Ireland";
  if (/germany|deutschland/.test(norm)) return "Germany";
  if (/france/.test(norm)) return "France";
  if (/spain|españa/.test(norm)) return "Spain";
  if (/netherlands|holland/.test(norm)) return "Netherlands";
  if (/canada/.test(norm)) return "Canada";
  if (/australia/.test(norm)) return "Australia";
  if (/india/.test(norm)) return "India";
  if (/singapore/.test(norm)) return "Singapore";
  if (/china/.test(norm)) return "China";
  return last;
}

function csvEscape(v: string | null | undefined): string {
  const s = v ?? "";
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Build the CSV body (header + rows) suitable for direct upload to LinkedIn. */
export function buildAudienceCsv(rows: AudienceRow[]): string {
  const header = "first_name,last_name,email,company,job_title,country,linkedin_url";
  const body = rows.map((r) =>
    [
      csvEscape(r.first_name),
      csvEscape(r.last_name),
      "", // email intentionally blank — URL-only export
      csvEscape(r.company),
      csvEscape(r.job_title),
      csvEscape(countryFromLocation(r.location)),
      // Prefer the URN-form public URL (LinkedIn canonicalizes to vanity); fall back
      // to the Sales Nav URL (won't match) so the row at least carries some link.
      csvEscape(r.public_linkedin_url ?? r.salesnav_lead_url ?? r.person_linkedin_url),
    ].join(","),
  );
  return [header, ...body].join("\n") + "\n";
}

/** Stream the CSV as a download response. Sets X-Audience-Size for UI counters. */
export function sendAudienceCsv(
  res: Response,
  rows: AudienceRow[],
  filename: string,
): void {
  const csv = buildAudienceCsv(rows);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
  );
  res.setHeader("X-Audience-Size", String(rows.length));
  // Expose the custom header so a same-origin fetch can read it via response.headers.
  res.setHeader("Access-Control-Expose-Headers", "X-Audience-Size");
  res.send(csv);
}
