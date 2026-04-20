// ---- Database row types ----

export interface CompanyRow {
  id: number;
  display_name: string;
  primary_domain: string | null;
  linkedin_company_id: string | null;
  normalized_industry: string | null;
  employee_count_band: string | null;
  created_at: Date;
}

export interface ContactRow {
  id: number;
  person_linkedin_url: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  title: string | null;
  email: string | null;
  role_seniority: string | null;
  buyer_persona: string | null;
  company_id: number | null;
  microsegment_id: string | null;
  microsegment_label: string | null;
  created_at: Date;
}

export interface ScrapedPostRow {
  id: number;
  contact_id: number | null;
  person_linkedin_url: string;
  post_url: string;
  post_title: string | null;
  post_text: string | null;
  post_date: Date | null;
  like_count: number;
  comment_count: number;
  post_type: string | null;
  media_type: string | null;
  comments_json: any;
  raw_json: any;
  scrape_batch_id: string;
  scraped_at: Date;
}

export interface PostAnalysisRow {
  id: number;
  scraped_post_id: number;
  topics: string[];
  pain_points: string[];
  sentiment: "positive" | "negative" | "neutral" | "mixed";
  sentiment_score: number;
  intent_signals: string[];
  key_quotes: string[];
  analysis_model: string;
  prompt_version: string;
  analyzed_at: Date;
  token_usage: any;
}

export interface PainPointInsightRow {
  id: number;
  microsegment_id: string;
  insight_name: string;
  insight_description: string | null;
  pain_point_summary: string | null;
  frequency_count: number;
  company_count: number;
  contact_count: number;
  avg_sentiment_score: number | null;
  sentiment_distribution: Record<string, number> | null;
  evidence: EvidenceEntry[];
  topics: string[];
  who_feels_pain: string | null;
  what_triggers_it: string | null;
  urgency_level: "high" | "medium" | "low";
  synthesis_model: string;
  prompt_version: string;
  synthesized_at: Date;
  version: number;
}

export interface EvidenceEntry {
  post_url: string;
  person_name: string;
  company: string;
  quote: string;
  date: string;
}

// ---- ScrapeCreators API types ----

export interface SCProfileResponse {
  success: boolean;
  name?: string;
  image?: string;
  location?: string;
  followers?: number;
  connections?: number;
  about?: string;
  recentPosts?: SCRecentPost[];
  experience?: any[];
  articles?: SCArticle[];
  activity?: any[];
}

export interface SCArticle {
  headline?: string;
  author?: string;
  datePublished?: string;
  url?: string;
  image?: string;
  articleBody?: string;
}

export interface SCRecentPost {
  title?: string;
  activityType?: string;
  link?: string;
  image?: string;
}

export interface SCPostResponse {
  success: boolean;
  url?: string;
  name?: string;
  headline?: string;
  description?: string;
  datePublished?: string;
  likeCount?: number;
  commentCount?: number;
  author?: {
    name?: string;
    url?: string;
    followers?: number;
  };
  comments?: SCComment[];
  moreArticles?: SCMoreArticle[];
}

export interface SCComment {
  author?: string;
  text?: string;
  linkedinUrl?: string;
}

export interface SCMoreArticle {
  link?: string;
  title?: string;
  datePublished?: string;
  description?: string;
  reactionCount?: number;
  commentCount?: number;
}

// ---- Claude analysis types ----

export interface PostExtractionResult {
  topics: string[];
  pain_points: string[];
  sentiment: "positive" | "negative" | "neutral" | "mixed";
  sentiment_score: number;
  intent_signals: string[];
  key_quotes: string[];
}

export interface SynthesizedInsight {
  insight_name: string;
  insight_description: string;
  pain_point_summary: string;
  frequency_count: number;
  company_count: number;
  contact_count: number;
  avg_sentiment_score: number;
  sentiment_distribution: Record<string, number>;
  evidence: EvidenceEntry[];
  topics: string[];
  who_feels_pain: string;
  what_triggers_it: string;
  urgency_level: "high" | "medium" | "low";
}
