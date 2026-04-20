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
import { fetchInsights, fetchPosts, fetchTopics } from "../lib/api";
import type { Insight, Post } from "../lib/api";

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
}: {
  insight: Insight;
  expanded: boolean;
  onToggle: () => void;
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
        <span className="text-gray-500 text-sm">{expanded ? "−" : "+"}</span>
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
  const [tab, setTab] = useState<"insights" | "posts">("insights");
  const [postPage, setPostPage] = useState(1);

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

  const { data: postData, isLoading: loadingPosts } = useQuery({
    queryKey: ["posts", msId, postPage],
    queryFn: () => fetchPosts(msId!, postPage),
    enabled: !!msId && tab === "posts",
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
        {(["insights", "posts"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`pb-2 text-sm capitalize ${
              tab === t
                ? "text-white border-b-2 border-blue-500"
                : "text-gray-400 hover:text-gray-300"
            }`}
          >
            {t} {t === "insights" ? `(${insights.length})` : ""}
          </button>
        ))}
        <a
          href={`/api/export/csv/${encodeURIComponent(msId)}`}
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
              />
            ))
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
