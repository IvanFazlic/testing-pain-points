import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import {
  fetchInsights,
  fetchPosts,
  fetchTopics,
  fetchCompanyBreakdown,
  fetchContactStats,
  fetchContactsFiltered,
  fetchAudiencePreview,
  audienceExportUrl,
  insightsCsvUrl,
} from "../lib/api";
import type {
  Insight,
  Post,
  BreakdownEntry,
  Contact,
  AudienceFilters,
} from "../lib/api";

const URGENCY_COLORS: Record<string, string> = {
  high: "bg-red-500/20 text-red-400 border-red-500/30",
  medium: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  low: "bg-green-500/20 text-green-400 border-green-500/30",
};

const SENTIMENT_COLORS: Record<string, string> = {
  positive: "#22c55e",
  neutral: "#6b7280",
  negative: "#ef4444",
  mixed: "#eab308",
};

function BreakdownPanel({
  title,
  entries,
}: {
  title: string;
  entries: BreakdownEntry[] | undefined;
}) {
  if (!entries || entries.length === 0) return null;
  const max = Math.max(...entries.map((e) => e.count));
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h3 className="text-xs font-medium mb-3 text-gray-400 uppercase tracking-wide">
        {title}
      </h3>
      <div className="space-y-1.5">
        {entries.slice(0, 5).map((e) => (
          <div key={e.label} className="text-sm">
            <div className="flex justify-between items-baseline gap-2">
              <span className="text-gray-300 truncate" title={e.label}>
                {e.label}
              </span>
              <span className="text-gray-500 text-xs tabular-nums">{e.count}</span>
            </div>
            <div className="h-1 bg-gray-800 rounded mt-0.5 overflow-hidden">
              <div
                className="h-full bg-blue-500/60"
                style={{ width: `${(e.count / max) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Title → seniority bucket. Mirrors the SQL CASE in /contact-stats so the client-side
// filter matches the server-side bucket counts.
function roleBucket(title: string | null): string {
  if (!title) return "Other";
  const t = title.toLowerCase();
  if (
    /(\bceo\b|chief executive|founder|owner|president|managing director|\bmd\b)/.test(t)
  )
    return "CEO/Founder/MD";
  if (/(\bcto\b|\bcfo\b|\bcoo\b|\bcio\b|\bcmo\b|\bcro\b|chief\s)/.test(t))
    return "C-Suite";
  if (/(\bvp\b|vice president|\bsvp\b|\bevp\b)/.test(t)) return "VP";
  if (/(director|head of|partner)/.test(t)) return "Director/Head";
  if (/(senior manager|principal|lead engineer|technical lead)/.test(t))
    return "Senior IC";
  if (/manager/.test(t)) return "Manager";
  return "Other";
}

const ROLE_BUCKETS = [
  "CEO/Founder/MD",
  "C-Suite",
  "VP",
  "Director/Head",
  "Senior IC",
  "Manager",
  "Other",
] as const;

function ContactRow({ c }: { c: Contact }) {
  const [expanded, setExpanded] = useState(false);
  // Prefer the URN-form public URL (LinkedIn 301s to vanity). Fall back to Sales Nav
  // only if we never resolved one — that should be impossible for IoT cohort today.
  const lead = c.public_linkedin_url ?? c.salesnav_lead_url ?? c.person_linkedin_url;
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 text-sm">
      <div className="flex items-baseline gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="font-medium text-gray-100 truncate" title={c.full_name ?? ""}>
            {c.full_name ?? "—"}
          </div>
          <div className="text-xs text-gray-400 truncate" title={c.title ?? ""}>
            {c.title ?? "—"}
          </div>
        </div>
        <div className="text-xs text-gray-400 min-w-[140px] truncate" title={c.company_name ?? ""}>
          {c.company_name ?? "—"}
        </div>
        <div className="text-xs text-gray-500 min-w-[160px] truncate" title={c.location ?? ""}>
          {c.location ?? "—"}
        </div>
        <span className="text-xs text-gray-500 px-1.5 py-0.5 rounded bg-gray-800">
          {c.connection_degree ?? "?"}
        </span>
        <span className="text-xs text-gray-500 px-1.5 py-0.5 rounded bg-gray-800">
          {c.role_seniority ?? roleBucket(c.title)}
        </span>
        {lead && (
          <a
            href={lead}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-blue-400 hover:text-blue-300"
          >
            LinkedIn ↗
          </a>
        )}
        {c.bio && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-xs text-gray-400 hover:text-gray-200"
          >
            {expanded ? "Hide bio" : "Show bio"}
          </button>
        )}
      </div>
      {expanded && c.bio && (
        <div className="mt-2 text-xs text-gray-300 leading-relaxed border-t border-gray-800 pt-2">
          {c.bio}
        </div>
      )}
    </div>
  );
}

function UrgencyBadge({ level }: { level: string }) {
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded border ${URGENCY_COLORS[level] ?? "bg-gray-700 text-gray-300"}`}
    >
      {level}
    </span>
  );
}

function SentimentBadge({ sentiment }: { sentiment: string | null }) {
  if (!sentiment) return null;
  const color = SENTIMENT_COLORS[sentiment] ?? "#6b7280";
  return (
    <span
      className="text-xs px-2 py-0.5 rounded"
      style={{ background: `${color}20`, color }}
    >
      {sentiment}
    </span>
  );
}

function InsightCard({
  insight,
  expanded,
  onToggle,
  onBuildAudience,
}: {
  insight: Insight;
  expanded: boolean;
  onToggle: () => void;
  onBuildAudience: () => void;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div
        className="flex items-start justify-between gap-4 cursor-pointer"
        onClick={onToggle}
      >
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h4 className="font-medium">{insight.insight_name}</h4>
            <UrgencyBadge level={insight.urgency_level} />
          </div>
          <p className="text-sm text-gray-400">
            {insight.pain_point_summary}
          </p>
          <div className="flex gap-4 mt-2 text-xs text-gray-500">
            <span>{insight.frequency_count} mentions</span>
            <span>{insight.company_count} companies</span>
            <span>{insight.contact_count} contacts</span>
            {insight.avg_sentiment_score != null && (
              <span>
                sentiment: {insight.avg_sentiment_score.toFixed(2)}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onBuildAudience();
            }}
            className="text-xs px-2 py-1 rounded border border-blue-500/40 text-blue-300 hover:bg-blue-500/10"
          >
            Build audience →
          </button>
          <span className="text-gray-500 text-sm">{expanded ? "−" : "+"}</span>
        </div>
      </div>

      {expanded && (
        <div className="mt-4 space-y-4 border-t border-gray-800 pt-4">
          {insight.insight_description && (
            <p className="text-sm text-gray-300">{insight.insight_description}</p>
          )}

          <div className="grid grid-cols-2 gap-4 text-sm">
            {insight.who_feels_pain && (
              <div>
                <div className="text-gray-500 text-xs mb-1">Who feels this</div>
                <div className="text-gray-300">{insight.who_feels_pain}</div>
              </div>
            )}
            {insight.what_triggers_it && (
              <div>
                <div className="text-gray-500 text-xs mb-1">Trigger</div>
                <div className="text-gray-300">{insight.what_triggers_it}</div>
              </div>
            )}
          </div>

          {insight.topics && insight.topics.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {insight.topics.map((t) => (
                <span
                  key={t}
                  className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded"
                >
                  {t}
                </span>
              ))}
            </div>
          )}

          {insight.evidence && insight.evidence.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs text-gray-500 font-medium">
                Evidence ({insight.evidence.length} posts)
              </div>
              {insight.evidence.slice(0, 5).map((e, i) => (
                <div
                  key={i}
                  className="bg-gray-800/50 rounded p-3 text-sm"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-gray-300">
                      {e.person_name}
                    </span>
                    <span className="text-gray-500">at {e.company}</span>
                    <span className="text-gray-600 text-xs">{e.date}</span>
                  </div>
                  <blockquote className="text-gray-400 italic border-l-2 border-gray-700 pl-3">
                    "{e.quote}"
                  </blockquote>
                  <a
                    href={e.post_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:text-blue-300 text-xs mt-1 inline-block"
                  >
                    View on LinkedIn
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PostCard({ post }: { post: Post }) {
  const [expanded, setExpanded] = useState(false);
  const text = post.post_text ?? "";
  const preview = text.length > 200 ? text.slice(0, 200) + "..." : text;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="font-medium text-sm">
          {post.full_name ?? post.first_name ?? "Unknown"}
        </span>
        {post.author_title && (
          <span className="text-gray-500 text-xs">{post.author_title}</span>
        )}
        {post.company_name && (
          <span className="text-gray-500 text-xs">at {post.company_name}</span>
        )}
        <SentimentBadge sentiment={post.sentiment} />
      </div>

      <p className="text-sm text-gray-300 whitespace-pre-line">
        {expanded ? text : preview}
        {text.length > 200 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-blue-400 hover:text-blue-300 ml-1 text-xs"
          >
            {expanded ? "less" : "more"}
          </button>
        )}
      </p>

      <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
        {post.post_date && (
          <span>{new Date(post.post_date).toLocaleDateString()}</span>
        )}
        <span>{post.like_count} likes</span>
        <span>{post.comment_count} comments</span>
        <a
          href={post.post_url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 hover:text-blue-300"
        >
          LinkedIn
        </a>
      </div>

      {post.topics && post.topics.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {post.topics.map((t) => (
            <span
              key={t}
              className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded"
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SegmentDetail() {
  const { msId } = useParams<{ msId: string }>();
  const [expandedInsight, setExpandedInsight] = useState<number | null>(null);
  const [tab, setTab] = useState<"insights" | "posts" | "contacts">("insights");
  const [postPage, setPostPage] = useState(1);
  const [contactPage, setContactPage] = useState(1);
  // AudienceBuilder state. Empty arrays mean "no filter on this axis" — wide open.
  const [insightFilter, setInsightFilter] = useState<number[]>([]);
  const [industryFilter, setIndustryFilter] = useState<string[]>([]);
  const [seniorityFilter, setSeniorityFilter] = useState<string[]>([]);
  const [degreeFilter, setDegreeFilter] = useState<string[]>([]);
  const [sinceFilter, setSinceFilter] = useState<string | null>(null);

  const audienceFilters: AudienceFilters = {
    insight_id: insightFilter.length ? insightFilter : undefined,
    industry: industryFilter.length ? industryFilter : undefined,
    seniority: seniorityFilter.length ? seniorityFilter : undefined,
    degree: degreeFilter.length ? degreeFilter : undefined,
    since: sinceFilter ?? undefined,
  };

  const { data: insightData, isLoading: loadingInsights } = useQuery({
    queryKey: ["insights", msId],
    queryFn: () => fetchInsights(msId!),
    enabled: !!msId,
  });

  const { data: topicData } = useQuery({
    queryKey: ["topics", msId],
    queryFn: () => fetchTopics(msId!),
    enabled: !!msId,
  });

  const { data: breakdownData } = useQuery({
    queryKey: ["breakdown", msId],
    queryFn: () => fetchCompanyBreakdown(msId!),
    enabled: !!msId,
  });

  const { data: postData, isLoading: loadingPosts } = useQuery({
    queryKey: ["posts", msId, postPage],
    queryFn: () => fetchPosts(msId!, postPage),
    enabled: !!msId && tab === "posts",
  });

  const { data: contactStats } = useQuery({
    queryKey: ["contact-stats", msId],
    queryFn: () => fetchContactStats(msId!),
    enabled: !!msId,
  });

  const { data: contactData, isLoading: loadingContacts } = useQuery({
    queryKey: ["contacts", msId, contactPage, audienceFilters],
    queryFn: () => fetchContactsFiltered(msId!, audienceFilters, contactPage, 100),
    enabled: !!msId && tab === "contacts",
  });

  const { data: audiencePreview } = useQuery({
    queryKey: ["audience-preview", msId, audienceFilters],
    queryFn: () => fetchAudiencePreview(msId!, audienceFilters),
    enabled: !!msId && tab === "contacts",
  });

  if (!msId) return <div>No segment ID</div>;
  if (loadingInsights) return <div className="text-gray-400">Loading...</div>;

  const stats = insightData?.stats;
  const insights = insightData?.insights ?? [];
  const topics = topicData?.topics ?? [];

  // Sentiment distribution for pie chart
  const sentimentData = insights.reduce(
    (acc, i) => {
      if (i.sentiment_distribution) {
        for (const [k, v] of Object.entries(i.sentiment_distribution)) {
          acc[k] = (acc[k] ?? 0) + (v as number);
        }
      }
      return acc;
    },
    {} as Record<string, number>,
  );
  const pieData = Object.entries(sentimentData).map(([name, value]) => ({
    name,
    value,
  }));

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <Link to="/" className="hover:text-white">
          Overview
        </Link>
        <span>/</span>
        <span className="text-white">
          {insightData?.microsegment_label ?? msId}
        </span>
      </div>

      <h2 className="text-xl font-semibold">
        {insightData?.microsegment_label ?? msId}
      </h2>

      {/* Stats row */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
            <div className="text-lg font-bold">{Number(stats.post_count).toLocaleString()}</div>
            <div className="text-xs text-gray-400">Posts Scraped</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
            <div className="text-lg font-bold">{Number(stats.analyzed_count).toLocaleString()}</div>
            <div className="text-xs text-gray-400">Analyzed</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
            <div className="text-lg font-bold">{Number(stats.contact_count).toLocaleString()}</div>
            <div className="text-xs text-gray-400">Contacts</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
            <div className="text-lg font-bold">{Number(stats.company_count).toLocaleString()}</div>
            <div className="text-xs text-gray-400">Companies</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
            <div className="text-lg font-bold">
              {stats.avg_sentiment != null
                ? Number(stats.avg_sentiment).toFixed(2)
                : "—"}
            </div>
            <div className="text-xs text-gray-400">Avg Sentiment</div>
          </div>
        </div>
      )}

      {/* Cohort breakdown (enrichment from Sales Nav seed) */}
      {breakdownData &&
        (breakdownData.industries.length > 0 ||
          breakdownData.revenue_bands.length > 0 ||
          breakdownData.employee_bands.length > 0 ||
          breakdownData.hq_locations.length > 0) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <BreakdownPanel title="Industries" entries={breakdownData.industries} />
            <BreakdownPanel title="Revenue" entries={breakdownData.revenue_bands} />
            <BreakdownPanel title="Employees" entries={breakdownData.employee_bands} />
            <BreakdownPanel title="HQ Locations" entries={breakdownData.hq_locations} />
          </div>
        )}

      {/* Decision-maker breakdown (Sales Nav contacts) */}
      {contactStats && contactStats.coverage.total > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <BreakdownPanel title="Roles" entries={contactStats.roles} />
          <BreakdownPanel title="Connection Degree" entries={contactStats.degrees} />
          <BreakdownPanel title="Top Locations" entries={contactStats.locations} />
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <h3 className="text-xs font-medium mb-3 text-gray-400 uppercase tracking-wide">
              Coverage
            </h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-300">Total contacts</span>
                <span className="text-gray-100 tabular-nums">
                  {contactStats.coverage.total.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-300">With LinkedIn URL</span>
                <span className="text-gray-100 tabular-nums">
                  {contactStats.coverage.with_lead_url.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-300">With bio</span>
                <span className="text-gray-100 tabular-nums">
                  {contactStats.coverage.with_bio.toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Charts row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Topic bar chart */}
        {topics.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <h3 className="text-sm font-medium mb-3 text-gray-400">
              Top Topics
            </h3>
            <ResponsiveContainer width="100%" height={Math.max(200, topics.slice(0, 15).length * 28)}>
              <BarChart
                data={topics.slice(0, 15)}
                layout="vertical"
                margin={{ left: 120, right: 20, top: 0, bottom: 0 }}
              >
                <XAxis type="number" tick={{ fill: "#9ca3af", fontSize: 11 }} />
                <YAxis
                  type="category"
                  dataKey="topic"
                  tick={{ fill: "#d1d5db", fontSize: 11 }}
                  width={110}
                />
                <Tooltip
                  contentStyle={{
                    background: "#1f2937",
                    border: "1px solid #374151",
                    borderRadius: 6,
                    color: "#f3f4f6",
                  }}
                />
                <Bar dataKey="count" fill="#3b82f6" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Sentiment pie */}
        {pieData.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <h3 className="text-sm font-medium mb-3 text-gray-400">
              Sentiment Distribution
            </h3>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={80}
                  label={({ name, percent }) =>
                    `${name} ${(percent * 100).toFixed(0)}%`
                  }
                >
                  {pieData.map((entry) => (
                    <Cell
                      key={entry.name}
                      fill={
                        SENTIMENT_COLORS[entry.name] ?? "#6b7280"
                      }
                    />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    background: "#1f2937",
                    border: "1px solid #374151",
                    borderRadius: 6,
                    color: "#f3f4f6",
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Tab switcher */}
      <div className="flex gap-4 border-b border-gray-800">
        {(["insights", "posts", "contacts"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`pb-2 text-sm capitalize ${
              tab === t
                ? "text-white border-b-2 border-blue-500"
                : "text-gray-400 hover:text-gray-300"
            }`}
          >
            {t}
            {t === "insights" ? ` (${insights.length})` : ""}
            {t === "contacts" && contactStats
              ? ` (${contactStats.coverage.total})`
              : ""}
          </button>
        ))}
        <a
          href={insightsCsvUrl(msId)}
          className="ml-auto text-xs text-gray-500 hover:text-gray-300 self-center"
        >
          Export CSV
        </a>
      </div>

      {/* Insights tab */}
      {tab === "insights" && (
        <div className="space-y-3">
          {insights.length === 0 ? (
            <div className="text-gray-500 text-sm py-8 text-center">
              No insights yet. Run the analysis pipeline first.
            </div>
          ) : (
            insights.map((insight) => (
              <InsightCard
                key={insight.id}
                insight={insight}
                expanded={expandedInsight === insight.id}
                onToggle={() =>
                  setExpandedInsight(
                    expandedInsight === insight.id ? null : insight.id,
                  )
                }
                onBuildAudience={() => {
                  setInsightFilter([insight.id]);
                  setIndustryFilter([]);
                  setSeniorityFilter([]);
                  setDegreeFilter([]);
                  setContactPage(1);
                  setTab("contacts");
                }}
              />
            ))
          )}
        </div>
      )}

      {/* Contacts tab */}
      {tab === "contacts" && (
        <div className="space-y-4">
          {/* Audience Builder — pain points, industries, seniority, degree */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <div>
                <div className="text-xs uppercase tracking-wide text-gray-400">
                  Audience Builder
                </div>
                <div className="text-2xl font-semibold text-white tabular-nums">
                  {audiencePreview?.count?.toLocaleString() ?? "—"}
                  <span className="text-sm text-gray-400 font-normal ml-2">
                    contacts match
                  </span>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setInsightFilter([]);
                    setIndustryFilter([]);
                    setSeniorityFilter([]);
                    setDegreeFilter([]);
                    setSinceFilter(null);
                    setContactPage(1);
                  }}
                  className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1 rounded border border-gray-700"
                  disabled={
                    !insightFilter.length &&
                    !industryFilter.length &&
                    !seniorityFilter.length &&
                    !degreeFilter.length &&
                    !sinceFilter
                  }
                >
                  Clear filters
                </button>
                <a
                  href={audienceExportUrl(msId, audienceFilters)}
                  className="text-xs px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white"
                >
                  Export CSV →
                </a>
              </div>
            </div>

            {/* Pain Points */}
            <div>
              <div className="text-xs text-gray-500 mb-1.5">Pain points</div>
              <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
                {insights.map((ins) => {
                  const on = insightFilter.includes(ins.id);
                  return (
                    <button
                      key={ins.id}
                      onClick={() => {
                        setInsightFilter((prev) =>
                          on ? prev.filter((x) => x !== ins.id) : [...prev, ins.id],
                        );
                        setContactPage(1);
                      }}
                      className={`text-xs px-2 py-0.5 rounded border ${
                        on
                          ? "border-blue-500 text-blue-300 bg-blue-500/10"
                          : "border-gray-700 text-gray-400 hover:text-gray-200"
                      }`}
                      title={ins.pain_point_summary ?? ""}
                    >
                      {ins.insight_name}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Industries */}
            {breakdownData && breakdownData.industries.length > 0 && (
              <div>
                <div className="text-xs text-gray-500 mb-1.5">Industry</div>
                <div className="flex flex-wrap gap-1.5 max-h-20 overflow-y-auto">
                  {breakdownData.industries.map((ind) => {
                    const on = industryFilter.includes(ind.label);
                    return (
                      <button
                        key={ind.label}
                        onClick={() => {
                          setIndustryFilter((prev) =>
                            on
                              ? prev.filter((x) => x !== ind.label)
                              : [...prev, ind.label],
                          );
                          setContactPage(1);
                        }}
                        className={`text-xs px-2 py-0.5 rounded border ${
                          on
                            ? "border-blue-500 text-blue-300 bg-blue-500/10"
                            : "border-gray-700 text-gray-400 hover:text-gray-200"
                        }`}
                      >
                        {ind.label} <span className="text-gray-500">({ind.count})</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Recency */}
            <div>
              <div className="text-xs text-gray-500 mb-1.5">
                Recency <span className="text-gray-600">(post activity window)</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {([
                  { label: "All time", v: null },
                  { label: "Last 30 days", v: "30d" },
                  { label: "Last 90 days", v: "90d" },
                  { label: "Last 12 months", v: "365d" },
                ] as const).map((r) => {
                  const on = sinceFilter === r.v;
                  return (
                    <button
                      key={r.label}
                      onClick={() => {
                        setSinceFilter(r.v);
                        setContactPage(1);
                      }}
                      className={`text-xs px-2 py-0.5 rounded border ${
                        on
                          ? "border-blue-500 text-blue-300 bg-blue-500/10"
                          : "border-gray-700 text-gray-400 hover:text-gray-200"
                      }`}
                    >
                      {r.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Seniority + Degree */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-gray-500 mb-1.5">Seniority</div>
                <div className="flex flex-wrap gap-1.5">
                  {ROLE_BUCKETS.map((r) => {
                    const on = seniorityFilter.includes(r);
                    return (
                      <button
                        key={r}
                        onClick={() => {
                          setSeniorityFilter((prev) =>
                            on ? prev.filter((x) => x !== r) : [...prev, r],
                          );
                          setContactPage(1);
                        }}
                        className={`text-xs px-2 py-0.5 rounded border ${
                          on
                            ? "border-blue-500 text-blue-300 bg-blue-500/10"
                            : "border-gray-700 text-gray-400 hover:text-gray-200"
                        }`}
                      >
                        {r}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1.5">Connection degree</div>
                <div className="flex flex-wrap gap-1.5">
                  {(["1st", "2nd", "3rd", "3rd+"] as const).map((d) => {
                    const on = degreeFilter.includes(d);
                    return (
                      <button
                        key={d}
                        onClick={() => {
                          setDegreeFilter((prev) =>
                            on ? prev.filter((x) => x !== d) : [...prev, d],
                          );
                          setContactPage(1);
                        }}
                        className={`text-xs px-2 py-0.5 rounded border ${
                          on
                            ? "border-blue-500 text-blue-300 bg-blue-500/10"
                            : "border-gray-700 text-gray-400 hover:text-gray-200"
                        }`}
                      >
                        {d}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {loadingContacts ? (
            <div className="text-gray-400">Loading contacts...</div>
          ) : (
            <>
              {(contactData?.contacts ?? []).map((c) => (
                <ContactRow key={c.id} c={c} />
              ))}
              {contactData && contactData.contacts.length >= contactData.limit && (
                <div className="flex items-center justify-center gap-4 mt-4">
                  <button
                    disabled={contactPage <= 1}
                    onClick={() => setContactPage((p) => p - 1)}
                    className="text-sm text-gray-400 hover:text-white disabled:opacity-30"
                  >
                    Previous
                  </button>
                  <span className="text-sm text-gray-500">Page {contactPage}</span>
                  <button
                    onClick={() => setContactPage((p) => p + 1)}
                    className="text-sm text-gray-400 hover:text-white"
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Posts tab */}
      {tab === "posts" && (
        <div className="space-y-3">
          {loadingPosts ? (
            <div className="text-gray-400">Loading posts...</div>
          ) : postData?.posts.length === 0 ? (
            <div className="text-gray-500 text-sm py-8 text-center">
              No posts scraped yet. Run the scraping pipeline first.
            </div>
          ) : (
            <>
              {postData?.posts.map((post) => (
                <PostCard key={post.id} post={post} />
              ))}
              {/* Pagination */}
              {postData && postData.total > postData.limit && (
                <div className="flex items-center justify-center gap-4 mt-4">
                  <button
                    disabled={postPage <= 1}
                    onClick={() => setPostPage((p) => p - 1)}
                    className="text-sm text-gray-400 hover:text-white disabled:opacity-30"
                  >
                    Previous
                  </button>
                  <span className="text-sm text-gray-500">
                    Page {postPage} of{" "}
                    {Math.ceil(postData.total / postData.limit)}
                  </span>
                  <button
                    disabled={
                      postPage >= Math.ceil(postData.total / postData.limit)
                    }
                    onClick={() => setPostPage((p) => p + 1)}
                    className="text-sm text-gray-400 hover:text-white disabled:opacity-30"
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
