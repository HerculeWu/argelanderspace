import { describe, expect, test } from "vitest";
import { PdfActionType, PdfZoomMode, type PdfBookmarkObject, type PdfLinkTarget } from "@embedpdf/models";
import { flattenPdfBookmarks, safePdfExternalUrl } from "../src/doc/pdf-navigation";

describe("PDF navigation adaptation", () => {
  test("retains nested native outline hierarchy and only activates explicit targets", () => {
    const tree: PdfBookmarkObject[] = [
      { title: "First", target: { type: "destination", destination: { pageIndex: 0, zoom: { mode: PdfZoomMode.Unknown }, view: [] } }, children: [
        { title: "Nested", target: { type: "destination", destination: { pageIndex: 2, zoom: { mode: PdfZoomMode.Unknown }, view: [] } } },
      ] },
      { title: "No target" },
    ];
    const result = flattenPdfBookmarks(tree, 3);
    expect(result.entries.map(({ title, level, disabled }) => ({ title, level, disabled }))).toEqual([
      { title: "First", level: 1, disabled: false },
      { title: "Nested", level: 2, disabled: false },
      { title: "No target", level: 1, disabled: true },
    ]);
    expect(result.targets.get("pdf-outline-0.0")?.type).toBe("destination");
    expect(result.targets.has("pdf-outline-1")).toBe(false);
  });

  test("allows only credential-free HTTP(S) external link destinations", () => {
    expect(safePdfExternalUrl("https://example.org/path?q=1")).toBe("https://example.org/path?q=1");
    expect(safePdfExternalUrl("http://example.org")).toBe("http://example.org/");
    for (const unsafe of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,bad", "//example.org", "https://user:pass@example.org"]) {
      expect(safePdfExternalUrl(unsafe)).toBeNull();
    }
  });

  test("fail-closes unsafe native bookmark actions while allowing same-document Goto", () => {
    const target = (type: PdfActionType): PdfLinkTarget => ({ type: "action", action: { type, ...(type === PdfActionType.Goto || type === PdfActionType.RemoteGoto ? { destination: { pageIndex: 0, zoom: { mode: PdfZoomMode.Unknown }, view: [] } } : type === PdfActionType.LaunchAppOrOpenFile ? { path: "/tmp/untrusted" } : {}) } } as PdfLinkTarget);
    const result = flattenPdfBookmarks([
      { title: "Goto", target: target(PdfActionType.Goto) },
      { title: "Remote", target: target(PdfActionType.RemoteGoto) },
      { title: "Launch", target: target(PdfActionType.LaunchAppOrOpenFile) },
      { title: "Unsupported", target: target(PdfActionType.Unsupported) },
      { title: "Bad destination", target: { type: "destination", destination: { pageIndex: 99 } } as unknown as PdfLinkTarget },
    ], 1);
    expect(result.entries.map(({ title, disabled }) => [title, disabled])).toEqual([
      ["Goto", false],
      ["Remote", true],
      ["Launch", true],
      ["Unsupported", true],
      ["Bad destination", true],
    ]);
    expect([...result.targets.keys()]).toEqual(["pdf-outline-0"]);
  });
});
