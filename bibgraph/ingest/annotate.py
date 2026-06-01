"""Shared machinery for replacing in-text spans with ``[[...]]`` tokens.

Both the citation and cross-reference detectors return :class:`Match` objects
(character span + the occurrence record). They are merged, de-overlapped, and
applied to the body text in a *single* rewrite so that inserting one token can
never corrupt the offsets of another.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..schema import CitationOccurrence, CrossRefOccurrence


@dataclass
class Match:
    start: int
    end: int
    occ: CitationOccurrence | CrossRefOccurrence

    @property
    def token(self) -> str:
        return self.occ.token

    @property
    def is_cite(self) -> bool:
        return isinstance(self.occ, CitationOccurrence)


def apply_matches(
    text: str, matches: list[Match]
) -> tuple[str, list[CitationOccurrence], list[CrossRefOccurrence]]:
    """Rewrite *text*, replacing each accepted match span with its token.

    Overlapping matches are resolved by preferring the earlier start, then the
    longer span. Returns ``(new_text, citations, crossrefs)`` in reading order.
    """
    ordered = sorted(matches, key=lambda m: (m.start, -(m.end - m.start)))
    accepted: list[Match] = []
    last_end = -1
    for m in ordered:
        if m.start < 0 or m.end > len(text) or m.end <= m.start:
            continue
        if m.start < last_end:          # overlaps a previously accepted match
            continue
        accepted.append(m)
        last_end = m.end

    parts: list[str] = []
    cursor = 0
    cites: list[CitationOccurrence] = []
    xrefs: list[CrossRefOccurrence] = []
    for m in accepted:                  # already sorted by start, non-overlapping
        parts.append(text[cursor:m.start])
        parts.append(m.token)
        cursor = m.end
        if m.is_cite:
            cites.append(m.occ)         # type: ignore[arg-type]
        else:
            xrefs.append(m.occ)         # type: ignore[arg-type]
    parts.append(text[cursor:])
    return "".join(parts), cites, xrefs
