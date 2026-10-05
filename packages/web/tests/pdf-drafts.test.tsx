import { cleanup, render } from "@testing-library/react";
import type { PdfAnnotationsFile } from "@argelanderspace/contracts";
import { PdfPageSchema } from "@argelanderspace/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfAnnotationSession } from "../src/doc/PdfAnnotationSession";
import { PdfAnnotationsPanel } from "../src/doc/PdfAnnotationsPanel";
import { pdfDraftsView } from "../src/doc/pdf-view-actions";
import i18n from "../src/i18n";

vi.mock("../src/api/ws", () => ({ onAnnotationChanged: () => () => undefined }));
afterEach(cleanup);

const sha = "a".repeat(64);
const at = "2026-10-05T10:00:00.000Z";
const file = (annotations: PdfAnnotationsFile["annotations"]): PdfAnnotationsFile => ({ version: 1, doc_id: "pdf-d", content_sha256: sha, rev: 1, annotations });

describe("the user's unsaved panel text (copilot ticket 21)", () => {
  it("is reported to the Copilot as presence and blocked state only", () => {
    const view = pdfDraftsView(
      { "pann_a": "typed, changed", "pann_same": "same body", "pann_gone": "deleted elsewhere", "draft:1": "new", "style:pann_a": "{}" },
      [{ id: "pann_a", body: "old" }, { id: "pann_same", body: "same body" }],
      false
    );
    expect(view).toEqual({ create: true, edit: [{ annotationId: "pann_a", blocked: false }, { annotationId: "pann_gone", blocked: false }] });
    expect(JSON.stringify(view)).not.toContain("typed");
    expect(pdfDraftsView({ pann_a: "x" }, [{ id: "pann_a", body: "y" }], true).edit[0]?.blocked).toBe(true);
    expect(pdfDraftsView({}, [], false)).toEqual({ create: false, edit: [] });
  });

  it("is accepted by the page contract", () => {
    const base = { docId: "pdf-d", format: "pdf", phase: "ready", sha256: sha, pageCount: 2, currentPage: 0, zoom: null, outline: [], outlineTruncated: false, search: null, selection: null, panels: { outlineCollapsed: false, annotationsCollapsed: false } };
    expect(PdfPageSchema.safeParse({ ...base, drafts: { create: false, edit: [{ annotationId: "pann_a", blocked: false }] } }).success).toBe(true);
    expect(PdfPageSchema.safeParse({ ...base, drafts: { create: false, edit: [{ annotationId: "pann_a", blocked: false, text: "no" }] } }).success).toBe(false);
  });

  it("stays visible and recoverable when the annotation it was for is gone, even though the panel is not blocked", async () => {
    await i18n.changeLanguage("en");
    const session = new PdfAnnotationSession("pdf-d", sha, file([{ id: "pann_a", kind: "document_comment", body: "agent text", created_at: at, updated_at: at }]));
    session.start();
    session.setDraft("pann_a", "what the user was typing");
    // the annotation is deleted elsewhere (the Copilot) and the session takes the new file
    (session as unknown as { state: { file: PdfAnnotationsFile } }).state.file = file([]);
    const { container } = render(<PdfAnnotationsPanel session={session} currentPage={0} onNavigatePage={() => undefined} />);
    const draft = container.querySelector('[data-ui="pdf-annotation-draft"]') as HTMLElement;
    expect(draft).toBeTruthy();
    expect((draft.querySelector("textarea") as HTMLTextAreaElement).value).toBe("what the user was typing");
    expect(draft.querySelector('[data-ui="copy-pdf-draft"]')).toBeTruthy();
    expect(draft.querySelector('[data-ui="discard-pdf-pending"]')).toBeTruthy();
    session.stop();
  });

  it("does not list the text of a new comment being written, or a draft of an annotation that is still there", async () => {
    await i18n.changeLanguage("en");
    const session = new PdfAnnotationSession("pdf-d", sha, file([{ id: "pann_a", kind: "document_comment", body: "agent text", created_at: at, updated_at: at }]));
    session.start();
    session.setDraft("pann_a", "editing in place");
    session.setDraft("draft:new", "a new comment");
    const { container } = render(<PdfAnnotationsPanel session={session} currentPage={0} onNavigatePage={() => undefined} />);
    expect(container.querySelector('[data-ui="pdf-annotation-draft"]')).toBeNull();
    session.stop();
  });
});
