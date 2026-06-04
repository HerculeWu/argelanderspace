"""Build the citation graph + API projections from enriched library works.

Nodes = papers (saved works + suggested neighbours), edges = citation links.
Edges come from two sources, unioned:

* **OpenAlex** ``referenced_works`` — the broad network (saved→neighbour,
  neighbour→neighbour, and saved→saved when OpenAlex matched the bibliography);
* **offline** — each ingested paper's own parsed bibliography matched against
  the saved set (guarantees the saved↔saved edges regardless of OpenAlex).

Suggested neighbours are the most-cited works referenced by the library, capped
so the payload stays small; the frontend's depth/count sliders filter further.
"""

from __future__ import annotations

import logging

from .seed import doc_reference_ids
from .sources.openalex import OpenAlex
from .store import LibraryStore, Work, display_authors, norm_arxiv, norm_doi, norm_title, slug

log = logging.getLogger("bibgraph.library.graph")

MAX_SUGGEST = 120


# --------------------------------------------------------------------------- #
# Enrichment
# --------------------------------------------------------------------------- #

def _suffix(n: int) -> str:
    """1→'a', 26→'z', 27→'aa', … (always [a-z], no overflow past 'z')."""
    s, k = "", n
    while k > 0:
        k, r = divmod(k - 1, 26)
        s = chr(ord("a") + r) + s
    return s


def _cite_key(w: Work, used: set[str]) -> str:
    fam = (w.authors[0] if w.authors else slug(w.title, 12)).lower()
    fam = "".join(ch for ch in fam if ch.isalnum()) or "ref"
    base = f"{fam}{w.year or ''}"
    key, n = base, 0
    while key in used:
        n += 1
        key = base + _suffix(n)
    used.add(key)
    return key


# Metadata enrichment now lives in the acquisition layer's resolution chain
# (ADS▸Crossref▸OpenAlex); see bibgraph.acquire.resolve / bibgraph.acquire.run.
# This module keeps _cite_key (shared) plus offline edge + graph assembly.


# --------------------------------------------------------------------------- #
# Offline edges (saved ↔ saved from the ingested bibliographies)
# --------------------------------------------------------------------------- #

def offline_edges(store: LibraryStore) -> set[tuple[str, str]]:
    key2wid: dict[str, str] = {}
    for w in store.works:
        for k in w.identity_keys():
            key2wid[k] = w.id
    edges: set[tuple[str, str]] = set()
    for w in store.works:
        for doc_id in w.doc_ids:
            for r in doc_reference_ids(doc_id):
                cks: set[str] = set()
                if r.get("doi"):
                    cks.add("doi:" + (norm_doi(r["doi"]) or ""))
                if r.get("arxiv_id"):
                    cks.add("arxiv:" + (norm_arxiv(r["arxiv_id"]) or ""))
                if r.get("title"):
                    nt = norm_title(r["title"])
                    if len(nt) > 12:  # avoid spurious short-title collisions
                        cks.add("title:" + nt)
                for ck in cks:
                    tgt = key2wid.get(ck)
                    if tgt and tgt != w.id:
                        edges.add((w.id, tgt))
    return edges


# --------------------------------------------------------------------------- #
# Graph assembly
# --------------------------------------------------------------------------- #

def _saved_node(w: Work) -> dict:
    return {
        "id": w.id,
        "ref": w.id,
        "y": w.year or 2024,
        "c": w.cited_by_count or 0,
        "a": display_authors(w.authors) or (w.title[:24] if w.title else w.id),
        "v": w.venue or "",
        "t": w.title or w.id,
        "doi": w.doi,
        "arxiv_id": w.arxiv_id,
        "doc_id": w.doc_ids[0] if w.doc_ids else None,
    }


def _suggested_node(m: dict) -> dict:
    return {
        "id": "oa:" + m["openalex_id"],
        "y": m["year"],
        "c": m["cited_by_count"] or 0,
        "a": display_authors(m["authors"]) or (m["title"][:24] if m["title"] else m["openalex_id"]),
        "v": m["venue"] or "",
        "t": m["title"] or m["openalex_id"],
        "doi": m["doi"],
    }


def build_graph(store: LibraryStore, oa: OpenAlex) -> dict:
    oaid2node: dict[str, str] = {}
    nodes: list[dict] = []
    for w in store.works:
        nodes.append(_saved_node(w))
        if w.openalex_id:
            oaid2node[w.openalex_id] = w.id

    saved_oa = {w.openalex_id for w in store.works if w.openalex_id}
    pool: set[str] = set()
    for w in store.works:
        pool.update(w.referenced_works or [])
    pool -= saved_oa

    meta = oa.fetch_many(sorted(pool)) if pool else {}
    cands = sorted(
        (m for m in meta.values() if m.get("year")),
        key=lambda m: m.get("cited_by_count") or 0,
        reverse=True,
    )[:MAX_SUGGEST]
    for c in cands:
        nid = "oa:" + c["openalex_id"]
        oaid2node[c["openalex_id"]] = nid
        nodes.append(_suggested_node(c))

    links: set[tuple[str, str]] = set()

    def add_refs(refs: list[str] | None, src_node: str) -> None:
        for r in refs or []:
            tgt = oaid2node.get(r)
            if tgt and tgt != src_node:
                links.add((src_node, tgt))

    for w in store.works:
        add_refs(w.referenced_works, w.id)
    for c in cands:
        add_refs(c.get("referenced_works"), "oa:" + c["openalex_id"])
    links |= offline_edges(store)

    # keep only nodes that are saved or actually connected
    connected = {a for a, _ in links} | {b for _, b in links}
    saved_ids = {w.id for w in store.works}
    kept = [n for n in nodes if n["id"] in saved_ids or n["id"] in connected]
    kept_ids = {n["id"] for n in kept}
    links = {(a, b) for a, b in links if a in kept_ids and b in kept_ids}

    log.info("graph: %d nodes (%d saved) · %d links", len(kept), len(saved_ids), len(links))
    return {"nodes": kept, "links": [[a, b] for a, b in sorted(links)]}


# --------------------------------------------------------------------------- #
# API projections
# --------------------------------------------------------------------------- #

def work_to_ref(w: Work) -> dict:
    # required fields (the TS LibraryRef declares these non-optional) are always
    # present — never stripped — so the frontend can rely on e.g. r.authors.
    ref = {
        "id": w.id,
        "title": w.title or w.id,
        "authors": display_authors(w.authors),
        "year": w.year or 0,
        "venue": w.venue or "",
        "type": w.type,
        "cite": w.cite_key or slug(w.id),
        "tags": w.tags,
        "pdf": bool(w.doc_ids),
        "read": w.read,
        "note": bool(w.note),
        "star": w.star,
    }
    acq = w.acquisition or {}
    optional = {
        "abstract": w.abstract,
        "doi": w.doi,
        "arxiv_id": w.arxiv_id,
        "doc_id": w.doc_ids[0] if w.doc_ids else None,
        "citedBy": w.cited_by_count,
        "label": w.label,
        "journal": w.journal,
        # acquisition: which full-text source is planned + whether it's ready now
        "source": acq.get("chosen"),
        "sourceLabel": acq.get("chosen_label"),
        "sourceStatus": acq.get("status"),
        "sourceReady": acq.get("ready"),
        # bot-walled & no auto source → the UI offers a PDF upload
        "needs_upload": acq.get("needs_upload") or None,
        # resolution: which provider supplied the citation count (ads/crossref/openalex)
        "resolvedBy": (w.resolution or {}).get("count"),
    }
    ref.update({k: v for k, v in optional.items() if v is not None and v != ""})
    return ref
