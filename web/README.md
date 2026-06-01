# bibgraph reader (web UI)

A localhost reader for the structured JSON produced by the Phase-1 ingestion
pipeline. Three-panel layout: left = table of contents (+ figure/table/equation
lists), center = the rendered article, right = a live "in view" panel showing the
figures / equations / tables / citations / symbols referenced by the text you are
currently reading (updates as you scroll).

## Stack
- **Backend:** FastAPI (conda `astro` env) — serves the paper JSON (with on-the-fly
  heuristic symbol descriptions) and the MinerU-extracted images.
- **Frontend:** React + TypeScript + Vite, KaTeX for math, framer-motion for the
  card transitions.

## Run (dev, with hot reload)
Two processes; open the **Vite** URL.

```bash
# 1) backend (from the repo root)
/home/wwu/miniforge3/envs/astro/bin/python -m uvicorn server.app:app --reload --port 8000

# 2) frontend
cd web && npm install && npm run dev   # -> http://localhost:5173
```

Vite proxies `/api` and `/images` to the backend on :8000, so the same code also
works when FastAPI serves the production build.

Pick a paper with `?doc=<id>` (defaults to the first one in `data/output/`):
`http://localhost:5173/?doc=2603.03522`

## Production build (single port)
```bash
cd web && npm run build          # emits web/dist
/home/wwu/miniforge3/envs/astro/bin/python -m uvicorn server.app:app --port 8000
# -> http://localhost:8000  (FastAPI serves web/dist + the API)
```

## Endpoints
- `GET /api/papers` — available doc ids (scans `data/output/`)
- `GET /api/paper/{id}` — enriched structured JSON
- `GET /images/{id}/{file}` — a MinerU-extracted image
