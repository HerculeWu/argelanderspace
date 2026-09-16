/**
 * Coverage of the Stage-10 Writer contracts (`.pi/memory-reference/
 * 2026-09-15-stage10-writer-plan.md` §3/§6): cell/manuscript/template schema
 * rules, looseObject unknown-key preservation (agent file contract, the I010
 * strip regret must not repeat), the `writer.changed` WS message, and the
 * global cell→LaTeX serialization mapping plus document assembly.
 */

import { describe, expect, it } from "vitest";
import { WsServerMessageSchema } from "../src/jobs.js";
import {
  buildTexDocument,
  buildTexDocumentMapped,
  CellSchema,
  CommentSchema,
  defaultCellData,
  extractCitedKeys,
  ManuscriptSchema,
  renderFrontMatter,
  serializeCell,
  type WriterManuscript,
  WriterTemplateSchema,
  WsWriterChangedSchema,
} from "../src/writer.js";
import { BUILTIN_WRITER_TEMPLATES } from "../src/writer-templates.js";

const VALID_MANUSCRIPT = {
  version: 1,
  id: "m_0123abcd",
  rev: 2,
  template: "aa",
  title: "Stellar Streams in the Galactic Halo",
  authors: [{ name: "Wenjie Wu", aff: "1", email: "wenjie@example.org" }],
  affiliations: ["Argelander-Institut für Astronomie"],
  userPreamble: "\\newcommand{\\kms}{\\mathrm{km\\,s^{-1}}}",
  infoValues: { keywords: "Galaxy: halo" },
  cells: [{ id: "c_aaaa0001", type: "latex", data: { source: "\\section{Intro}" } }],
  comments: [
    {
      id: "cm_0000aaaa",
      cell: "c_aaaa0001",
      who: "You",
      body: "补一句 selection",
      created_at: "2026-09-15T10:00:00.000Z",
    },
  ],
  created_at: "2026-09-15T09:00:00.000Z",
  updated_at: "2026-09-15T10:00:00.000Z",
};

const TEMPLATE_AA = {
  id: "aa",
  version: 1,
  label: "A&A",
  chip: "A&A manuscript",
  preamble: "\\documentclass{aa}\n\\usepackage{graphicx}",
  types: ["latex", "abstract-aa"],
  infoFields: [{ key: "keywords", label: "Keywords", input: "text" }],
  frontMatter: "\\title{ {{title}} }\n\\author{ {{authors}} }\n\\maketitle",
};

describe("CellSchema", () => {
  it("parses every cell type and fills per-type data defaults", () => {
    const types = [
      "latex",
      "abstract-aa",
      "figure",
      "table",
      "code",
      "ack",
      "appendix",
      "recipient",
    ];
    for (const [i, type] of types.entries()) {
      const result = CellSchema.safeParse({ id: `c_0000000${i}`, type, data: {} });
      expect(result.success, type).toBe(true);
    }
    const figure = CellSchema.parse({ id: "c_00000010", type: "figure", data: {} });
    expect(figure.data).toMatchObject({ placement: "center", width: 80, image: null });
    const code = CellSchema.parse({ id: "c_00000011", type: "code", data: {} });
    expect(code.data).toMatchObject({ language: "Python", lineNumbers: true });
  });

  it("omitting data entirely is allowed (agent-authored minimal files)", () => {
    const result = CellSchema.safeParse({ id: "c_00000020", type: "latex" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.data).toMatchObject({ source: "" });
  });

  it("rejects an unknown cell type / malformed id", () => {
    expect(CellSchema.safeParse({ id: "c_00000030", type: "math" }).success).toBe(false);
    expect(CellSchema.safeParse({ id: "cell-1", type: "latex" }).success).toBe(false);
  });

  it("preserves unknown keys at cell level AND inside data (looseObject)", () => {
    const parsed = CellSchema.parse({
      id: "c_00000040",
      type: "latex",
      data: { source: "x", agentNote: "keep me" },
      futureField: 42,
    });
    expect(parsed.futureField).toBe(42);
    expect((parsed.data as Record<string, unknown>).agentNote).toBe("keep me");
  });
});

describe("defaultCellData", () => {
  it("returns the prototype defaultData shape per type", () => {
    expect(defaultCellData("figure")).toMatchObject({
      caption: "",
      label: "",
      placement: "center",
      width: 80,
      image: null,
    });
    expect(defaultCellData("appendix")).toEqual({});
    expect(defaultCellData("abstract-aa")).toMatchObject({ Context: "", Conclusions: "" });
  });
});

describe("ManuscriptSchema / CommentSchema", () => {
  it("parses a fully-populated manuscript", () => {
    expect(ManuscriptSchema.safeParse(VALID_MANUSCRIPT).success).toBe(true);
  });

  it("parses a minimal manuscript and fills defaults", () => {
    const result = ManuscriptSchema.safeParse({
      version: 1,
      id: "m_0000bbbb",
      rev: 0,
      template: "report",
      created_at: "2026-09-15T09:00:00.000Z",
      updated_at: "2026-09-15T09:00:00.000Z",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe("Untitled manuscript");
      expect(result.data.cells).toEqual([]);
      expect(result.data.infoValues).toEqual({});
    }
  });

  it("preserves unknown top-level keys (looseObject round-trip)", () => {
    const parsed = ManuscriptSchema.parse({ ...VALID_MANUSCRIPT, agentMeta: { stage: "draft" } });
    expect(parsed.agentMeta).toEqual({ stage: "draft" });
  });

  it("rejects a bad template id / negative rev / missing created_at", () => {
    expect(ManuscriptSchema.safeParse({ ...VALID_MANUSCRIPT, template: "Bad Id" }).success).toBe(
      false
    );
    expect(ManuscriptSchema.safeParse({ ...VALID_MANUSCRIPT, rev: -1 }).success).toBe(false);
    const { created_at: _c, ...noCreated } = VALID_MANUSCRIPT;
    expect(ManuscriptSchema.safeParse(noCreated).success).toBe(false);
  });

  it('CommentSchema defaults who to "You" and rejects an empty body', () => {
    const parsed = CommentSchema.parse({
      id: "cm_1111bbbb",
      cell: "c_aaaa0001",
      body: "hi",
      created_at: "2026-09-15T10:00:00.000Z",
    });
    expect(parsed.who).toBe("You");
    expect(
      CommentSchema.safeParse({
        id: "cm_1111bbbb",
        cell: "c_aaaa0001",
        body: " ",
        created_at: "2026-09-15T10:00:00.000Z",
      }).success
    ).toBe(true); // non-empty string passes; trimming is a UI concern
    expect(
      CommentSchema.safeParse({
        id: "cm_1111bbbb",
        cell: "c_aaaa0001",
        body: "",
        created_at: "2026-09-15T10:00:00.000Z",
      }).success
    ).toBe(false);
  });
});

describe("WriterTemplateSchema", () => {
  it("parses a full template and keeps unknown keys", () => {
    const parsed = WriterTemplateSchema.parse({ ...TEMPLATE_AA, agentHint: "astro" });
    expect(parsed.agentHint).toBe("astro");
  });

  it("rejects an empty types array and defaults infoFields/frontMatter", () => {
    expect(WriterTemplateSchema.safeParse({ ...TEMPLATE_AA, types: [] }).success).toBe(false);
    const parsed = WriterTemplateSchema.parse({
      id: "mini",
      version: 1,
      label: "Mini",
      preamble: "",
      types: ["latex"],
    });
    expect(parsed.infoFields).toEqual([]);
    expect(parsed.frontMatter).toBe("");
  });
});

describe("WsWriterChangedSchema", () => {
  it("is a member of the WsServerMessage union", () => {
    const msg = {
      type: "writer.changed",
      cause: "put",
      id: "m_0123abcd",
      at: "2026-09-15T10:00:00.000Z",
    };
    expect(WsWriterChangedSchema.safeParse(msg).success).toBe(true);
    expect(WsServerMessageSchema.safeParse(msg).success).toBe(true);
  });

  it("allows omitting id (template-dir changes)", () => {
    expect(
      WsServerMessageSchema.safeParse({
        type: "writer.changed",
        cause: "template",
        at: "2026-09-15T10:00:00.000Z",
      }).success
    ).toBe(true);
  });
});

describe("serializeCell (global fixed mapping)", () => {
  const cell = (type: string, data: Record<string, unknown>) =>
    CellSchema.parse({ id: "c_00000099", type, data });

  it("latex: source passes through verbatim", () => {
    expect(serializeCell(cell("latex", { source: "\\section{Method}\n\nText $x$." }))).toBe(
      "\\section{Method}\n\nText $x$."
    );
  });

  it("abstract-aa: five brace groups in Context…Conclusions order", () => {
    expect(
      serializeCell(
        cell("abstract-aa", {
          Context: "C",
          Aims: "A",
          Methods: "M",
          Results: "R",
          Conclusions: "X",
        })
      )
    ).toBe("\\abstract\n{C}\n{A}\n{M}\n{R}\n{X}");
  });

  it("figure: includegraphics with width fraction, or % no asset", () => {
    expect(
      serializeCell(cell("figure", { caption: "Cap", label: "fig:a", image: "rc.png", width: 80 }))
    ).toBe(
      "\\begin{figure}\n  \\centering\n  \\includegraphics[width=0.8\\columnwidth]{assets/rc.png}\n  \\caption{Cap}\n  \\label{fig:a}\n\\end{figure}"
    );
    expect(
      serializeCell(cell("figure", { caption: "", label: "", image: null, width: 50 }))
    ).toContain("% no asset");
  });

  it("table: hline-ruled tabular from simple CSV", () => {
    const out = serializeCell(
      cell("table", {
        head: "Parameter,Value",
        csv: "R_0,8.18 kpc\nV_c,232 km/s",
        caption: "C",
        label: "tab:c",
      })
    );
    expect(out).toContain("\\begin{tabular}{ll}");
    expect(out).toContain("Parameter & Value \\\\");
    expect(out).toContain("R_0 & 8.18 kpc \\\\");
    expect(out).toContain("\\caption{C}");
  });

  it("code: lstlisting options honor lineNumbers", () => {
    expect(
      serializeCell(cell("code", { caption: "C", label: "lst:a", code: "x=1", lineNumbers: true }))
    ).toBe("\\begin{lstlisting}[caption={C},label={lst:a},numbers=left]\nx=1\n\\end{lstlisting}");
    expect(
      serializeCell(cell("code", { caption: "", label: "", code: "", lineNumbers: false }))
    ).toContain("\\begin{lstlisting}[caption={}]");
    // Empty labels are not emitted: otherwise multiple unlabelled floats
    // create a spurious duplicate-label warning and ambiguous aux target.
    for (const type of ["figure", "table"] as const) {
      expect(serializeCell(cell(type, { label: "" }))).not.toContain("\\label{}");
    }
  });

  it("ack / appendix / recipient", () => {
    expect(serializeCell(cell("ack", { source: "Thanks." }))).toBe(
      "\\begin{acknowledgements}\nThanks.\n\\end{acknowledgements}"
    );
    expect(serializeCell(cell("appendix", {}))).toBe("\\appendix");
    expect(
      serializeCell(cell("recipient", { name: "Editor", organization: "A&A", address: "Paris" }))
    ).toBe("% recipient\nEditor\nA&A\nParis");
  });
});

describe("extractCitedKeys", () => {
  it("collects comma-separated keys across cells in first-use order, deduped", () => {
    const cells = [
      CellSchema.parse({
        id: "c_000000a1",
        type: "latex",
        data: { source: "see \\citep{Belokurov2006, GaiaDR3} and \\cite{SmithEvans2025}" },
      }),
      CellSchema.parse({
        id: "c_000000a2",
        type: "ack",
        data: { source: "thanks \\cite{Belokurov2006}" },
      }),
      CellSchema.parse({
        id: "c_000000a3",
        type: "figure",
        data: { caption: "\\cite{Koposov2024}", width: 80 },
      }),
    ];
    expect(extractCitedKeys(cells)).toEqual([
      "Belokurov2006",
      "GaiaDR3",
      "SmithEvans2025",
      "Koposov2024",
    ]);
  });

  it("returns [] when nothing is cited", () => {
    expect(
      extractCitedKeys([
        CellSchema.parse({ id: "c_000000b1", type: "latex", data: { source: "no cites" } }),
      ])
    ).toEqual([]);
  });
});

describe("renderFrontMatter", () => {
  const template = WriterTemplateSchema.parse({
    ...TEMPLATE_AA,
    frontMatter:
      "\\title{ {{title}} }\n\\author{ {{authors}} }\n\\keywords{ {{info.keywords}} }\n{{unknown}}",
  });
  it("substitutes title/authors/info placeholders and blanks unknown ones", () => {
    const out = renderFrontMatter(template, ManuscriptSchema.parse(VALID_MANUSCRIPT));
    expect(out).toBe(
      "\\title{ Stellar Streams in the Galactic Halo }\n\\author{ Wenjie Wu }\n\\keywords{ Galaxy: halo }\n"
    );
  });
});

describe("buildTexDocument", () => {
  const template = WriterTemplateSchema.parse(TEMPLATE_AA);
  it("assembles preamble + user preamble + front matter + cells + bibliography", () => {
    const m = ManuscriptSchema.parse({
      ...VALID_MANUSCRIPT,
      cells: [
        {
          id: "c_000000c1",
          type: "latex",
          data: { source: "\\section{Intro}\n\nSee \\citep{Belokurov2006}." },
        },
        { id: "c_000000c2", type: "appendix", data: {} },
        { id: "c_000000c3", type: "latex", data: { source: "\\section{Extra}" } },
      ],
    });
    const tex = buildTexDocument(m, template);
    expect(tex).toBe(
      [
        "\\documentclass{aa}",
        "\\usepackage{graphicx}",
        "",
        "\\newcommand{\\kms}{\\mathrm{km\\,s^{-1}}}",
        "",
        "\\begin{document}",
        "",
        "\\title{ Stellar Streams in the Galactic Halo }",
        "\\author{ Wenjie Wu }",
        "\\maketitle",
        "",
        "\\section{Intro}\n\nSee \\citep{Belokurov2006}.",
        "",
        "\\appendix",
        "",
        "\\section{Extra}",
        "",
        "\\bibliography{references}",
        "",
        "\\end{document}",
        "",
      ].join("\n")
    );
  });

  it("omits \\bibliography when nothing is cited and skips empty front matter", () => {
    const bare = WriterTemplateSchema.parse({ ...TEMPLATE_AA, frontMatter: "" });
    const m = ManuscriptSchema.parse({
      ...VALID_MANUSCRIPT,
      userPreamble: "",
      cells: [{ id: "c_000000d1", type: "latex", data: { source: "Body." } }],
    });
    const tex = buildTexDocument(m, bare);
    expect(tex).not.toContain("\\bibliography");
    expect(tex).toContain("\\begin{document}\n\nBody.\n\n\\end{document}\n");
  });
});

describe("buildTexDocumentMapped", () => {
  const template = WriterTemplateSchema.parse(TEMPLATE_AA);
  it("tex is byte-identical to buildTexDocument and ranges point at cells", () => {
    const m = ManuscriptSchema.parse({
      ...VALID_MANUSCRIPT,
      cells: [
        {
          id: "c_000000c1",
          type: "latex",
          data: { source: "\\section{Intro}\n\nSee \\citep{Belokurov2006}." },
        },
        { id: "c_000000c2", type: "appendix", data: {} },
        { id: "c_000000c3", type: "latex", data: { source: "\\section{Extra}" } },
      ],
    });
    const mapped = buildTexDocumentMapped(m, template);
    expect(mapped.tex).toBe(buildTexDocument(m, template));
    const lines = mapped.tex.split("\n");
    expect(mapped.cellRanges.map((r) => r.cell)).toEqual([
      "c_000000c1",
      "c_000000c2",
      "c_000000c3",
    ]);
    for (const r of mapped.cellRanges) {
      expect(lines.slice(r.startLine - 1, r.endLine).join("\n")).toContain(
        r.cell === "c_000000c2" ? "\\appendix" : "\\section"
      );
    }
    expect(mapped.cellRanges[1]?.startLine).toBeGreaterThan(mapped.cellRanges[0]?.endLine ?? 0);
  });

  it("zero cells: still assembles and reports no ranges", () => {
    const m = ManuscriptSchema.parse({ ...VALID_MANUSCRIPT, cells: [] });
    const mapped = buildTexDocumentMapped(m, template);
    expect(mapped.tex).toBe(buildTexDocument(m, template));
    expect(mapped.cellRanges).toEqual([]);
  });
});

describe("BUILTIN_WRITER_TEMPLATES", () => {
  it("ships aa / report / letter with non-empty types", () => {
    expect(BUILTIN_WRITER_TEMPLATES.map((t) => t.id)).toEqual(["aa", "report", "letter"]);
    for (const t of BUILTIN_WRITER_TEMPLATES) expect(t.types.length).toBeGreaterThan(0);
  });
});

// Type-level sanity: ManuscriptSchema output feeds the serializers.
const _typecheck: WriterManuscript = ManuscriptSchema.parse(VALID_MANUSCRIPT);
void _typecheck;
