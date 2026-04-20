import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import dotenv from "dotenv";
import { registerRoutes } from "./routes.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT ?? 3030);

app.use(express.json());

// CORS for dashboard dev server
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// API routes
registerRoutes(app);

// Serve static dashboard in production
const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardDist = join(__dirname, "../../dashboard/dist");
app.use(express.static(dashboardDist));
app.get("*", (_req, res) => {
  res.sendFile(join(dashboardDist, "index.html"));
});

app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});
