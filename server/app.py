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

from fastapi import FastAPI, HTTPException, Request
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


# --------------------------------------------------------------------------- #
# Library (HubbleSpace 文献 manager)
# --------------------------------------------------------------------------- #

_ALLOWED_ORIGINS = {
    "http://localhost:5173", "http://127.0.0.1:5173",
    "http://localhost:8000", "http://127.0.0.1:8000",
}


def _guard_csrf(request: Request) -> None:
    """Reject cross-site mutations. Browsers always send Origin on POST/PATCH;
    a malicious page's request carries its own origin and is rejected. Same-origin
    requests and local tools (no Origin header) pass."""
    origin = request.headers.get("origin")
    if origin and origin not in _ALLOWED_ORIGINS:
        raise HTTPException(403, "cross-site request rejected")


@app.get("/api/library")
def get_library() -> dict:
    from bibgraph.library import library_payload

    return library_payload()


@app.post("/api/library/refs")
def add_library_ref(body: dict, request: Request) -> dict:
    _guard_csrf(request)
    from bibgraph.library.build import add_node_to_library

    node_id = (body or {}).get("nodeId")
    if not node_id:
        raise HTTPException(400, "nodeId required")
    ref = add_node_to_library(node_id)
    if ref is None:
        raise HTTPException(404, f"graph node {node_id!r} not found")
    return {"ref": ref}


@app.patch("/api/library/refs")
def patch_library_ref(body: dict, request: Request) -> dict:
    # work ids contain slashes/colons (e.g. "doi:10.1051/..."), so the id rides
    # in the body rather than the path.
    _guard_csrf(request)
    from bibgraph.library.build import patch_work

    work_id = (body or {}).get("id")
    if not work_id:
        raise HTTPException(400, "id required")
    patch = {k: v for k, v in (body or {}).items() if k != "id"}
    if not patch_work(work_id, patch):
        raise HTTPException(404, f"work {work_id!r} not found")
    return {"ok": True}


@app.post("/api/library/refresh")
def refresh_library(request: Request, offline: bool = False) -> dict:
    _guard_csrf(request)
    from bibgraph.library import rebuild

    return rebuild(enrich_remote=not offline)


@app.post("/api/library/upload")
async def upload_pdf(request: Request, id: str | None = None,
                     doi: str | None = None, arxiv: str | None = None) -> dict:
    """Attach a user-supplied PDF to a work and OCR it (MinerU).

    The PDF rides in the raw request body (``Content-Type: application/pdf``) and
    the target work is named by query param — so no python-multipart dependency.
    Synchronous: the response waits for the OCR to finish (can take minutes)."""
    _guard_csrf(request)
    if not (id or doi or arxiv):
        raise HTTPException(400, "id, doi, or arxiv query param required")
    data = await request.body()
    if not data[:5].startswith(b"%PDF"):
        raise HTTPException(400, "request body is not a PDF")
    import tempfile
    from bibgraph.acquire.upload import attach_pdf

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=True) as tf:
        tf.write(data)
        tf.flush()
        try:
            ref = attach_pdf(tf.name, work_id=id, doi=doi, arxiv=arxiv)
        except (ValueError, FileNotFoundError) as e:
            raise HTTPException(404, str(e))
        except Exception as e:  # MinerU / pipeline failure
            raise HTTPException(500, f"ingest failed: {e}")
    return {"ref": ref}


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
