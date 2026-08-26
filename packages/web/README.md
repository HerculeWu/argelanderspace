# ArgelanderSpace web UI (`@argelanderspace/web`)

A localhost reader for the structured JSON produced by the ingestion pipelines,
plus the citation-graph literature manager. Three-panel reader layout: left =
table of contents (+ figure/table/equation lists), center = the rendered
article, right = a live "in view" panel showing the figures / equations /
tables / citations referenced by the text you are currently reading (updates as
you scroll).

## Stack
- **Backend:** `@argelanderspace/server` (Hono, `packages/server`) — serves the
  paper JSON, the MinerU-extracted images, and the `/ws` progress channel.
- **Frontend:** React + TypeScript + Vite, KaTeX for math, framer-motion for the
  card transitions.

## Run (dev, with hot reload)
Two processes; open the **Vite** URL.

```bash
# 1) backend (from the repo root; serves ./data by default)
node packages/cli/dist/bin.js serve --port 8000

# 2) frontend
corepack pnpm --filter @argelanderspace/web dev   # -> http://localhost:5173
```

Vite proxies `/api`, `/images`, and `/ws` (WebSocket) to the backend on :8000,
so the same code also works when the server hosts the production build.

Pick a paper with `?doc=<id>` (defaults to the first one in `data/output/`):
`http://localhost:5173/?doc=2603.03522`

## Production build (single port)
```bash
corepack pnpm --filter @argelanderspace/web build   # emits packages/web/dist
node packages/cli/dist/bin.js serve --port 8000
# -> http://localhost:8000  (server hosts packages/web/dist + the API)
```

## Endpoints
- `GET /api/papers` — available doc ids (scans `data/output/`)
- `GET /api/paper/{id}` — enriched structured JSON
- `GET /images/{id}/{file}` — a MinerU-extracted image
- `/ws` — WebSocket: job progress + `library.changed` (see `src/api/ws.ts`)
