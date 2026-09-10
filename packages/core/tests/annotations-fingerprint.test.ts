/**
 * Stage 8 MS1 — the canonical annotation text rules (locked here per roadmap
 * §1), the content fingerprint (§3: canonical projection + asset hashing +
 * exclusions), and the `ensureCurrentAnnotations` tri-state/archive
 * semantics (§3/§4).
 *
 * IR fixtures are real zod-typed `DocIr`/`TexDocIr` objects built inline;
 * `ensureCurrentAnnotations` reads the stored IR from tmp doc dirs.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AnnotationsFile,
  DocIr,
  IrBlock,
  IrCiteRef,
  IrCiteSegment,
  IrMathSegment,
  IrSection,
  IrTextSegment,
  IrXrefSegment,
  IrXrefTarget,
  TexDocIr,
} from "@argelanderspace/contracts";
import {
  canonicalContainerText,
  canonicalSegmentsText,
  canonicalSegmentText,
} from "@argelanderspace/contracts";
import { describe, expect, it } from "vitest";
import {
  AnnotationsError,
  annotationsArchiveDir,
  annotationsCurrentPath,
  docContentFingerprint,
  docContentProjection,
  ensureCurrentAnnotations,
  saveAnnotationsFile,
} from "../src/annotations/store.js";

const DOC = "arxiv-2501.17225";

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "annotations-fp-"));
}

// --------------------------------------------------------------------------- //
// Segment fixtures
// --------------------------------------------------------------------------- //

const txt = (text: string): IrTextSegment => ({ type: "text", text });
const math = (latex: string): IrMathSegment => ({ type: "math", latex });
const cite = (refs: IrCiteRef[], raw?: string): IrCiteSegment => ({
  type: "cite",
  refs,
  ...(raw === undefined ? {} : { raw }),
});
const xref = (target: Partial<IrXrefTarget> & { id: string }, raw?: string): IrXrefSegment => ({
  type: "xref",
  target: { resolved: true, ...target },
  ...(raw === undefined ? {} : { raw }),
});

// --------------------------------------------------------------------------- //
// Canonical annotation text (roadmap §1 rules, pinned to segments.tsx)
// --------------------------------------------------------------------------- //

describe("canonicalSegmentText", () => {
  it("text segments pass through as-is", () => {
    expect(canonicalSegmentText(txt("plain 文字 — untouched"))).toBe("plain 文字 — untouched");
    expect(canonicalSegmentText(txt(""))).toBe("");
  });

  it("math segments canonicalize to $…$ (atomic; never KaTeX internals)", () => {
    expect(canonicalSegmentText(math("E=mc^2"))).toBe("$E=mc^2$");
  });

  it("cite with raw → the raw string verbatim (single ref)", () => {
    const seg = cite(
      [{ id: "ref-1", resolved: true, short: "Hunt & Reffert 2021" }],
      "(Hunt & Reffert 2021)"
    );
    expect(canonicalSegmentText(seg)).toBe("(Hunt & Reffert 2021)");
  });

  it("cite with raw → verbatim for multi-ref groups (wrapper + '; ' reconstruct raw)", () => {
    // Stage 6 per-ref chips: open + parts.join("; ") + close === raw
    const seg = cite(
      [
        { id: "ref-1", resolved: true, short: "Bok 1934" },
        { id: "ref-2", resolved: true, short: "van Albada 1940" },
      ],
      "(Bok 1934; van Albada 1940)"
    );
    expect(canonicalSegmentText(seg)).toBe("(Bok 1934; van Albada 1940)");
  });

  it("cite with pathological raw (won't split into the ref count) → still verbatim", () => {
    const seg = cite(
      [
        { id: "ref-1", resolved: true, short: "A 1934" },
        { id: "ref-2", resolved: true, short: "B 1940" },
      ],
      "see (A 1934; B 1940) and friends"
    );
    expect(canonicalSegmentText(seg)).toBe("see (A 1934; B 1940) and friends");
  });

  it("cite without raw → per-ref short labels joined with '; '", () => {
    const seg = cite([
      { id: "ref-1", resolved: true, short: "Bok 1934" },
      { id: "ref-2", resolved: true, short: "van Albada 1940" },
    ]);
    expect(canonicalSegmentText(seg)).toBe("Bok 1934; van Albada 1940");
  });

  it("cite without raw → unresolved refs fall back to their id", () => {
    expect(
      canonicalSegmentText(cite([{ id: "ref-9", resolved: false, short: "Ghost 1999" }]))
    ).toBe("ref-9");
    expect(canonicalSegmentText(cite([{ id: "?", resolved: false }]))).toBe("?");
  });

  it('cite with neither raw nor refs → "?" (the reader\'s unresolved label)', () => {
    expect(canonicalSegmentText(cite([]))).toBe("?");
    // an empty-string raw is falsy and falls through, like the reader's `||`
    expect(canonicalSegmentText(cite([], ""))).toBe("?");
  });

  it("xref with raw → the raw string verbatim", () => {
    const seg = xref({ id: "fig-2", targetType: "figure", number: "2" }, "Fig.~\\ref{fig:rar}");
    expect(canonicalSegmentText(seg)).toBe("Fig.~\\ref{fig:rar}");
  });

  it("xref without raw → prettified 'Kind number' for every target type", () => {
    const cases: [IrXrefTarget["targetType"], string, string][] = [
      ["equation", "3", "Eq. 3"],
      ["figure", "2", "Fig. 2"],
      ["table", "1", "Table 1"],
      ["section", "2", "Sec. 2"],
      ["algorithm", "1", "Alg. 1"],
      ["code", "4", "Listing 4"],
    ];
    for (const [targetType, number, want] of cases) {
      expect(canonicalSegmentText(xref({ id: "x-1", targetType, number }))).toBe(want);
    }
  });

  it("xref without raw → target id when number or targetType is missing", () => {
    expect(canonicalSegmentText(xref({ id: "fig-2", targetType: "figure" }))).toBe("fig-2");
    expect(canonicalSegmentText(xref({ id: "?", resolved: false }))).toBe("?");
  });
});

describe("canonicalSegmentsText", () => {
  it("concatenates the run without separators", () => {
    const segs = [
      txt("The result "),
      math("x^2"),
      txt(" follows from "),
      cite([{ id: "ref-1", resolved: true, short: "Bok 1934" }], "(Bok 1934)"),
      txt("."),
    ];
    expect(canonicalSegmentsText(segs)).toBe("The result $x^2$ follows from (Bok 1934).");
  });
});

describe("canonicalContainerText", () => {
  const para: IrBlock = {
    id: "p-1",
    type: "paragraph",
    segments: [txt("body "), math("a"), cite([{ id: "ref-1", resolved: true, short: "B 1934" }])],
  };
  const list: IrBlock = {
    id: "list-1",
    type: "list",
    ordered: false,
    items: [{ segments: [txt("first")] }, { segments: [txt("second "), math("b")] }],
  };
  const figure: IrBlock = {
    id: "fig-1",
    type: "figure",
    captionSegments: [txt("The "), xref({ id: "eq-1", targetType: "equation", number: "1" })],
  };
  const noCaptionFigure: IrBlock = { id: "fig-2", type: "figure" };
  const equation: IrBlock = { id: "eq-1", type: "equation", latex: "E=mc^2" };

  it("paragraph content → the canonical segment run", () => {
    expect(canonicalContainerText(para, { type: "content" })).toBe("body $a$B 1934");
  });

  it("list_item resolves by index", () => {
    expect(canonicalContainerText(list, { type: "list_item", index: 0 })).toBe("first");
    expect(canonicalContainerText(list, { type: "list_item", index: 1 })).toBe("second $b$");
  });

  it("caption resolves on figure/table/code/algorithm blocks", () => {
    expect(canonicalContainerText(figure, { type: "caption" })).toBe("The Eq. 1");
    const table: IrBlock = { id: "tab-1", type: "table", captionSegments: [txt("t")] };
    const code: IrBlock = { id: "code-1", type: "code", captionSegments: [txt("c")] };
    const alg: IrBlock = { id: "alg-1", type: "algorithm", captionSegments: [txt("a")] };
    expect(canonicalContainerText(table, { type: "caption" })).toBe("t");
    expect(canonicalContainerText(code, { type: "caption" })).toBe("c");
    expect(canonicalContainerText(alg, { type: "caption" })).toBe("a");
  });

  it("throws (never a silent wrong answer) when the container doesn't exist", () => {
    // content on a non-paragraph
    expect(() => canonicalContainerText(figure, { type: "content" })).toThrowError(
      /no content container/
    );
    // list_item on a non-list / out of range
    expect(() => canonicalContainerText(para, { type: "list_item", index: 0 })).toThrowError(
      /no list items/
    );
    expect(() => canonicalContainerText(list, { type: "list_item", index: 2 })).toThrowError(
      /out of range/
    );
    // caption on blocks without captions
    expect(() => canonicalContainerText(para, { type: "caption" })).toThrowError(
      /no caption container/
    );
    expect(() => canonicalContainerText(equation, { type: "caption" })).toThrowError(
      /no caption container/
    );
    expect(() => canonicalContainerText(noCaptionFigure, { type: "caption" })).toThrowError(
      /has no caption/
    );
  });
});

// --------------------------------------------------------------------------- //
// Content fingerprint (roadmap §3)
// --------------------------------------------------------------------------- //

function mkDocIr(sections: IrSection[], overrides: Partial<DocIr> = {}): DocIr {
  return {
    docId: DOC,
    sections,
    refsManifest: [],
    bib: [],
    citationsByBlock: {},
    ...overrides,
  };
}

function mkSection(blocks: IrBlock[], overrides: Partial<IrSection> = {}): IrSection {
  return {
    id: "sec-1",
    level: 1,
    number: "1",
    heading: "Introduction",
    blocks,
    children: [],
    ...overrides,
  };
}

const BASE_BLOCKS: IrBlock[] = [
  { id: "p-1", type: "paragraph", segments: [txt("Hello "), math("x")] },
  { id: "eq-1", type: "equation", number: "1", label: "eq:x", latex: "x=1" },
  {
    id: "list-1",
    type: "list",
    ordered: true,
    items: [{ segments: [txt("item one")] }, { segments: [txt("item two")] }],
  },
  {
    id: "code-1",
    type: "code",
    number: "1",
    captionSegments: [txt("cap")],
    lang: "python",
    body: "print()",
  },
  { id: "alg-1", type: "algorithm", captionSegments: [txt("alg cap")], body: "steps" },
  {
    id: "tab-1",
    type: "table",
    number: "1",
    captionSegments: [txt("tab cap")],
    footnote: "note",
    tableBody: "<tr><td>1</td></tr>",
  },
];

describe("docContentFingerprint", () => {
  it("is deterministic for identical content", () => {
    const docDir = tmpDataDir();
    const ir = mkDocIr([mkSection(structuredClone(BASE_BLOCKS))]);
    expect(docContentFingerprint(ir, { docDir })).toBe(
      docContentFingerprint(mkDocIr([mkSection(structuredClone(BASE_BLOCKS))]), { docDir })
    );
    expect(docContentFingerprint(ir, { docDir })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("detects the block-id cascade: removing/adding a paragraph shifts every later id", () => {
    const docDir = tmpDataDir();
    const fp = (blocks: IrBlock[]) =>
      docContentFingerprint(mkDocIr([mkSection(blocks)]), { docDir });
    const full = fp(structuredClone(BASE_BLOCKS));
    expect(fp(structuredClone(BASE_BLOCKS).slice(1))).not.toBe(full); // removed p-1
    expect(
      fp([...structuredClone(BASE_BLOCKS), { id: "p-9", type: "paragraph", segments: [txt("x")] }])
    ).not.toBe(full);
    // content change with ids stable
    const edited = structuredClone(BASE_BLOCKS);
    edited[0] = { id: "p-1", type: "paragraph", segments: [txt("Hello!")] };
    expect(fp(edited)).not.toBe(full);
    // list item boundary change
    const listEdited = structuredClone(BASE_BLOCKS);
    listEdited[2] = {
      id: "list-1",
      type: "list",
      ordered: true,
      items: [
        { segments: [txt("item one")] },
        { segments: [txt("item two")] },
        { segments: [txt("item three")] },
      ],
    };
    expect(fp(listEdited)).not.toBe(full);
    // ordered flag flip
    const orderEdited = structuredClone(BASE_BLOCKS);
    orderEdited[2] = {
      id: "list-1",
      type: "list",
      ordered: false,
      items: [{ segments: [txt("item one")] }, { segments: [txt("item two")] }],
    };
    expect(fp(orderEdited)).not.toBe(full);
  });

  it("includes section id/level/number/heading (heading lives inside the addressable tree)", () => {
    const docDir = tmpDataDir();
    const base = mkDocIr([mkSection(structuredClone(BASE_BLOCKS))]);
    const fp = docContentFingerprint(base, { docDir });
    expect(
      docContentFingerprint(mkDocIr([mkSection([], { heading: "Retitled" })]), { docDir })
    ).not.toBe(docContentFingerprint(mkDocIr([mkSection([])]), { docDir }));
    for (const patch of [
      { heading: "Retitled" },
      { number: "2" },
      { level: 2 },
      { number: undefined },
    ] as const) {
      const mutated = mkDocIr([mkSection(structuredClone(BASE_BLOCKS), patch)]);
      expect(docContentFingerprint(mutated, { docDir })).not.toBe(fp);
    }
  });

  it("excludes title/nPages/refsManifest/bib/references/citationsByBlock (provenance ≠ content)", () => {
    const docDir = tmpDataDir();
    const base = mkDocIr([mkSection(structuredClone(BASE_BLOCKS))]);
    const fp = docContentFingerprint(base, { docDir });
    const mutated = mkDocIr([mkSection(structuredClone(BASE_BLOCKS))], {
      title: "A Completely Different Title",
      nPages: 42,
      refsManifest: [
        {
          id: "fig-1",
          kind: "figure",
          number: "1",
          content: "cap",
          short: "cap",
          section: "1:Introduction",
        },
      ],
      bib: [{ id: "ref-1", short: "Bok 1934", raw: "Bok, B. 1934" }],
      references: [{ id: "ref-1", raw: "Bok, B. 1934", title: "T" }],
      citationsByBlock: { "p-1": ["ref-1"] },
    });
    expect(docContentFingerprint(mutated, { docDir })).toBe(fp);
  });

  it("excludes display facts (imgWidth/imgHeight, chartType/content) from figures", () => {
    const docDir = tmpDataDir();
    const fig: IrBlock = { id: "fig-1", type: "figure", captionSegments: [txt("cap")] };
    const fp = docContentFingerprint(mkDocIr([mkSection([fig])]), { docDir });
    const dressed: IrBlock = {
      id: "fig-1",
      type: "figure",
      captionSegments: [txt("cap")],
      imgWidth: 800,
      imgHeight: 600,
      chartType: "line",
      content: "chart data",
    };
    expect(docContentFingerprint(mkDocIr([mkSection([dressed])]), { docDir })).toBe(fp);
  });

  it("projects in document order (section → blocks → children)", () => {
    const docDir = tmpDataDir();
    const ir = mkDocIr([
      mkSection([{ id: "p-1", type: "paragraph", segments: [txt("a")] }], {
        children: [
          mkSection([{ id: "p-2", type: "paragraph", segments: [txt("b")] }], {
            id: "sec-1-1",
            level: 2,
            number: "1.1",
            heading: "Sub",
          }),
        ],
      }),
    ]);
    expect(docContentProjection(ir, { docDir })).toEqual([
      ["section", "sec-1", 1, "1", "Introduction"],
      ["paragraph", "p-1", "a"],
      ["section", "sec-1-1", 2, "1.1", "Sub"],
      ["paragraph", "p-2", "b"],
    ]);
  });
});

describe("docContentFingerprint: figure/table assets", () => {
  it("a figure without imgPath is a normal no-asset case (explicit null token)", () => {
    const docDir = tmpDataDir();
    const ir = mkDocIr([mkSection([{ id: "fig-1", type: "figure", captionSegments: [txt("c")] }])]);
    const projection = docContentProjection(ir, { docDir });
    expect(projection[1]).toEqual(["figure", "fig-1", null, null, "c", null, null]);
  });

  it("hashes the asset bytes of a bare imgPath from <docDir>/assets/ (server /images rule)", () => {
    const docDir = tmpDataDir();
    mkdirSync(join(docDir, "assets"), { recursive: true });
    writeFileSync(join(docDir, "assets", "plot__pdf.svg"), "<svg>v1</svg>");
    const fig: IrBlock = { id: "fig-1", type: "figure", imgPath: "plot__pdf.svg" };
    const ir = mkDocIr([mkSection([fig])]);
    const hash = createHash("sha256").update("<svg>v1</svg>").digest("hex");
    expect(docContentProjection(ir, { docDir })[1]).toEqual([
      "figure",
      "fig-1",
      null,
      null,
      null,
      null,
      hash,
    ]);
    // changing the bytes changes the fingerprint
    const withV1 = docContentFingerprint(ir, { docDir });
    writeFileSync(join(docDir, "assets", "plot__pdf.svg"), "<svg>v2</svg>");
    expect(docContentFingerprint(ir, { docDir })).not.toBe(withV1);
  });

  it("resolves a subdirectory-carrying imgPath doc-dir relative (verbatim rule)", () => {
    const docDir = tmpDataDir();
    mkdirSync(join(docDir, "assets", "sub"), { recursive: true });
    writeFileSync(join(docDir, "assets", "sub", "fig.svg"), "<svg/>");
    const fig: IrBlock = { id: "fig-1", type: "figure", imgPath: "assets/sub/fig.svg" };
    const hash = createHash("sha256").update("<svg/>").digest("hex");
    expect(docContentProjection(mkDocIr([mkSection([fig])]), { docDir })[1]).toEqual([
      "figure",
      "fig-1",
      null,
      null,
      null,
      null,
      hash,
    ]);
  });

  it("throws a typed fingerprint error when a referenced asset is missing", () => {
    const docDir = tmpDataDir();
    const ir = mkDocIr([mkSection([{ id: "fig-1", type: "figure", imgPath: "gone.svg" }])]);
    let err: unknown;
    try {
      docContentFingerprint(ir, { docDir });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AnnotationsError);
    expect((err as AnnotationsError).code).toBe("fingerprint");
    expect((err as AnnotationsError).message).toContain("gone.svg");
  });
});

// --------------------------------------------------------------------------- //
// ensureCurrentAnnotations (roadmap §3 tri-state + §4 archive semantics)
// --------------------------------------------------------------------------- //

function mkStoredIr(overrides: Partial<TexDocIr> = {}): TexDocIr {
  return {
    version: 1,
    docId: DOC,
    sections: [mkSection([{ id: "p-1", type: "paragraph", segments: [txt("Hello world")] }])],
    refsManifest: [],
    bib: [],
    citationsByBlock: {},
    source: { type: "latex", origin: "/tmp/src", main_tex: "main.tex" },
    meta: { title: "The Title" },
    ...overrides,
  };
}

/** Write the stored IR to `<dataDir>/output/<doc>/<doc>.json`; returns docDir. */
function writeDoc(dataDir: string, ir: unknown): string {
  const docDir = join(dataDir, "output", DOC);
  mkdirSync(docDir, { recursive: true });
  writeFileSync(join(docDir, `${DOC}.json`), typeof ir === "string" ? ir : JSON.stringify(ir));
  return docDir;
}

const FIXED_NOW = new Date("2026-09-10T12:34:56.789Z");
const OLD_FP = "f".repeat(64);

describe("ensureCurrentAnnotations", () => {
  it("doc missing → typed not_found, nothing created", () => {
    const dir = tmpDataDir();
    let err: unknown;
    try {
      ensureCurrentAnnotations(dir, DOC);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AnnotationsError);
    expect((err as AnnotationsError).code).toBe("not_found");
    expect(existsSync(annotationsCurrentPath(dir, DOC))).toBe(false);
  });

  it("corrupt / pre-migration / schema-invalid IR → typed corrupt_ir, annotations untouched", () => {
    const cases: { name: string; body: string }[] = [
      { name: "corrupt JSON", body: "{ not json" },
      { name: "pre-migration (no version)", body: JSON.stringify({ docId: DOC, sections: [] }) },
      { name: "schema-invalid", body: JSON.stringify({ ...mkStoredIr(), version: 2 }) },
    ];
    for (const { name, body } of cases) {
      const dir = tmpDataDir();
      writeDoc(dir, body);
      saveAnnotationsFile(dir, DOC, {
        version: 1,
        rev: 2,
        content_fingerprint: OLD_FP,
        annotations: [],
      });
      const before = readFileSync(annotationsCurrentPath(dir, DOC), "utf8");
      let err: unknown;
      try {
        ensureCurrentAnnotations(dir, DOC);
      } catch (e) {
        err = e;
      }
      expect(err, name).toBeInstanceOf(AnnotationsError);
      expect((err as AnnotationsError).code, name).toBe("corrupt_ir");
      expect(readFileSync(annotationsCurrentPath(dir, DOC), "utf8"), name).toBe(before);
      expect(existsSync(annotationsArchiveDir(dir, DOC)), name).toBe(false);
    }
  });

  it("fingerprint failure (referenced asset missing) → typed fingerprint error, annotations untouched", () => {
    const dir = tmpDataDir();
    const ir = mkStoredIr();
    ir.sections[0]?.blocks.push({ id: "fig-1", type: "figure", imgPath: "gone.svg" });
    const docDir = writeDoc(dir, ir);
    mkdirSync(join(docDir, "assets"), { recursive: true }); // dir exists, file does not
    saveAnnotationsFile(dir, DOC, {
      version: 1,
      rev: 0,
      content_fingerprint: OLD_FP,
      annotations: [],
    });
    const before = readFileSync(annotationsCurrentPath(dir, DOC), "utf8");
    let err: unknown;
    try {
      ensureCurrentAnnotations(dir, DOC);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AnnotationsError);
    expect((err as AnnotationsError).code).toBe("fingerprint");
    expect(readFileSync(annotationsCurrentPath(dir, DOC), "utf8")).toBe(before);
  });

  it("current.json missing → ephemeral empty file bound to the fresh fingerprint, NOT persisted", () => {
    const dir = tmpDataDir();
    const docDir = writeDoc(dir, mkStoredIr());
    const fresh = docContentFingerprint(mkStoredIr(), { docDir });
    const result = ensureCurrentAnnotations(dir, DOC);
    expect(result.invalidated).toBe(false);
    expect(result.file).toEqual({
      version: 1,
      rev: 0,
      content_fingerprint: fresh,
      annotations: [],
    });
    expect(existsSync(annotationsCurrentPath(dir, DOC))).toBe(false); // persist only on first PUT
  });

  it("crash recovery: archive/ exists but current.json is gone → ephemeral empty, no error", () => {
    const dir = tmpDataDir();
    writeDoc(dir, mkStoredIr());
    const archiveDir = annotationsArchiveDir(dir, DOC);
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, "20260901T000000000Z-ffffffff.json"), "{}");
    const result = ensureCurrentAnnotations(dir, DOC);
    expect(result.invalidated).toBe(false);
    expect(result.file.annotations).toEqual([]);
    expect(existsSync(annotationsCurrentPath(dir, DOC))).toBe(false);
  });

  it("corrupt current.json → typed corrupt_store (never silently reset)", () => {
    const dir = tmpDataDir();
    writeDoc(dir, mkStoredIr());
    saveAnnotationsFile(dir, DOC, {
      version: 1,
      rev: 0,
      content_fingerprint: OLD_FP,
      annotations: [],
    });
    writeFileSync(annotationsCurrentPath(dir, DOC), "{ broken");
    let err: unknown;
    try {
      ensureCurrentAnnotations(dir, DOC);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AnnotationsError);
    expect((err as AnnotationsError).code).toBe("corrupt_store");
  });

  it("fingerprint match → returns the file untouched, invalidated false", () => {
    const dir = tmpDataDir();
    const docDir = writeDoc(dir, mkStoredIr());
    const fresh = docContentFingerprint(mkStoredIr(), { docDir });
    saveAnnotationsFile(dir, DOC, {
      version: 1,
      rev: 7,
      content_fingerprint: fresh,
      annotations: [
        {
          id: "a_0123abcd",
          target: { type: "document" },
          body: "kept",
          created_at: "2026-09-10T10:00:00.000Z",
          updated_at: "2026-09-10T10:00:00.000Z",
        },
      ],
    });
    const before = readFileSync(annotationsCurrentPath(dir, DOC), "utf8");
    const result = ensureCurrentAnnotations(dir, DOC);
    expect(result.invalidated).toBe(false);
    expect(result.file.annotations).toHaveLength(1);
    expect(readFileSync(annotationsCurrentPath(dir, DOC), "utf8")).toBe(before); // no rewrite
    expect(existsSync(annotationsArchiveDir(dir, DOC))).toBe(false);
  });

  it("mismatch → archive old current verbatim, then write a new rev-0 epoch bound to the fresh fingerprint", () => {
    const dir = tmpDataDir();
    const docDir = writeDoc(dir, mkStoredIr());
    const fresh = docContentFingerprint(mkStoredIr(), { docDir });
    const old: AnnotationsFile = {
      version: 1,
      rev: 9,
      content_fingerprint: OLD_FP,
      annotations: [
        {
          id: "a_0123abcd",
          target: {
            type: "text",
            block: "p-1",
            container: { type: "content" },
            start: 0,
            end: 5,
            quote: "Hello",
          },
          body: "旧标注",
          created_at: "2026-09-01T08:00:00.000Z",
          updated_at: "2026-09-02T09:30:00.000Z",
        },
      ],
    };
    saveAnnotationsFile(dir, DOC, old);
    const result = ensureCurrentAnnotations(dir, DOC, { now: FIXED_NOW });
    expect(result.invalidated).toBe(true);
    expect(result.file).toEqual({
      version: 1,
      rev: 0,
      content_fingerprint: fresh,
      annotations: [],
    });
    // archive: exact name, old current verbatim
    const archives = readdirSync(annotationsArchiveDir(dir, DOC));
    expect(archives).toEqual(["20260910T123456789Z-ffffffff.json"]);
    expect(readFileSync(join(annotationsArchiveDir(dir, DOC), archives[0] as string), "utf8")).toBe(
      JSON.stringify(old, null, 2)
    );
    // the live current is the new epoch
    expect(JSON.parse(readFileSync(annotationsCurrentPath(dir, DOC), "utf8"))).toEqual(result.file);
  });

  it("archive is BYTE-verbatim: unknown keys an external editor added survive the round trip", () => {
    const dir = tmpDataDir();
    const docDir = writeDoc(dir, mkStoredIr());
    const fresh = docContentFingerprint(mkStoredIr(), { docDir });
    // hand-written current.json: valid per the schema, but compact-formatted
    // and carrying keys the schema doesn't know (zod strips them on parse) —
    // a re-serialized archive would lose both the formatting and the keys.
    const rawBytes =
      `{"version":1,"rev":5,"content_fingerprint":"${OLD_FP}",` +
      '"user_extra_key":{"note":"外部编辑器加的"},"annotations":[' +
      '{"id":"a_0123abcd","target":{"type":"document"},"body":"旧标注",' +
      '"created_at":"2026-09-01T08:00:00.000Z","updated_at":"2026-09-02T09:30:00.000Z",' +
      '"editor_pin":true}]}\n';
    mkdirSync(join(dir, "annotations", DOC), { recursive: true });
    writeFileSync(annotationsCurrentPath(dir, DOC), rawBytes, "utf8");
    const result = ensureCurrentAnnotations(dir, DOC, { now: FIXED_NOW });
    expect(result.invalidated).toBe(true);
    // the archive is byte-identical to the pre-archival file
    const archivePath = join(annotationsArchiveDir(dir, DOC), "20260910T123456789Z-ffffffff.json");
    expect(readFileSync(archivePath, "utf8")).toBe(rawBytes);
    const archived = JSON.parse(readFileSync(archivePath, "utf8")) as Record<string, unknown>;
    expect(archived.user_extra_key).toEqual({ note: "外部编辑器加的" });
    // …while the parsed value still drives the new empty epoch
    expect(result.file).toEqual({
      version: 1,
      rev: 0,
      content_fingerprint: fresh,
      annotations: [],
    });
  });

  it("archive name collisions get -2/-3 suffixes and never overwrite", () => {
    const dir = tmpDataDir();
    writeDoc(dir, mkStoredIr());
    saveAnnotationsFile(dir, DOC, {
      version: 1,
      rev: 1,
      content_fingerprint: OLD_FP,
      annotations: [],
    });
    const archiveDir = annotationsArchiveDir(dir, DOC);
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, "20260910T123456789Z-ffffffff.json"), "sentinel-1");
    writeFileSync(join(archiveDir, "20260910T123456789Z-ffffffff-2.json"), "sentinel-2");
    const result = ensureCurrentAnnotations(dir, DOC, { now: FIXED_NOW });
    expect(result.invalidated).toBe(true);
    const archives = readdirSync(archiveDir).sort();
    expect(archives).toEqual([
      "20260910T123456789Z-ffffffff-2.json",
      "20260910T123456789Z-ffffffff-3.json",
      "20260910T123456789Z-ffffffff.json",
    ]);
    expect(readFileSync(join(archiveDir, "20260910T123456789Z-ffffffff.json"), "utf8")).toBe(
      "sentinel-1"
    );
    expect(readFileSync(join(archiveDir, "20260910T123456789Z-ffffffff-2.json"), "utf8")).toBe(
      "sentinel-2"
    );
    expect(
      JSON.parse(readFileSync(join(archiveDir, "20260910T123456789Z-ffffffff-3.json"), "utf8"))
    ).toEqual({ version: 1, rev: 1, content_fingerprint: OLD_FP, annotations: [] });
  });

  it("archive-write failure → typed archive error, the old current stays byte-identical", () => {
    const dir = tmpDataDir();
    writeDoc(dir, mkStoredIr());
    const old = { version: 1 as const, rev: 3, content_fingerprint: OLD_FP, annotations: [] };
    saveAnnotationsFile(dir, DOC, old);
    // sabotage: `archive` exists as a FILE, so mkdir recursive fails
    mkdirSync(join(dir, "annotations", DOC), { recursive: true });
    writeFileSync(annotationsArchiveDir(dir, DOC), "not a dir");
    const before = readFileSync(annotationsCurrentPath(dir, DOC), "utf8");
    let err: unknown;
    try {
      ensureCurrentAnnotations(dir, DOC, { now: FIXED_NOW });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AnnotationsError);
    expect((err as AnnotationsError).code).toBe("archive");
    expect(readFileSync(annotationsCurrentPath(dir, DOC), "utf8")).toBe(before);
  });

  it("new-current write failure after a successful archive → throw; the next call recovers", () => {
    const dir = tmpDataDir();
    writeDoc(dir, mkStoredIr());
    const old = { version: 1 as const, rev: 4, content_fingerprint: OLD_FP, annotations: [] };
    saveAnnotationsFile(dir, DOC, old);
    // sabotage the tmp file of the new current: current.json.tmp as a directory
    mkdirSync(join(dir, "annotations", DOC, "current.json.tmp"), { recursive: true });
    expect(() => ensureCurrentAnnotations(dir, DOC, { now: FIXED_NOW })).toThrowError();
    // user data is safe in the archive; the old current is still on disk
    expect(readdirSync(annotationsArchiveDir(dir, DOC))).toEqual([
      "20260910T123456789Z-ffffffff.json",
    ]);
    expect(JSON.parse(readFileSync(annotationsCurrentPath(dir, DOC), "utf8"))).toEqual(old);
    // recover: clear the sabotage, the next call completes the epoch switch
    rmSync(join(dir, "annotations", DOC, "current.json.tmp"), { recursive: true });
    const result = ensureCurrentAnnotations(dir, DOC, {
      now: new Date("2026-09-10T12:34:57.000Z"),
    });
    expect(result.invalidated).toBe(true);
    expect(result.file.rev).toBe(0);
    expect(result.file.annotations).toEqual([]);
    // the re-run archived again under a fresh stamp (never an overwrite)
    expect(readdirSync(annotationsArchiveDir(dir, DOC)).sort()).toEqual([
      "20260910T123456789Z-ffffffff.json",
      "20260910T123457000Z-ffffffff.json",
    ]);
    // and a subsequent call is a clean match
    const again = ensureCurrentAnnotations(dir, DOC);
    expect(again.invalidated).toBe(false);
    expect(again.file).toEqual(result.file);
  });
});
