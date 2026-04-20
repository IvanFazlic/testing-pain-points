import express from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import dotenv from "dotenv";
import { registerRoutes } from "./routes.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT ?? 3030);

app.use(express.json());

// CORS: allow the dashboard origin (Vite dev + Vercel prod). Set CORS_ORIGIN in
// the Railway env to the Vercel URL for a tight prod policy; falls back to '*'
// so local dev keeps working.
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "*";
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Expose-Headers", "X-Audience-Size");
  next();
});

// API routes
registerRoutes(app);

// Serve the built dashboard if present (single-host deploy like local dev). When
// the Vite build hasn't run (Railway-only backend, dashboard on Vercel), skip the
// static middleware entirely so unknown routes 404 cleanly instead of returning
// an HTML shell.
const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardDist = join(__dirname, "../../dashboard/dist");
if (existsSync(dashboardDist)) {
  app.use(express.static(dashboardDist));
  app.get("*", (_req, res) => {
    res.sendFile(join(dashboardDist, "index.html"));
  });
  console.log(`Serving dashboard from ${dashboardDist}`);
} else {
  console.log("No dashboard build found — running as API-only service");
}

// Bind to 0.0.0.0 explicitly so Railway's edge proxy can reach the container.
// On some Node/Linux setups the default bind resolves to ::1 (localhost-only),
// which causes Railway to return "Application failed to respond" even though
// the process is listening.
app.listen(PORT, "0.0.0.0", () => {
  console.log(`API server listening on 0.0.0.0:${PORT}`);
});

// Add a tiny root handler so Railway healthchecks (or curl /) get 200, not 404.
app.get("/", (_req, res) => {
  res.json({ service: "linkedin-pain-points-api", ok: true });
});
