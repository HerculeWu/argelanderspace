/**
 * Source-acquisition planner: *where* to read each paper's full text
 * (bibgraph/acquire/planner.py).
 *
 * The user's source priority, strongest first:
 *
 *   1. journal-website HTML   (semantic markup, authoritative anchors)
 *   2. journal-website PDF     (born-digital, real text layer — not a scan)
 *   3. arXiv LaTeX             (author source; maths + cites are authoritative)
 *   4. ADS-archived scan PDF   (old papers; needs OCR)
 *
 * For one resolved record we emit a ranked list of {@link Candidate} sources and
 * pick the highest-priority one we can realistically obtain. "Realistically" is
 * checked against the HTML-adapter registry — a journal-HTML candidate is
 * `ready` only once an adapter for that publisher exists (today: A&A, MNRAS).
 *
 * Port notes (bug-for-bug):
 * - The publisher table is ported AS-IS, including the EDP/A&A `ready` marking
 *   and the bot-wall annotations that no longer match reality (decision 2; the
 *   publisher-access reality is documented in
 *   `.kimi-code/memory/2026-08-26-publisher-access-status.md` and deliberately
 *   NOT fixed here).
 * - Python consults the live `ingest_html.ADAPTERS` registry for
 *   `html_adapter_for_doi`. The adapters are M3; the port takes an injectable
 *   registry and defaults to {@link DEFAULT_HTML_ADAPTERS}, a static snapshot of
 *   the Python registry at migration time (aanda + oup, with their doi_prefixes
 *   from `bibgraph/ingest_html/{aanda,oup}.py`). M3 wires the live registry in.
 */

import { arxivFromDoi } from "../library/store.js";

// --------------------------------------------------------------------------- //
// Publisher classification
// --------------------------------------------------------------------------- //

export interface Publisher {
  /** e.g. "EDP Sciences" */
  name: string;
  /** default journal label, e.g. "A&A" */
  journal: string;
  doiPrefixes: readonly string[];
  /** lowercase substrings for no-DOI matching */
  journalNames: readonly string[];
  /** the journal ships a digital HTML full text */
  hasHtml: boolean;
  /** a born-digital (text-layer) PDF exists */
  hasDigitalPdf: boolean;
  /**
   * the site bot-walls automated fetches (Radware/Cloudflare): HTML+PDF can't
   * be auto-fetched — route to arXiv / a user-uploaded PDF instead.
   */
  blocked: boolean;
  /** map a finer DOI prefix to the specific journal label (AAS/IOP share a host) */
  subJournals: readonly (readonly [string, string])[];
}

function pub(
  name: string,
  journal: string,
  doiPrefixes: readonly string[],
  journalNames: readonly string[],
  extra?: Partial<Publisher>
): Publisher {
  return {
    name,
    journal,
    doiPrefixes,
    journalNames,
    hasHtml: true,
    hasDigitalPdf: true,
    blocked: false,
    subJournals: [],
    ...extra,
  };
}

const PUBLISHERS: readonly Publisher[] = [
  pub(
    "EDP Sciences",
    "A&A",
    ["10.1051/0004-6361"],
    ["astronomy & astrophysics", "astronomy and astrophysics", "a&a"]
  ),
  pub(
    "Oxford University Press",
    "MNRAS",
    ["10.1093/mnras", "10.1093/mnrasl"],
    ["monthly notices of the royal astronomical society", "mnras"]
  ),
  // Pre-2016 MNRAS lived on Wiley/Blackwell.
  pub(
    "Wiley (MNRAS)",
    "MNRAS",
    ["10.1111/j.1365-2966", "10.1046/j.1365-8711", "10.1111/j.1365-2960"],
    []
  ),
  // AAS journals on iopscience.iop.org — bot-walled (Radware) → arXiv/user-PDF.
  pub("AAS / IOP", "ApJ", ["10.3847"], [], {
    blocked: true,
    subJournals: [
      ["10.3847/1538-4357", "ApJ"],
      ["10.3847/1538-4365", "ApJS"],
      ["10.3847/1538-3881", "AJ"],
      ["10.3847/2041-8213", "ApJL"],
    ],
  }),
  // Pre-2017 AAS journals had IOP DOIs (also iopscience, bot-walled).
  pub(
    "IOP (AAS)",
    "ApJ",
    [
      "10.1088/0004-637x",
      "10.1088/0067-0049",
      "10.1088/0004-6256",
      "10.1088/2041-8205",
      "10.1088/2041-8213",
    ],
    [],
    {
      blocked: true,
      subJournals: [
        ["10.1088/0004-637x", "ApJ"],
        ["10.1088/0067-0049", "ApJS"],
        ["10.1088/0004-6256", "AJ"],
        ["10.1088/2041-8205", "ApJL"],
        ["10.1088/2041-8213", "ApJL"],
      ],
    }
  ),
  // APS on link.aps.org — Cloudflare-walled → arXiv/user-PDF.
  pub("APS", "PRL", ["10.1103/physrevlett"], ["physical review letters"], { blocked: true }),
  pub("APS", "Phys. Rev.", ["10.1103/physrev"], ["physical review"], { blocked: true }),
  // Pre-digital University of Chicago Press ApJ/AJ — DOIs exist but resolve to
  // a scan, never a digital HTML/PDF: route these to the ADS scan tier.
  pub("U. Chicago Press (legacy)", "ApJ", ["10.1086"], [], {
    hasHtml: false,
    hasDigitalPdf: false,
  }),
];

/** Journal names that imply EDP/A&A etc. when no DOI is present. */
const NAME_INDEX: readonly (readonly [string, Publisher])[] = PUBLISHERS.flatMap((p) =>
  p.journalNames.map((n) => [n, p] as const)
);

/** Return `(publisher, journal_label)` for a DOI and/or journal name. */
export function classify(
  doi: string | null | undefined,
  journal: string | null | undefined
): readonly [Publisher | null, string] {
  let d = (doi || "").toLowerCase();
  if (d && arxivFromDoi(d)) d = ""; // an arXiv DOI is not a journal DOI
  if (d) {
    for (const p of PUBLISHERS) {
      if (p.doiPrefixes.some((pre) => d.startsWith(pre))) {
        let label = p.journal;
        for (const [sub, jl] of p.subJournals) {
          if (d.startsWith(sub)) {
            label = jl;
            break;
          }
        }
        return [p, label];
      }
    }
  }
  const jn = (journal || "").toLowerCase();
  if (jn) {
    for (const [name, p] of NAME_INDEX) {
      if (jn.includes(name)) return [p, p.journal];
    }
  }
  return [null, journal || ""];
}

// --------------------------------------------------------------------------- //
// HTML-adapter availability (the registry is M3; a static snapshot is the default)
// --------------------------------------------------------------------------- //

/** One registered HTML adapter (the slice of `HtmlAdapter` the planner needs). */
export interface HtmlAdapterInfo {
  name: string;
  doiPrefixes: readonly string[];
}

/**
 * Static snapshot of the Python `ingest_html.ADAPTERS` registry at migration
 * time (`aanda.py`, `oup.py`). The live TS registry landed with M3c:
 * `pipelines/html/base.ts` `htmlAdapterInfos()` returns the same slice from
 * the actually-registered adapters; composition layers (CLI/server, M5) should
 * pass that in — this constant stays the default so the planner works without
 * the pipeline modules loaded.
 */
export const DEFAULT_HTML_ADAPTERS: readonly HtmlAdapterInfo[] = [
  { name: "aanda", doiPrefixes: ["10.1051/0004-6361"] },
  {
    name: "oup",
    doiPrefixes: ["10.1093/mnras", "10.1093/mnrasl", "10.1111/j.1365-2966", "10.1046/j.1365-8711"],
  },
];

/** Name of the registered HTML adapter that can render *doi*, if any. */
export function htmlAdapterForDoi(
  doi: string | null | undefined,
  adapters: readonly HtmlAdapterInfo[] = DEFAULT_HTML_ADAPTERS
): string | null {
  if (!doi) return null;
  const d = doi.toLowerCase();
  for (const ad of adapters) {
    if (ad.doiPrefixes.some((pre) => d.startsWith(pre.toLowerCase()))) return ad.name;
  }
  return null;
}

// --------------------------------------------------------------------------- //
// Candidates + plan
// --------------------------------------------------------------------------- //

// status values, best → worst readiness
/** we can fetch this right now */
export const READY = "ready";
/** tier exists in principle; no parser yet */
export const NEEDS_ADAPTER = "needs_adapter";
/** parser/fetcher needs network access / a token */
export const NEEDS_ACCESS = "needs_access";
/** site bot-walls automation; only a user upload helps */
export const BLOCKED = "blocked";
/** this source does not exist for this paper */
export const UNAVAILABLE = "unavailable";

/** statuses that the auto-fetch executor cannot satisfy → skip when choosing */
const NOT_AUTO: readonly string[] = [UNAVAILABLE, BLOCKED];

const TIER_ORDER = ["journal_html", "journal_pdf", "arxiv_latex", "ads_scan"] as const;
const TIER_RANK = new Map(TIER_ORDER.map((t, i) => [t, i]));

export interface Candidate {
  /** one of TIER_ORDER */
  tier: string;
  /** human label, "A&A HTML" */
  label: string;
  /** READY | NEEDS_ADAPTER | NEEDS_ACCESS | BLOCKED | UNAVAILABLE */
  status: string;
  /** doi / arxiv id / bibcode used to fetch */
  locator: string | null;
  publisher: string | null;
  note: string;
}

/** `Candidate.to_dict()`: strip None and "" (keeps other falsy values). */
export function candidateToDict(c: Candidate): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (k: string, v: unknown): void => {
    if (v !== null && v !== undefined && v !== "") out[k] = v;
  };
  put("tier", c.tier);
  put("label", c.label);
  put("status", c.status);
  put("locator", c.locator);
  put("publisher", c.publisher);
  put("note", c.note);
  return out;
}

export interface AcquisitionPlan {
  /** top-priority candidate we can auto-fetch */
  chosen: Candidate | null;
  /** top-priority candidate fetchable *today* */
  ready: Candidate | null;
  candidates: Candidate[];
  publisher: string;
  reason: string;
  /** top bot-walled tier (UI: offer PDF upload) */
  blocked: Candidate | null;
}

/** `AcquisitionPlan.to_dict()`. */
export function planToDict(p: AcquisitionPlan): Record<string, unknown> {
  // when nothing is auto-fetchable but a bot-walled tier exists, surface it
  // as the chosen source with status "blocked" so the UI offers PDF upload.
  const head = p.chosen ?? p.blocked;
  return {
    chosen: head ? head.tier : null,
    chosen_label: head ? head.label : null,
    status: head ? head.status : UNAVAILABLE,
    ready: p.ready ? p.ready.tier : null,
    needs_upload: p.chosen === null && p.blocked !== null,
    publisher: p.publisher,
    reason: p.reason,
    candidates: p.candidates.map(candidateToDict),
  };
}

/** Rank full-text sources for one (already metadata-resolved) paper. */
export function planSources(
  query: {
    doi?: string | null;
    arxivId?: string | null;
    bibcode?: string | null;
    title?: string | null;
    year?: number | null;
    journal?: string | null;
    venue?: string | null;
  },
  adapters: readonly HtmlAdapterInfo[] = DEFAULT_HTML_ADAPTERS
): AcquisitionPlan {
  // an arXiv DOI is not a journal DOI: don't let it spawn journal tiers, and
  // fold it into the arXiv id instead.
  let { doi } = query;
  let arxivId = query.arxivId ?? null;
  if (doi && arxivFromDoi(doi)) {
    arxivId = arxivId || arxivFromDoi(doi);
    doi = null;
  }
  const [publisher, label] = classify(doi, query.journal || query.venue);
  const cands: Candidate[] = [];

  // 1) journal-website HTML
  if (publisher?.hasHtml && doi) {
    if (publisher.blocked) {
      cands.push({
        tier: "journal_html",
        label: `${label} HTML`,
        status: BLOCKED,
        locator: doi,
        publisher: publisher.name,
        note: "bot-walled; needs a user-uploaded PDF",
      });
    } else {
      const adapter = htmlAdapterForDoi(doi, adapters);
      if (adapter) {
        cands.push({
          tier: "journal_html",
          label: `${label} HTML`,
          status: READY,
          locator: doi,
          publisher: publisher.name,
          note: `adapter=${adapter}`,
        });
      } else {
        cands.push({
          tier: "journal_html",
          label: `${label} HTML`,
          status: NEEDS_ADAPTER,
          locator: doi,
          publisher: publisher.name,
          note: "no HTML adapter yet",
        });
      }
    }
  }

  // 2) journal-website PDF (born-digital only)
  if (publisher?.hasDigitalPdf && doi) {
    const status = publisher.blocked ? BLOCKED : NEEDS_ACCESS;
    const note = publisher.blocked
      ? "bot-walled; needs a user-uploaded PDF"
      : "digital PDF via publisher";
    cands.push({
      tier: "journal_pdf",
      label: `${label} PDF`,
      status,
      locator: doi,
      publisher: publisher.name,
      note,
    });
  }

  // 3) arXiv LaTeX
  if (arxivId) {
    cands.push({
      tier: "arxiv_latex",
      label: "arXiv LaTeX",
      status: READY,
      locator: arxivId,
      publisher: null,
      note: "author e-print source",
    });
  }

  // 4) ADS-archived scan PDF — only a real fallback for *legacy* papers. ADS
  //    holds independent scans for pre-electronic articles; for a modern paper
  //    its "scan" link just redirects to the (often bot-walled) publisher, so
  //    we don't offer it there — a modern blocked paper falls to a user upload.
  const isLegacy =
    publisher === null ||
    !publisher.hasHtml ||
    (query.year !== null && query.year !== undefined && query.year < 1998);
  const hasLocator = query.bibcode || doi || (query.title && query.year);
  if (isLegacy && hasLocator) {
    const loc = query.bibcode || doi || query.title || "";
    cands.push({
      tier: "ads_scan",
      label: "ADS scan",
      status: NEEDS_ACCESS,
      locator: loc,
      publisher: publisher ? publisher.name : null,
      note: "old/scanned article",
    });
  }

  cands.sort(
    (a, b) =>
      (TIER_RANK.get(a.tier as (typeof TIER_ORDER)[number]) ?? 0) -
      (TIER_RANK.get(b.tier as (typeof TIER_ORDER)[number]) ?? 0)
  );
  // "chosen" = the top-priority source we can actually auto-fetch (skip a
  // bot-walled or non-existent tier); blocked tiers remain in the list so the
  // UI can show "upload a PDF" for them.
  const usable = cands.filter((c) => !NOT_AUTO.includes(c.status));
  const chosen = usable.length > 0 ? (usable[0] as Candidate) : null;
  const ready = cands.find((c) => c.status === READY) ?? null;
  const blockedTop = cands.find((c) => c.status === BLOCKED) ?? null;

  let reason: string;
  if (chosen === null && blockedTop !== null) {
    reason = `${blockedTop.label} is bot-walled and no arXiv/scan source was found — upload the PDF to read it`;
  } else if (chosen === null) {
    reason = "no obtainable source (no DOI, arXiv id, or ADS record)";
  } else if (ready === chosen) {
    reason = `${chosen.label} is the top-priority obtainable source, fetchable now`;
  } else if (chosen.status === NEEDS_ADAPTER) {
    reason =
      `${chosen.label} is top priority but needs a publisher adapter` +
      (ready ? `; ${ready.label} is fetchable now` : "");
  } else {
    reason =
      `${chosen.label} is top priority but needs access` +
      (ready ? `; ${ready.label} is fetchable now` : "");
  }

  return {
    chosen,
    ready,
    candidates: cands,
    publisher: publisher ? publisher.name : "",
    reason,
    blocked: blockedTop,
  };
}
