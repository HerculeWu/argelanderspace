"""FastAPI backend for the bibgraph reader.

Serves the structured paper JSON and the figure/table images extracted by
MinerU, plus the built React app.

Run (dev, with the Vite dev server proxying to this on :8000):
    /home/wwu/miniforge3/envs/astro/bin/python -m uvicorn server.app:app \
        --reload --port 8000

Endpoints:
    GET /api/papers            -> list available doc ids
    GET /api/paper/{doc_id}    -> enriched structured JSON
    GET /images/{doc_id}/{fn}  -> a MinerU-extracted image
    GET /                      -> built React app (web/dist), if present
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = ROOT / "data" / "output"
WEB_DIST = ROOT / "web" / "dist"

app = FastAPI(title="bibgraph reader")

# Dev: the Vite dev server (localhost:5173) calls this API directly.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


def _paper_path(doc_id: str) -> Path:
    # Guard against path traversal / empty ids in the doc_id.
    if not doc_id or not doc_id.strip():
        raise HTTPException(400, "bad doc id")
    if "/" in doc_id or "\\" in doc_id or doc_id.startswith("."):
        raise HTTPException(400, "bad doc id")
    p = OUTPUT_DIR / doc_id / f"{doc_id}.json"
    if not p.is_file():
        raise HTTPException(404, f"paper {doc_id!r} not found")
    return p


@lru_cache(maxsize=16)
def _load_paper(doc_id: str, cache_key: tuple) -> dict:
    """Load a paper. `cache_key` (mtime_ns, size) busts the cache when the file
    changes (ns avoids float rounding; size catches same-mtime edits)."""
    return json.loads(_paper_path(doc_id).read_text())


@app.get("/api/papers")
def list_papers() -> dict:
    ids = []
    if OUTPUT_DIR.is_dir():
        for d in sorted(OUTPUT_DIR.iterdir()):
            if d.is_dir() and (d / f"{d.name}.json").is_file():
                ids.append(d.name)
    return {"papers": ids}


@app.get("/api/paper/{doc_id}")
def get_paper(doc_id: str) -> dict:
    p = _paper_path(doc_id)
    st = p.stat()
    return _load_paper(doc_id, (st.st_mtime_ns, st.st_size))


@app.get("/images/{doc_id}/{filename}")
def get_image(doc_id: str, filename: str) -> FileResponse:
    if "/" in filename or "\\" in filename or filename.startswith("."):
        raise HTTPException(400, "bad filename")
    if "/" in doc_id or "\\" in doc_id or doc_id.startswith("."):
        raise HTTPException(400, "bad doc id")
    # PDF docs keep images under mineru/images/; HTML docs under assets/.
    for sub in ("mineru/images", "assets"):
        img = OUTPUT_DIR / doc_id / sub / filename
        if img.is_file():
            return FileResponse(img)
    raise HTTPException(404, "image not found")


# Serve the built SPA last so it doesn't shadow the API routes.
if WEB_DIST.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="spa")
