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
      "# T\n\nfine\n\n> quoted\n\n- a\n  - nested\n\n```\ncode\n```\n\nSee [link](http://x).\n";
    const result = parseTextSource(md, opts);
    expect(result.ir).toBeNull();
    const byLine = result.diagnostics.map((d) => [d.severity, d.code, d.line]);
    expect(byLine).toContainEqual(["error", "unsupported_syntax", 5]);
    expect(byLine).toContainEqual(["error", "unsupported_syntax", 7]);
    expect(byLine).toContainEqual(["error", "unsupported_syntax", 10]);
    expect(byLine).toContainEqual(["error", "unsupported_syntax", 14]);
    expect(result.diagnostics.every((d) => d.message.length > 0 && d.column !== undefined)).toBe(
      true
    );
  });

  it("refuses a list item that is not a single paragraph, and raw HTML", () => {
    const loose = parseTextSource("- one\n\n  continued\n", opts);
    expect(loose.ir).toBeNull();
    expect(loose.diagnostics[0]).toMatchObject({ code: "unsupported_syntax", line: 1 });
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
    expect(result.diagnostics[0]).toMatchObject({ code: "unsupported_syntax", line: 3 });
  });

  it("CRLF text reports the same lines as LF text", () => {
    const result = parseTextSource("# T\r\n\r\n> q\r\n", opts);
    expect(result.diagnostics[0]?.line).toBe(3);
  });
});
