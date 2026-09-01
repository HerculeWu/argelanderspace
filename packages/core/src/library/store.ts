/**
 * The ArgelanderSpace literature store (bibgraph/library/store.py).
 *
 * The library is a small set of files on disk under `literatures/library/`:
 * - `library.json` — the source of truth: saved works + per-work user state
 *   (tags, color label, read flag, note, star) + the project header;
 * - `library.bib` — a regenerated BibTeX export of the saved works;
 * - `cache/` — derived/enrichment artifacts (the citation graph, raw source
 *   responses); never hand-edited, safe to delete.
 *
 * A *work* is one canonical paper; several ingested reader documents (the PDF /
 * LaTeX / HTML renderings of the same paper) collapse into a single work that
 * points back at all of them via `doc_ids`.
 *
 * Port notes (bug-for-bug):
 * - `Work` fields keep the Python dataclass's snake_case names: they ARE the
 *   `library.json` keys, so round-tripping stays exact.
 * - Python's module-level `ROOT`/`LIBRARY_DIR` constants become an injected
 *   {@link LibraryPaths} (decision 3: `--data-dir` configurable, default `./literatures`).
 * - Python `Work.identity_keys()` returns a `set` whose iteration order is
 *   hash-dependent; the TS port iterates in insertion order (doi ▸ arxiv ▸
 *   openalex ▸ title). This only matters when one upsert bridges several
 *   existing works — the survivor pick was already non-deterministic in Python
 *   (PYTHONHASHSEED), so the deterministic TS order is the faithful choice.
 * - `workToDict` mirrors `Work.to_dict()`: it drops `None` / `[]` / `""` but
 *   keeps `false`, `0` and `{}` (Python's `v not in (None, [], "")`).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pyOr, pyTruthy, stripChars } from "../documents/pyregex.js";

// --------------------------------------------------------------------------- //
// Paths
// --------------------------------------------------------------------------- //

/** The on-disk layout of a library (Python's module constants, made injectable). */
export interface LibraryPaths {
  dataDir: string;
  /** `literatures/library` */
  libraryDir: string;
  /** `literatures/library/library.json` */
  libraryJson: string;
  /** `literatures/library/library.bib` */
  libraryBib: string;
  /** `literatures/library/cache` */
  cacheDir: string;
  /** `literatures/library/cache/graph.json` */
  graphJson: string;
  /** `literatures/output` (ingested reader documents) */
  outputDir: string;
}

/** The standard layout under *dataDir* (default `./literatures`, decision 3). */
export function libraryPaths(dataDir: string): LibraryPaths {
  const libraryDir = join(dataDir, "library");
  const cacheDir = join(libraryDir, "cache");
  return {
    dataDir,
    libraryDir,
    libraryJson: join(libraryDir, "library.json"),
    libraryBib: join(libraryDir, "library.bib"),
    cacheDir,
    graphJson: join(cacheDir, "graph.json"),
    outputDir: join(dataDir, "output"),
  };
}

// --------------------------------------------------------------------------- //
// Identity helpers
// --------------------------------------------------------------------------- //

export function normDoi(doi: string | null | undefined): string | null {
  if (!doi) return null;
  let d = doi.trim().toLowerCase();
  d = d.replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
  d = d.replace(/^doi:/, "");
  return d || null;
}

export function normArxiv(arxiv: string | null | undefined): string | null {
  if (!arxiv) return null;
  let a = arxiv.trim().toLowerCase();
  a = a.replace(/^arxiv:/, "");
  a = a.replace(/v\d+$/, ""); // strip version
  return a || null;
}

const ARXIV_DOI_RE = /^10\.48550\/arxiv\.(.+)$/i;

/**
 * The arXiv id behind a DataCite arXiv DOI (`10.48550/arXiv.2603.03522`).
 *
 * OpenAlex returns this DOI for an arXiv-only record; it is *not* a journal DOI
 * and must never drive publisher classification or work identity.
 */
export function arxivFromDoi(doi: string | null | undefined): string | null {
  const d = normDoi(doi);
  if (!d) return null;
  const m = ARXIV_DOI_RE.exec(d);
  return m?.[1] !== undefined ? normArxiv(m[1]) : null;
}

export function normTitle(title: string | null | undefined): string {
  if (!title) return "";
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function slug(s: string | null | undefined, n = 48): string {
  const out = stripChars((s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-"), "-").slice(0, n);
  return out || "work";
}

/** Stable canonical id for a work (DOI ▸ arXiv ▸ OpenAlex ▸ title-slug). */
export function canonicalId(ids: {
  doi?: string | null;
  arxiv?: string | null;
  openalex?: string | null;
  title?: string | null;
  year?: number | null;
}): string {
  const d = normDoi(ids.doi);
  if (d) return `doi:${d}`;
  const a = normArxiv(ids.arxiv);
  if (a) return `arxiv:${a}`;
  if (ids.openalex) return `openalex:${ids.openalex.split("/").pop()}`;
  return `work:${slug(ids.title)}${ids.year ? `-${ids.year}` : ""}`;
}

/** `["Hunt","Reffert","Smith"]` → `"Hunt et al."` (Zotero-ish). */
export function displayAuthors(authors: readonly string[]): string {
  const a = authors.filter((x) => x);
  if (a.length === 0) return "";
  if (a.length === 1) return a[0] as string;
  if (a.length === 2) return `${a[0]} & ${a[1]}`;
  return `${a[0]} et al.`;
}

// --------------------------------------------------------------------------- //
// Work model
// --------------------------------------------------------------------------- //

/**
 * One canonical paper. Field names are the `library.json` keys (snake_case,
 * Python dataclass order); defaults match the dataclass exactly.
 */
export interface Work {
  id: string;
  title: string;
  /** family names, in order */
  authors: string[];
  year: number | null;
  venue: string | null;
  /** article | conf */
  type: string;
  doi: string | null;
  arxiv_id: string | null;
  bibcode: string | null;
  openalex_id: string | null;
  abstract: string | null;
  cited_by_count: number | null;
  cite_key: string | null;
  /** openalex ids this work cites */
  referenced_works: string[];
  /** reader docs that ARE this work */
  doc_ids: string[];
  // ---- user state ----
  tags: string[];
  /** color-label key */
  label: string | null;
  read: boolean;
  note: string | null;
  star: boolean;
  /** ingested | manual | graph-node | bib */
  origin: string;
  added_at: string | null;
  /** short label, e.g. "A&A" (publisher-classified) */
  journal: string | null;
  /** acquisition: where to read the full text (planner output, see acquire/) */
  acquisition: Record<string, unknown> | null;
  /** resolution: which source answered for citation metadata (ads|crossref|openalex) */
  resolution: Record<string, unknown> | null;
}

/** The dataclass defaults (Python `Work()` field defaults). */
export function emptyWork(id: string): Work {
  return {
    id,
    title: "",
    authors: [],
    year: null,
    venue: null,
    type: "article",
    doi: null,
    arxiv_id: null,
    bibcode: null,
    openalex_id: null,
    abstract: null,
    cited_by_count: null,
    cite_key: null,
    referenced_works: [],
    doc_ids: [],
    tags: [],
    label: null,
    read: false,
    note: null,
    star: false,
    origin: "ingested",
    added_at: null,
    journal: null,
    acquisition: null,
    resolution: null,
  };
}

/**
 * Build a Work from a parsed `library.json` record (Python `Work(**w)`).
 * Unknown keys are ignored (Python would raise `TypeError`; the TS port is
 * lenient rather than crashing on a hand-edited file — documented divergence).
 */
export function workFromJson(rec: Record<string, unknown>): Work {
  const w = emptyWork(String(rec.id));
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  w.title = typeof rec.title === "string" ? rec.title : "";
  w.authors = strList(rec.authors);
  w.year = num(rec.year);
  w.venue = str(rec.venue);
  w.type = typeof rec.type === "string" ? rec.type : "article";
  w.doi = str(rec.doi);
  w.arxiv_id = str(rec.arxiv_id);
  w.bibcode = str(rec.bibcode);
  w.openalex_id = str(rec.openalex_id);
  w.abstract = str(rec.abstract);
  w.cited_by_count = num(rec.cited_by_count);
  w.cite_key = str(rec.cite_key);
  w.referenced_works = strList(rec.referenced_works);
  w.doc_ids = strList(rec.doc_ids);
  w.tags = strList(rec.tags);
  w.label = str(rec.label);
  w.read = rec.read === true;
  w.note = str(rec.note);
  w.star = rec.star === true;
  w.origin = typeof rec.origin === "string" ? rec.origin : "ingested";
  w.added_at = str(rec.added_at);
  w.journal = str(rec.journal);
  w.acquisition =
    rec.acquisition && typeof rec.acquisition === "object" && !Array.isArray(rec.acquisition)
      ? (rec.acquisition as Record<string, unknown>)
      : null;
  w.resolution =
    rec.resolution && typeof rec.resolution === "object" && !Array.isArray(rec.resolution)
      ? (rec.resolution as Record<string, unknown>)
      : null;
  return w;
}

/** Mirrors `Work.to_dict()`: drop `None` / `[]` / `""`, keep `false` / `0` / `{}`. */
export function workToDict(w: Work): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (k: string, v: unknown): void => {
    if (v === null || v === undefined || v === "") return;
    if (Array.isArray(v) && v.length === 0) return;
    out[k] = v;
  };
  // Python dataclass field order
  put("id", w.id);
  put("title", w.title);
  put("authors", w.authors);
  put("year", w.year);
  put("venue", w.venue);
  put("type", w.type);
  put("doi", w.doi);
  put("arxiv_id", w.arxiv_id);
  put("bibcode", w.bibcode);
  put("openalex_id", w.openalex_id);
  put("abstract", w.abstract);
  put("cited_by_count", w.cited_by_count);
  put("cite_key", w.cite_key);
  put("referenced_works", w.referenced_works);
  put("doc_ids", w.doc_ids);
  put("tags", w.tags);
  put("label", w.label);
  put("read", w.read);
  put("note", w.note);
  put("star", w.star);
  put("origin", w.origin);
  put("added_at", w.added_at);
  put("journal", w.journal);
  put("acquisition", w.acquisition);
  put("resolution", w.resolution);
  return out;
}

/** All keys by which a work may be matched to another (for dedup). */
export function identityKeys(w: Work): Set<string> {
  const keys = new Set<string>();
  const d = normDoi(w.doi); // guard: a bare "doi:" normalizes to null
  if (d) keys.add(`doi:${d}`);
  const a = normArxiv(w.arxiv_id);
  if (a) keys.add(`arxiv:${a}`);
  if (w.openalex_id) keys.add(`openalex:${w.openalex_id.split("/").pop()}`);
  const nt = normTitle(w.title);
  if (nt) keys.add(`title:${nt}`);
  return keys;
}

// --------------------------------------------------------------------------- //
// Store
// --------------------------------------------------------------------------- //

export const DEFAULT_PROJECT: Record<string, unknown> = {
  name: "我的文献库",
  short: "Library",
  field: "",
};

export class LibraryStore {
  works: Work[];
  project: Record<string, unknown>;
  private byKey = new Map<string, Work>();

  constructor(works: Work[] = [], project?: Record<string, unknown> | null) {
    this.works = works;
    this.project = (pyOr(project) as Record<string, unknown> | undefined) ?? {
      ...DEFAULT_PROJECT,
    };
    this.reindex();
  }

  // ---- indexing ----
  private reindex(): void {
    this.byKey = new Map();
    for (const w of this.works) {
      for (const k of identityKeys(w)) {
        if (!this.byKey.has(k)) this.byKey.set(k, w);
      }
    }
  }

  get(workId: string): Work | undefined {
    return this.works.find((w) => w.id === workId);
  }

  match(...keys: (string | null | undefined)[]): Work | undefined {
    for (const k of keys) {
      if (k && this.byKey.has(k)) return this.byKey.get(k);
    }
    return undefined;
  }

  /**
   * Add *w*, or merge it into the existing work(s) sharing any identity key.
   *
   * A bridging record (e.g. one carrying both a DOI and a title that two
   * separate works each already hold) reconciles those works into one, so a
   * single paper never persists as duplicates.
   */
  upsert(w: Work): Work {
    const matches: Work[] = [];
    const seen = new Set<Work>();
    for (const k of identityKeys(w)) {
      const m = this.byKey.get(k);
      if (m !== undefined && !seen.has(m)) {
        seen.add(m);
        matches.push(m);
      }
    }
    if (matches.length === 0) {
      this.works.push(w);
      this.reindex();
      return w;
    }
    const survivor = matches[0] as Work;
    for (const extra of matches.slice(1)) {
      // collapse works the new record bridges
      mergeInto(survivor, extra);
      this.works.splice(this.works.indexOf(extra), 1);
    }
    mergeInto(survivor, w);
    this.reindex();
    return survivor;
  }

  // ---- persistence ----
  static load(paths: LibraryPaths): LibraryStore {
    if (!existsSync(paths.libraryJson)) return new LibraryStore();
    const data = JSON.parse(readFileSync(paths.libraryJson, "utf8")) as Record<string, unknown>;
    const rawWorks = Array.isArray(data.works) ? data.works : [];
    const works = rawWorks.map((w) => workFromJson(w as Record<string, unknown>));
    const project = pyOr(data.project) as Record<string, unknown> | undefined;
    return new LibraryStore(works, project);
  }

  save(paths: LibraryPaths): void {
    mkdirSync(paths.libraryDir, { recursive: true });
    mkdirSync(paths.cacheDir, { recursive: true });
    const payload = {
      version: 1,
      project: this.project,
      works: this.works.map(workToDict),
    };
    const tmp = paths.libraryJson.replace(/\.json$/, ".json.tmp");
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmp, paths.libraryJson);
    const btmp = paths.libraryBib.replace(/\.bib$/, ".bib.tmp");
    writeFileSync(btmp, this.toBibtex(), "utf8");
    renameSync(btmp, paths.libraryBib);
  }

  // ---- exports ----
  toBibtex(): string {
    return `${this.works.map(workToBibtex).join("\n\n")}\n`;
  }
}

/** Fold *src* into *dst*, filling blanks and unioning lists (dst wins on scalars). */
export function mergeInto(dst: Work, src: Work): void {
  const scalars = [
    "title",
    "venue",
    "doi",
    "arxiv_id",
    "bibcode",
    "openalex_id",
    "abstract",
    "cite_key",
    "journal",
    "acquisition",
    "resolution",
  ] as const;
  for (const f of scalars) {
    if (!pyTruthy(dst[f]) && pyTruthy(src[f])) {
      (dst as unknown as Record<string, unknown>)[f] = src[f];
    }
  }
  // numeric: 0 is a real value, not "blank"
  if (dst.year === null && src.year !== null) dst.year = src.year;
  if (dst.cited_by_count === null && src.cited_by_count !== null) {
    dst.cited_by_count = src.cited_by_count;
  }
  if (dst.authors.length === 0 && src.authors.length > 0) dst.authors = src.authors;
  if (src.type && dst.type === "article") dst.type = src.type;
  for (const f of ["doc_ids", "tags", "referenced_works"] as const) {
    dst[f] = [...new Set([...dst[f], ...src[f]])];
  }
}

// --------------------------------------------------------------------------- //
// BibTeX
// --------------------------------------------------------------------------- //

function bibAuthors(authors: readonly string[]): string {
  return authors.length > 0 ? authors.join(" and ") : "";
}

export function workToBibtex(w: Work): string {
  const key = (pyOr(w.cite_key) as string | undefined) ?? slug(w.id);
  const kind = w.type === "conf" ? "inproceedings" : "article";
  const fields: [string, string][] = [
    ["title", w.title],
    ["author", bibAuthors(w.authors)],
    ["journal", w.venue ?? ""],
    ["year", w.year ? String(w.year) : ""],
    ["doi", w.doi ?? ""],
    ["eprint", w.arxiv_id ?? ""],
  ];
  const body = fields
    .filter(([, v]) => v)
    .map(([k, v]) => `  ${k.padEnd(8)}= {${v}}`)
    .join(",\n");
  return `@${kind}{${key},\n${body}\n}`;
}
