/**
 * Canonical seniority-bucket classifier, shared between the API and the dashboard.
 *
 * The previous implementations lived (a) as a SQL CASE in the contact-stats endpoint
 * and (b) as a JS function in SegmentDetail.tsx. Keeping them in sync across three
 * places would be brittle; this is the single source of truth. The dashboard
 * imports `ROLE_BUCKETS` from this file for its filter chip row.
 */

export const ROLE_BUCKETS = [
  "CEO/Founder/MD",
  "C-Suite",
  "VP",
  "Director/Head",
  "Senior IC",
  "Manager",
  "Other",
] as const;

export type RoleBucket = (typeof ROLE_BUCKETS)[number];

export function roleBucket(title: string | null | undefined): RoleBucket {
  if (!title) return "Other";
  const t = title.toLowerCase();
  if (
    /(\bceo\b|chief executive|founder|\bowner\b|\bpresident\b|managing director|\bmd\b)/.test(t)
  ) {
    return "CEO/Founder/MD";
  }
  if (/(\bcto\b|\bcfo\b|\bcoo\b|\bcio\b|\bcmo\b|\bcro\b|\bchief\b)/.test(t)) {
    return "C-Suite";
  }
  if (/(\bvp\b|vice president|\bsvp\b|\bevp\b)/.test(t)) {
    return "VP";
  }
  if (/(director|head of|\bpartner\b)/.test(t)) {
    return "Director/Head";
  }
  if (/(senior manager|\bprincipal\b|lead engineer|technical lead)/.test(t)) {
    return "Senior IC";
  }
  if (/\bmanager\b/.test(t)) {
    return "Manager";
  }
  return "Other";
}
