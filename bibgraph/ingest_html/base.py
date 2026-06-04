"""Per-publisher HTML adapter interface + registry.

Each publisher ships its own front-end markup, so each gets an adapter that
knows how to walk *that* DOM. An adapter consumes the fetched page and emits a
:class:`ParsedDoc` (section tree + references + title/meta); the common pipeline
(:mod:`bibgraph.pipeline_html`) does the publisher-independent rest (regex
citation fallback, tokenisation, indexing, JSON).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from bs4 import BeautifulSoup

from ..config import HtmlConfig
from ..schema import Reference, Section
from .fetch import Fetcher


@dataclass
class ParsedDoc:
    sections: list[Section]
    references: list[Reference]
    title: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)
    source_extra: dict[str, Any] = field(default_factory=dict)


class HtmlAdapter(ABC):
    """Base class for a publisher-specific HTML parser."""

    name: str = "generic"
    #: substrings any of which, in the host/url, claim a page for this adapter
    host_hints: tuple[str, ...] = ()
    #: human label for the journal this adapter serves (e.g. "A&A")
    publisher: str = ""
    #: DOI prefixes this adapter can render; lets the acquisition planner know a
    #: journal-HTML source is actually fetchable for a given paper.
    doi_prefixes: tuple[str, ...] = ()

    @classmethod
    def matches(cls, url: str, soup: BeautifulSoup) -> bool:
        u = url.lower()
        return any(h in u for h in cls.host_hints)

    @abstractmethod
    def parse(self, soup: BeautifulSoup, *, base_url: str, fetcher: Fetcher,
              asset_dir: Path, config: HtmlConfig) -> ParsedDoc:
        ...


# Registry, populated by each adapter module at import time. ----------------- #
ADAPTERS: list[type[HtmlAdapter]] = []


def register(cls: type[HtmlAdapter]) -> type[HtmlAdapter]:
    ADAPTERS.append(cls)
    return cls


def adapter_for(url: str, soup: BeautifulSoup) -> HtmlAdapter | None:
    for cls in ADAPTERS:
        try:
            if cls.matches(url, soup):
                return cls()
        except Exception:
            continue
    return None
