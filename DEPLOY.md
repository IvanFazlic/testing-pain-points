# Deployment

Split deploy: **backend** (Express + tsx) on Railway, **frontend** (React + Vite)
on Vercel, **database** (Postgres) on Railway. The backend and frontend run as
independent services; the frontend calls the backend cross-origin.

## 1. Database (Railway Postgres)

Already provisioned. Grab the connection string from the Railway dashboard:
`Postgres service → Variables → DATABASE_URL`. That's the value we'll set on
the API service too.

## 2. Backend (Railway Node service)

Create a new service in the same Railway project, pointed at this repo:

- **Build command:** `npm install` (default — Railway auto-detects Node)
- **Start command:** `npm start` (runs `tsx src/api/server.ts`)
- **Port:** `PORT` env var is supplied by Railway; server.ts reads it.

Env vars to set on the service:

| Name | Value |
|---|---|
| `DATABASE_URL` | Copy from the Postgres service variables (share across services) |
| `SCRAPECREATORS_API_KEY` | From your ScrapeCreators account |
| `SCRAPECREATORS_RATE_DELAY_MS` | `200` (optional) |
| `ANTHROPIC_AUTH_TOKEN` | From `claude setup-token` (year-long OAuth). Note: Haiku only — see README |
| `CORS_ORIGIN` | The Vercel dashboard URL, e.g. `https://pain-points-dashboard.vercel.app` |
| `NODE_ENV` | `production` |

No `ANTHROPIC_AUTH_TOKEN` needed on the API service if you don't plan to
re-run analysis pipelines from prod — the app reads from the DB for serving.

Once deployed, verify: `curl https://<railway-url>/api/overview` returns JSON.

The server will log `No dashboard build found — running as API-only service` on
Railway since `dashboard/dist` isn't built there — that's expected and correct.

## 3. Frontend (Vercel)

Import the repo into Vercel. Configure:

- **Framework preset:** Vite
- **Root directory:** `dashboard`
- **Build command:** `npm run build` (default)
- **Output directory:** `dist`
- **Install command:** `npm install`

Env var (Vercel → Settings → Environment Variables):

| Name | Value |
|---|---|
| `VITE_API_URL` | Backend URL without trailing slash, e.g. `https://pain-points-api.up.railway.app` |

`dashboard/vercel.json` handles SPA fallback routing.

## 4. Post-deploy checks

After both services are up:

1. Open `https://<vercel-url>/` — overview page should load and show segments.
2. Click a segment → insights, posts, contacts tabs populate.
3. Contacts tab → Audience Builder → filters → Export CSV downloads a file.
4. Open the CSV and confirm it has `linkedin_url` cells starting with
   `https://www.linkedin.com/in/…` (the URN form we rebuilt).
5. The browser devtools Network tab should show requests going to
   `https://<railway-url>/api/…` (the `VITE_API_URL` host), not Vercel.

## 5. Common gotchas

- **CORS blocked at browser**: `CORS_ORIGIN` on Railway must match the Vercel
  origin *exactly* (scheme + host + no trailing slash). Unsetting it wildcards
  to `*` which also works for a test but is looser than needed.
- **Cross-origin cookies**: we don't use them — the API is stateless except for
  the DB pool. Nothing to configure here.
- **`VITE_API_URL` not picked up**: Vite bakes env vars at build time, not
  runtime. You must re-deploy (Vercel redeploys on env-var change automatically
  in newer accounts; if not, trigger a manual redeploy).
- **Migrations on prod DB**: Railway Postgres is the same instance we've been
  using in dev, so the schema is already current. If you ever need to re-run
  migrations from prod: `npm run migrate` against the Railway
  `DATABASE_URL` — the schema file is additive and idempotent.
- **Scraping/analysis pipelines**: run these locally against the prod DB
  (set `DATABASE_URL` in your local `.env`) rather than on Railway. The
  Railway service is a serving layer; long-running tsx scripts aren't what
  it's for.

## 6. Analysis model access in prod

The `ANTHROPIC_AUTH_TOKEN` from `claude setup-token` is tied to *your* Claude
subscription. It grants Haiku 4.5 programmatic access; Sonnet and Opus are
gated to the interactive Claude Code product (via attestation headers we can't
replicate). If you need Sonnet/Opus on the backend:

1. Grab a developer API key from https://console.anthropic.com (prefix
   `sk-ant-api03-…`) with billing set up.
2. Replace `ANTHROPIC_AUTH_TOKEN` with `ANTHROPIC_API_KEY` in Railway env.
3. Edit `src/services/post-analysis.ts:16` from `authToken: …` to
   `apiKey: process.env.ANTHROPIC_API_KEY`, and drop the
   `anthropic-beta: oauth-2025-04-20` header.
4. Flip `SYNTHESIS_MODEL` / `EXTRACTION_MODEL` as desired.

Current 24 → 15 Opus-synthesized insights were produced via Claude Code
subagents on this laptop; the results are in the DB already.
