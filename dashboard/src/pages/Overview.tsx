import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { fetchOverview } from "../lib/api";

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg px-5 py-4">
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-sm text-gray-400 mt-1">{label}</div>
    </div>
  );
}

export default function Overview() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["overview"],
    queryFn: fetchOverview,
  });

  if (isLoading) return <div className="text-gray-400">Loading...</div>;
  if (error) return <div className="text-red-400">Error: {(error as Error).message}</div>;
  if (!data) return null;

  const { totals, segments } = data;

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <h2 className="text-xl font-semibold">Overview</h2>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatCard label="Contacts" value={Number(totals.total_contacts).toLocaleString()} />
        <StatCard label="Companies" value={Number(totals.total_companies).toLocaleString()} />
        <StatCard label="Posts Scraped" value={Number(totals.total_posts).toLocaleString()} />
        <StatCard label="Posts Analyzed" value={Number(totals.total_analyzed).toLocaleString()} />
        <StatCard label="Insights" value={Number(totals.total_insights).toLocaleString()} />
      </div>

      <div>
        <h3 className="text-lg font-medium mb-4">Segments</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-left text-gray-400">
                <th className="pb-2 pr-4">Segment</th>
                <th className="pb-2 pr-4 text-right">Contacts</th>
                <th className="pb-2 pr-4 text-right">Posts</th>
                <th className="pb-2 pr-4 text-right">Analyzed</th>
                <th className="pb-2 pr-4 text-right">Insights</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {segments.map((s) => (
                <tr
                  key={s.microsegment_id}
                  className="border-b border-gray-800/50 hover:bg-gray-900/50"
                >
                  <td className="py-3 pr-4">
                    <Link
                      to={`/segment/${encodeURIComponent(s.microsegment_id)}`}
                      className="text-blue-400 hover:text-blue-300"
                    >
                      {s.microsegment_label}
                    </Link>
                  </td>
                  <td className="py-3 pr-4 text-right">{Number(s.contact_count).toLocaleString()}</td>
                  <td className="py-3 pr-4 text-right">{Number(s.post_count).toLocaleString()}</td>
                  <td className="py-3 pr-4 text-right">{Number(s.analyzed_count).toLocaleString()}</td>
                  <td className="py-3 pr-4 text-right">{Number(s.insight_count).toLocaleString()}</td>
                  <td className="py-3">
                    <Link
                      to={`/segment/${encodeURIComponent(s.microsegment_id)}`}
                      className="text-gray-500 hover:text-gray-300 text-xs"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
