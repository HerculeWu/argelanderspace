import { cleanup, render } from "@testing-library/react";
import type { PdfAnnotationsFile } from "@argelanderspace/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfAnnotationSession } from "../src/doc/PdfAnnotationSession";
import { PdfAnnotationsPanel } from "../src/doc/PdfAnnotationsPanel";
import i18n from "../src/i18n";

vi.mock("../src/api/ws", () => ({ onAnnotationChanged: () => () => undefined }));

const sha = "a".repeat(64);
const at = "2026-10-05T10:00:00.000Z";
afterEach(cleanup);

describe("a PDF annotation body is written by the user, a model or a pasted text: shown safely (copilot ticket 21)", () => {
  it("shows live HTML and images as text, keeps http links and math, and never runs a script or an event handler", async () => {
    await i18n.changeLanguage("en");
    const hostile = [
      "plain **bold** and $x^2$",
      '<img src=x onerror="window.__pwned=1"> <script>window.__pwned=2</script>',
      "[ok](https://example.org/a) [bad](javascript:window.__pwned=3)",
    ].join("\n\n");
    const file: PdfAnnotationsFile = {
      version: 1,
      doc_id: "pdf-safe",
      content_sha256: sha,
      rev: 1,
      annotations: [{ id: "pann_1", kind: "document_comment", body: hostile, created_at: at, updated_at: at }],
    };
    const session = new PdfAnnotationSession("pdf-safe", sha, file);
    session.start();
    const { container } = render(<PdfAnnotationsPanel session={session} currentPage={0} onNavigatePage={() => undefined} />);
    const body = container.querySelector('[data-ui="pdf-annotation-body"]') as HTMLElement;
    expect(body.querySelector("img")).toBeNull();
    expect(body.querySelector("script")).toBeNull();
    for (const element of body.querySelectorAll("*"))
      expect([...element.attributes].filter((attribute) => /^on/i.test(attribute.name))).toEqual([]);
    expect(body.textContent).toContain("<img");
    expect(body.querySelector("strong")?.textContent).toBe("bold");
    expect(body.querySelector(".katex")).toBeTruthy();
    const links = [...body.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.org/a"]);
    expect(body.innerHTML).not.toMatch(/href="javascript:/i);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    session.stop();
  });
});
