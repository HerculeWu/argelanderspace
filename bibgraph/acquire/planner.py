"""Source-acquisition planner: *where* to read each paper's full text.

The user's source priority, strongest first:

    1. journal-website HTML   (semantic markup, authoritative anchors)
    2. journal-website PDF     (born-digital, real text layer — not a scan)
    3. arXiv LaTeX             (author source; maths + cites are authoritative)
    4. ADS-archived scan PDF   (old papers; needs OCR)

For one resolved record we emit a ranked list of :class:`Candidate` sources and
pick the highest-priority one we can realistically obtain. "Realistically" is
checked against the live HTML-adapter registry — a journal-HTML candidate is
``ready`` only once an adapter for that publisher exists (today: A&A); MNRAS /
ApJ / PRL come online in Phase 2. PDF/scan tiers are ``needs_access`` until the
fetchers (Phase 3) and the user's network access are in place.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

from ..library.store import arxiv_from_doi


# --------------------------------------------------------------------------- #
# Publisher classification
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class Publisher:
    name: str                       # "EDP Sciences"
    journal: str                    # default journal label, "A&A"
    doi_prefixes: tuple[str, ...] = ()
    journal_names: tuple[str, ...] = ()   # lowercase substrings for no-DOI matching
    has_html: bool = True           # the journal ships a digital HTML full text
    has_digital_pdf: bool = True    # a born-digital (text-layer) PDF exists
    # the site bot-walls automated fetches (Radware/Cloudflare): HTML+PDF can't
    # be auto-fetched — route to arXiv / a user-uploaded PDF instead.
    blocked: bool = False
    # map a finer DOI prefix to the specific journal label (AAS/IOP share a host)
    sub_journals: tuple[tuple[str, str], ...] = ()


_PUBLISHERS: tuple[Publisher, ...] = (
    Publisher("EDP Sciences", "A&A", ("10.1051/0004-6361",),
              ("astronomy & astrophysics", "astronomy and astrophysics", "a&a")),
    Publisher("Oxford University Press", "MNRAS",
              ("10.1093/mnras", "10.1093/mnrasl"),
              ("monthly notices of the royal astronomical society", "mnras")),
    # Pre-2016 MNRAS lived on Wiley/Blackwell.
    Publisher("Wiley (MNRAS)", "MNRAS",
              ("10.1111/j.1365-2966", "10.1046/j.1365-8711", "10.1111/j.1365-2960"),
              ()),
    # AAS journals on iopscience.iop.org — bot-walled (Radware) → arXiv/user-PDF.
    Publisher("AAS / IOP", "ApJ", ("10.3847",), (), blocked=True,
              sub_journals=(("10.3847/1538-4357", "ApJ"),
                            ("10.3847/1538-4365", "ApJS"),
                            ("10.3847/1538-3881", "AJ"),
                            ("10.3847/2041-8213", "ApJL"))),
    # Pre-2017 AAS journals had IOP DOIs (also iopscience, bot-walled).
    Publisher("IOP (AAS)", "ApJ",
              ("10.1088/0004-637x", "10.1088/0067-0049",
               "10.1088/0004-6256", "10.1088/2041-8205", "10.1088/2041-8213"),
              (), blocked=True,
              sub_journals=(("10.1088/0004-637x", "ApJ"),
                            ("10.1088/0067-0049", "ApJS"),
                            ("10.1088/0004-6256", "AJ"),
                            ("10.1088/2041-8205", "ApJL"),
                            ("10.1088/2041-8213", "ApJL"))),
    # APS on link.aps.org — Cloudflare-walled → arXiv/user-PDF.
    Publisher("APS", "PRL", ("10.1103/physrevlett",),
              ("physical review letters",), blocked=True),
    Publisher("APS", "Phys. Rev.", ("10.1103/physrev",),
              ("physical review",), blocked=True),
    # Pre-digital University of Chicago Press ApJ/AJ — DOIs exist but resolve to
    # a scan, never a digital HTML/PDF: route these to the ADS scan tier.
    Publisher("U. Chicago Press (legacy)", "ApJ", ("10.1086",), (),
              has_html=False, has_digital_pdf=False),
)

# Journal names that imply EDP/A&A etc. when no DOI is present.
_NAME_INDEX: tuple[tuple[str, Publisher], ...] = tuple(
    (n, p) for p in _PUBLISHERS for n in p.journal_names
)


def classify(doi: str | None, journal: str | None) -> tuple[Publisher | None, str]:
    """Return ``(publisher, journal_label)`` for a DOI and/or journal name."""
    d = (doi or "").lower()
    if d and arxiv_from_doi(d):
        d = ""                       # an arXiv DOI is not a journal DOI
    if d:
        for p in _PUBLISHERS:
            if any(d.startswith(pre) for pre in p.doi_prefixes):
                label = p.journal
                for sub, jl in p.sub_journals:
                    if d.startswith(sub):
                        label = jl
                        break
                return p, label
    jn = (journal or "").lower()
    if jn:
        for name, p in _NAME_INDEX:
            if name in jn:
                return p, p.journal
    return None, (journal or "")


# --------------------------------------------------------------------------- #
# HTML-adapter availability (consults the live registry)
# --------------------------------------------------------------------------- #

def html_adapter_for_doi(doi: str | None) -> str | None:
    """Name of the registered HTML adapter that can render *doi*, if any."""
    if not doi:
        return None
    # import the package (not just .base) so every adapter has registered itself
    from ..ingest_html import ADAPTERS  # lazy: avoids heavy import at module load
    d = doi.lower()
    for ad in ADAPTERS:
        if any(d.startswith(pre.lower()) for pre in getattr(ad, "doi_prefixes", ())):
            return ad.name
    return None


# --------------------------------------------------------------------------- #
# Candidates + plan
# --------------------------------------------------------------------------- #

# status values, best → worst readiness
READY = "ready"                 # we can fetch this right now
NEEDS_ADAPTER = "needs_adapter"  # tier exists in principle; no parser yet
NEEDS_ACCESS = "needs_access"    # parser/fetcher needs network access / a token
BLOCKED = "blocked"             # site bot-walls automation; only a user upload helps
UNAVAILABLE = "unavailable"      # this source does not exist for this paper

# statuses that the auto-fetch executor cannot satisfy → skip when choosing
_NOT_AUTO = (UNAVAILABLE, BLOCKED)

_TIER_ORDER = ("journal_html", "journal_pdf", "arxiv_latex", "ads_scan")
_TIER_RANK = {t: i for i, t in enumerate(_TIER_ORDER)}


@dataclass
class Candidate:
    tier: str                       # one of _TIER_ORDER
    label: str                      # human label, "A&A HTML"
    status: str                     # READY | NEEDS_ADAPTER | NEEDS_ACCESS | UNAVAILABLE
    locator: str | None = None      # doi / arxiv id / bibcode used to fetch
    publisher: str | None = None
    note: str = ""

    def to_dict(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v not in (None, "")}


@dataclass
class AcquisitionPlan:
    chosen: Candidate | None        # top-priority candidate we can auto-fetch
    ready: Candidate | None         # top-priority candidate fetchable *today*
    candidates: list[Candidate] = field(default_factory=list)
    publisher: str = ""
    reason: str = ""
    blocked: Candidate | None = None  # top bot-walled tier (UI: offer PDF upload)

    def to_dict(self) -> dict:
        # when nothing is auto-fetchable but a bot-walled tier exists, surface it
        # as the chosen source with status "blocked" so the UI offers PDF upload.
        head = self.chosen or self.blocked
        return {
            "chosen": head.tier if head else None,
            "chosen_label": head.label if head else None,
            "status": head.status if head else UNAVAILABLE,
            "ready": self.ready.tier if self.ready else None,
            "needs_upload": self.chosen is None and self.blocked is not None,
            "publisher": self.publisher,
            "reason": self.reason,
            "candidates": [c.to_dict() for c in self.candidates],
        }


def plan_sources(*, doi: str | None = None, arxiv_id: str | None = None,
                 bibcode: str | None = None, title: str | None = None,
                 year: int | None = None, journal: str | None = None,
                 venue: str | None = None) -> AcquisitionPlan:
    """Rank full-text sources for one (already metadata-resolved) paper."""
    # an arXiv DOI is not a journal DOI: don't let it spawn journal tiers, and
    # fold it into the arXiv id instead.
    if doi and arxiv_from_doi(doi):
        arxiv_id = arxiv_id or arxiv_from_doi(doi)
        doi = None
    pub, label = classify(doi, journal or venue)
    cands: list[Candidate] = []

    # 1) journal-website HTML
    if pub and pub.has_html and doi:
        if pub.blocked:
            cands.append(Candidate("journal_html", f"{label} HTML", BLOCKED, doi,
                                   pub.name, "bot-walled; needs a user-uploaded PDF"))
        elif html_adapter_for_doi(doi):
            cands.append(Candidate("journal_html", f"{label} HTML", READY, doi,
                                   pub.name, f"adapter={html_adapter_for_doi(doi)}"))
        else:
            cands.append(Candidate("journal_html", f"{label} HTML", NEEDS_ADAPTER,
                                   doi, pub.name, "no HTML adapter yet"))

    # 2) journal-website PDF (born-digital only)
    if pub and pub.has_digital_pdf and doi:
        st = BLOCKED if pub.blocked else NEEDS_ACCESS
        note = ("bot-walled; needs a user-uploaded PDF" if pub.blocked
                else "digital PDF via publisher")
        cands.append(Candidate("journal_pdf", f"{label} PDF", st, doi, pub.name, note))

    # 3) arXiv LaTeX
    if arxiv_id:
        cands.append(Candidate("arxiv_latex", "arXiv LaTeX", READY, arxiv_id,
                               None, "author e-print source"))

    # 4) ADS-archived scan PDF — only a real fallback for *legacy* papers. ADS
    #    holds independent scans for pre-electronic articles; for a modern paper
    #    its "scan" link just redirects to the (often bot-walled) publisher, so
    #    we don't offer it there — a modern blocked paper falls to a user upload.
    is_legacy = (pub is None) or (not pub.has_html) or (year is not None and year < 1998)
    if is_legacy and (bibcode or doi or (title and year)):
        loc = bibcode or doi or (title or "")
        cands.append(Candidate("ads_scan", "ADS scan", NEEDS_ACCESS, loc,
                               pub.name if pub else None, "old/scanned article"))

    cands.sort(key=lambda c: _TIER_RANK[c.tier])
    # "chosen" = the top-priority source we can actually auto-fetch (skip a
    # bot-walled or non-existent tier); blocked tiers remain in the list so the
    # UI can show "upload a PDF" for them.
    usable = [c for c in cands if c.status not in _NOT_AUTO]
    chosen = usable[0] if usable else None
    ready = next((c for c in cands if c.status == READY), None)
    blocked_top = next((c for c in cands if c.status == BLOCKED), None)

    if chosen is None and blocked_top is not None:
        reason = (f"{blocked_top.label} is bot-walled and no arXiv/scan source was "
                  "found — upload the PDF to read it")
    elif chosen is None:
        reason = "no obtainable source (no DOI, arXiv id, or ADS record)"
    elif ready is chosen:
        reason = f"{chosen.label} is the top-priority obtainable source, fetchable now"
    elif chosen.status == NEEDS_ADAPTER:
        reason = (f"{chosen.label} is top priority but needs a publisher adapter"
                  + (f"; {ready.label} is fetchable now" if ready else ""))
    else:
        reason = (f"{chosen.label} is top priority but needs access"
                  + (f"; {ready.label} is fetchable now" if ready else ""))

    return AcquisitionPlan(chosen=chosen, ready=ready, candidates=cands,
                           publisher=(pub.name if pub else ""), reason=reason,
                           blocked=blocked_top)
