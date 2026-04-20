const BASE = "/api";

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

export const fetchOverview = () => get<OverviewData>("/overview");
export const fetchInsights = (msId: string) => get<InsightData>(`/insights/${msId}`);
export const fetchPosts = (msId: string, page = 1, limit = 50) =>
  get<PostsData>(`/insights/${msId}/posts?page=${page}&limit=${limit}`);
export const fetchTopics = (msId: string) => get<TopicsData>(`/insights/${msId}/topics`);
