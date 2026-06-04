"""Orchestrate the library: seed → enrich → graph, and serve the API payload.

``rebuild()`` (re)generates everything from ``data/output/`` + the network and
writes ``library.json`` + ``cache/graph.json``. ``library_payload()`` composes
the frontend's ``/api/library`` response from those files (no network).
"""

from __future__ import annotations

import json
import logging
import threading
from collections import Counter
from pathlib import Path

from .graph import _cite_key, build_graph, work_to_ref
from .seed import seed_from_output
from .sources.ads import ADS
from .sources.crossref import Crossref
from .sources.openalex import OpenAlex
from .store import CACHE_DIR, LibraryStore, Work, canonical_id

log = logging.getLogger("bibgraph.library.build")

GRAPH_JSON = CACHE_DIR / "graph.json"

# Serialize load→mutate→save cycles so concurrent API writes can't lose updates.
_WRITE_LOCK = threading.Lock()


def rebuild(enrich_remote: bool = True, bib_path: str | Path | None = None) -> dict:
    """Rebuild from ingested papers (+ optional ``.bib``) through the resolution
    chain (ADS▸Crossref▸OpenAlex) and the source planner. Returns a summary."""
    with _WRITE_LOCK:
        return _rebuild_locked(enrich_remote, bib_path)


def acquire_references(bib_path: str | Path, enrich_remote: bool = True) -> dict:
    """Add every entry of *bib_path* to the library (resolve + plan + graph)."""
    return rebuild(enrich_remote=enrich_remote, bib_path=bib_path)


def _rebuild_locked(enrich_remote: bool, bib_path: str | Path | None) -> dict:
    # imported here (not at module top) to break the library↔acquire import cycle
    from ..acquire.bibtex import parse_bibtex
    from ..acquire.run import add_bib_records, enrich_and_plan

    store = LibraryStore.load()
    seed_from_output(store)
    n_bib = 0
    if bib_path:
        records = parse_bibtex(bib_path)
        add_bib_records(store, records)
        n_bib = len(records)
    oa = OpenAlex(enabled=enrich_remote)
    cr = Crossref(enabled=enrich_remote)
    ads = ADS()
    enrich_and_plan(store, ads=ads, crossref=cr, oa=oa)
    graph = build_graph(store, oa)
    store.save()
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    GRAPH_JSON.write_text(json.dumps(graph, ensure_ascii=False), "utf-8")
    summary = {
        "works": len(store.works),
        "bib_entries": n_bib,
        "saved_nodes": sum(1 for n in graph["nodes"] if n.get("ref")),
        "nodes": len(graph["nodes"]),
        "links": len(graph["links"]),
        "ads_status": ads.status,
        "acquisition": _acquisition_summary(store),
        "resolution": _resolution_summary(store),
    }
    return summary


def _tally(values) -> dict:
    return dict(Counter(v if v is not None else "—" for v in values))


def _acquisition_summary(store: LibraryStore) -> dict:
    acq = [w.acquisition or {} for w in store.works]
    return {
        "chosen": _tally(a.get("chosen") for a in acq),
        "ready_now": _tally(a.get("ready") for a in acq),
        "status": _tally(a.get("status") for a in acq),
        "ingested": sum(1 for a in acq if a.get("ingested_doc")),
    }


def _resolution_summary(store: LibraryStore) -> dict:
    return {"count_source": _tally((w.resolution or {}).get("count")
                                   for w in store.works)}


def load_graph() -> dict:
    if GRAPH_JSON.is_file():
        try:
            return json.loads(GRAPH_JSON.read_text("utf-8"))
        except ValueError:
            pass
    return {"nodes": [], "links": []}


def library_payload() -> dict:
    """The /api/library response: project + saved refs + tags + citation graph."""
    store = LibraryStore.load()
    tags = sorted({t for w in store.works for t in w.tags})
    return {
        "project": store.project,
        "refs": [work_to_ref(w) for w in store.works],
        "tags": tags,
        "graph": load_graph(),
    }


def add_node_to_library(node_id: str) -> dict | None:
    """Persist a suggested graph node as a saved work; return its ref (or None)."""
    node = next((n for n in load_graph()["nodes"] if n["id"] == node_id), None)
    if node is None:
        return None
    with _WRITE_LOCK:
        store = LibraryStore.load()
        oaid = node_id[3:] if node_id.startswith("oa:") else None
        venue = node.get("v") or ""
        w = Work(
            id=canonical_id(doi=node.get("doi"), openalex=oaid, title=node.get("t"), year=node.get("y")),
            title=node.get("t", ""),
            authors=[node["a"]] if node.get("a") else [],
            year=node.get("y"),
            venue=venue or None,
            type="conf" if any(k in venue for k in ("ICLR", "ICML", "NeurIPS", "CVPR", "Proc")) else "article",
            doi=node.get("doi"),
            openalex_id=oaid,
            cited_by_count=node.get("c"),
            origin="graph-node",
        )
        w = store.upsert(w)
        if not w.cite_key:
            w.cite_key = _cite_key(w, {x.cite_key for x in store.works if x.cite_key})
        store.save()
        return work_to_ref(w)


def patch_work(work_id: str, patch: dict) -> bool:
    """Update per-work user state (label / read / star / tags / note), validated."""
    with _WRITE_LOCK:
        store = LibraryStore.load()
        w = store.get(work_id)
        if w is None:
            return False
        if patch.get("label") is not None:
            w.label = (str(patch["label"])[:32]) or None
        if patch.get("read") is not None:
            w.read = bool(patch["read"])
        if patch.get("star") is not None:
            w.star = bool(patch["star"])
        if patch.get("note") is not None:
            w.note = str(patch["note"])[:10000] or None
        if patch.get("tags") is not None and isinstance(patch["tags"], list):
            w.tags = [str(t)[:64] for t in patch["tags"]][:64]
        store.save()
        return True
