import { TextDocIrSchema } from "@argelanderspace/contracts";
import { describe, expect, it } from "vitest";
import { parseTextSource, textSourceFingerprint } from "../src/documents/text-codec.js";

const opts = { docId: "text-1", sourceRev: 3 };

describe("argelander-text v1 basic codec (ticket 25)", () => {
  it("builds the section tree, a preface, paragraphs and single-level lists", () => {
    const md = [
      "Opening words before any heading.",
      "",
      "# Weak lensing",
      "",
      "A *first* paragraph with `code` and",
      "a soft break.",
      "",
      "## Method",
      "",
      "- alpha",
      "- beta **bold**",
      "",
      "1. one",
      "2. two",
      "",
      "## Results",
      "",
      "Done.",
      "",
    ].join("\n");
    const result = parseTextSource(md, opts);
    expect(result.diagnostics).toEqual([]);
    const ir = result.ir;
    expect(ir).not.toBeNull();
    expect(TextDocIrSchema.parse(ir)).toEqual(ir);
    expect(ir?.source).toEqual({
      type: "text",
      input_version: 1,
      source_rev: 3,
      source_fingerprint: textSourceFingerprint(md),
    });
    expect(ir?.title).toBe("Weak lensing");
    const [preface, h1] = ir?.sections ?? [];
    expect(preface?.id).toBe("sec-preface");
    expect(preface?.heading).toBeUndefined();
    expect(preface?.blocks).toEqual([
      {
        id: "p-1",
        type: "paragraph",
        segments: [{ type: "text", text: "Opening words before any heading." }],
      },
    ]);
    expect(h1?.heading).toBe("Weak lensing");
    expect(h1?.blocks[0]).toEqual({
      id: "p-2",
      type: "paragraph",
      segments: [{ type: "text", text: "A first paragraph with code and a soft break." }],
    });
    expect(h1?.children.map((s) => s.heading)).toEqual(["Method", "Results"]);
    const method = h1?.children[0];
    expect(method?.blocks).toEqual([
      {
        id: "l-1",
        type: "list",
        ordered: false,
        items: [
          { segments: [{ type: "text", text: "alpha" }] },
          { segments: [{ type: "text", text: "beta bold" }] },
        ],
      },
      {
        id: "l-2",
        type: "list",
        ordered: true,
        items: [
          { segments: [{ type: "text", text: "one" }] },
          { segments: [{ type: "text", text: "two" }] },
        ],
      },
    ]);
    expect(result.stats).toEqual({ sections: 3, paragraphs: 3, lists: 2 });
    expect(ir?.refsManifest.map((r) => r.id)).toEqual(["sec-1", "sec-2", "sec-3"]);
  });

  it("is deterministic: the same text and revision give the same IR", () => {
    const md = "# T\n\nbody\n";
    expect(parseTextSource(md, opts).ir).toEqual(parseTextSource(md, opts).ir);
  });

  it("falls back to the given title when there is no level-1 heading", () => {
    const ir = parseTextSource("## Only\n\nx", { ...opts, fallbackTitle: "Work title" }).ir;
    expect(ir?.title).toBe("Work title");
    expect(ir?.meta.title).toBe("Work title");
  });

  it("reports unsupported syntax with its line and refuses to produce an IR (nothing is dropped)", () => {
    const md =
      "# T\n\nfine\n\n> quoted\n\n- a\n  - nested\n\nWords ![img](assets/a.png) inline.\n\nSee [link](http://x).\n";
    const result = parseTextSource(md, opts);
    expect(result.ir).toBeNull();
    const byLine = result.diagnostics.map((d) => [d.severity, d.code, d.line]);
    expect(byLine).toContainEqual(["error", "quote_unsupported", 5]);
    expect(byLine).toContainEqual(["error", "nested_list_unsupported", 7]);
    expect(byLine).toContainEqual(["error", "image_inline", 10]);
    expect(byLine).toContainEqual(["error", "link_unsupported", 12]);
    expect(result.diagnostics.every((d) => d.message.length > 0 && d.column !== undefined)).toBe(
      true
    );
  });

  it("refuses a list item that is not a single paragraph, and raw HTML", () => {
    const loose = parseTextSource("- one\n\n  continued\n", opts);
    expect(loose.ir).toBeNull();
    expect(loose.diagnostics[0]).toMatchObject({ code: "list_item_unsupported", line: 1 });
    const html = parseTextSource("text <b>bold</b>\n", opts);
    expect(html.ir).toBeNull();
    expect(html.diagnostics[0]?.message).toMatch(/HTML/);
  });

  it("an empty or whitespace-only source is an explicit error", () => {
    for (const md of ["", "  \n\n"]) {
      const result = parseTextSource(md, opts);
      expect(result.ir).toBeNull();
      expect(result.diagnostics).toEqual([
        { code: "empty_document", severity: "error", message: expect.any(String) },
      ]);
    }
  });

  it("an unclosed fence is a diagnostic, never a crash", () => {
    const result = parseTextSource("# T\n\n```\nnever closed\n", opts);
    expect(result.ir).toBeNull();
    expect(result.diagnostics[0]).toMatchObject({ code: "fence_unclosed", line: 3 });
  });

  describe("math and cite/ref syntax is never silently reduced (B1; supported since ticket 26)", () => {
    const segs = (md: string) => {
      const para = parseTextSource(md, opts).ir?.sections[0]?.blocks[0];
      return para?.type === "paragraph" ? para.segments : undefined;
    };
    it("inline math with emphasis characters and escaped braces keeps its exact source", () => {
      expect(segs("# T\n\nBefore $a *b* c$ after.\n")).toEqual([
        { type: "text", text: "Before " },
        { type: "math", latex: "a *b* c" },
        { type: "text", text: " after." },
      ]);
      expect(segs("# T\n\nSet $\\{x\\}$ here.\n")?.[1]).toEqual({ type: "math", latex: "\\{x\\}" });
    });
    it("[cite: ...] and [ref: ...] are segments, not text", () => {
      const cite = segs("# T\n\nSee [cite: a;b | A] now.\n")?.[1];
      expect(cite).toMatchObject({ type: "cite", raw: "A" });
      const ref = segs("# T\n\nSee [ref: fig-1] now.\n")?.[1];
      expect(ref).toMatchObject({ type: "xref", target: { id: "fig-1", resolved: false } });
    });
    it("literal zones stay text: currency, escaped dollars, code spans, URLs", () => {
      const md =
        "# T\n\nIt costs $100 to $200, or \\$5 and \\$6. Run `a $x$ b` and see https://example.org/a$b$c now.\n";
      const r = parseTextSource(md, opts);
      expect(r.diagnostics).toEqual([]);
      const para = r.ir?.sections[0]?.blocks[0];
      expect(para?.type === "paragraph" && para.segments[0]).toMatchObject({ type: "text" });
      expect(JSON.stringify(para)).toContain("https://example.org/a$b$c");
      expect(JSON.stringify(para)).toContain("a $x$ b");
    });
  });

  describe("bounded work and exact locations (fix round 2)", () => {
    it("40k diagnostics on a 1 MB source are located in well under 2 s and the report is capped with a count", () => {
      const md = `# T\n\n${"> quoted\n\n".repeat(40000)}`;
      const started = performance.now();
      const result = parseTextSource(md, opts);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(result.ir).toBeNull();
      expect(result.diagnostics.length).toBeLessThanOrEqual(201);
      const last = result.diagnostics[result.diagnostics.length - 1];
      expect(last).toMatchObject({ code: "too_many_diagnostics", count: 40000 - 200 });
      // the ones that are shown are the first ones, with exact positions
      expect(result.diagnostics[0]).toMatchObject({
        code: "quote_unsupported",
        line: 3,
        column: 1,
      });
      expect(result.diagnostics[1]).toMatchObject({ line: 5 });
    });

    it("lines are counted like the editor: only \\n breaks a line; a lone CR is an ordinary character", () => {
      // line 1 "# T", line 2 "", line 3 "a\rb $$x end" (the CR is inside the line), so the display is at line 3, column 5
      const r = parseTextSource("# T\n\na\rb $$x end\n", opts);
      const math = r.diagnostics.find((d) => d.code === "math_unclosed");
      expect(math).toMatchObject({ line: 3, column: 5 });
      // CRLF files keep their lines and columns
      const crlf = parseTextSource("# T\r\n\r\nab $$x end\r\n", opts).diagnostics.find(
        (d) => d.code === "math_unclosed"
      );
      expect(crlf).toMatchObject({ line: 3, column: 4 });
    });

    it("a stray backtick does not hide a problem in a later paragraph (code spans end at the block)", () => {
      const r = parseTextSource(
        "# T\n\nA stray ` here.\n\nMath $$a b now and a `real` span.\n",
        opts
      );
      expect(r.ir).toBeNull();
      expect(r.diagnostics.map((d) => [d.code, d.line])).toContainEqual(["math_unclosed", 5]);
      // a real multi-line span inside one paragraph still masks its content
      const ok = parseTextSource("# T\n\nRun `a $$x\nb` now.\n", opts);
      expect(ok.diagnostics).toEqual([]);
    });
  });

  describe("autolinks are plain text (B2)", () => {
    it("bare URLs, e-mail addresses and <angle> autolinks keep their exact characters", () => {
      const md =
        "# T\n\nSee https://example.org/a_b*c and www.example.com, mail me@example.org or <https://x.org/y>.\n";
      const r = parseTextSource(md, opts);
      expect(r.diagnostics).toEqual([]);
      const para = r.ir?.sections[0]?.blocks[0];
      const text =
        para?.type === "paragraph"
          ? para.segments.map((s) => (s.type === "text" ? s.text : "")).join("")
          : "";
      expect(text).toBe(
        "See https://example.org/a_b*c and www.example.com, mail me@example.org or <https://x.org/y>."
      );
    });
    it("an explicit [text](url) link stays unsupported", () => {
      expect(
        parseTextSource("# T\n\nA [x](https://example.org) link.\n", opts).diagnostics[0]?.code
      ).toBe("link_unsupported");
    });
  });

  it("CRLF text reports the same lines as LF text", () => {
    const result = parseTextSource("# T\r\n\r\n> q\r\n", opts);
    expect(result.diagnostics[0]?.line).toBe(3);
  });
});
