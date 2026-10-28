/**
 * The synthetic "messy project" of the project-intake acceptance (project-intake ticket 08, spec "验收"): what a
 * researcher's half-finished work looks like on disk, built from nothing but this file. Fictional papers, hand-made
 * one-text-layer PDFs, no real full text, no local path of anyone's machine. Also the offline ADS: the search, export
 * and biblib answers for the fictional catalog, served through the real `AdsClient` / `AdsLibrariesClient` by a `fetch`
 * stand-in, so every parse and every request shape is the product's own.
 *
 * Layout under `<root>/messy/` (all read-only for the intake):
 *   zotero/Thesis/Thesis.bib + files/…   a Zotero "export collection" (BibTeX, Export Files ticked): native `file` fields
 *   downloads/*.pdf                      loose PDFs: identifiable, unidentifiable, over the page limit, same paper twice
 *   overleaf/thesis-source.zip           Overleaf "Download Source": main.tex, refs.bib (one cited key has no entry)
 *   notes/TODO.md                        the plan, with a task that has no deadline
 *   server-copy/papers, results          what the "server" holds; the test copies papers/ with local rsync
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { crc32 } from "node:zlib";

// ---- the catalog --------------------------------------------------------------------------------------- //

export interface CatalogPaper {
  bibcode: string;
  title: string;
  authors: string[];
  year: number;
  pub: string;
  doi?: string;
  eprint?: string;
  /** the Work id the Library gives it when it is created from this record */
  workId: string;
}

/** Everything the fictional ADS knows. A bibcode, DOI or arXiv id that is not here is "not on ADS". */
export const CATALOG: Record<string, CatalogPaper> = {
  A: {
    bibcode: "2020MNRAS.499.1001A",
    title: "Dust settling in synthetic discs",
    authors: ["Smith, John", "Weber, Anna"],
    year: 2020,
    pub: "Monthly Notices of the Royal Astronomical Society",
    doi: "10.5555/smith.a1",
    workId: "doi:10.5555/smith.a1",
  },
  X: {
    bibcode: "2019ApJ...880...10X",
    title: "A benchmark for gas flow",
    authors: ["Xavier, Maria"],
    year: 2019,
    pub: "The Astrophysical Journal",
    doi: "10.5555/xavier.x1",
    workId: "doi:10.5555/xavier.x1",
  },
  Y: {
    bibcode: "2021arXiv210100002Y",
    title: "Gas flow benchmarks revisited",
    authors: ["Yu, Lin"],
    year: 2021,
    pub: "arXiv e-prints",
    eprint: "2101.00002",
    workId: "arxiv:2101.00002",
  },
  C: {
    bibcode: "2022A&A...650A...3C",
    title: "Cold cores in synthetic clouds",
    authors: ["Chen, Wei"],
    year: 2022,
    pub: "Astronomy and Astrophysics",
    doi: "10.5555/chen.c3",
    eprint: "2208.00033",
    workId: "doi:10.5555/chen.c3",
  },
  // carries the DOI of X and the arXiv id of Y: it would merge the two Works already in the library
  M: {
    bibcode: "2023MNRAS.521.0007M",
    title: "A bridge between two benchmarks",
    authors: ["Moreau, Luc"],
    year: 2023,
    pub: "Monthly Notices of the Royal Astronomical Society",
    doi: "10.5555/xavier.x1",
    eprint: "2101.00002",
    workId: "doi:10.5555/xavier.x1",
  },
  N: {
    bibcode: "2023ApJ...950..100N",
    title: "A fresh look at nothing",
    authors: ["Nova, Ines"],
    year: 2023,
    pub: "The Astrophysical Journal",
    doi: "10.5555/nova.n1",
    workId: "doi:10.5555/nova.n1",
  },
  // the loose arXiv PDF 2108.01234v2.pdf
  T: {
    bibcode: "2021arXiv210801234T",
    title: "Radiative transfer in toy atmospheres",
    authors: ["Tanaka, Ken"],
    year: 2021,
    pub: "arXiv e-prints",
    eprint: "2108.01234",
    workId: "arxiv:2108.01234",
  },
  // scan_0042.pdf: only its DOI identifies it
  O: {
    bibcode: "2022ApJ...930...55O",
    title: "Opacity tables for the lazy",
    authors: ["Ortiz, Rosa"],
    year: 2022,
    pub: "The Astrophysical Journal",
    doi: "10.5555/ortiz.o5",
    workId: "doi:10.5555/ortiz.o5",
  },
  // huge.pdf (over the page limit) and the copy fetched from the "server"
  H: {
    bibcode: "2018MNRAS.480..900H",
    title: "Handbook of everything, volume one",
    authors: ["Hale, Tom"],
    year: 2018,
    pub: "Monthly Notices of the Royal Astronomical Society",
    doi: "10.5555/huge.h1",
    workId: "doi:10.5555/huge.h1",
  },
  // the DOI in the reference list of trap.pdf: ADS resolves it, so importing it creates a Work nobody asked for
  R: {
    bibcode: "2017PASP..129..100R",
    title: "A survey of cold gas",
    authors: ["Reyes, Dana"],
    year: 2017,
    pub: "Publications of the Astronomical Society of the Pacific",
    doi: "10.5555/refd.r1",
    workId: "doi:10.5555/refd.r1",
  },
  S: {
    bibcode: "2020A&A...640A..11S",
    title: "Cluster runs on the lab machine",
    authors: ["Sato, Aya"],
    year: 2020,
    pub: "Astronomy and Astrophysics",
    doi: "10.5555/lab.s1",
    workId: "doi:10.5555/lab.s1",
  },
};

/** A bibcode ADS lists in a library but cannot export (a stale entry). */
export const STALE_BIBCODE = "2023MNRAS.520.9999G";
export const LIBRARIES = [
  {
    id: "lib_thesis-1",
    name: "Thesis refs",
    bibcodes: ["A", "X", "Y", "C"],
    extra: [STALE_BIBCODE],
  },
  { id: "lib_misc-2", name: "Misc", bibcodes: ["M", "N"], extra: [] as string[] },
];
export const ADS_TOKEN = "SYNTHETIC-ADS-TOKEN";

const bibtexOf = (p: CatalogPaper) =>
  [
    `@ARTICLE{${p.bibcode},`,
    `  author = {${p.authors.map((a) => `{${a.split(",")[0]}}, ${a.split(", ")[1] ?? ""}`).join(" and ")}},`,
    `  title = "{${p.title}}",`,
    `  journal = {${p.pub}},`,
    `  year = ${p.year},`,
    p.doi ? `  doi = {${p.doi}},` : "",
    p.eprint ? `  eprint = {${p.eprint}},\n  archivePrefix = {arXiv},` : "",
    "}",
  ]
    .filter((l) => l !== "")
    .join("\n");

export interface AdsStub {
  fetchImpl: typeof fetch;
  /** every request the stand-in answered: method, path and the part of the query that identifies it */
  requests: { method: string; path: string; detail: string }[];
}

/** The offline ADS: search (`/search/query`), export (`/export/bibtex`) and biblib (`/biblib/libraries…`). */
export function adsStub(libraries: typeof LIBRARIES = LIBRARIES): AdsStub {
  const requests: AdsStub["requests"] = [];
  const all = Object.values(CATALOG);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (
    input: unknown,
    init?: { method?: string; body?: string; headers?: Record<string, string> }
  ) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (auth !== `Bearer ${ADS_TOKEN}`) return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/v1/search/query") {
      const q = url.searchParams.get("q") ?? "";
      requests.push({ method, path: url.pathname, detail: q });
      const doi = /^doi:(.+)$/.exec(q)?.[1];
      const arxiv = /^arxiv:(.+)$/.exec(q)?.[1];
      const hit = all.find((p) => (doi && p.doi === doi) || (arxiv && p.eprint === arxiv));
      return json({
        response: {
          docs: hit
            ? [
                {
                  bibcode: hit.bibcode,
                  title: [hit.title],
                  author: hit.authors,
                  year: String(hit.year),
                  pub: hit.pub,
                  ...(hit.doi ? { doi: [hit.doi] } : {}),
                  citation_count: 3,
                  reference: [],
                },
              ]
            : [],
        },
      });
    }
    if (url.pathname === "/v1/export/bibtex") {
      const codes = (JSON.parse(String(init?.body)) as { bibcode: string[] }).bibcode;
      requests.push({ method, path: url.pathname, detail: codes.join(" ") });
      const text = all
        .filter((p) => codes.includes(p.bibcode))
        .map(bibtexOf)
        .join("\n\n");
      return json({ export: text });
    }
    if (url.pathname === "/v1/biblib/libraries") {
      requests.push({ method, path: url.pathname, detail: "" });
      return json({
        count: libraries.length,
        libraries: libraries.map((l) => ({
          id: l.id,
          name: l.name,
          description: "",
          num_documents: l.bibcodes.length + l.extra.length,
          permission: "owner",
          public: false,
          owner: "synthetic",
        })),
      });
    }
    const lib = libraries.find((l) => url.pathname === `/v1/biblib/libraries/${l.id}`);
    if (lib) {
      const start = Number(url.searchParams.get("start") ?? 0);
      const rows = Math.min(Number(url.searchParams.get("rows") ?? 100), 100);
      requests.push({ method, path: url.pathname, detail: `start=${start} rows=${rows}` });
      // alphabetical, like biblib's raw window
      const codes = [
        ...lib.bibcodes.map((k) => (CATALOG[k] as CatalogPaper).bibcode),
        ...lib.extra,
      ].sort();
      return json({
        documents: codes.slice(start, start + rows),
        metadata: { name: lib.name, num_documents: codes.length },
      });
    }
    requests.push({ method, path: url.pathname, detail: "unknown" });
    return new Response("", { status: 410 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

// ---- PDFs: one text layer, nothing else ---------------------------------------------------------------- //

const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

/** A PDF whose pages carry the given lines of text (Helvetica, 11 pt). A page with no lines has no text layer. */
export function textPdf(pages: string[][]): Buffer {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) && objects.length;
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids: number[] = [];
  for (const lines of pages) {
    const body = lines
      .map((l, i) => `BT /F1 11 Tf 40 ${760 - i * 16} Td (${esc(l)}) Tj ET`)
      .join("\n");
    const content = add(
      `<< /Length ${Buffer.byteLength(body, "latin1")} >>\nstream\n${body}\nendstream`
    );
    kids.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`
      )
    );
  }
  objects[1] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const paper = (title: string, authors: string, ids: string[], extra: string[] = []) =>
  textPdf([[title, authors, "Synthetic first page, no real text.", ...ids, ...extra]]);

// ---- a real zip with correct CRCs ---------------------------------------------------------------------- //

/** A stored zip that `unzip` accepts (makeZip in helpers.ts zeroes the CRCs, which `unzip -p` reports). */
export function zipOf(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const count = Object.keys(entries).length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// ---- the folders --------------------------------------------------------------------------------------- //

export interface Messy {
  root: string;
  zoteroBib: string;
  zoteroDir: string;
  downloads: string;
  zip: string;
  todo: string;
  serverPapers: string;
  serverResults: string;
  overleafLink: string;
  /** the byte-identical pair: the Zotero attachment and its copy among the loose PDFs */
  smithPdf: Buffer;
}

const PAST = new Date("2025-03-04T05:06:07Z");

const SMITH = (variant = "") =>
  paper(
    "Dust settling in synthetic discs",
    "J. Smith, A. Weber",
    ["DOI: 10.5555/smith.a1"],
    variant ? [variant] : []
  );

export const OVERLEAF_LINK = "https://www.overleaf.com/project/0123456789abcdef01234567";

export function buildMessy(root: string): Messy {
  const messy = join(root, "messy");
  const put = (rel: string, data: string | Buffer) => {
    const path = join(messy, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, data);
    return path;
  };
  const smithPdf = SMITH();
  // Zotero: "Export Collection…", BibTeX, "Export Files" ticked. The `file` field is Zotero's own form,
  // `description:path:mime`, several attachments separated by `;`, paths relative to the .bib.
  const zoteroBib = put(
    "zotero/Thesis/Thesis.bib",
    [
      '@string{mnras = "Monthly Notices of the Royal Astronomical Society"}',
      "",
      "@article{smith2020,",
      "  title = {Dust settling in synthetic discs},",
      "  author = {Smith, John and Weber, Anna},",
      "  journal = mnras,",
      "  year = {2020},",
      "  doi = {10.5555/smith.a1},",
      "  file = {Full Text PDF:files/101/Smith 2020.pdf:application/pdf}",
      "}",
      "",
      "@article{lee2019,",
      "  title = {Magnetic braking in young stars},",
      "  author = {Lee, Sung},",
      "  journal = mnras,",
      "  year = {2019},",
      "  doi = {10.5555/lee.l1},",
      "  file = {Snapshot:files/102/index.html:text/html;Full Text PDF:files/102/Lee 2019.pdf:application/pdf}",
      "}",
      "",
      "@article{rossi2022,",
      "  title = {Photometric redshifts at scale},",
      "  author = {Rossi, Paolo},",
      "  journal = mnras,",
      "  year = {2022},",
      "  doi = {10.5555/rossi.r1}",
      "}",
      "",
      "@article{park2021,",
      "  title = {Weak lensing with synthetic shear},",
      "  author = {Park, Joon},",
      "  year = {2021},",
      "  eprint = {2105.04321},",
      "  archivePrefix = {arXiv}",
      "}",
      "",
      "@article{bridge2023,",
      "  title = {A bridge between two benchmarks (preprint)},",
      "  author = {Moreau, Luc},",
      "  year = {2023},",
      "  doi = {10.5555/xavier.x1},",
      "  eprint = {2101.00002},",
      "  archivePrefix = {arXiv}",
      "}",
      "",
    ].join("\n")
  );
  put("zotero/Thesis/files/101/Smith 2020.pdf", smithPdf);
  put(
    "zotero/Thesis/files/102/Lee 2019.pdf",
    paper("Magnetic braking in young stars", "S. Lee", ["DOI: 10.5555/lee.l1"])
  );
  put("zotero/Thesis/files/102/index.html", "<html><body>snapshot</body></html>\n");

  // loose PDFs
  put(
    "downloads/2108.01234v2.pdf",
    paper("Radiative transfer in toy atmospheres", "K. Tanaka", ["arXiv:2108.01234v2 [astro-ph]"])
  );
  put(
    "downloads/scan_0042.pdf",
    paper("Opacity tables for the lazy", "R. Ortiz", [
      "Published in ApJ 930, 55",
      "DOI: 10.5555/ortiz.o5",
    ])
  );
  put(
    "downloads/Rossi_final_v3.pdf",
    paper("Photometric redshifts at scale", "P. Rossi", ["doi:10.5555/rossi.r1"])
  );
  put("downloads/Smith2020_copy.pdf", smithPdf); // the same bytes as the Zotero attachment
  put("downloads/Smith_preprint.pdf", SMITH("Preprint version, not the published text."));
  put(
    "downloads/trap.pdf",
    paper(
      "Notes on cold gas",
      "unpublished",
      ["Internal memo, no identifier."],
      ["References", "[1] D. Reyes, doi:10.5555/refd.r1"]
    )
  );
  put(
    "downloads/notes_scan.pdf",
    paper("A note on tidal tails", "H. Kowalski, B. Berg", [
      "Proceedings of the Synthetic Conference, 2018",
    ])
  );
  put("downloads/blank.pdf", textPdf([[]]));
  put(
    "downloads/huge.pdf",
    textPdf([
      ["Handbook of everything, volume one", "T. Hale", ["DOI: 10.5555/huge.h1"]].flat(),
      ...Array.from({ length: 100 }, (_, i) => [`page ${i + 2}`]),
    ])
  );

  // Overleaf "Download Source"
  const zip = put(
    "overleaf/thesis-source.zip",
    zipOf({
      "main.tex": [
        "\\documentclass{article}",
        "\\begin{document}",
        "Dust \\cite{smith2020,lee2019} and the new result \\citep{newkey, ghost2022}.",
        "\\bibliography{refs}",
        "\\end{document}",
        "",
      ].join("\n"),
      "refs.bib": [
        "@article{smith2020,",
        "  title = {Dust settling in synthetic discs},",
        "  author = {Smith, John and Weber, Anna},",
        "  year = {2020},",
        "  doi = {10.5555/smith.a1}",
        "}",
        "",
        "@article{lee2019,",
        "  title = {Magnetic braking in young stars},",
        "  author = {Lee, Sung},",
        "  year = {2019},",
        "  doi = {10.5555/lee.l1}",
        "}",
        "",
        "@article{newkey,",
        "  title = {A key only the thesis uses},",
        "  author = {Keller, Uma},",
        "  year = {2024},",
        "  doi = {10.5555/new.k1}",
        "}",
        "",
      ].join("\n"),
    })
  );

  const todo = put(
    "notes/TODO.md",
    [
      "# Thesis TODO",
      "",
      "Thesis: submit by 2027-03-31.",
      "",
      "- Draft chapter 3 (dust settling) by 2026-12-01; builds on Smith 2020.",
      "- Re-run the gas flow benchmark on the cluster (no date yet).",
      "",
    ].join("\n")
  );

  // what the "server" holds: only papers/ is to be copied, results/ is only recorded
  const serverPapers = join(messy, "server-copy", "papers");
  put(
    "server-copy/papers/cluster_run.pdf",
    paper("Cluster runs on the lab machine", "A. Sato", ["DOI: 10.5555/lab.s1"])
  );
  put("server-copy/results/big.dat", "0 1 2 3\n");

  // pin every mtime, so "unchanged" has a meaning
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      utimesSync(full, PAST, PAST);
      if (statSync(full).isDirectory()) walk(full);
    }
  };
  walk(messy);
  utimesSync(messy, PAST, PAST);
  return {
    root: messy,
    zoteroBib,
    zoteroDir: join(messy, "zotero", "Thesis"),
    downloads: join(messy, "downloads"),
    zip,
    todo,
    serverPapers,
    serverResults: join(messy, "server-copy", "results"),
    overleafLink: OVERLEAF_LINK,
    smithPdf,
  };
}

// ---- "unchanged" --------------------------------------------------------------------------------------- //

/** Every file and folder under a root: relative path, kind, size, content hash (files) and mtime (both). */
export function snapshotTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const stat = statSync(full);
      const rel = relative(root, full);
      if (stat.isDirectory()) {
        out.push(`${rel}/ mtime=${stat.mtimeMs}`);
        walk(full);
      } else {
        const sha = createHash("sha256").update(readFileSync(full)).digest("hex").slice(0, 16);
        out.push(`${rel} ${stat.size} ${sha} mtime=${stat.mtimeMs}`);
      }
    }
  };
  walk(root);
  return out;
}

/** Every path under a root (files and folders), relative, sorted. */
export function pathsUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      out.push(relative(root, full));
      if (statSync(full).isDirectory()) walk(full);
    }
  };
  walk(root);
  return out;
}
