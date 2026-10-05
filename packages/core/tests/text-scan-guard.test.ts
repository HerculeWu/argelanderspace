import { describe, expect, it, vi } from "vitest";

// The scan and the lexer are meant to agree; the codec still checks that every find the scan extracted is placed
// exactly once. Here the scan is made to disagree on purpose (a find inside a code block) to prove the check fires.
vi.mock("../src/documents/text-scan.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/documents/text-scan.js")>();
  return {
    ...actual,
    scanSyntax: (source: string, options: { blockDisplay: boolean }) => {
      const scan = actual.scanSyntax(source, options);
      if (source.startsWith("```\ncode")) {
        scan.items.push({ kind: "math", start: 5, end: 9, where: 5, latex: "x", bad: false });
      }
      if (source.startsWith("~~~\ncode")) {
        scan.displays.push({ lineStart: 4, lineEnd: 8, start: 4, latex: "y" });
      }
      return scan;
    },
  };
});

const { parseTextSource } = await import("../src/documents/text-codec.js");

describe("exactly-once guard", () => {
  it("an inline find the lexer left inside a code block is a located error, not a silent duplicate", () => {
    const r = parseTextSource("```\ncode\n```\n", { docId: "text-1", sourceRev: 1 });
    expect(r.ir).toBeNull();
    expect(r.diagnostics).toMatchObject([
      { code: "scan_mismatch", severity: "error", line: 2, column: 2 },
    ]);
  });
  it("so is a display equation", () => {
    const r = parseTextSource("~~~\ncode\n~~~\n", { docId: "text-1", sourceRev: 1 });
    expect(r.ir).toBeNull();
    expect(r.diagnostics).toMatchObject([
      { code: "scan_mismatch", severity: "error", line: 2, column: 1 },
    ]);
  });
});
