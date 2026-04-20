import { Routes, Route, Link, useLocation } from "react-router-dom";
import Overview from "./pages/Overview";
import SegmentDetail from "./pages/SegmentDetail";

const NAV = [{ path: "/", label: "Overview" }];

export default function App() {
  const loc = useLocation();

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-3 flex items-center gap-6">
        <h1 className="text-lg font-semibold tracking-tight">
          LinkedIn Pain Points
        </h1>
        <nav className="flex gap-4 text-sm">
          {NAV.map((n) => (
            <Link
              key={n.path}
              to={n.path}
              className={`hover:text-white transition ${
                loc.pathname === n.path ? "text-white" : "text-gray-400"
              }`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="p-6">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/segment/:msId" element={<SegmentDetail />} />
        </Routes>
      </main>
    </div>
  );
}
