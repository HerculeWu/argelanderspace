import type { IrBlock, TextSourceAsset } from "@argelanderspace/contracts";
import { describe, expect, it } from "vitest";
import { parseTextSource, textSourceFingerprint } from "../src/documents/text-codec.js";

const A: TextSourceAsset = {
  name: "profile-0123abcd.png",
  sha256: "a".repeat(64),
  byte_length: 100,
  media_type: "image/png",
  width: 320,
  height: 200,
};
const B: TextSourceAsset = {
  ...A,
  name: "other-89abcdef.jpg",
  sha256: "b".repeat(64),
  media_type: "image/jpeg",
};
const opts = { docId: "text-1", sourceRev: 1, assets: [A, B] };

const blocks = (md: string, o = opts): IrBlock[] => {
  const r = parseTextSource(md, o);
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const ir = r.ir;
  if (ir === null) throw new Error("no IR");
  return ir.sections.flatMap((s) => s.blocks);
};
const errors = (md: string, o = opts) =>
  parseTextSource(md, o).diagnostics.filter((d) => d.severity === "error");
const codes = (md: string, o = opts) => errors(md, o).map((d) => d.code);

describe("figures (ticket 27)", () => {
  it("builds a figure block from a standalone image and its metadata", () => {
    const md = [
      '```argelander-block\n{"id":"fig-profile","number":"2","label":"Figure 2","caption":"A profile of $\\\\gamma_t$.","footnote":"Synthetic."}\n```',
      "![Shear profile](assets/profile-0123abcd.png)",
      "",
    ].join("\n");
    const [fig] = blocks(md);
    expect(fig).toEqual({
      id: "fig-profile",
      type: "figure",
      number: "2",
      label: "Figure 2",
      footnote: "Synthetic.",
      imgPath: A.name,
      imgWidth: 320,
      imgHeight: 200,
      content: "Shear profile",
      captionSegments: [
        { type: "text", text: "A profile of " },
        { type: "math", latex: "\\gamma_t" },
        { type: "text", text: "." },
      ],
    });
  });

  it("gives deterministic implicit ids and lets ref resolve to figures and tables", () => {
    const md = [
      "See [ref: fig-1 | Fig. 1] and [ref: tab-1 | Tab. 1].",
      "",
      '```argelander-block\n{"number":"3"}\n```',
      "![](assets/profile-0123abcd.png)",
      "",
      "| a | b |\n| - | - |\n| 1 | 2 |",
      "",
    ].join("\n");
    const r = parseTextSource(md, opts);
    expect(r.diagnostics).toEqual([]);
    const ir = r.ir;
    const all = ir?.sections.flatMap((s) => s.blocks) ?? [];
    expect(all.map((b) => b.id)).toEqual(["p-1", "fig-1", "tab-1"]);
    const para = all[0];
    const refs = para?.type === "paragraph" ? para.segments.filter((s) => s.type === "xref") : [];
    expect(refs.map((s) => (s.type === "xref" ? s.target.targetType : ""))).toEqual([
      "figure",
      "table",
    ]);
    expect(ir?.refsManifest.map((x) => x.kind)).toEqual(["figure", "table"]);
  });

  it("the fingerprint covers referenced assets only", () => {
    const md = "![](assets/profile-0123abcd.png)\n";
    const withA = parseTextSource(md, opts).ir?.source.source_fingerprint;
    const changed = parseTextSource(md, {
      ...opts,
      assets: [{ ...A, sha256: "c".repeat(64) }, B],
    }).ir?.source.source_fingerprint;
    const unrelated = parseTextSource(md, { ...opts, assets: [A] }).ir?.source.source_fingerprint;
    expect(withA).toBe(textSourceFingerprint(md, [A]));
    expect(changed).not.toBe(withA);
    expect(unrelated).toBe(withA);
    // a text without figures keeps the plain Markdown hash
    expect(parseTextSource("plain\n", opts).ir?.source.source_fingerprint).toBe(
      textSourceFingerprint("plain\n")
    );
  });

  it.each([
    ["![x](https://example.org/a.png)", "image_remote"],
    ["![x](http://example.org/a.png)", "image_remote"],
    ["![x](data:image/png;base64,AAAA)", "image_remote"],
    ["![x](//example.org/a.png)", "image_remote"],
    ["![x](file:///etc/passwd)", "image_remote"],
    ["![x](/etc/passwd)", "image_path_unsafe"],
    ["![x](assets/../../etc/passwd)", "image_path_unsafe"],
    ["![x](../assets/profile-0123abcd.png)", "image_path_unsafe"],
    ["![x](assets\\profile-0123abcd.png)", "image_path_unsafe"],
    ["![x](assets/%2e%2e/a.png)", "image_path_unsafe"],
    ["![x](profile-0123abcd.png)", "image_path_invalid"],
    ["![x](assets/sub/profile-0123abcd.png)", "image_path_invalid"],
    ["![x](assets/evil.svg)", "image_path_invalid"],
    ["![x](assets/.hidden-0123abcd.png)", "image_path_invalid"],
    ["![x](assets/missing-0123abcd.png)", "image_asset_missing"],
    ["![x](assets/profile-0123abcd.png) trailing words", "image_inline"],
    ["words before ![x](assets/profile-0123abcd.png)", "image_inline"],
    ["# Title ![x](assets/profile-0123abcd.png)", "image_inline"],
    ["- item ![x](assets/profile-0123abcd.png)", "image_inline"],
    ["![x $a$](assets/profile-0123abcd.png)", "image_alt_token"],
  ])("refuses %s with %s and a position", (md, code) => {
    const found = errors(`${md}\n`);
    expect(found.map((d) => d.code)).toContain(code);
    expect(found.find((d) => d.code === code)?.line).toBe(1);
    expect(parseTextSource(`${md}\n`, opts).ir).toBeNull();
  });

  it("an image without any registered assets is a located missing-asset error", () => {
    expect(
      codes("![x](assets/profile-0123abcd.png)\n", { docId: "t", sourceRev: 1 } as never)
    ).toEqual(["image_asset_missing"]);
  });

  it("warns about an ignored title and keeps the rest", () => {
    const r = parseTextSource('![x](assets/profile-0123abcd.png "a title")\n', opts);
    expect(r.ir).not.toBeNull();
    expect(r.diagnostics.map((d) => d.code)).toEqual(["image_title_ignored"]);
  });

  it("figure metadata with a footnote is only valid on figures and tables", () => {
    const md = '```argelander-block\n{"footnote":"n"}\n```\nplain paragraph\n';
    expect(codes(md)).toEqual(["block_meta_field"]);
    expect(
      codes('```argelander-block\n{"kind":"table"}\n```\n![x](assets/profile-0123abcd.png)\n')
    ).toEqual(["block_meta_kind"]);
  });
});

describe("GFM tables (ticket 27)", () => {
  it("keeps every row, column, cell and the math, with a header row of th", () => {
    const md = [
      '```argelander-block\n{"id":"tab-x","number":"1","label":"Table 1","caption":"Two things.","footnote":"Note."}\n```',
      "| Estimator | Mass $M_\\odot$ | a\\|b |",
      "| :--- | ---: | --- |",
      "| Full | $4.82$ | x |",
      "| x < y & co | $a|b$ |  |",
      "",
    ].join("\n");
    const r = parseTextSource(md, opts);
    expect(r.diagnostics.map((d) => d.code)).toEqual(["table_align_ignored"]);
    const [t] = r.ir?.sections.flatMap((s) => s.blocks) ?? [];
    expect(t?.type).toBe("table");
    if (t?.type !== "table") return;
    expect(t.id).toBe("tab-x");
    expect(t.footnote).toBe("Note.");
    expect(t.tableBody).toBe(
      "<table><tr><th>Estimator</th><th>Mass $M_\\odot$</th><th>a|b</th></tr>" +
        "<tr><td>Full</td><td>$4.82$</td><td>x</td></tr>" +
        "<tr><td>x &lt; y &amp; co</td><td>$a|b$</td><td></td></tr></table>"
    );
  });

  it("a row with more cells than the header is refused, not truncated", () => {
    const md = "| a | b |\n| - | - |\n| 1 | 2 | 3 |\n";
    const found = errors(md);
    expect(found.map((d) => d.code)).toEqual(["table_extra_cells"]);
    expect(found[0]?.line).toBe(3);
  });

  it("cite, ref and display math inside a cell are located errors", () => {
    expect(codes("| a | b |\n| - | - |\n| [cite: x] | 1 |\n")).toEqual(["table_token_unsupported"]);
    expect(codes("| a | b |\n| - | - |\n| $$x$$ | 1 |\n")).toContain("math_display_in_table");
  });
});

describe("argelander-table (ticket 27)", () => {
  const fence = (json: unknown) => `\`\`\`argelander-table\n${JSON.stringify(json)}\n\`\`\`\n`;
  const cell = (text: string, more: object = {}) => ({ text, ...more });

  it("builds the merged-cell table with escaped text and kept math", () => {
    const json = {
      rows: [
        [
          cell("Estimator", { header: true, rowspan: 2 }),
          cell("Uncertainty & $\\sigma$", { header: true, colspan: 2 }),
        ],
        [cell("Stat", { header: true }), cell("Syst <i>", { header: true })],
        [cell("Full"), cell("0.31"), cell("0.12")],
      ],
    };
    const [t] = blocks(fence(json));
    if (t?.type !== "table") throw new Error("not a table");
    expect(t.id).toBe("tab-1");
    expect(t.tableBody).toBe(
      '<table><tr><th rowspan="2">Estimator</th><th colspan="2">Uncertainty &amp; $\\sigma$</th></tr>' +
        "<tr><th>Stat</th><th>Syst &lt;i&gt;</th></tr>" +
        "<tr><td>Full</td><td>0.31</td><td>0.12</td></tr></table>"
    );
  });

  it("takes block metadata and a caption with math", () => {
    const md = `\`\`\`argelander-block\n{"id":"t1","number":"4","caption":"Gains of $x$","footnote":"n"}\n\`\`\`\n${fence({ rows: [[cell("a")]] })}`;
    const [t] = blocks(md);
    if (t?.type !== "table") throw new Error("not a table");
    expect(t).toMatchObject({ id: "t1", number: "4", footnote: "n" });
    expect(t.captionSegments?.map((s) => s.type)).toEqual(["text", "math"]);
  });

  it.each([
    [
      "colspan out of the grid",
      { rows: [[cell("a"), cell("b")], [cell("c", { colspan: 3 })]] },
      "table_span_bounds",
      2,
    ],
    [
      "rowspan past the last row",
      { rows: [[cell("a", { rowspan: 3 }), cell("b")], [cell("c")]] },
      "table_span_bounds",
      2,
    ],
    [
      "overlap",
      {
        rows: [
          [cell("a", { rowspan: 2 }), cell("b")],
          [cell("c"), cell("d", { colspan: 2 })],
        ],
      },
      "table_span_bounds",
      2,
    ],
    [
      "a row that stays short",
      { rows: [[cell("a"), cell("b")], [cell("c")]] },
      "table_row_incomplete",
      2,
    ],
  ])("%s is a located error", (_name, json, code) => {
    const found = errors(fence(json));
    expect(found.map((d) => d.code)).toContain(code);
    expect(found[0]?.line).toBeGreaterThanOrEqual(1);
    expect(parseTextSource(fence(json), opts).ir).toBeNull();
  });

  it("a real overlap (two cells over one square) is reported", () => {
    const json = {
      rows: [[cell("a"), cell("b"), cell("c", { rowspan: 2 })], [cell("d", { colspan: 3 })]],
    };
    expect(codes(fence(json))).toEqual(["table_span_overlap"]);
    const overlap = {
      rows: [
        [cell("a", { rowspan: 2 }), cell("b"), cell("c")],
        [cell("d"), cell("e")],
      ],
    };
    // the second row: d fills column 1, e (colspan 2) covers columns 2-3 - fine
    expect(codes(fence(overlap))).toEqual([]);
    const clash = {
      rows: [
        [cell("a", { rowspan: 2 }), cell("b", { colspan: 2 })],
        [cell("c", { colspan: 2 }), cell("d")],
      ],
    };
    expect(codes(fence(clash)).length).toBeGreaterThan(0);
    expect(codes(fence(clash))).toContain("table_span_bounds");
  });

  it.each([
    [{ rows: [[{ text: "a", rowspan: 0 }]] }, "table_invalid", "rows[0][0].rowspan"],
    [{ rows: [[{ text: "a", colspan: 1.5 }]] }, "table_invalid", "rows[0][0].colspan"],
    [{ rows: [[{ text: "a", colspan: -1 }]] }, "table_invalid", "rows[0][0].colspan"],
    [{ rows: [[{ text: "a", html: "<b>" }]] }, "table_unknown_field", "rows[0][0].html"],
    [{ rows: [] }, "table_invalid", "rows"],
    [{ rows: [[]] }, "table_invalid", "rows[0]"],
    [{ rows: [[{ text: 5 }]] }, "table_invalid", "rows[0][0].text"],
  ])("schema problem %j is %s at %s", (json, code, field) => {
    const found = errors(fence(json));
    expect(found[0]?.code).toBe(code);
    expect(found[0]?.field).toBe(field);
    expect(found[0]?.line).toBeGreaterThanOrEqual(1);
  });

  it("bad JSON and an unclosed fence are located", () => {
    expect(codes("```argelander-table\n{rows:\n```\n")).toEqual(["table_json"]);
    expect(codes('```argelander-table\n{"rows":[[{"text":"a"}]]}\n')).toEqual(["fence_unclosed"]);
  });

  it("cite / ref / display math inside a cell text are errors", () => {
    expect(codes(fence({ rows: [[cell("see [cite: a]")]] }))).toEqual(["table_token_unsupported"]);
    expect(codes(fence({ rows: [[cell("$$x$$")]] }))).toContain("math_display_inline");
  });

  it("limits rows and cells", () => {
    const big = { rows: Array.from({ length: 2001 }, () => [cell("x")]) };
    expect(codes(fence(big))).toEqual(["table_too_large"]);
  });

  it("a dangling block meta before a refused table does not leak onto the next block", () => {
    const md = `\`\`\`argelander-block\n{"id":"keep"}\n\`\`\`\n${fence({ rows: [[{ text: "a", rowspan: 0 }]] })}\nnext paragraph\n`;
    expect(codes(md)).toEqual(["table_invalid"]);
  });
});

describe("exactly once with figures and tables", () => {
  it("every marked word of cells, captions and footnotes appears once", () => {
    const md = [
      '```argelander-block\n{"caption":"cap Q1Z $x$","footnote":"foot Q2Z"}\n```',
      "![alt Q3Z](assets/profile-0123abcd.png)",
      "",
      "| h Q4Z | h2 |\n| - | - |\n| c Q5Z | $q Q6Z$ |",
      "",
      `\`\`\`argelander-table\n${JSON.stringify({ rows: [[{ text: "j Q7Z" }]] })}\n\`\`\``,
      "",
    ].join("\n");
    const r = parseTextSource(md, opts);
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const text = JSON.stringify(r.ir?.sections);
    for (const w of ["Q1Z", "Q2Z", "Q3Z", "Q4Z", "Q5Z", "Q6Z", "Q7Z"])
      expect(text.split(w).length - 1, w).toBe(1);
  });
});
