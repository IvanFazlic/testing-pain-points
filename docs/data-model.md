# Data Model — Pain Points → LinkedIn Ads Dashboard

One-page reference for what's in the DB, how it got there, and how the dashboard
filters slice it. Snapshot as of 2026-04-20 for microsegment
`uk-industrial-iot::ex-london`.

---

## Live row counts

### Global (all microsegments)

| Table | Rows | Notes |
|---|---:|---|
| `companies` | 4,953 | From MXD Compass seed + Sales Nav seed |
| `contacts` | 18,365 | 1,151 in IoT cohort; rest across 39 other MSs untagged |
| `scraped_company_posts` | 6,170 | 6,121 from Sales Nav HTML (`salesnav://…`), 49 from ScrapeCreators smoke |
| `company_post_analysis` | 5,757 | Haiku-extracted topics/pain_points/sentiment per post |
| `scraped_posts` | 5 | Individual-person posts (near-empty; ScrapeCreators not run) |
| `post_analysis` | 5 | Parallel to above, also near-empty |
| `pain_point_insights` | 39 | Synthesized cross-post pain points (24 for IoT) |
| `post_insight_tags` | 13,686 | Post → insight join (evidence + fuzzy + LLM) |
| `scrape_runs` | 21 | Execution/audit log |

### IoT cohort

| Scope | Count |
|---|---:|
| Companies | 450 |
| Contacts | 1,151 (all with Sales Nav URL, 496 with location, 666 with bio) |
| Company posts | 5,725 distinct |
| Analyzed posts | 5,719 (Haiku 4.5) |
| Synthesized insights | 24 (12 high-urgency, 12 medium) |
| Post → insight tag edges | 13,686 (4,435 posts tagged = 77%) |

---

## Entity diagram (logical)

```
┌────────────────────┐      1..N      ┌────────────────────┐
│     companies      │ ─────────────→ │      contacts      │
│────────────────────│                │────────────────────│
│ id (PK)            │                │ id (PK)            │
│ display_name       │                │ person_linkedin_url│  ← UNIQUE
│ primary_domain ◆   │                │ full_name / title  │
│ linkedin_company_id│                │ company_id ──┐ FK  │
│ company_linkedin_url│               │ microsegment_id ★  │
│ normalized_industry│                │ role_seniority ✚   │  ← backfilled
│ employee_count_band│                │ connection_degree  │
│ raw_employee_count │                │ location / bio     │
│ revenue_band       │                │ salesnav_lead_url  │
│ headquarters       │                │ tenure_in_role     │
│ about_text         │                └────────────────────┘
└────────────────────┘                         │
        │                                      │ posts authored by a contact
        │ 1..N posts by the company page       │ (near-empty today)
        ▼                                      ▼
┌──────────────────────┐               ┌─────────────────────┐
│ scraped_company_posts│               │   scraped_posts     │
│──────────────────────│               │─────────────────────│
│ id (PK)              │               │ id (PK)             │
│ post_url (UNIQUE) ◆  │               │ post_url (UNIQUE) ◆ │
│ company_id FK        │               │ contact_id FK       │
│ post_text            │               │ post_text           │
│ post_date            │               │ post_date, likes…   │
│ raw_json             │               │ raw_json            │
└──────────────────────┘               └─────────────────────┘
        │ 1..1                                  │ 1..1
        ▼                                      ▼
┌──────────────────────┐               ┌─────────────────────┐
│ company_post_analysis│               │   post_analysis     │
│──────────────────────│               │─────────────────────│
│ topics[] (JSONB)     │               │ same shape, parallel│
│ pain_points[] JSONB  │               │ table for per-person│
│ sentiment (+score)   │               │ posts               │
│ intent_signals[]     │               └─────────────────────┘
│ key_quotes[]         │
│ analysis_model       │
└──────────────────────┘
        │ many-to-many
        │ via post_insight_tags
        ▼
┌──────────────────────────────────────────┐
│          post_insight_tags  (NEW)         │
│──────────────────────────────────────────│
│ id (PK)                                   │
│ company_scraped_post_id  XOR              │
│ scraped_post_id          ───┐             │  ← exactly one set
│ insight_id  ──────────→ pain_point_insights│
│ microsegment_id  (★)                      │
│ score (0..1)   source ∈                   │
│   {evidence, fuzzy, llm, manual}          │
│ UNIQUE (post, insight)  ← idempotent      │
└──────────────────────────────────────────┘
        │ M..1
        ▼
┌────────────────────────────────────────────┐
│             pain_point_insights            │
│────────────────────────────────────────────│
│ id (PK)                                    │
│ microsegment_id (★)                        │
│ insight_name           UNIQUE(ms, name)    │
│ insight_description                        │
│ pain_point_summary                         │
│ who_feels_pain                             │
│ what_triggers_it                           │
│ urgency_level  ∈ {high, medium, low}       │
│ frequency_count / company_count /          │
│   contact_count                            │
│ avg_sentiment_score / sentiment_distribution│
│ topics[] (JSONB)                           │
│ evidence[] (JSONB)  ← [{post_url, quote,   │
│                         company, person,   │
│                         date}, …]          │
└────────────────────────────────────────────┘

◆ = indexed for lookup / dedupe
★ = microsegment_id (TEXT); not FK'd to a table — soft foreign key
✚ = backfilled by scripts/backfill-role-seniority.ts from src/lib/role-bucket.ts
```

---

## Data flow (how rows land in each table)

```
┌──────────────────────────┐
│  Sales Nav HTML bundle   │   (linkedin_account/linkedin_account/scraped html/)
│                          │
│   company_<id>_page.html │
│   company_<id>_decision_makers.html
│   upload_<cohort>.csv    │
│   linkedin_sales_nav_*.csv
└────────────┬─────────────┘
             │
             │ scripts/seed-from-linkedin-salesnav.ts
             │   ├─ parseCompanyPage         → UPSERT companies
             │   ├─ parseDecisionMakers      → UPSERT contacts
             │   └─ parseCompanyPagePosts    → INSERT scraped_company_posts
             │                                  (post_url = salesnav://<co>/alert/<id>)
             ▼
     [companies] [contacts] [scraped_company_posts]
             │
             │ scripts/run-company-analysis.ts  (Haiku 4.5, concurrency 10)
             ▼
     [company_post_analysis]  — per-post topics / pains / sentiment
             │
             │ scripts/run-analysis.ts --stage 2  (Haiku 4.5, 16k tokens)
             ▼
     [pain_point_insights]  — synthesized cross-post insights
         (writes evidence=[{post_url, quote, …}] back-reference)
             │
             │ tagging pipeline (THREE passes, idempotent)
             │   1. scripts/bootstrap-tags-from-evidence.ts   (source=evidence, score=1.0)
             │   2. scripts/run-fuzzy-tagging.ts              (pg_trgm, threshold 0.45 → 0.55)
             │   3. scripts/run-llm-tagging.ts                (Haiku classify residual)
             ▼
     [post_insight_tags]  — 13,686 edges across 24 insights
             │
             │ API layer  /api/audiences/{preview,export}
             │            /api/contacts  (filtered)
             ▼
        Dashboard AudienceBuilder → CSV → LinkedIn Campaign Manager
```

### Auxiliary enrichment (available but not fully run)

```
ScrapeCreators API                       credits: 4 remaining
  GET /v1/linkedin/company/posts?url=    (slug-form required — numeric IDs 500)
       → scraped_company_posts           (49 rows from smoke)
  GET /v1/linkedin/profile?url=          (not used yet — enables scraped_posts)
       → scraped_posts + post_analysis
```

---

## Filters — where each filter hits the DB

All filters are composable and optional on `/api/contacts`, `/api/audiences/preview`,
`/api/audiences/export`. Missing filter = axis wide open.

| Filter (URL param)    | SQL Column / Join                                  | Populated by                               |
|-----------------------|----------------------------------------------------|--------------------------------------------|
| `microsegment`        | `contacts.microsegment_id`                         | seeder (hard-coded per cohort)            |
| `insight_id` (CSV)    | `EXISTS (… post_insight_tags pit WHERE pit.insight_id = ANY($x))` | tagging passes (evidence / fuzzy / llm)   |
| `industry` (CSV)      | `companies.normalized_industry = ANY($x)`          | parsed from Sales Nav `[data-anonymize="industry"]` |
| `seniority` (CSV)     | `contacts.role_seniority = ANY($x)`                | `backfill-role-seniority.ts` + `roleBucket()` |
| `degree` (CSV)        | `contacts.connection_degree = ANY($x)`             | parsed from Sales Nav regex `\b(1st\|2nd\|3rd\+?)\b` |
| `has_bio`             | `contacts.bio IS NOT NULL AND bio <> ''`           | parsed from `[data-anonymize="person-blurb"]` `title` attr |
| `page` / `limit`      | `LIMIT $n OFFSET $m`                               | — |

Role buckets (canonical in `src/lib/role-bucket.ts`, mirrored in
`dashboard/src/pages/SegmentDetail.tsx`):

| Bucket | Regex (on lowercased title) |
|---|---|
| CEO/Founder/MD | `\bceo\b \| chief executive \| founder \| \bowner\b \| \bpresident\b \| managing director \| \bmd\b` |
| C-Suite | `\bcto\b \| \bcfo\b \| \bcoo\b \| \bcio\b \| \bcmo\b \| \bcro\b \| \bchief\b` |
| VP | `\bvp\b \| vice president \| \bsvp\b \| \bevp\b` |
| Director/Head | `director \| head of \| \bpartner\b` |
| Senior IC | `senior manager \| \bprincipal\b \| lead engineer \| technical lead` |
| Manager | `\bmanager\b` |
| Other | (fallback) |

---

## Key fields on contacts (what the exported CSV draws from)

| DB column | Used in export CSV as | Export-ready? | Source |
|---|---|---|---|
| `first_name`, `last_name` | `first_name`, `last_name` | ✅ | Sales Nav person-name split on first space |
| `title` | `job_title` | ✅ | `[data-anonymize="title"]` |
| `companies.display_name` (via JOIN) | `company` | ✅ | Sales Nav company page |
| `location` | → `country` via `countryFromLocation()` | ✅ (coarse) | `[data-anonymize="location"]`, split on last comma |
| `salesnav_lead_url` | `linkedin_url` | ⚠️ see below | Sales Nav `/sales/lead/ACwAA…` anchor |
| `person_linkedin_url` | fallback `linkedin_url` | same as above | same |
| `email` | `email` | ❌ always blank | not enriched |

**The `linkedin_url` caveat** is the one thing to know about LinkedIn Matched
Audiences compatibility — see next section.

---

## LinkedIn Matched Audiences readiness

LinkedIn Campaign Manager accepts contact lists via any of:

1. **Hashed email** (best match rate; hashes their DB of member emails) — **we have 0 emails**.
2. **Name + Company + Job Title** (coarse match, lower rate; good fallback) — **we have 1,151/1,151**.
3. **LinkedIn Member URN / Profile URL** (`https://www.linkedin.com/in/<vanity>`) — **we have 0 of these in the right format**.

The Sales Nav URLs we store look like:

```
https://www.linkedin.com/sales/lead/ACwAAARldoMBF1XL4DpfGs_KSI_EsXV3F1nZuvQ,NAME_SEARCH,kF-Q
```

That is a Sales Nav internal lead URL with an obfuscated member ID. It is not
the same thing as a public `linkedin.com/in/<vanity>` URL. LinkedIn's Campaign
Manager **will not match** these URLs directly against its member graph.

**What actually happens on upload today** (URL-only path):
- The CSV parses — column headers are correct (`first_name,last_name,email,company,job_title,country,linkedin_url`).
- LinkedIn silently ignores the unparseable `sales/lead/…` URLs and falls back to name + company + title matching on each row.
- That fallback typically yields **30–50 % match rate** (acceptable for a test campaign, not great).

**To get a good match rate (>70%), we need one of:**

| Option | How | Cost | Privacy |
|---|---|---|---|
| **A. Resolve to public URLs** | Run `GET /v1/linkedin/profile?url=<salesnav_lead_url>` via ScrapeCreators — the response includes the public `/in/<vanity>` URL and profile data. Then rewrite the CSV. | 1 credit per contact × 1,151 = ~$12 at ScrapeCreators rates | ✅ same source already used |
| **B. Email enrichment** | Use a vendor (Apollo, Clearbit, Hunter) keyed on `first_name + last_name + company_domain`. Backfill `contacts.email`. | Vendor-dependent; Apollo ~$0.30/lookup | ⚠️ new PII surface |
| **C. Ship as-is, accept lower match** | No further work; LinkedIn does the name/company/title fallback. | $0 | ✅ minimal |

**Minimum-viable recommendation for first live campaign:** ship as-is (option C),
measure the LinkedIn-reported match rate on a small test audience, then decide
whether the match rate justifies paying for option A or B.

---

## Do we need ScrapeCreators?

Status: optional for current cohort, necessary for expansion.

| Use case | Needs ScrapeCreators? | Why |
|---|---|---|
| IoT cohort end-to-end (done) | **No** — Sales Nav HTML embedded the posts | `parseCompanyPagePosts` harvested 6,121 posts from `[data-anonymize="general-blurb"]` directly |
| Resolving Sales Nav URLs → public `/in/` URLs for Matched Audiences | **Yes** | LinkedIn UI obfuscates public URLs in Sales Nav HTML |
| Scraping person-level posts (not just company-page) | **Yes** | Richer intent signals per contact, not in Sales Nav HTML |
| Expanding to other microsegments **without** new Sales Nav exports (e.g. the 39 existing cohorts with only numeric LinkedIn IDs) | **Yes, with a prerequisite** | Script already patched to use slug URLs; need the slugs for each company first. No free way to get them from numeric IDs without ScrapeCreators' company lookup |
| Expanding to new microsegments **with** a fresh Sales Nav HTML bundle | **No** | Same free path as the IoT cohort |

Right now ScrapeCreators credit balance = **4**. Topup required for any of the
"Yes" rows above.

---

## Operational endpoints (for the dashboard)

| Endpoint | Purpose | Key joins |
|---|---|---|
| `GET /api/overview` | Segments list + totals | `contacts ⨝ companies ⨝ scraped_* ⨝ post_analysis ⨝ insights` |
| `GET /api/insights/:ms` | Insight list + stats for a segment | `pain_point_insights` filtered by ms |
| `GET /api/insights/:ms/posts` | Paged posts for a segment | `scraped_company_posts ⨝ contacts` |
| `GET /api/insights/:ms/topics` | Top extracted topics | `jsonb_array_elements(company_post_analysis.topics)` |
| `GET /api/insights/:ms/company-breakdown` | Industry / revenue / HQ / size | `companies` fields |
| `GET /api/insights/:ms/contact-stats` | Role / degree / location / coverage | `contacts` fields |
| `GET /api/contacts?microsegment=…&insight_id=…&…` | Paged contact rows, filterable | `contacts ⨝ companies ⨝ EXISTS(post_insight_tags)` |
| `GET /api/audiences/preview?…` | Live count + breakdown for builder UI | same |
| `GET /api/audiences/export?…` | LinkedIn Matched Audiences CSV download | same |
| `GET /api/export/csv/:ms` | Insights export (not contacts) | `pain_point_insights` |
