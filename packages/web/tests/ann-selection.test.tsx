/**
 * Stage 8 MS4 integration: text selection → floating toolbar → create flow;
 * rejection toasts (cross-container / unsupported position); click hit-testing
 * with a stubbed caretRangeFromPoint; the gutter count marker + multi-hit
 * chooser; highlight painting through a stubbed `CSS.highlights` registry
 * (happy-dom has no Custom Highlight API — the painter's degrade path is
 * exercised too). Rendering and the annotations API ride the same harness
 * shape as annotations.test.tsx with a small hand-built IR fixture.
 */

import { useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type {
  Annotation,
  AnnotationsFile,
  AnnotationTarget,
} from "@argelanderspace/contracts";
import { DocPane } from "../src/doc/DocPane";
import { WorkspaceProvider, type Workspace } from "../src/argelander/workspace";
import { firstText, fixtureIr, IOStub } from "./ann-fixture";

const wsMock = vi.hoisted(() => ({ annotationChangedCbs: [] as ((docId: string) => void)[] }));
vi.mock("../src/api/ws", () => ({
  onAnnotationChanged: (cb: (docId: string) => void) => {
    wsMock.annotationChangedCbs.push(cb);
    return () => {};
  },
  onLibraryChanged: () => () => {},
  onPlanChanged: () => () => {},
  onJobEvent: () => () => {},
}));

// ---------------------------------------------------------------------------
// fixture IR + in-test server
// ---------------------------------------------------------------------------

const DOC = "testdoc";

function mkAnn(id: string, target: AnnotationTarget, body: string): Annotation {
  return {
    id,
    target,
    body,
    created_at: "2026-09-10T08:00:00.000Z",
    updated_at: "2026-09-10T08:00:00.000Z",
  };
}

let serverFile: AnnotationsFile;
let putBodies: AnnotationsFile[];
let getCount: number;

function okJson(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === `/api/paper/${DOC}/ir`) return okJson(fixtureIr);
      if (url === `/api/paper/${DOC}/annotations` && method === "GET") {
        getCount++;
        return okJson(serverFile);
      }
      if (url === `/api/paper/${DOC}/annotations` && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as AnnotationsFile;
        putBodies.push(body);
        // the §5 double check, mirroring the server route
        if (body.content_fingerprint !== serverFile.content_fingerprint) {
          return okJson({ detail: "document changed", file: serverFile }, 409);
        }
        if (body.rev !== serverFile.rev) {
          return okJson({ detail: "rev mismatch", rev: serverFile.rev }, 409);
        }
        serverFile = { ...body, rev: body.rev + 1 };
        return okJson(serverFile);
      }
      return okJson({}, 404);
    })
  );
}

// ---------------------------------------------------------------------------
// DocPane harness (mirrors annotations.test.tsx)
// ---------------------------------------------------------------------------

function renderDocPane() {
  function Harness() {
    const [anchor, setAnchor] = useState<string | null>(null);
    const ws: Workspace = useMemo(
      () => ({
        papers: [DOC],
        currentDoc: DOC,
        setCurrentDoc: vi.fn(),
        openDoc: vi.fn(),
        pendingAnchor: anchor,
        clearPendingAnchor: () => setAnchor(null),
        docDeleted: vi.fn(),
        tweaks: { theme: "dark", accent: "azure", density: "regular", labels: true },
      }),
      [anchor]
    );
    return (
      <WorkspaceProvider value={ws}>
        <DocPane />
      </WorkspaceProvider>
    );
  }
  return render(<Harness />);
}

async function ready(container: HTMLElement) {
  await waitFor(() => expect(container.querySelector("[data-block-id='p-1']")).toBeTruthy());
  await waitFor(() => expect(getCount).toBeGreaterThan(0));
  await act(async () => {});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const block = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-block-id='${id}']`)!;

/** Stub the caret API happy-dom lacks: the next click hit-tests as if the
 *  caret landed at (node, offset). */
function stubCaret(node: Node, offset: number) {
  (document as Document & { caretRangeFromPoint?: unknown }).caretRangeFromPoint = () =>
    ({ startContainer: node, startOffset: offset }) as Range;
}

/** Select [aOff..bOff) of the given nodes and let the settle debounce run
 *  (happy-dom fires a real selectionchange from setBaseAndExtent). */
async function select(a: [Node, number], b: [Node, number]) {
  const sel = window.getSelection()!;
  sel.setBaseAndExtent(a[0], a[1], b[0], b[1]);
  await sleep(220); // SEL_SETTLE_MS = 140 + slack
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", IOStub);
  serverFile = { version: 1, rev: 0, content_fingerprint: "fp", annotations: [] };
  putBodies = [];
  getCount = 0;
  wsMock.annotationChangedCbs.length = 0;
  installFetch();
  // happy-dom's document Selection persists across tests in this file — a
  // stale non-collapsed selection would suppress click hit-testing
  window.getSelection()?.removeAllRanges();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe("selection → toolbar → create flow", () => {
  it("a pure-text selection shows the toolbar; 添加标注 opens create; save PUTs the text target", async () => {
    const { container } = renderDocPane();
    await ready(container);
    const p2text = firstText(block(container, "p-2"));
    await select([p2text, 6], [p2text, 15]); // "paragraph"

    const bar = await waitFor(() => {
      const el = container.querySelector(".ann-selbar");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    const btn = [...bar.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("添加标注")
    )!;
    fireEvent.click(btn);

    const pop = await waitFor(() => {
      const p = container.querySelector(".ann-popover");
      expect(p).toBeTruthy();
      return p as HTMLElement;
    });
    expect(pop.textContent).toContain("添加文本标注");
    // toolbar consumed by the create flow
    expect(container.querySelector(".ann-selbar")).toBeNull();

    const ta = pop.querySelector("textarea")!;
    fireEvent.change(ta, { target: { value: "这段写得关键" } });
    fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(putBodies).toHaveLength(1));
    const a = putBodies[0]!.annotations[0]!;
    expect(a.target).toEqual({
      type: "text",
      block: "p-2",
      container: { type: "content" },
      start: 6,
      end: 15,
      quote: "paragraph",
    });
    // saved state: popover switches to the body view
    await waitFor(() => expect(pop.textContent).toContain("这段写得关键"));
  });

  it("a selection ending mid-math expands to the whole atom ($latex$ in the quote)", async () => {
    const { container } = renderDocPane();
    await ready(container);
    const p1 = block(container, "p-1");
    const startText = firstText(p1); // "Alpha "
    const glyph = firstText(p1.querySelector(".katex")!);
    await select([startText, 2], [glyph, 1]);
    const bar = await waitFor(() => container.querySelector(".ann-selbar") as HTMLElement);
    fireEvent.click(
      [...bar.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        b.textContent?.includes("添加标注")
      )!
    );
    const pop = await waitFor(() => container.querySelector(".ann-popover") as HTMLElement);
    fireEvent.change(pop.querySelector("textarea")!, { target: { value: "公式边界" } });
    fireEvent.keyDown(pop.querySelector("textarea")!, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(putBodies).toHaveLength(1));
    const t = putBodies[0]!.annotations[0]!.target;
    expect(t).toEqual({
      type: "text",
      block: "p-1",
      container: { type: "content" },
      start: 2,
      end: 13, // "$\\beta$".length + 6
      quote: "pha $\\beta$",
    });
  });

  it("a selection starting inside a multi-cite group expands to the whole group", async () => {
    const { container } = renderDocPane();
    await ready(container);
    const p1 = block(container, "p-1");
    // the multi-cite group "(A 1934; B 1940)" starts at canonical 33; find its
    // separator text node by walking the paragraph's text nodes
    const walker = p1.ownerDocument.createTreeWalker(p1, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) {
      if (!(n as Text).data.includes("\\") && (n as Text).data.trim() !== "") texts.push(n as Text);
    }
    const sep = texts.find((t) => t.data === "; ")!;
    const tail = texts.find((t) => t.data === " tail")!;
    await select([sep, 1], [tail, 2]);
    const bar = await waitFor(() => container.querySelector(".ann-selbar") as HTMLElement);
    fireEvent.click(
      [...bar.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        b.textContent?.includes("添加标注")
      )!
    );
    const pop = await waitFor(() => container.querySelector(".ann-popover") as HTMLElement);
    fireEvent.change(pop.querySelector("textarea")!, { target: { value: "引用组" } });
    fireEvent.keyDown(pop.querySelector("textarea")!, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(putBodies).toHaveLength(1));
    const t = putBodies[0]!.annotations[0]!.target;
    if (t.type !== "text") throw new Error("unreachable");
    expect(t.start).toBe(33); // expanded to the group start
    expect(t.quote.startsWith("(A 1934; B 1940) see ")).toBe(true);
  });

  it("list item selection carries container {type:list_item, index}", async () => {
    const { container } = renderDocPane();
    await ready(container);
    const li = block(container, "list-1").querySelectorAll("li")[1]!;
    const t = firstText(li);
    await select([t, 0], [t, 6]); // "Second"
    const bar = await waitFor(() => container.querySelector(".ann-selbar") as HTMLElement);
    fireEvent.click(
      [...bar.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        b.textContent?.includes("添加标注")
      )!
    );
    const pop = await waitFor(() => container.querySelector(".ann-popover") as HTMLElement);
    fireEvent.change(pop.querySelector("textarea")!, { target: { value: "列表项" } });
    fireEvent.keyDown(pop.querySelector("textarea")!, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]!.annotations[0]!.target).toEqual({
      type: "text",
      block: "list-1",
      container: { type: "list_item", index: 1 },
      start: 0,
      end: 6,
      quote: "Second",
    });
  });

  it("figure caption selection carries container {type:caption} (cap-label excluded)", async () => {
    const { container } = renderDocPane();
    await ready(container);
    const cap = block(container, "fig-1").querySelector("figcaption")!;
    const t = firstText(cap.querySelector(".cap-label")!.nextElementSibling ?? cap);
    // caption canonical: "Caption $Y$ end"; select "Caption"
    await select([t, 0], [t, 7]);
    const bar = await waitFor(() => container.querySelector(".ann-selbar") as HTMLElement);
    fireEvent.click(
      [...bar.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        b.textContent?.includes("添加标注")
      )!
    );
    const pop = await waitFor(() => container.querySelector(".ann-popover") as HTMLElement);
    fireEvent.change(pop.querySelector("textarea")!, { target: { value: "图注" } });
    fireEvent.keyDown(pop.querySelector("textarea")!, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]!.annotations[0]!.target).toEqual({
      type: "text",
      block: "fig-1",
      container: { type: "caption" },
      start: 0,
      end: 7,
      quote: "Caption",
    });
  });
});

// ---------------------------------------------------------------------------

describe("rejection paths", () => {
  it("cross-block selection → toast 暂不支持跨段落标注, no toolbar", async () => {
    const { container } = renderDocPane();
    await ready(container);
    await select([firstText(block(container, "p-1")), 0], [firstText(block(container, "p-2")), 5]);
    await waitFor(() =>
      expect(container.querySelector(".ann-toast")?.textContent).toContain("暂不支持跨段落标注")
    );
    expect(container.querySelector(".ann-selbar")).toBeNull();
    expect(putBodies).toHaveLength(0);
  });

  it("cross-container selection (two list items) → same rejection", async () => {
    const { container } = renderDocPane();
    await ready(container);
    const lis = block(container, "list-1").querySelectorAll("li");
    await select([firstText(lis[0]!), 0], [firstText(lis[1]!), 3]);
    await waitFor(() =>
      expect(container.querySelector(".ann-toast")?.textContent).toContain("暂不支持跨段落标注")
    );
    expect(container.querySelector(".ann-selbar")).toBeNull();
  });

  it("selection inside an equation body → toast 此处不支持文本标注", async () => {
    const { container } = renderDocPane();
    await ready(container);
    const eq = block(container, "eq-1");
    const glyph = firstText(eq.querySelector(".eqn-body")!);
    const sel = window.getSelection()!;
    sel.setBaseAndExtent(glyph, 0, glyph, 1);
    await sleep(220);
    expect(container.querySelector(".ann-toast")?.textContent).toContain("此处不支持文本标注");
    expect(container.querySelector(".ann-selbar")).toBeNull();
  });

  it("the toolbar dismisses when the selection collapses or on Escape", async () => {
    const { container } = renderDocPane();
    await ready(container);
    const t = firstText(block(container, "p-2"));
    await select([t, 0], [t, 5]);
    await waitFor(() => expect(container.querySelector(".ann-selbar")).toBeTruthy());
    window.getSelection()!.removeAllRanges(); // fires selectionchange (collapsed)
    await waitFor(() => expect(container.querySelector(".ann-selbar")).toBeNull());

    await select([t, 0], [t, 5]);
    await waitFor(() => expect(container.querySelector(".ann-selbar")).toBeTruthy());
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(container.querySelector(".ann-selbar")).toBeNull());
  });

  it("N1: a selection anchored in the cap-label chrome is rejected (standard toast)", async () => {
    const { container } = renderDocPane();
    await ready(container);
    const cap = block(container, "fig-1").querySelector("figcaption")!;
    const labelText = firstText(cap.querySelector(".cap-label")!);
    const captionText = firstText(cap.querySelector("span:not(.cap-label)")!);
    await select([labelText, 2], [captionText, 5]);
    await waitFor(() =>
      expect(container.querySelector(".ann-toast")?.textContent).toContain("此处不支持文本标注")
    );
    expect(container.querySelector(".ann-selbar")).toBeNull();
    expect(putBodies).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("B1: 409 document-changed with an open TEXT create popover", () => {
  it("closes the popover with a text-specific toast — never a structure-target conversion", async () => {
    const { container } = renderDocPane();
    await ready(container);
    const t = firstText(block(container, "p-2"));
    await select([t, 6], [t, 15]);
    const bar = await waitFor(() => container.querySelector(".ann-selbar") as HTMLElement);
    fireEvent.click(
      [...bar.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        b.textContent?.includes("添加标注")
      )!
    );
    const pop = await waitFor(() => container.querySelector(".ann-popover") as HTMLElement);
    expect(pop.textContent).toContain("添加文本标注");
    // the doc is re-ingested elsewhere before the save lands
    serverFile = { version: 1, rev: 0, content_fingerprint: "fp-epoch-2", annotations: [] };
    fireEvent.change(pop.querySelector("textarea")!, { target: { value: "跨纪元的文本标注" } });
    fireEvent.keyDown(pop.querySelector("textarea")!, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]!.annotations[0]!.target.type).toBe("text");
    // the popover CLOSES (the dead-epoch target can never be retried) and the
    // toast says the text must be re-selected
    await waitFor(() =>
      expect(container.querySelector(".ann-toast")?.textContent).toContain(
        "文档内容已变化，旧标注已归档；请重新选择文本"
      )
    );
    await waitFor(() => expect(container.querySelector(".ann-popover")).toBeNull());
    // no structure-target retry ever leaves the client
    await sleep(60);
    expect(putBodies).toHaveLength(1);
  });

  it("structure create popovers keep the MS3 rebuild semantics (control)", async () => {
    const { container } = renderDocPane();
    await ready(container);
    fireEvent.click(
      block(container, "p-2").querySelector<HTMLButtonElement>(".ann-edge-btn")!
    );
    const pop = await waitFor(() => container.querySelector(".ann-popover") as HTMLElement);
    fireEvent.change(pop.querySelector("textarea")!, { target: { value: "结构标注重试" } });
    serverFile = { version: 1, rev: 0, content_fingerprint: "fp-epoch-2", annotations: [] };
    fireEvent.keyDown(pop.querySelector("textarea")!, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(putBodies).toHaveLength(1));
    await waitFor(() =>
      expect(container.querySelector(".ann-toast")?.textContent).toContain("文档内容已变化")
    );
    // popover STAYS open in create mode; the retry persists the rebuilt structure target
    expect(container.querySelector(".ann-popover")).toBeTruthy();
    expect(container.querySelector(".ann-toast")?.textContent).not.toContain("请重新选择文本");
    fireEvent.keyDown(pop.querySelector("textarea")!, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(putBodies).toHaveLength(2));
    expect(putBodies[1]!.annotations[0]!.target).toEqual({
      type: "structure",
      id: "p-2",
      kind: "paragraph",
      snapshot: { text: "Plain paragraph text here." },
    });
  });
});

// ---------------------------------------------------------------------------

describe("gutter count marker + chooser (degraded painting: no CSS.highlights)", () => {
  const T1: AnnotationTarget = {
    type: "text",
    block: "p-2",
    container: { type: "content" },
    start: 6,
    end: 15,
    quote: "paragraph",
  };
  const T2: AnnotationTarget = {
    type: "text",
    block: "p-2",
    container: { type: "content" },
    start: 0,
    end: 5,
    quote: "Plain",
  };

  it("one text annotation: the count marker opens its popover directly", async () => {
    serverFile.annotations = [mkAnn("a_00000001", T1, "单条文本标注")];
    const { container } = renderDocPane();
    await ready(container);
    const p2 = block(container, "p-2");
    await waitFor(() => expect(p2.querySelector(".ann-count")).toBeTruthy());
    expect(p2.querySelector(".ann-count")!.textContent).toBe("1");
    fireEvent.click(p2.querySelector<HTMLButtonElement>(".ann-count")!);
    const pop = await waitFor(() => container.querySelector(".ann-popover") as HTMLElement);
    expect(pop.textContent).toContain("单条文本标注");
    expect(container.querySelector(".ann-chooser")).toBeNull();
  });

  it("several text annotations: the count marker opens the chooser; picking opens the popover", async () => {
    serverFile.annotations = [
      mkAnn("a_00000001", T1, "第一条文本"),
      mkAnn("a_00000002", T2, "第二条文本"),
      mkAnn("a_00000003", { type: "structure", id: "p-2", kind: "paragraph", snapshot: {} }, "结构标注"),
    ];
    const { container } = renderDocPane();
    await ready(container);
    const p2 = block(container, "p-2");
    await waitFor(() => expect(p2.querySelector(".ann-count")?.textContent).toBe("2"));
    // the structure annotation keeps its individual marker
    expect(p2.querySelectorAll(".ann-marker")).toHaveLength(1);
    fireEvent.click(p2.querySelector<HTMLButtonElement>(".ann-count")!);
    const chooser = await waitFor(() => container.querySelector(".ann-chooser") as HTMLElement);
    const entries = chooser.querySelectorAll(".ann-chooser-entry");
    expect(entries).toHaveLength(2);
    expect(chooser.textContent).toContain("第一条文本");
    expect(chooser.textContent).toContain("「paragraph」");
    fireEvent.click(entries[1] as HTMLElement);
    const pop = await waitFor(() => container.querySelector(".ann-popover") as HTMLElement);
    expect(pop.textContent).toContain("第二条文本");
    expect(container.querySelector(".ann-chooser")).toBeNull();
    // everything still works with painting degraded (no CSS.highlights)
    expect(document.head.querySelector("style[data-ann-highlights]")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("painting with a stubbed Custom Highlight registry", () => {
  interface FakeHl {
    priority: number;
    ranges: Range[];
  }
  let live: Map<string, FakeHl>;

  beforeEach(() => {
    live = new Map();
    class FakeHighlight {
      priority = 0;
      ranges: Range[];
      constructor(...r: Range[]) {
        this.ranges = r;
      }
    }
    vi.stubGlobal("Highlight", FakeHighlight);
    vi.stubGlobal("CSS", {
      highlights: {
        set: (name: string, h: FakeHl) => live.set(name, h),
        delete: (name: string) => live.delete(name),
      },
      escape: (s: string) => s,
    });
  });

  const T1: AnnotationTarget = {
    type: "text",
    block: "p-2",
    container: { type: "content" },
    start: 6,
    end: 15,
    quote: "paragraph",
  };

  it("paints each text annotation's range under its own name; ranges carry the quote", async () => {
    serverFile.annotations = [mkAnn("a_00000001", T1, "画出来")];
    const { container } = renderDocPane();
    await ready(container);
    await waitFor(() => expect(live.size).toBeGreaterThan(0));
    const key = [...live.keys()].find((k) => k.includes("a_00000001"))!;
    const hl = live.get(key)!;
    expect(hl.ranges[0]!.toString()).toBe("paragraph");
    expect(hl.priority).toBe(0);
    expect(document.head.querySelector("style[data-ann-highlights]")?.textContent).toContain(
      "::highlight("
    );
  });

  it("the active annotation moves to the ann-active name with priority 1", async () => {
    serverFile.annotations = [mkAnn("a_00000001", T1, "激活我")];
    const { container } = renderDocPane();
    await ready(container);
    await waitFor(() => expect(live.size).toBe(1));
    fireEvent.click(block(container, "p-2").querySelector<HTMLButtonElement>(".ann-count")!);
    await waitFor(() => expect(container.querySelector(".ann-popover")).toBeTruthy());
    await waitFor(() =>
      expect([...live.keys()].some((k) => k.startsWith("annhl-active-"))).toBe(true)
    );
    const active = live.get([...live.keys()].find((k) => k.startsWith("annhl-active-"))!)!;
    expect(active.priority).toBe(1);
    expect(active.ranges[0]!.toString()).toBe("paragraph");
    // the per-id name is gone while active (no double paint)
    expect([...live.keys()].some((k) => k.includes("a_00000001"))).toBe(false);
  });

  it("annotation.changed refetch rebuilds the ranges from the new file", async () => {
    serverFile.annotations = [mkAnn("a_00000001", T1, "旧")];
    const { container } = renderDocPane();
    await ready(container);
    await waitFor(() => expect(live.size).toBe(1));
    serverFile = {
      ...serverFile,
      rev: 1,
      annotations: [
        ...serverFile.annotations,
        mkAnn("a_00000002", { type: "text", block: "p-2", container: { type: "content" }, start: 0, end: 5, quote: "Plain" }, "新"),
      ],
    };
    act(() => wsMock.annotationChangedCbs.forEach((cb) => cb(DOC)));
    await waitFor(() => expect(live.size).toBe(2));
    const keys = [...live.keys()];
    const second = live.get(keys.find((k) => k.includes("a_00000002"))!)!;
    expect(second.ranges[0]!.toString()).toBe("Plain");
  });

  it("a refetch with a fresh-identity file rebuilds WITHOUT leaking old names", async () => {
    serverFile.annotations = [mkAnn("a_00000001", T1, "旧")];
    const { container } = renderDocPane();
    await ready(container);
    await waitFor(() => expect(live.size).toBe(1));
    expect([...live.keys()][0]).toContain("a_00000001");
    // a brand-new file object (fresh identity), one annotation replaced
    serverFile = {
      version: 1,
      rev: 2,
      content_fingerprint: "fp",
      annotations: [
        mkAnn("a_00000002", { type: "text", block: "p-2", container: { type: "content" }, start: 0, end: 5, quote: "Plain" }, "新"),
      ],
    };
    act(() => wsMock.annotationChangedCbs.forEach((cb) => cb(DOC)));
    await waitFor(() => expect(live.size).toBe(1));
    expect([...live.keys()][0]).toContain("a_00000002");
    expect([...live.keys()].some((k) => k.includes("a_00000001"))).toBe(false);
  });

  it("unmounting the reader disposes the registry entries AND the managed style", async () => {
    serverFile.annotations = [mkAnn("a_00000001", T1, "x")];
    const { container, unmount } = renderDocPane();
    await ready(container);
    await waitFor(() => expect(live.size).toBe(1));
    expect(document.head.querySelector("style[data-ann-highlights]")).toBeTruthy();
    unmount();
    expect(live.size).toBe(0);
    expect(document.head.querySelector("style[data-ann-highlights]")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("click hit-testing", () => {
  const T1: AnnotationTarget = {
    type: "text",
    block: "p-2",
    container: { type: "content" },
    start: 6,
    end: 15,
    quote: "paragraph",
  };

  it("a click inside one annotation's range opens its popover", async () => {
    serverFile.annotations = [mkAnn("a_00000001", T1, "点我")];
    const { container } = renderDocPane();
    await ready(container);
    const p2text = firstText(block(container, "p-2"));
    stubCaret(p2text, 8); // inside [6,15)
    fireEvent.click(block(container, "p-2"), { clientX: 50, clientY: 50 });
    const pop = await waitFor(() => container.querySelector(".ann-popover") as HTMLElement);
    expect(pop.textContent).toContain("点我");
  });

  it("overlapping hits open the chooser; a bare-area click opens nothing", async () => {
    serverFile.annotations = [
      mkAnn("a_00000001", T1, "重叠一"),
      mkAnn("a_00000002", { ...T1, start: 8, end: 20, quote: "paragraph te" }, "重叠二"),
    ];
    const { container } = renderDocPane();
    await ready(container);
    const p2text = firstText(block(container, "p-2"));
    stubCaret(p2text, 10); // inside both
    fireEvent.click(block(container, "p-2"), { clientX: 50, clientY: 50 });
    const chooser = await waitFor(() => container.querySelector(".ann-chooser") as HTMLElement);
    expect(chooser.querySelectorAll(".ann-chooser-entry")).toHaveLength(2);

    // collapse the chooser, then click an uncovered offset (2 → no hit)
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(container.querySelector(".ann-chooser")).toBeNull());
    stubCaret(p2text, 2);
    fireEvent.click(block(container, "p-2"), { clientX: 60, clientY: 60 });
    await sleep(40);
    expect(container.querySelector(".ann-popover")).toBeNull();
    expect(container.querySelector(".ann-chooser")).toBeNull();
  });

  it("chip clicks keep their own behavior (no annotation hit-test)", async () => {
    serverFile.annotations = [
      mkAnn("a_00000001", {
        type: "text",
        block: "p-1",
        container: { type: "content" },
        start: 20,
        end: 28,
        quote: "A (1934)",
      }, "盖住引用"),
    ];
    const { container } = renderDocPane();
    await ready(container);
    const chip = block(container, "p-1").querySelector<HTMLElement>(".chip")!;
    stubCaret(firstText(chip), 2); // the caret lands inside the chip…
    fireEvent.click(chip, { clientX: 50, clientY: 50 }); // …but the target is the chip
    await sleep(40);
    expect(container.querySelector(".ann-popover")).toBeNull();
  });

  it("a non-collapsed selection suppresses hit-testing", async () => {
    serverFile.annotations = [mkAnn("a_00000001", T1, "不该开")];
    const { container } = renderDocPane();
    await ready(container);
    const p2text = firstText(block(container, "p-2"));
    stubCaret(p2text, 8);
    window.getSelection()!.setBaseAndExtent(p2text, 6, p2text, 15); // drag in progress
    fireEvent.click(block(container, "p-2"), { clientX: 50, clientY: 50 });
    await sleep(40);
    expect(container.querySelector(".ann-popover")).toBeNull();
  });

  it("N1: cap-label ghost clicks do NOT hit-test (but real caption text does)", async () => {
    serverFile.annotations = [
      mkAnn("a_00000001", {
        type: "text",
        block: "fig-1",
        container: { type: "caption" },
        start: 0,
        end: 7,
        quote: "Caption",
      }, "图注标注"),
    ];
    const { container } = renderDocPane();
    await ready(container);
    const cap = block(container, "fig-1").querySelector("figcaption")!;
    // ghost: the caret lands in the "Figure 1. " label — no hit even though an
    // annotation covers the caption's [0,7)
    stubCaret(firstText(cap.querySelector(".cap-label")!), 1);
    fireEvent.click(cap, { clientX: 40, clientY: 40 });
    await sleep(40);
    expect(container.querySelector(".ann-popover")).toBeNull();
    // control: the same annotation IS reachable from the real caption text
    stubCaret(firstText(cap.querySelector("span:not(.cap-label)")!), 2);
    fireEvent.click(cap, { clientX: 45, clientY: 45 });
    const pop = await waitFor(() => container.querySelector(".ann-popover") as HTMLElement);
    expect(pop.textContent).toContain("图注标注");
  });
});

// ---------------------------------------------------------------------------

describe("N3: floating UI clamps BOTH axes to the viewport", () => {
  it("the selection toolbar clamps y (and keeps x clamped)", async () => {
    vi.stubGlobal("innerWidth", 200);
    vi.stubGlobal("innerHeight", 150);
    const { container } = renderDocPane();
    await ready(container);
    const t = firstText(block(container, "p-2"));
    await select([t, 0], [t, 5]);
    const bar = await waitFor(() => container.querySelector(".ann-selbar") as HTMLElement);
    const top = Number.parseFloat(bar.style.top);
    const left = Number.parseFloat(bar.style.left);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top).toBeLessThanOrEqual(150 - 44 - 8); // viewport − bar height − margin
    expect(left).toBeGreaterThanOrEqual(8 + 70);
    expect(left).toBeLessThanOrEqual(200 - 8 - 70);
  });

  it("the chooser clamps y to the viewport", async () => {
    vi.stubGlobal("innerWidth", 800);
    vi.stubGlobal("innerHeight", 200);
    const base: AnnotationTarget = {
      type: "text",
      block: "p-2",
      container: { type: "content" },
      start: 6,
      end: 15,
      quote: "paragraph",
    };
    serverFile.annotations = [
      mkAnn("a_00000001", base, "重叠一"),
      mkAnn("a_00000002", { ...base, start: 8, end: 20, quote: "paragraph te" }, "重叠二"),
    ];
    const { container } = renderDocPane();
    await ready(container);
    stubCaret(firstText(block(container, "p-2")), 10);
    fireEvent.click(block(container, "p-2"), { clientX: 50, clientY: 10000 });
    const chooser = await waitFor(() => container.querySelector(".ann-chooser") as HTMLElement);
    const top = Number.parseFloat(chooser.style.top);
    // estimated height = min(2·76+16, 0.4·200+16) = 96 → top ≤ 200 − 96 − 8
    expect(top).toBeLessThanOrEqual(96);
    expect(top).toBeGreaterThanOrEqual(8);
  });
});
