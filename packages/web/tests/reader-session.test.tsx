import { createHash } from "node:crypto";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode, useMemo, useState } from "react";
import type { Annotation, CoherentAnnotationsRead, TexDocIr } from "@argelanderspace/contracts";
import { ReaderSessionController } from "../src/doc/ReaderSession";
import { DocPane } from "../src/doc/DocPane";
import { parseDocRoute } from "../src/lib/deeplink";
import { WorkspaceProvider, type Workspace } from "../src/argelander/workspace";

const events = vi.hoisted(() => ({
  library: new Set<() => void>(),
  annotation: new Set<(id: string) => void>(),
}));
vi.mock("../src/api/ws", () => ({
  onLibraryChanged: (cb: () => void) => {
    events.library.add(cb);
    return () => events.library.delete(cb);
  },
  onAnnotationChanged: (cb: (id: string) => void) => {
    events.annotation.add(cb);
    return () => events.annotation.delete(cb);
  },
}));
function representation(text = "A", rev = 100, fp = text): CoherentAnnotationsRead {
  const ir: TexDocIr = {
    version: 1,
    docId: "synthetic",
    title: `Title ${text}`,
    source: { type: "latex", origin: "synthetic", main_tex: "main.tex" },
    meta: {},
    sections: [
      {
        id: "sec-1",
        level: 1,
        heading: "Heading",
        blocks: [
          { id: "p-1", type: "paragraph", segments: [{ type: "text", text: `Real body ${text}` }] },
        ],
        children: [],
      },
    ],
    refsManifest: [],
    bib: [],
    citationsByBlock: {},
  };
  return {
    version: 1,
    ir,
    file: { version: 1, rev, content_fingerprint: fp, annotations: [] },
    assets: [],
  };
}
const annotation = (body = "original"): Annotation => ({
  id: "a_12345678",
  target: { type: "structure", id: "p-1", kind: "paragraph", snapshot: { text: "Real body A" } },
  body,
  created_at: "2026-09-13T00:00:00.000Z",
  updated_at: "2026-09-13T00:00:00.000Z",
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
interface Pending {
  url: string;
  init?: RequestInit;
  resolve: (r: Response) => void;
}
let pending: Pending[];
let controllers: ReaderSessionController[];
function makeController() {
  const c = new ReaderSessionController("synthetic");
  controllers.push(c);
  c.start();
  return c;
}
async function answer(index: number, value: unknown, status = 200) {
  await act(async () => {
    pending[index]!.resolve(json(value, status));
  });
}
async function startReady(value = representation()) {
  const c = makeController();
  await answer(0, value);
  expect(c.getSnapshot().phase).toBe("ready");
  return c;
}
class IO {
  static images: { callback: IntersectionObserverCallback; target: Element }[] = [];
  constructor(private callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    if (target.classList.contains("verified-figure")) {
      IO.images.push({ callback: this.callback, target });
      return;
    }
    this.callback(
      [{ target, isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    );
  }
  disconnect() {}
  static reveal() {
    for (const { callback, target } of IO.images)
      callback(
        [{ target, isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
  }
}
const realScroll = Element.prototype.scrollIntoView;
beforeEach(() => {
  pending = [];
  controllers = [];
  IO.images = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => pending.push({ url: String(url), init, resolve }))
    )
  );
  vi.stubGlobal("IntersectionObserver", IO);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  for (const c of controllers) c.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Element.prototype.scrollIntoView = realScroll;
});

function renderDoc(anchor: string | null = null, strict = false) {
  let changeAnchor: (anchor: string) => void = () => {};
  function Harness() {
    const [pendingAnchor, setAnchor] = useState(anchor);
    changeAnchor = setAnchor;
    const ws: Workspace = useMemo(
      () => ({
        papers: ["synthetic"],
        currentDoc: "synthetic",
        setCurrentDoc: () => {},
        openDoc: () => {},
        pendingAnchor,
        clearPendingAnchor: () => setAnchor(null),
        docDeleted: () => {},
        tweaks: { theme: "dark", accent: "azure", density: "regular", labels: true },
      }),
      [pendingAnchor]
    );
    return (
      <WorkspaceProvider value={ws}>
        <DocPane />
      </WorkspaceProvider>
    );
  }
  const result = render(
    strict ? (
      <StrictMode>
        <Harness />
      </StrictMode>
    ) : (
      <Harness />
    )
  );
  return { ...result, setAnchor: (anchor: string) => act(() => changeAnchor(anchor)) };
}
const notify = () =>
  act(() => {
    for (const cb of events.library) cb();
  });

describe("ReaderSession request authority", () => {
  it("single-flight dirty trailing accepts real B rev0 after A rev100; latest same-fp rev0 and metadata also win", async () => {
    const c = await startReady();
    c.requestSync();
    for (let i = 0; i < 30; i++) c.requestSync();
    expect(pending).toHaveLength(2);
    await answer(1, representation("obsolete", 101));
    expect(c.getSnapshot().phase).toBe("syncing");
    expect(pending).toHaveLength(3);
    await answer(2, representation("B", 0));
    expect(c.getSnapshot().accepted?.ir.title).toBe("Title B");
    c.requestSync();
    await answer(3, representation("metadata update", 0, "B"));
    expect(c.getSnapshot().accepted?.ir.title).toBe("Title metadata update");
    expect(c.getSnapshot().accepted?.file.rev).toBe(0);
    expect(pending).toHaveLength(4);
  });
  it("manual supersession and stopped doc reject late responses even when abort is ignored", async () => {
    const c = makeController();
    c.retry();
    await answer(1, representation("B", 0));
    await answer(0, representation("A", 999));
    expect(c.getSnapshot().accepted?.ir.title).toBe("Title B");
    c.requestSync();
    c.stop();
    await answer(2, representation("C"));
    expect(c.getSnapshot().accepted?.ir.title).toBe("Title B");
  });
  it("same-fingerprint current deletion resets a high rev to zero", async () => {
    const c = await startReady();
    c.requestSync();
    await answer(1, representation("A", 0));
    expect(c.getSnapshot().accepted?.file.rev).toBe(0);
  });
  it("PUT + notifications serialize; late successful file cannot make old text ready", async () => {
    const c = await startReady();
    const a = c.getSnapshot().accepted!;
    const saving = c.persist(
      { ...a.file, annotations: [annotation()] },
      c.getSnapshot().generation
    );
    c.requestSync();
    c.requestSync();
    expect(pending).toHaveLength(2);
    expect(await c.persist(a.file, c.getSnapshot().generation)).toBe(false);
    await answer(1, { ...a.file, rev: 101, annotations: [annotation()] });
    expect(await saving).toBe(true);
    expect(c.getSnapshot().phase).toBe("syncing");
    expect(c.getSnapshot().accepted?.file.rev).toBe(100);
    expect(pending).toHaveLength(3);
    await answer(2, representation("B", 0));
    expect(c.getSnapshot().accepted?.ir.title).toBe("Title B");
  });
  it("PUT 409 file is not IR evidence; reload failure preserves old text and freezes writes", async () => {
    const c = await startReady();
    const a = c.getSnapshot().accepted!;
    const saving = c.persist(a.file, c.getSnapshot().generation);
    await answer(1, { detail: "document changed", file: representation("B", 0).file }, 409);
    expect(await saving).toBe(false);
    expect(c.getSnapshot().accepted).toBe(a);
    expect(pending).toHaveLength(3);
    await answer(2, { detail: "bad IR" }, 500);
    c.requestSync();
    c.requestSync();
    expect(pending).toHaveLength(3);
    expect(c.canAnnotate()).toBe(false);
    expect(c.getSnapshot().accepted?.ir.title).toBe("Title A");
  });
  it("ordinary busy can wake once notified, errors cannot; no polling", async () => {
    const c = makeController();
    await answer(0, { detail: "document busy" }, 409);
    expect(c.getSnapshot().reason).toBe("busy");
    expect(pending).toHaveLength(1);
    c.requestSync();
    await answer(1, representation());
    c.requestSync();
    await answer(2, {}, 500);
    c.requestSync();
    expect(pending).toHaveLength(3);
    c.retry();
    await answer(3, representation("B", 0));
    expect(c.canAnnotate()).toBe(true);
  });
  it("external draft-body conflicts and cross-fp reused ids remain blocked", async () => {
    const a = representation();
    a.file.annotations = [annotation()];
    const c = await startReady(a);
    c.beginEdit(annotation());
    c.setEditBody(annotation().id, "  draft\n");
    c.requestSync();
    await answer(1, a);
    expect(c.getSnapshot().editDrafts[annotation().id]?.blocked).toBe(false);
    const changed = representation("B", 0);
    changed.file.annotations = [annotation()];
    c.requestSync();
    await answer(2, changed);
    expect(c.getSnapshot().editDrafts[annotation().id]).toMatchObject({
      body: "  draft\n",
      blocked: true,
      sourceFingerprint: "A",
    });
    c.requestSync();
    await answer(3, a);
    expect(c.getSnapshot().editDrafts[annotation().id]?.blocked).toBe(true);
  });
  it("protocol-invalid manifest and IR doc identity fail closed", async () => {
    const c = makeController();
    const a = representation();
    a.assets = [{ imgPath: "unreferenced.svg", sha256: "a".repeat(64) }];
    await answer(0, a);
    expect(c.getSnapshot().phase).toBe("error");
    c.retry();
    const b = representation();
    b.ir.docId = "other";
    await answer(1, b);
    expect(c.getSnapshot().accepted).toBeNull();
    expect(c.canAnnotate()).toBe(false);
  });
  it("a same-fp external body change blocks an edit without overwriting its bytes", async () => {
    const a = representation();
    a.file.annotations = [annotation()];
    const c = await startReady(a);
    c.beginEdit(annotation());
    c.setEditBody(annotation().id, "mine");
    c.requestSync();
    const b = representation("A", 101);
    b.file.annotations = [annotation("external")];
    await answer(1, b);
    expect(c.getSnapshot().editDrafts[annotation().id]).toMatchObject({
      body: "mine",
      blocked: true,
    });
  });
});

describe("strict shared asset recovery episode", () => {
  const withAsset = () => {
    const a = representation();
    a.ir.sections[0]!.blocks.push({ id: "fig-1", type: "figure", imgPath: "assets/a.svg" });
    a.assets = [{ imgPath: "assets/a.svg", sha256: "a".repeat(64) }];
    return a;
  };
  const binding = (c: ReaderSessionController) => ({
    docId: c.docId,
    generation: c.getSnapshot().generation,
    ...withAsset().assets[0]!,
  });
  it("many failing images spend only one GET; invalidate before R1 and external after cannot create R2", async () => {
    const c = await startReady(withAsset());
    const b = binding(c);
    c.reportAssetFailure(b, "changed");
    c.reportAssetFailure(b, "changed");
    expect(pending).toHaveLength(2);
    c.requestSync();
    expect(c.getSnapshot().phase).toBe("error");
    await answer(1, withAsset());
    c.requestSync();
    expect(pending).toHaveLength(2);
    expect(c.getSnapshot().accepted?.ir.title).toBe("Title A");
  });
  it("R1 may recover without notices, but a later notification still exhausts the episode", async () => {
    const c = await startReady(withAsset());
    c.reportAssetFailure(binding(c), "changed");
    await answer(1, withAsset());
    expect(c.canAnnotate()).toBe(true);
    c.requestSync();
    expect(c.getSnapshot().phase).toBe("error");
    expect(pending).toHaveLength(2);
    c.retry();
    await answer(2, withAsset());
    c.reportAssetFailure(binding(c), "changed");
    expect(pending).toHaveLength(4);
  });
  it.each([409, 500])(
    "R1 failure %s is terminal, including busy wake and trailing notifications",
    async (status) => {
      const c = await startReady(withAsset());
      c.reportAssetFailure(binding(c), "changed");
      await answer(1, { detail: "document busy" }, status);
      c.requestSync();
      c.requestSync();
      expect(c.getSnapshot().phase).toBe("error");
      expect(pending).toHaveLength(2);
    }
  );
  it("second mismatch after temporary ready stops; stale generation failure is ignored", async () => {
    const c = await startReady(withAsset());
    const old = binding(c);
    c.reportAssetFailure(old, "changed");
    await answer(1, withAsset());
    c.reportAssetFailure(old, "error");
    expect(c.canAnnotate()).toBe(true);
    c.reportAssetFailure(binding(c), "changed");
    expect(c.getSnapshot().phase).toBe("error");
    expect(pending).toHaveLength(2);
  });
  it("a mismatch during PUT waits for settle and shares the same budget with WS", async () => {
    const c = await startReady(withAsset());
    const saving = c.persist(c.getSnapshot().accepted!.file, c.getSnapshot().generation);
    c.reportAssetFailure(binding(c), "changed");
    expect(pending).toHaveLength(2);
    await answer(1, { ...withAsset().file, rev: 101 });
    expect(await saving).toBe(true);
    expect(pending).toHaveLength(3);
    c.requestSync();
    await answer(2, withAsset());
    c.requestSync();
    expect(pending).toHaveLength(3);
  });
  it("image busy waits for an ordinary notification without spending an asset retry", async () => {
    const c = await startReady(withAsset());
    c.reportAssetFailure(binding(c), "busy");
    expect(c.getSnapshot()).toMatchObject({ phase: "syncing", reason: "busy" });
    expect(pending).toHaveLength(1);
    c.requestSync();
    await answer(1, withAsset());
    c.reportAssetFailure(binding(c), "changed");
    expect(pending).toHaveLength(3);
  });
});

describe("DocPane coherent integration and protected drafts", () => {
  it("StrictMode replay rejects the aborted first GET and preserves working navigation with one deep-link consumption", async () => {
    const { container } = renderDoc("p-1", true);
    expect(pending).toHaveLength(2);
    await answer(1, representation());
    await answer(0, representation("late"));
    expect(container.querySelector("main.reader")?.textContent).toContain("Real body A");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
  });
  it("retains the SAME main/old text while syncing; commits real changed IR and new snapshot only after coherent response", async () => {
    const { container } = renderDoc();
    await answer(0, representation());
    const main = container.querySelector("main.reader")!;
    fireEvent.click(main.querySelector("[data-block-id='p-1'] .ann-edge-btn")!);
    const ta = main.querySelector("textarea")!;
    fireEvent.change(ta, { target: { value: "  creation\n" } });
    notify();
    expect(container.querySelector("main.reader")).toBe(main);
    expect(main.textContent).toContain("Real body A");
    expect(main.querySelector(".ann-popover")).toBeNull();
    expect(
      container.querySelector<HTMLTextAreaElement>("[aria-label='保留的创建草稿']")?.value
    ).toBe("  creation\n");
    const b = representation("B", 0);
    b.ir.sections[0]!.blocks[0]!.id = "p-2";
    await answer(1, b);
    expect(container.querySelector("main.reader")).toBe(main);
    expect(main.textContent).toContain("Real body B");
    expect(main.textContent).not.toContain("Real body A");
    fireEvent.click(main.querySelector("[data-block-id='p-2'] .ann-edge-btn")!);
    expect(main.querySelector("textarea")?.value).toBe("");
    fireEvent.click(
      [...main.querySelectorAll("button")].find((b) => b.textContent === "使用保留文字")!
    );
    fireEvent.keyDown(main.querySelector("textarea")!, { key: "Enter", ctrlKey: true });
    const put = JSON.parse(String(pending[2]!.init?.body));
    expect(put).toMatchObject({
      content_fingerprint: "B",
      rev: 0,
      annotations: [
        { body: "  creation\n", target: { id: "p-2", snapshot: { text: "Real body B" } } },
      ],
    });
  });
  it("late PUT success clears only the submitted draft revision, not later typing", async () => {
    const { container } = renderDoc();
    await answer(0, representation());
    fireEvent.click(container.querySelector("[data-block-id='p-1'] .ann-edge-btn")!);
    const ta = container.querySelector(".ann-popover textarea")!;
    fireEvent.change(ta, { target: { value: "submitted" } });
    fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true });
    fireEvent.change(ta, { target: { value: "later unsaved\n" } });
    const put = JSON.parse(String(pending[1]!.init?.body));
    await answer(1, { ...put, rev: 101 });
    expect(container.querySelector<HTMLTextAreaElement>(".ann-popover textarea")?.value).toBe(
      "later unsaved\n"
    );
    expect(
      container.querySelector<HTMLTextAreaElement>("[aria-label='保留的创建草稿']")?.value
    ).toBe("later unsaved\n");
  });
  it("editing survives sync/error/missing visibly, with blocked reused id after changed fp", async () => {
    const a = representation();
    a.file.annotations = [annotation()];
    const { container } = renderDoc();
    await answer(0, a);
    fireEvent.click(container.querySelector(".ann-marker")!);
    fireEvent.click(
      [...container.querySelectorAll(".ann-popover button")].find((b) =>
        b.textContent?.includes("编辑")
      )!
    );
    fireEvent.change(container.querySelector(".ann-popover textarea")!, {
      target: { value: " protected edit \n" },
    });
    notify();
    await answer(1, {}, 500);
    const retained = "[aria-label='保留的编辑草稿 a_12345678']";
    expect(container.querySelector<HTMLTextAreaElement>(retained)?.value).toBe(
      " protected edit \n"
    );
    fireEvent.click(container.querySelector(".reader-sync-status button")!);
    const b = representation("B", 0);
    b.file.annotations = [annotation()];
    await answer(2, b);
    expect(container.querySelector(".reader-drafts")?.textContent).toContain("不可保存");
    notify();
    await answer(3, {}, 404);
    expect(container.querySelector("main.reader")).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>(retained)?.value).toBe(
      " protected edit \n"
    );
  });
  it("deep link waits through error until manual successful read", async () => {
    const { container } = renderDoc("p-1");
    await answer(0, {}, 500);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector(".reader-sync-status button")!);
    await answer(1, representation("B", 0));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
  });
  it("fresh text selection and highlight ranges use the real accepted B DOM, not A offsets", async () => {
    const registry = new Map<string, unknown>();
    vi.stubGlobal("CSS", { escape: (s: string) => s, highlights: registry });
    vi.stubGlobal(
      "Highlight",
      class {
        priority = 0;
        ranges: Range[];
        constructor(...ranges: Range[]) {
          this.ranges = ranges;
        }
      }
    );
    const a = representation();
    a.file.annotations = [
      {
        ...annotation(),
        target: {
          type: "text",
          block: "p-1",
          container: { type: "content" },
          start: 0,
          end: 4,
          quote: "Real",
        },
      },
    ];
    const { container } = renderDoc();
    await answer(0, a);
    expect(registry.size).toBe(1);
    expect((Array.from(registry.values())[0] as { ranges: Range[] }).ranges[0]?.toString()).toBe(
      "Real"
    );
    notify();
    expect(registry.size).toBe(0);
    expect(container.querySelector(".ann-count")).toBeNull();
    await answer(1, representation("B", 0));
    const paragraph = container.querySelector("[data-block-id='p-1']")!;
    const text = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT).nextNode()!;
    vi.useFakeTimers();
    act(() => {
      window.getSelection()!.setBaseAndExtent(text, 5, text, 11);
      document.dispatchEvent(new Event("selectionchange"));
      vi.advanceTimersByTime(200);
    });
    fireEvent.click(container.querySelector(".ann-selbar button")!);
    const ta = container.querySelector(".ann-popover textarea")!;
    fireEvent.change(ta, { target: { value: "B selection" } });
    fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true });
    const put = JSON.parse(String(pending[2]!.init?.body));
    expect(put.annotations[0].target).toEqual({
      type: "text",
      block: "p-1",
      container: { type: "content" },
      start: 5,
      end: 11,
      quote: "body B",
    });
    expect(put.content_fingerprint).toBe("B");
  });
  it("ordinary deep link arriving during PUT remains pending until navigation is enabled", async () => {
    const { container, setAnchor } = renderDoc();
    await answer(0, representation());
    fireEvent.click(container.querySelector("[data-block-id='p-1'] .ann-edge-btn")!);
    const ta = container.querySelector(".ann-popover textarea")!;
    fireEvent.change(ta, { target: { value: "pending save" } });
    fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true });
    setAnchor("p-1");
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    const put = JSON.parse(String(pending[1]!.init?.body));
    await answer(1, { ...put, rev: 101 });
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
  });
  it("old ref deep-link timer cannot focus the new same-doc epoch after B is ready", async () => {
    const cited = (text: string) => {
      const value = representation(text, text === "A" ? 100 : 0);
      value.ir.references = [{ id: "ref-1", raw: `Reference ${text}` }];
      value.ir.citationsByBlock = { "p-1": ["ref-1"] };
      return value;
    };
    vi.useFakeTimers();
    const { container, setAnchor } = renderDoc("ref-1");
    await answer(0, cited("A"));
    act(() => vi.advanceTimersByTime(100));
    expect(container.querySelector("#ref-1")?.textContent).toContain("Reference A");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1); // initial body jump

    notify();
    await answer(1, cited("B"));
    act(() => vi.advanceTimersByTime(100));
    const card = container.querySelector("#ref-1")!;
    expect(card.textContent).toContain("Reference B");
    expect(container.querySelector("main.reader")?.textContent).toContain("Real body B");
    expect(container.querySelector(".reader-sync-status")).toBeNull();
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    act(() => vi.advanceTimersByTime(650)); // A's 850ms delayed focus now fires
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(card.classList.contains("focused")).toBe(false);

    setAnchor("ref-1"); // a new explicit B navigation still works
    vi.mocked(Element.prototype.scrollIntoView).mockClear();
    act(() => vi.advanceTimersByTime(850));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledExactlyOnceWith({
      block: "nearest",
      behavior: "smooth",
    });
    expect(card.classList.contains("focused")).toBe(true);
  });

  it("discarding an active edit draft restores the popover view and permits editing again", async () => {
    const value = representation();
    value.file.annotations = [annotation()];
    const { container } = renderDoc();
    await answer(0, value);
    fireEvent.click(container.querySelector(".ann-marker")!);
    const popover = container.querySelector(".ann-popover")!;
    const editButton = () =>
      [...popover.querySelectorAll("button")].find((b) => b.textContent?.includes("编辑"))!;
    fireEvent.click(editButton());
    fireEvent.change(popover.querySelector("textarea")!, {
      target: { value: "discard this draft" },
    });
    fireEvent.click(container.querySelector(".reader-drafts summary")!);
    fireEvent.click(
      [...container.querySelectorAll(".reader-drafts button")].find(
        (b) => b.textContent === "丢弃编辑草稿"
      )!
    );

    expect(container.querySelector(".ann-popover")).toBe(popover);
    expect(popover.querySelector("textarea")).toBeNull();
    expect(popover.querySelector(".ann-popover-body")?.textContent?.trim()).toBe("original");
    expect(container.querySelector("[aria-label='保留的编辑草稿 a_12345678']")).toBeNull();
    expect(pending).toHaveLength(1); // discarding is not a server mutation
    fireEvent.click(editButton());
    expect(popover.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("original");
    fireEvent.change(popover.querySelector("textarea")!, { target: { value: "replacement edit" } });
    fireEvent.keyDown(popover.querySelector("textarea")!, { key: "Enter", ctrlKey: true });
    const put = JSON.parse(String(pending[1]!.init?.body));
    expect(put.annotations[0].body).toBe("replacement edit");
    await answer(1, { ...put, rev: 101 });
    expect(popover.querySelector(".ann-popover-body")?.textContent?.trim()).toBe(
      "replacement edit"
    );
    expect(editButton()).toBeTruthy();
  });

  it("unavailable reader removes native fragment IDs for every target kind but retains internal DOM anchors", async () => {
    const a = representation();
    a.ir.sections[0]!.blocks.push(
      { id: "eq-1", type: "equation", latex: "a=b" },
      { id: "fig-1", type: "figure", captionSegments: [{ type: "text", text: "caption" }] },
      { id: "tab-1", type: "table", tableBody: "<table><tr><td>cell</td></tr></table>" },
      {
        id: "list-1",
        type: "list",
        ordered: false,
        items: [{ segments: [{ type: "text", text: "item" }] }],
      },
      { id: "code-1", type: "code", body: "code" },
      { id: "alg-1", type: "algorithm", body: "algorithm" }
    );
    a.ir.sections[0]!.children.push({
      id: "sec-2",
      level: 2,
      heading: "Nested",
      blocks: [],
      children: [],
    });
    a.ir.references = [{ id: "ref-1", raw: "Reference A" }];
    a.ir.citationsByBlock = { "p-1": ["ref-1"] };
    const { container } = renderDoc();
    await answer(0, a);
    await waitFor(() => expect(container.querySelector("#ref-1")).toBeTruthy());
    const main = container.querySelector<HTMLElement>("main.reader")!;
    const targets = [...main.querySelectorAll<HTMLElement>("[data-block-id]")];
    expect(targets.map((e) => e.id)).toEqual([
      "sec-1",
      "p-1",
      "eq-1",
      "fig-1",
      "tab-1",
      "list-1",
      "code-1",
      "alg-1",
      "sec-2",
    ]);
    notify();
    const expectUnavailable = () => {
      expect(container.querySelector("main.reader")).toBe(main);
      expect([...main.querySelectorAll("[data-block-id]")]).toEqual(targets);
      for (const e of targets) expect(e.hasAttribute("id")).toBe(false);
      expect(container.querySelector("#ref-1")).toBeNull();
      expect(main.textContent).toContain("Real body A");
    };
    expectUnavailable();
    await answer(1, {}, 500);
    expectUnavailable();
    main.scrollTop = 234;
    fireEvent.wheel(main);
    expect(main.scrollTop).toBe(234); // native scrolling itself is covered by Chrome, not happy-dom
    fireEvent.click(container.querySelector(".reader-sync-status button")!);
    const b = structuredClone(a);
    b.ir.sections[0]!.blocks[0] = {
      id: "p-1",
      type: "paragraph",
      segments: [{ type: "text", text: "Real body B" }],
    };
    b.file = representation("B", 0).file;
    await answer(2, b);
    for (const e of main.querySelectorAll<HTMLElement>("[data-block-id]"))
      expect(e.id).toBe(e.dataset.blockId);
    await waitFor(() => expect(container.querySelector("#ref-1")).toBeTruthy());
    expect(main.textContent).toContain("Real body B");
  });

  it.each(["%70-1", "unknown-%E4%B8%AD"])(
    "pending fragment %s waits through sync and error before applying once to B",
    async (encoded) => {
      const { container, setAnchor } = renderDoc();
      await answer(0, representation());
      notify();
      const anchor = parseDocRoute("/doc/synthetic", "#" + encoded)!.anchor!;
      setAnchor(anchor); // same decoded pending value as Shell's hashchange/popstate handler
      expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
      expect(container.querySelector("#p-1")).toBeNull();
      await answer(1, {}, 500);
      expect(container.querySelector("#p-1")).toBeNull();
      expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
      fireEvent.click(container.querySelector(".reader-sync-status button")!);
      await answer(2, representation("B", 0));
      expect(container.querySelector("#p-1")?.textContent).toContain("Real body B");
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(anchor === "p-1" ? 1 : 0);
      fireEvent.wheel(container.querySelector("main.reader")!);
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(anchor === "p-1" ? 1 : 0);
    }
  );

  it("latest scroll px is restored once; sync cancels old jump correction, flash and undo", async () => {
    const a = representation();
    a.ir.sections.push({ id: "sec-2", level: 1, heading: "Second", blocks: [], children: [] });
    const { container } = renderDoc();
    await answer(0, a);
    const main = container.querySelector<HTMLElement>("main.reader")!;
    Object.defineProperties(main, {
      scrollHeight: { value: 1200, configurable: true },
      clientHeight: { value: 400, configurable: true },
    });
    main.scrollTop = 123;
    vi.useFakeTimers();
    fireEvent.click(container.querySelector(".toc-section")!);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".undo-fab")).toBeTruthy();
    notify();
    expect(container.querySelector(".undo-fab")).toBeNull();
    expect(main.querySelector(".flash")).toBeNull();
    fireEvent.click(container.querySelector(".toc-section")!);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    main.scrollTop = 222; // hand scrolling during the pending read has priority
    await answer(1, representation("B", 0));
    expect(container.querySelector("main.reader")).toBe(main);
    expect(main.scrollTop).toBe(222);
    main.scrollTop = 300;
    fireEvent.wheel(main);
    act(() => vi.advanceTimersByTime(5000));
    expect(main.scrollTop).toBe(300);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
  });
  it("late edit success retains newer typing and advances only its saved base body", async () => {
    const a = representation();
    a.file.annotations = [annotation()];
    const { container } = renderDoc();
    await answer(0, a);
    fireEvent.click(container.querySelector(".ann-marker")!);
    fireEvent.click(
      [...container.querySelectorAll(".ann-popover button")].find((b) =>
        b.textContent?.includes("编辑")
      )!
    );
    const ta = container.querySelector(".ann-popover textarea")!;
    fireEvent.change(ta, { target: { value: "submitted edit" } });
    fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true });
    fireEvent.change(ta, { target: { value: "newer draft" } });
    const put = JSON.parse(String(pending[1]!.init?.body));
    await answer(1, { ...put, rev: 101 });
    expect(container.querySelector<HTMLTextAreaElement>(".ann-popover textarea")?.value).toBe(
      "newer draft"
    );
    notify();
    await answer(2, { ...a, file: { ...put, rev: 101 } });
    expect(
      container.querySelector<HTMLTextAreaElement>("[aria-label='保留的编辑草稿 a_12345678']")
        ?.value
    ).toBe("newer draft");
    expect(container.querySelector(".reader-drafts")?.textContent).not.toContain("不可保存");
  });
});

describe("verified images through real reader surfaces", () => {
  function images(bytes: string) {
    const a = representation();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const paragraph = a.ir.sections[0]!.blocks[0]!;
    if (paragraph.type === "paragraph")
      paragraph.segments.push(
        {
          type: "xref",
          target: { id: "fig-1", resolved: true, targetType: "figure", number: "1" },
          raw: "Fig. 1",
        },
        {
          type: "xref",
          target: { id: "tab-1", resolved: true, targetType: "table", number: "1" },
          raw: "Table 1",
        }
      );
    a.assets = [{ imgPath: "assets/a.svg", sha256 }];
    a.ir.sections[0]!.blocks.push(
      {
        id: "fig-1",
        type: "figure",
        imgPath: "assets/a.svg",
        imgWidth: 300,
        imgHeight: 200,
        captionSegments: [{ type: "text", text: "caption A" }],
      },
      {
        id: "tab-1",
        type: "table",
        imgPath: "assets/a.svg",
        captionSegments: [{ type: "text", text: "table A" }],
      }
    );
    return a;
  }
  it("lazy verified bytes create blobs on all figure/table/previews, and syncing revokes and render-hides every image", async () => {
    const blobs: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
      blobs.push(b as Blob);
      return `blob:test-${blobs.length}`;
    });
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { container } = renderDoc();
    const a = images("A bytes");
    await answer(0, a);
    await waitFor(() => expect(IO.images.length).toBeGreaterThanOrEqual(4));
    expect(pending).toHaveLength(1);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector<HTMLElement>(".figure-placeholder")?.style.aspectRatio).toBe(
      "300 / 200"
    );
    act(() => IO.reveal());
    await act(async () => {
      for (const p of pending.slice(1)) {
        expect(p.url).toContain(`?sha256=${a.assets[0]!.sha256}`);
        expect(p.init?.cache).toBe("no-store");
        p.resolve(
          new Response("A bytes", { status: 200, headers: { "Content-Type": "image/svg+xml" } })
        );
      }
    });
    await waitFor(() => expect(container.querySelectorAll("img").length).toBeGreaterThanOrEqual(4));
    for (const b of blobs) expect(await b.text()).toBe("A bytes");
    const old = container.querySelector("img")!;
    const count = pending.length;
    notify();
    expect(container.querySelector("img")).toBeNull();
    expect(revoke.mock.calls.length).toBe(blobs.length);
    fireEvent.load(old);
    fireEvent.error(old);
    expect(pending).toHaveLength(count + 1);
    await answer(count, {}, 500);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("main.reader")?.textContent).toContain("Real body A");
  });
  it("late old image bytes cannot resurrect after coherent generation replacement", async () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:late");
    const { container } = renderDoc();
    await answer(0, images("A bytes"));
    act(() => IO.reveal());
    const oldRequests = pending.slice(1);
    const count = pending.length;
    notify();
    await answer(count, representation("B", 0));
    await act(async () => {
      for (const p of oldRequests) p.resolve(new Response("A bytes"));
    });
    expect(create).not.toHaveBeenCalled();
    expect(container.querySelector("img")).toBeNull();
  });
  it("real multi-image mismatch → one R1 → own invalidate before response → external after: no R2 or unverified fallback", async () => {
    const create = vi.spyOn(URL, "createObjectURL");
    const { container } = renderDoc();
    await answer(0, images("A bytes"));
    act(() => IO.reveal());
    const imageRequests = pending.slice(1);
    await act(async () => {
      for (const p of imageRequests) p.resolve(json({ detail: "asset changed" }, 409));
    });
    const gets = () => pending.filter((p) => p.url.includes("coherent=1"));
    expect(gets()).toHaveLength(2);
    expect(container.querySelector("img")).toBeNull();
    act(() => {
      for (const cb of events.annotation) cb("synthetic");
    }); // ensure's own invalidate
    const r1 = gets()[1]!;
    await act(async () => {
      r1.resolve(json(images("B bytes")));
    });
    act(() => {
      for (const cb of events.annotation) cb("synthetic");
    }); // later watcher external
    notify();
    expect(gets()).toHaveLength(2);
    expect(create).not.toHaveBeenCalled();
    expect(container.querySelector(".reader-sync-status")?.textContent).toContain("更新失败");
    expect(container.querySelector("main.reader")?.textContent).toContain("caption A");
  });
  it("a 200 proxy body with the wrong SHA is rejected before Blob creation", async () => {
    const create = vi.spyOn(URL, "createObjectURL");
    renderDoc();
    await answer(0, images("A bytes"));
    act(() => IO.reveal());
    const requests = pending.slice(1);
    await act(async () => {
      for (const p of requests) p.resolve(new Response("B bytes"));
    });
    await waitFor(() =>
      expect(pending.filter((p) => p.url.includes("coherent=1"))).toHaveLength(2)
    );
    expect(create).not.toHaveBeenCalled();
  });
});
