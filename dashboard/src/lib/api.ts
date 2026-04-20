// In dev, Vite proxies /api → localhost:3030 (vite.config.ts). In production,
// set VITE_API_URL at build time (Vercel env var) to the Railway URL, e.g.
// `https://pain-points-api.up.railway.app`. Leave unset for same-origin deploys.
const API_ORIGIN = import.meta.env.VITE_API_URL ?? "";
const BASE = `${API_ORIGIN}/api`;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}

export interface OverviewData {
  totals: {
    total_contacts: number;
    total_companies: number;
    total_posts: number;
    total_analyzed: number;
    total_insights: number;
  };
  segments: Array<{
    microsegment_id: string;
    microsegment_label: string;
    contact_count: number;
    post_count: number;
    analyzed_count: number;
    insight_count: number;
  }>;
}

export interface InsightData {
  microsegment_id: string;
  microsegment_label: string;
  stats: {
    post_count: number;
    analyzed_count: number;
    contact_count: number;
    company_count: number;
    avg_sentiment: number | null;
  };
  insights: Insight[];
}

export interface Insight {
  id: number;
  insight_name: string;
  insight_description: string | null;
  pain_point_summary: string | null;
  frequency_count: number;
  company_count: number;
  contact_count: number;
  avg_sentiment_score: number | null;
  sentiment_distribution: Record<string, number> | null;
  evidence: Array<{
    post_url: string;
    person_name: string;
    company: string;
    quote: string;
    date: string;
  }>;
  topics: string[];
  who_feels_pain: string | null;
  what_triggers_it: string | null;
  urgency_level: string;
}

export interface PostsData {
  page: number;
  limit: number;
  total: number;
  posts: Post[];
}

export interface Post {
  id: number;
  post_url: string;
  post_title: string | null;
  post_text: string | null;
  post_date: string | null;
  like_count: number;
  comment_count: number;
  full_name: string | null;
  first_name: string | null;
  author_title: string | null;
  company_name: string | null;
  topics: string[] | null;
  pain_points: string[] | null;
  sentiment: string | null;
  sentiment_score: number | null;
  key_quotes: string[] | null;
}

export interface TopicsData {
  topics: Array<{ topic: string; count: number }>;
}

export interface BreakdownEntry {
  label: string;
  count: number;
}

export interface CompanyBreakdownData {
  industries: BreakdownEntry[];
  revenue_bands: BreakdownEntry[];
  employee_bands: BreakdownEntry[];
  hq_locations: BreakdownEntry[];
}

export interface ContactStatsData {
  roles: BreakdownEntry[];
  degrees: BreakdownEntry[];
  locations: BreakdownEntry[];
  coverage: { total: number; with_bio: number; with_lead_url: number };
}

export interface Contact {
  id: number;
  full_name: string | null;
  title: string | null;
  location: string | null;
  bio: string | null;
  tenure_in_role: string | null;
  connection_degree: string | null;
  role_seniority: string | null;
  public_linkedin_url: string | null;
  salesnav_lead_url: string | null;
  person_linkedin_url: string | null;
  company_name: string | null;
  company_industry: string | null;
  microsegment_id: string | null;
  microsegment_label: string | null;
  post_count: number;
  analyzed_count: number;
}

export interface ContactsResponse {
  page: number;
  limit: number;
  contacts: Contact[];
}

export const fetchOverview = () => get<OverviewData>("/overview");
export const fetchInsights = (msId: string) => get<InsightData>(`/insights/${msId}`);
export const fetchPosts = (msId: string, page = 1, limit = 50) =>
  get<PostsData>(`/insights/${msId}/posts?page=${page}&limit=${limit}`);
export const fetchTopics = (msId: string) => get<TopicsData>(`/insights/${msId}/topics`);
export const fetchCompanyBreakdown = (msId: string) =>
  get<CompanyBreakdownData>(`/insights/${msId}/company-breakdown`);
export const fetchContactStats = (msId: string) =>
  get<ContactStatsData>(`/insights/${msId}/contact-stats`);
export const fetchContacts = (msId: string, page = 1, limit = 50) =>
  get<ContactsResponse>(`/contacts?microsegment=${encodeURIComponent(msId)}&page=${page}&limit=${limit}`);

// ---- Audience builder (LinkedIn Ads targeting) ----

export interface AudienceFilters {
  insight_id?: number[];
  industry?: string[];
  seniority?: string[];
  degree?: string[];
  has_bio?: boolean;
  /** Recency window, e.g. "30d", "90d", "365d". Matches only companies with a
   *  qualifying post within the window. */
  since?: string;
}

export interface AudiencePreview {
  count: number;
  by_role: BreakdownEntry[];
  by_industry: BreakdownEntry[];
}

function filterQuery(msId: string, f: AudienceFilters): string {
  const parts = [`microsegment=${encodeURIComponent(msId)}`];
  if (f.insight_id?.length) parts.push(`insight_id=${f.insight_id.join(",")}`);
  if (f.industry?.length)
    parts.push(`industry=${f.industry.map(encodeURIComponent).join(",")}`);
  if (f.seniority?.length)
    parts.push(`seniority=${f.seniority.map(encodeURIComponent).join(",")}`);
  if (f.degree?.length) parts.push(`degree=${f.degree.join(",")}`);
  if (f.has_bio) parts.push(`has_bio=true`);
  if (f.since) parts.push(`since=${encodeURIComponent(f.since)}`);
  return parts.join("&");
}

export const fetchAudiencePreview = (msId: string, f: AudienceFilters) =>
  get<AudiencePreview>(`/audiences/preview?${filterQuery(msId, f)}`);

/** Absolute URL suitable for <a href> / window.open triggering a CSV download. */
export const audienceExportUrl = (msId: string, f: AudienceFilters) =>
  `${API_ORIGIN}/api/audiences/export?${filterQuery(msId, f)}`;

/** Absolute URL for the insights CSV export. Same cross-origin handling as above. */
export const insightsCsvUrl = (msId: string) =>
  `${API_ORIGIN}/api/export/csv/${encodeURIComponent(msId)}`;

export const fetchContactsFiltered = (
  msId: string,
  f: AudienceFilters,
  page = 1,
  limit = 100,
) =>
  get<ContactsResponse>(
    `/contacts?${filterQuery(msId, f)}&page=${page}&limit=${limit}`,
  );
