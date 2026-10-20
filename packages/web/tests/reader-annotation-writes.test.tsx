/**
 * What the user's page does when annotations are written by someone else, such as the Copilot (ticket 19). The real
 * Shell, DocPane, ReaderSession, store and annotation layer are rendered over a stubbed HTTP; only the Copilot panel
 * and the WebSocket are replaced. The write itself is made by the server's shared PUT handler (server tests); here the
 * stored file changes and the page is notified exactly as the real WebSocket does, and everything the user sees and
 * keeps is the real page: the lists, the popover, the retained drafts and the page the assistant is told.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import {
  type CopilotViewAction,
  type PageContext,
  type TexDocIr,
} from "@argelanderspace/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/argelander/Shell";
import i18n from "../src/i18n";
import { installShellHarness } from "./shell-harness";

vi.setConfig({ testTimeout: 30000 });
const h = vi.hoisted(() => ({
  viewAction: null as null | ((action: unknown) => Promise<{ ok: boolean; detail?: string }>),
  context: null as null | PageContext,
  seen: [] as PageContext[],
  library: new Set<() => void>(),
  annotation: new Set<(id: string) => void>(),
}));
vi.mock("../src/api/ws", async () =>
  (await import("./shell-stubs")).quietWs({
    onLibraryChanged: (cb: () => void) => {
      h.library.add(cb);
      return () => h.library.delete(cb);
    },
    onAnnotationChanged: (cb: (id: string) => void) => {
      h.annotation.add(cb);
      return () => h.annotation.delete(cb);
    },
  })
);
vi.mock("../src/copilot/Copilot", async () => (await import("./shell-stubs")).copilotProbe(h));

const golden = JSON.parse(
  readFileSync(fileURLToPath(new NodeURL("../../../tests/golden/tex/arxiv-2501.17225.json", import.meta.url)), "utf8")
) as TexDocIr;
const END = "UNIQUE-LAST-PARAGRAPH-MARKER-5c1d";
const DOC = golden.docId;
/** The golden paper (38 sections, 25 figures, 4 tables, 76 references) with one unique paragraph at the very end. */
function longIr(): TexDocIr {
  const ir = structuredClone(golden);
  let last = ir.sections[ir.sections.length - 1]!;
  while (last.children.length) last = last.children[last.children.length - 1]!;
  last.blocks.push({ id: "p-end", type: "paragraph", segments: [{ type: "text", text: END }] });
  return ir;
}
function assetsOf(ir: TexDocIr) {
  const paths = new Set<string>();
  const walk = (sections: TexDocIr["sections"]) => {
    for (const s of sections) {
      for (const b of s.blocks) if ((b.type === "figure" || b.type === "table") && b.imgPath) paths.add(b.imgPath);
      walk(s.children);
    }
  };
  walk(ir.sections);
  return [...paths].map((imgPath) => ({ imgPath, sha256: "a".repeat(64) }));
}
const FP = "fp-1";
let ir: TexDocIr;
let annotations: object[];
let fingerprint: string;
let rev: number;
let readStatus: number;
let hold: Promise<void> | null;
let descriptionStatus: number;
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

// The store observes blocks with IntersectionObserver (absent in happy-dom): report the first few as visible.
class IOStub {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(target: Element) {
    if (target.classList.contains("verified-figure")) return;
    const id = (target as HTMLElement).dataset?.blockId;
    if (id === "p-1" || id === "p-2")
      this.cb([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
const scrolled: Element[] = [];
const realScrollIntoView = Element.prototype.scrollIntoView;

installShellHarness({
  papers: () => [DOC, "other-doc"],
  routes: async (url) => {
    if (url === "/api/plans") return ok({ version: 1, rev: 1, plans: [] });
    if (url === `/api/paper/${DOC}/description`)
      return descriptionStatus === 200 ? ok({ doc_id: DOC, format: "latex" }) : ({ ok: false, status: descriptionStatus, json: async () => ({}) } as unknown as Response);
    if (url === `/api/paper/${DOC}/annotations?coherent=1`) {
      if (hold) await hold;
      if (readStatus !== 200) return { ok: false, status: readStatus, json: async () => ({}) } as unknown as Response;
      return ok({ version: 1, ir, file: { version: 1, rev, content_fingerprint: fingerprint, annotations }, assets: assetsOf(ir) });
    }
    return null;
  },
});
beforeEach(() => {
  ir = longIr();
  annotations = [];
  fingerprint = FP;
  rev = 0;
  readStatus = 200;
  hold = null;
  descriptionStatus = 200;
  h.viewAction = null;
  h.context = null;
  h.seen = [];
  h.library.clear();
  h.annotation.clear();
  scrolled.length = 0;
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolled.push(this);
  });
  vi.stubGlobal("IntersectionObserver", IOStub);
});
afterEach(() => {
  Element.prototype.scrollIntoView = realScrollIntoView;
});

const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const qa = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const run = async (action: CopilotViewAction) => h.viewAction!(action);
const reader = () => h.context!.reader!;


const NOTE = (id: string, body: string, target: object = { type: "document" }) => ({
  id,
  target,
  body,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});
/** What the server's PUT handler leaves behind for another writer, then the notification the page gets. */
async function elsewhere(next: object[], nextRev: number, nextFingerprint = fingerprint) {
  annotations = next;
  rev = nextRev;
  fingerprint = nextFingerprint;
  act(() => {
    for (const cb of [...h.annotation]) cb(DOC);
  });
}
async function boot() {
  render(<Shell />);
  await waitFor(() => expect(h.viewAction).not.toBeNull());
  expect(await run({ action: "switch_view", view: "doc" })).toEqual({ ok: true });
  await waitFor(() => expect(h.context?.reader?.reading).toBeTruthy(), { timeout: 10000 });
  expect(await run({ action: "set_right_tab", docId: DOC, tab: "annotations" })).toEqual({ ok: true });
  await waitFor(() => expect(q('[data-ui="latex-annotations-list"]')).not.toBeNull());
}
const type = (el: Element, value: string) => fireEvent.change(el, { target: { value } });

describe("an annotation written by the Copilot", () => {
  it("shows in the page's list, and the page context at once, without a reload", async () => {
    await boot();
    expect(qa('[data-ui="latex-annotation"]')).toHaveLength(0);
    await elsewhere(
      [NOTE("a_0000aaaa", "agent wrote this", { type: "structure", id: "p-3", kind: "paragraph", snapshot: { text: "x" } })],
      1
    );
    await waitFor(() => expect(qa('[data-ui="latex-annotation"]').map((e) => e.getAttribute("data-ui-key"))).toEqual(["a_0000aaaa"]));
    await waitFor(() => expect(reader().reading?.annotations.map((a) => a.body)).toEqual(["agent wrote this"]));
    await waitFor(() => expect(reader().reading?.epoch.annotationsRev).toBe(1));
    expect(qa('[data-ui="latex-annotation"]')[0]?.textContent).toContain("agent wrote this");
    // and it opens like any other (the same navigation the user's list click and the model's navigate use)
    expect(await run({ action: "navigate", docId: DOC, anchor: "ann-a_0000aaaa" })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="latex-annotation-popover"]')).not.toBeNull());
    expect(q('[data-ui="latex-annotation-body"]')?.textContent).toContain("agent wrote this");
  });

  it("is shown safely: raw HTML, images and script links are text, math and code stay, the stored bytes are untouched", async () => {
    const body = [
      "<script>window.__pwned = 1</script>",
      "",
      '<img src="x" onerror="window.__pwned = 2">',
      "",
      '<a href="javascript:window.__pwned=3" onclick="window.__pwned=4">click</a>',
      "",
      "[js](javascript:window.__pwned=5) [ok](https://example.org/x) $x^2$",
      "",
      "```python",
      "print('<b>code</b>')",
      "```",
    ].join("\n");
    annotations = [NOTE("a_0000aaaa", body, { type: "structure", id: "p-3", kind: "paragraph", snapshot: { text: "x" } })];
    rev = 3;
    await boot();
    expect(await run({ action: "navigate", docId: DOC, anchor: "ann-a_0000aaaa" })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="latex-annotation-body"]')).not.toBeNull());
    const shown = q('[data-ui="latex-annotation-body"]') as HTMLElement;
    expect(shown.querySelector("script, img, iframe, [onerror], [onclick]")).toBeNull();
    expect([...shown.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["https://example.org/x"]);
    expect(shown.textContent).toContain("<script>window.__pwned = 1</script>");
    expect(shown.textContent).toContain("js"); // the unsafe link keeps its visible text
    expect(shown.querySelector(".katex")).not.toBeNull();
    expect(shown.querySelector("pre code")?.textContent).toContain("print('<b>code</b>')");
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    // what the model reads and what is stored are the original bytes
    expect(reader().reading?.annotations[0]?.body).toBe(body);
  });

  it("does not replace or save the user's unsaved edit: the draft stays, cannot be saved over the changed annotation, and the page says so", async () => {
    annotations = [NOTE("a_0000aaaa", "original")];
    rev = 1;
    await boot();
    fireEvent.click(q('[data-ui="edit-latex-annotation"]') as HTMLElement);
    const box = () => q('[data-ui="latex-annotation-body-input"]') as HTMLTextAreaElement;
    await waitFor(() => expect(box()).not.toBeNull());
    type(box(), "MY UNSAVED WORDS");
    await waitFor(() => expect(reader().drafts).toEqual({ create: false, edit: [{ annotationId: "a_0000aaaa", blocked: false }] }));
    // the Copilot changes that very annotation
    await elsewhere([NOTE("a_0000aaaa", "agent rewrote it")], 2);
    await waitFor(() => expect(reader().reading?.annotations[0]?.body).toBe("agent rewrote it"));
    await waitFor(() => expect(reader().drafts).toEqual({ create: false, edit: [{ annotationId: "a_0000aaaa", blocked: true }] }));
    // the page keeps the words where it keeps every retained draft, and the editor that is reopened cannot save them
    await waitFor(() => expect((q('[data-ui="retained-edit-body"]') as HTMLTextAreaElement | null)?.value).toBe("MY UNSAVED WORDS"));
    await waitFor(() => expect(q('[data-ui="edit-latex-annotation"]')).not.toBeNull());
    fireEvent.click(q('[data-ui="edit-latex-annotation"]') as HTMLElement);
    await waitFor(() => expect(box()).not.toBeNull());
    expect(box().value).toBe("MY UNSAVED WORDS");
    expect((q('[data-ui="save-latex-annotation"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain(i18n.t("annotation.editor.blocked"));
    expect(annotations[0]).toMatchObject({ body: "agent rewrote it" }); // nothing of the draft was written
  });

  it("does not clear the user's unsaved new annotation text, and an annotation the user is typing is not saved for them", async () => {
    await boot();
    fireEvent.click(q('[data-ui="add-document-annotation"]') as HTMLElement);
    const box = () => q('[data-ui="latex-annotation-body-input"]') as HTMLTextAreaElement;
    await waitFor(() => expect(box()).not.toBeNull());
    type(box(), "half a thought");
    await waitFor(() => expect(reader().drafts).toEqual({ create: true, edit: [] }));
    await elsewhere([NOTE("a_0000aaaa", "agent note")], 1);
    await waitFor(() => expect(qa('[data-ui="latex-annotation"]')).toHaveLength(1));
    await waitFor(() => expect((q('[data-ui="retained-create-body"]') as HTMLTextAreaElement | null)?.value).toBe("half a thought"));
    expect(reader().drafts).toEqual({ create: true, edit: [] });
    expect(annotations).toHaveLength(1);
  });

  it("a draft across a replaced document is kept but cannot be saved, even when the annotation id is reused", async () => {
    annotations = [NOTE("a_0000aaaa", "original")];
    rev = 1;
    await boot();
    fireEvent.click(q('[data-ui="edit-latex-annotation"]') as HTMLElement);
    const box = () => q('[data-ui="latex-annotation-body-input"]') as HTMLTextAreaElement;
    await waitFor(() => expect(box()).not.toBeNull());
    type(box(), "typed on the old text");
    // the document is replaced: another fingerprint, its own annotations (this id happens to be reused)
    await elsewhere([NOTE("a_0000aaaa", "original")], 0, "fp-2");
    await waitFor(() => expect(h.context?.reader?.reading?.epoch.fingerprint).toBe("fp-2"), { timeout: 5000 });
    await waitFor(() => expect(reader().drafts).toEqual({ create: false, edit: [{ annotationId: "a_0000aaaa", blocked: true }] }));
    await waitFor(() => expect((q('[data-ui="retained-edit-body"]') as HTMLTextAreaElement | null)?.value).toBe("typed on the old text"));
    await waitFor(() => expect(q('[data-ui="edit-latex-annotation"]')).not.toBeNull());
    fireEvent.click(q('[data-ui="edit-latex-annotation"]') as HTMLElement);
    await waitFor(() => expect(box()).not.toBeNull());
    expect(box().value).toBe("typed on the old text");
    expect((q('[data-ui="save-latex-annotation"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("deleted by the Copilot while its popover is open: the popover closes, the list drops it, the page context no longer has it", async () => {
    annotations = [NOTE("a_0000aaaa", "soon gone", { type: "structure", id: "p-3", kind: "paragraph", snapshot: { text: "x" } })];
    rev = 1;
    await boot();
    expect(await run({ action: "navigate", docId: DOC, anchor: "ann-a_0000aaaa" })).toEqual({ ok: true });
    await waitFor(() => expect(h.context?.reader?.openAnnotationId).toBe("a_0000aaaa"));
    await elsewhere([], 2);
    await waitFor(() => expect(q('[data-ui="latex-annotation-popover"]')).toBeNull());
    await waitFor(() => expect(qa('[data-ui="latex-annotation"]')).toHaveLength(0));
    await waitFor(() => expect(reader().reading?.annotations).toEqual([]));
    await waitFor(() => expect(reader().openAnnotationId).toBeNull());
  });
});
