-- LinkedIn Pain Points Analysis — PostgreSQL Schema

-- Companies (seeded from MXD Compass)
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  display_name TEXT NOT NULL,
  primary_domain TEXT,
  linkedin_company_id TEXT,
  normalized_industry TEXT,
  employee_count_band TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_domain
  ON companies(primary_domain) WHERE primary_domain IS NOT NULL;

-- Contacts (seeded from MXD Compass)
CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  person_linkedin_url TEXT NOT NULL UNIQUE,
  first_name TEXT,
  last_name TEXT,
  full_name TEXT,
  title TEXT,
  email TEXT,
  role_seniority TEXT,
  buyer_persona TEXT,
  company_id INTEGER REFERENCES companies(id),
  microsegment_id TEXT,
  microsegment_label TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contacts_microsegment ON contacts(microsegment_id);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);

-- Scrape runs (execution tracking)
CREATE TABLE IF NOT EXISTS scrape_runs (
  id SERIAL PRIMARY KEY,
  stage TEXT CHECK(stage IN ('scrape','analysis','synthesis')),
  microsegment_id TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT CHECK(status IN ('running','completed','failed','partial')) DEFAULT 'running',
  contacts_processed INTEGER DEFAULT 0,
  posts_scraped INTEGER DEFAULT 0,
  posts_analyzed INTEGER DEFAULT 0,
  insights_produced INTEGER DEFAULT 0,
  error_log TEXT
);

-- Scraped posts (raw from ScrapeCreators)
CREATE TABLE IF NOT EXISTS scraped_posts (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER REFERENCES contacts(id),
  person_linkedin_url TEXT NOT NULL,
  post_url TEXT NOT NULL UNIQUE,
  post_title TEXT,
  post_text TEXT,
  post_date TIMESTAMPTZ,
  like_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  post_type TEXT,
  media_type TEXT,
  comments_json JSONB,
  raw_json JSONB,
  scrape_batch_id TEXT NOT NULL,
  scraped_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scraped_posts_contact ON scraped_posts(contact_id);
CREATE INDEX IF NOT EXISTS idx_scraped_posts_date ON scraped_posts(post_date);
CREATE INDEX IF NOT EXISTS idx_scraped_posts_batch ON scraped_posts(scrape_batch_id);

-- Post analysis (Claude-extracted per-post)
CREATE TABLE IF NOT EXISTS post_analysis (
  id SERIAL PRIMARY KEY,
  scraped_post_id INTEGER NOT NULL UNIQUE REFERENCES scraped_posts(id),
  topics JSONB,
  pain_points JSONB,
  sentiment TEXT CHECK(sentiment IN ('positive','negative','neutral','mixed')),
  sentiment_score REAL,
  intent_signals JSONB,
  key_quotes JSONB,
  analysis_model TEXT,
  prompt_version TEXT,
  analyzed_at TIMESTAMPTZ DEFAULT NOW(),
  token_usage JSONB
);

-- Company posts (from LinkedIn company pages — public, high-yield)
CREATE TABLE IF NOT EXISTS scraped_company_posts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  company_linkedin_url TEXT NOT NULL,
  post_url TEXT NOT NULL UNIQUE,
  post_id TEXT,
  post_text TEXT,
  post_date TIMESTAMPTZ,
  raw_json JSONB,
  scrape_batch_id TEXT NOT NULL,
  scraped_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_company_posts_company ON scraped_company_posts(company_id);
CREATE INDEX IF NOT EXISTS idx_company_posts_date ON scraped_company_posts(post_date);

-- Per-company-post analysis (parallel to post_analysis)
CREATE TABLE IF NOT EXISTS company_post_analysis (
  id SERIAL PRIMARY KEY,
  company_scraped_post_id INTEGER NOT NULL UNIQUE REFERENCES scraped_company_posts(id),
  topics JSONB,
  pain_points JSONB,
  sentiment TEXT CHECK(sentiment IN ('positive','negative','neutral','mixed')),
  sentiment_score REAL,
  intent_signals JSONB,
  key_quotes JSONB,
  analysis_model TEXT,
  prompt_version TEXT,
  analyzed_at TIMESTAMPTZ DEFAULT NOW(),
  token_usage JSONB
);

-- Pain point insights (aggregated cross-post per microsegment)
CREATE TABLE IF NOT EXISTS pain_point_insights (
  id SERIAL PRIMARY KEY,
  microsegment_id TEXT NOT NULL,
  insight_name TEXT NOT NULL,
  insight_description TEXT,
  pain_point_summary TEXT,
  frequency_count INTEGER DEFAULT 0,
  company_count INTEGER DEFAULT 0,
  contact_count INTEGER DEFAULT 0,
  avg_sentiment_score REAL,
  sentiment_distribution JSONB,
  evidence JSONB,
  topics JSONB,
  who_feels_pain TEXT,
  what_triggers_it TEXT,
  urgency_level TEXT CHECK(urgency_level IN ('high','medium','low')),
  synthesis_model TEXT,
  prompt_version TEXT,
  synthesized_at TIMESTAMPTZ DEFAULT NOW(),
  version INTEGER DEFAULT 1,
  UNIQUE(microsegment_id, insight_name)
);
CREATE INDEX IF NOT EXISTS idx_insights_microsegment ON pain_point_insights(microsegment_id);
