/**
 * Stage 2 prompt: Cross-post pain point synthesis.
 * Used with Claude Sonnet for balanced quality/cost.
 */

export const PAIN_SYNTHESIS_SYSTEM = `You are a senior B2B market research analyst synthesizing pain points from hundreds of LinkedIn posts by decision-makers in a specific industry segment.

Your task: identify the 5-10 most significant, recurring pain points across all posts, ranked by frequency and business urgency.

Rules:
- Cluster similar pain points together (e.g., "hiring is hard" and "can't find engineers" are the same theme).
- Each insight must cite specific evidence: post URLs, author names, companies, and direct quotes.
- Urgency levels: "high" = mentioned by many, strong negative sentiment, business-critical; "medium" = moderate frequency, some frustration; "low" = mentioned by few, mild concern.
- Distinguish between:
  - Operational pain (day-to-day challenges)
  - Strategic pain (market/competitive threats)
  - Resource pain (hiring, funding, time)
  - Compliance/regulatory pain
- For each insight, explain WHO feels this pain (role/company type) and WHAT triggers it.
- If posts are mostly positive/promotional with few pain points, say so honestly — don't manufacture problems.

Respond with valid JSON only. No markdown, no explanation.`;

export const PAIN_SYNTHESIS_USER = (context: {
  microsegmentId: string;
  microsegmentLabel: string;
  totalPosts: number;
  totalContacts: number;
  totalCompanies: number;
  posts: Array<{
    postUrl: string;
    authorName: string;
    authorCompany: string;
    topics: string[];
    painPoints: string[];
    sentiment: string;
    sentimentScore: number;
    keyQuotes: string[];
    postDate: string;
  }>;
}) => `Synthesize pain point insights from ${context.totalPosts} LinkedIn posts by ${context.totalContacts} decision-makers across ${context.totalCompanies} companies in the "${context.microsegmentLabel}" segment.

Posts data (JSON array):
${JSON.stringify(context.posts, null, 0)}

Return JSON with this exact structure:
{
  "insights": [
    {
      "insight_name": "Short descriptive name",
      "insight_description": "2-3 sentence description of the pain point pattern",
      "pain_point_summary": "One-line summary",
      "frequency_count": 12,
      "company_count": 8,
      "contact_count": 10,
      "avg_sentiment_score": -0.4,
      "sentiment_distribution": {"negative": 8, "mixed": 3, "neutral": 1},
      "evidence": [
        {
          "post_url": "https://linkedin.com/...",
          "person_name": "Jane Doe",
          "company": "Acme Corp",
          "quote": "exact quote from post",
          "date": "2026-01-15"
        }
      ],
      "topics": ["related topic 1", "related topic 2"],
      "who_feels_pain": "CTOs and engineering leaders at mid-size SaaS companies",
      "what_triggers_it": "Rapid scaling exposing infrastructure gaps",
      "urgency_level": "high"
    }
  ]
}`;
