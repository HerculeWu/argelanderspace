/**
 * Reader annotation CRUD shell (Stage 8 MS3): right-panel 引用|标注 tabs,
 * document-order list, structure-annotation creation via the hover edge
 * button (snapshot fields asserted), popover + inline editing, delete, the
 * two 409 flows + 500 preservation, `#ann-<id>` deep links, and the
 * annotation.changed refetch (incl. the tolerated 404 after an external doc
 * delete).
 *
 * The annotations API is served through the real `api/annotations` module
 * over a stubbed global fetch (a tiny in-test "server" with the §5
 * fingerprint+rev double check); `api/ws` is mocked with the
 * annotation.changed subscribers captured so tests can fire them. The IR is
 * the golden tex-pipeline doc served verbatim (same trick as
 * deeplink.test.tsx).
 */

import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  canonicalSegmentsText,
  type Annotation,
  type AnnotationsFile,
  type AnnotationTarget,
  type TexDocIr,
} from "@argelanderspace/contracts";
import { DocPane } from "../src/doc/DocPane";
import { WorkspaceProvider, type Workspace } from "../src/argelander/workspace";

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

const goldenIr = JSON.parse(
  readFileSync(
    fileURLToPath(new NodeURL("../../../tests/golden/tex/arxiv-2501.17225.json", import.meta.url)),
    "utf8"
  )
) as TexDocIr;
const DOC = goldenIr.docId;

// eq-1 / fig-1 fields the snapshot assertions pin down (from the golden IR).
const EQ1 = { number: "1", label: "eq:Dist_err" } as const;
function goldenBlock(id: string) {
  const walk = (secs: TexDocIr["sections"]): any => {
    for (const s of secs) {
      for (const b of s.blocks) if (b.id === id) return b;
      const r = walk(s.children);
      if (r) return r;
    }
    return null;
  };
  const b = walk(goldenIr.sections);
  if (!b) throw new Error(`golden block ${id} not found`);
  return b;
}
const FIG1_CAPTION = canonicalSegmentsText(goldenBlock("fig-1").captionSegments);

// ---------------------------------------------------------------------------
// the in-test "server"
// ---------------------------------------------------------------------------

const FP = "fp-epoch-1";
let serverFile: AnnotationsFile;
let putBodies: AnnotationsFile[];
let getCount: number;
let forcePut500: boolean;
let getStatus: number; // 200 normally; 404 simulates an externally deleted doc
let assetBytes: Uint8Array | null; // bytes served for /images/…, null → 404
let putHang: boolean; // PUTs park on a gate until the test releases them
let putRelease: (() => void) | null;

function okJson(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function mkAnn(id: string, target: AnnotationTarget, body: string): Annotation {
  return {
    id,
    target,
    body,
    created_at: "2026-09-10T08:00:00.000Z",
    updated_at: "2026-09-10T08:00:00.000Z",
  };
}
const docTarget: AnnotationTarget = { type: "document" };
const structTarget = (id: string, kind: "paragraph" | "section"): AnnotationTarget => ({
  type: "structure",
  id,
  kind,
  snapshot: {},
});

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === `/api/paper/${DOC}/ir`) return okJson(goldenIr);
      if (url === `/api/paper/${DOC}/annotations?coherent=1` && method === "GET") {
        getCount++;
        if (getStatus !== 200) return okJson({ detail: "gone" }, getStatus);
        const assets: { imgPath: string; sha256: string }[] = [];
        const walk = (sections: TexDocIr["sections"]) => { for (const s of sections) { for (const b of s.blocks) if ((b.type === "figure" || b.type === "table") && b.imgPath) assets.push({ imgPath: b.imgPath, sha256: createHash("sha256").update(assetBytes ?? "fixture").digest("hex") }); walk(s.children); } };
        walk(goldenIr.sections);
        return okJson({ version: 1, ir: goldenIr, file: serverFile, assets });
      }
      if (url === `/api/paper/${DOC}/annotations` && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as AnnotationsFile;
        putBodies.push(body);
        if (putHang) await new Promise<void>((r) => (putRelease = r));
        if (forcePut500) return okJson({ detail: "boom" }, 500);
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
      if (url.startsWith(`/images/${DOC}/`)) {
        if (!assetBytes) return okJson({}, 404);
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () =>
            assetBytes!.buffer.slice(assetBytes!.byteOffset, assetBytes!.byteOffset + assetBytes!.length),
        } as unknown as Response;
      }
      return okJson({}, 404);
    })
  );
}

// ---------------------------------------------------------------------------
// DocPane render harness (mirrors deeplink.test.tsx)
// ---------------------------------------------------------------------------

const scrolled: Element[] = [];
const realScrollIntoView = Element.prototype.scrollIntoView;

class IOStub {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(target: Element) {
    if (target.classList.contains("verified-figure")) return;
    this.cb(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

function renderDocPane(pendingAnchor: string | null = null) {
  const clearPendingAnchor = vi.fn();
  // The harness mirrors the real Shell: pendingAnchor is consumed state
  // (clearPendingAnchor actually clears it). A static mock would leave the
  // ann- anchor permanently pending, re-firing the deep-link effect on every
  // annotation-state change.
  function Harness() {
    const [anchor, setAnchor] = useState<string | null>(pendingAnchor);
    const ws: Workspace = useMemo(
      () => ({
        papers: [DOC],
        currentDoc: DOC,
        setCurrentDoc: vi.fn(),
        openDoc: vi.fn(),
        pendingAnchor: anchor,
        clearPendingAnchor: () => {
          clearPendingAnchor();
          setAnchor(null);
        },
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
  const utils = render(<Harness />);
  return { ...utils, clearPendingAnchor };
}

/** Wait until the doc + annotations are both rendered. Also awaits the first
 *  annotations GET (fired from the provider's mount effect) being issued and
 *  its state flush, so no test races the initial load. */
async function ready(container: HTMLElement) {
  await waitFor(() => expect(container.querySelector("[data-block-id='p-1']")).toBeTruthy());
  await waitFor(() => expect(getCount).toBeGreaterThan(0));
  await act(async () => {}); // flush the provider's setState after the GET
}

/** The annotation popover, once open (waitFor only retries on a THROWING
 *  callback — a bare `as HTMLElement` return would resolve null). */
async function waitPopover(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const p = container.querySelector(".ann-popover");
    expect(p).toBeTruthy();
    return p as HTMLElement;
  });
}

function tabButton(container: HTMLElement, name: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll<HTMLButtonElement>(".right-tab")].find((b) =>
    b.textContent?.startsWith(name)
  );
  if (!btn) throw new Error(`tab ${name} not found`);
  return btn;
}

function annEntryIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".ann-entry")].map((e) =>
    e.getAttribute("data-ann-id")
  ) as string[];
}

/** Save the popover/panel editor's current draft via the 保存 button. */
async function saveEditor(scope: HTMLElement, body: string) {
  const ta = scope.querySelector("textarea");
  if (!ta) throw new Error("editor textarea not found");
  fireEvent.change(ta, { target: { value: body } });
  const save = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.includes("保存")
  );
  if (!save) throw new Error("save button not found");
  fireEvent.click(save);
}

beforeEach(() => {
  scrolled.length = 0;
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolled.push(this);
  });
  vi.stubGlobal("IntersectionObserver", IOStub);
  serverFile = { version: 1, rev: 0, content_fingerprint: FP, annotations: [] };
  putBodies = [];
  getCount = 0;
  forcePut500 = false;
  getStatus = 200;
  assetBytes = null;
  putHang = false;
  putRelease = null;
  wsMock.annotationChangedCbs.length = 0;
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Element.prototype.scrollIntoView = realScrollIntoView;
});

// ---------------------------------------------------------------------------

describe("right-panel tabs", () => {
  it("defaults to 引用; 标注 carries a count badge; switching shows the list", async () => {
    serverFile.annotations = [
      mkAnn("a_00000001", structTarget("p-6", "paragraph"), "第一条"),
      mkAnn("a_00000002", docTarget, "整篇的意见"),
    ];
    const { container } = renderDocPane();
    await ready(container);
    // default tab: the in-view cards (the panel-title is its header)
    await waitFor(() =>
      expect(container.querySelector(".right .panel-title")?.textContent).toContain("In view")
    );
    expect(tabButton(container, "引用").className).toContain("on");
    expect(tabButton(container, "标注").textContent).toContain("2"); // badge

    fireEvent.click(tabButton(container, "标注"));
    await waitFor(() => expect(annEntryIds(container)).toEqual(["a_00000002", "a_00000001"]));
    expect(tabButton(container, "标注").className).toContain("on");
    expect(tabButton(container, "引用").className).not.toContain("on");
  });

  it("lists annotations document-level first, then in document order", async () => {
    serverFile.annotations = [
      mkAnn("a_00000010", structTarget("p-10", "paragraph"), "P10"),
      mkAnn("a_00000002", docTarget, "DOC"),
      mkAnn("a_00000006", structTarget("p-6", "paragraph"), "P6"),
      mkAnn(
        "a_00000003",
        {
          type: "structure",
          id: "sec-2",
          kind: "section",
          snapshot: { number: "1", heading: "Introduction" },
        },
        "SEC"
      ),
    ];
    const { container } = renderDocPane();
    await ready(container);
    fireEvent.click(tabButton(container, "标注"));
    await waitFor(() =>
      expect(annEntryIds(container)).toEqual([
        "a_00000002", // document-level first
        "a_00000003", // sec-2 precedes its blocks
        "a_00000006",
        "a_00000010",
      ])
    );
    // entry shows kind label + section path
    const sec = container.querySelector("[data-ann-id='a_00000003']");
    expect(sec?.textContent).toContain("章节 1");
    expect(sec?.textContent).toContain("Introduction");
  });

  it("text targets (created by MS4) render with their quote when present", async () => {
    serverFile.annotations = [
      mkAnn(
        "a_00000007",
        {
          type: "text",
          block: "p-6",
          container: { type: "content" },
          start: 0,
          end: 4,
          quote: "The ",
        },
        "文本批注"
      ),
    ];
    const { container } = renderDocPane();
    await ready(container);
    fireEvent.click(tabButton(container, "标注"));
    await waitFor(() => expect(annEntryIds(container)).toEqual(["a_00000007"]));
    expect(container.querySelector("[data-ann-id='a_00000007']")?.textContent).toContain("「The 」");
  });

  it("empty state renders when the doc has no annotations", async () => {
    const { container } = renderDocPane();
    await ready(container);
    fireEvent.click(tabButton(container, "标注"));
    await waitFor(() => expect(container.querySelector(".ann-panel")).toBeTruthy());
    expect(container.querySelector(".ann-panel")?.textContent).toContain("暂无标注");
  });
});

// ---------------------------------------------------------------------------

describe("structure annotation creation (hover edge button → popover)", () => {
  it("creates an equation annotation with the full snapshot", async () => {
    const { container } = renderDocPane();
    await ready(container);
    const eq = container.querySelector("[data-block-id='eq-1']")!;
    const btn = eq.querySelector<HTMLButtonElement>(".ann-edge-btn")!;
    expect(btn).toBeTruthy();
    fireEvent.click(btn);

    const pop = await waitPopover(container);
    expect(pop.textContent).toContain("公式 1");
    await saveEditor(pop, "检查这个公式的量纲 $x^2$");
    await waitFor(() => expect(putBodies).toHaveLength(1));

    const sent = putBodies[0];
    expect(sent.content_fingerprint).toBe(FP);
    expect(sent.rev).toBe(0);
    expect(sent.annotations).toHaveLength(1);
    const a = sent.annotations[0];
    expect(a.id).toMatch(/^a_[0-9a-f]{8}$/);
    expect(a.body).toBe("检查这个公式的量纲 $x^2$"); // raw bytes, untrimmed
    expect(a.created_at).toBe(a.updated_at);
    expect(a.target).toEqual({
      type: "structure",
      id: "eq-1",
      kind: "equation",
      snapshot: {
        number: EQ1.number,
        label: EQ1.label,
        latex: goldenBlock("eq-1").latex,
      },
    });

    // saved state: the popover switches to the body view, the marker appears
    await waitFor(() => expect(pop.textContent).toContain("检查这个公式的量纲"));
    await waitFor(() => expect(eq.querySelector(".ann-marker")).toBeTruthy());
    expect(eq.classList.contains("ann-has")).toBe(true);
  });

  it("creates a figure annotation: caption snapshot + asset_hash when the asset is fetchable", async () => {
    assetBytes = new TextEncoder().encode("fake-svg-bytes");
    const { container } = renderDocPane();
    await ready(container);
    const fig = container.querySelector("[data-block-id='fig-1']")!;
    fireEvent.click(fig.querySelector<HTMLButtonElement>(".ann-edge-btn")!);
    const pop = await waitPopover(container);
    expect(pop.textContent).toContain("图 1");
    await saveEditor(pop, "这张图的颜色映射");
    await waitFor(() => expect(putBodies).toHaveLength(1));

    const a = putBodies[0].annotations[0];
    expect(a.target.type).toBe("structure");
    if (a.target.type !== "structure") throw new Error("unreachable");
    expect(a.target.id).toBe("fig-1");
    expect(a.target.kind).toBe("figure");
    expect(a.target.snapshot.number).toBe("1");
    expect(a.target.snapshot.label).toBe("Figure 1");
    expect(a.target.snapshot.caption).toBe(FIG1_CAPTION);
    // sha256 of the served bytes — the same value core's fingerprint computes
    const want = createHash("sha256").update(assetBytes!).digest("hex");
    expect(a.target.snapshot.asset_hash).toBe(want);
  });

  it("uses the accepted manifest without a separate snapshot asset fetch", async () => {
    assetBytes = null; // /images 404s
    const { container } = renderDocPane();
    await ready(container);
    fireEvent.click(
      container.querySelector("[data-block-id='fig-1'] .ann-edge-btn") as HTMLButtonElement
    );
    const pop = await waitPopover(container);
    await saveEditor(pop, "无图时的标注");
    await waitFor(() => expect(putBodies).toHaveLength(1));
    const a = putBodies[0].annotations[0];
    if (a.target.type !== "structure") throw new Error("unreachable");
    expect(a.target.kind).toBe("figure");
    expect(a.target.snapshot.asset_hash).toBe(createHash("sha256").update("fixture").digest("hex"));
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("/images/"))).toHaveLength(0);
  });

  it("creation does not auto-switch/auto-expand the panel tab; the badge updates", async () => {
    const { container } = renderDocPane();
    await ready(container);
    fireEvent.click(
      container.querySelector("[data-block-id='p-6'] .ann-edge-btn") as HTMLButtonElement
    );
    const pop = await waitPopover(container);
    await saveEditor(pop, "段落标注");
    await waitFor(() => expect(putBodies).toHaveLength(1));
    // still on 引用, the in-view cards untouched, badge now counts 1
    expect(tabButton(container, "引用").className).toContain("on");
    expect(tabButton(container, "标注").textContent).toContain("1");
    expect(container.querySelector(".right .panel-title")?.textContent).toContain("In view");
  });

  it("section headings are annotatable structure targets", async () => {
    const { container } = renderDocPane();
    await ready(container);
    const sec = container.querySelector("[data-block-id='sec-2']")!;
    fireEvent.click(sec.querySelector<HTMLButtonElement>(".ann-edge-btn")!);
    const pop = await waitPopover(container);
    await saveEditor(pop, "这一章整体上");
    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0].annotations[0].target).toEqual({
      type: "structure",
      id: "sec-2",
      kind: "section",
      snapshot: { number: "1", heading: "Introduction" },
    });
  });
});

// ---------------------------------------------------------------------------

describe("edit + delete", () => {
  const EXISTING = mkAnn("a_00000006", structTarget("p-6", "paragraph"), "原始内容");

  beforeEach(() => {
    serverFile.annotations = [EXISTING];
  });

  it("edits the body through the popover (⌘↵), bumping only updated_at", async () => {
    const { container } = renderDocPane();
    await ready(container);
    const p6 = container.querySelector("[data-block-id='p-6']")!;
    await waitFor(() => expect(p6.querySelector(".ann-marker")).toBeTruthy());
    fireEvent.click(p6.querySelector<HTMLButtonElement>(".ann-marker")!);
    const pop = await waitPopover(container);
    expect(pop.textContent).toContain("原始内容");
    // enter edit mode
    fireEvent.click(
      [...pop.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        b.textContent?.includes("编辑")
      )!
    );
    const ta = pop.querySelector("textarea")!;
    expect(ta.value).toBe("原始内容");
    fireEvent.change(ta, { target: { value: "改后的内容" } });
    fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true }); // ⌘↵ saves
    await waitFor(() => expect(putBodies).toHaveLength(1));
    const sent = putBodies[0].annotations[0];
    expect(sent.body).toBe("改后的内容");
    expect(sent.target).toEqual(EXISTING.target); // target immutable
    expect(sent.created_at).toBe(EXISTING.created_at);
    expect(sent.updated_at).not.toBe(EXISTING.updated_at);
    // popover back in view mode with the new body
    await waitFor(() => expect(pop.textContent).toContain("改后的内容"));
  });

  it("IME-composing ⌘↵ does not save (Stage-4 smoke guard)", async () => {
    const { container } = renderDocPane();
    await ready(container);
    await waitFor(() =>
      expect(container.querySelector("[data-block-id='p-6'] .ann-marker")).toBeTruthy()
    );
    fireEvent.click(
      container.querySelector("[data-block-id='p-6'] .ann-marker") as HTMLButtonElement
    );
    const pop = await waitPopover(container);
    fireEvent.click(
      [...pop.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        b.textContent?.includes("编辑")
      )!
    );
    const ta = pop.querySelector("textarea")!;
    fireEvent.change(ta, { target: { value: "组词中" } });
    fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true, isComposing: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(putBodies).toHaveLength(0);
    expect(ta.value).toBe("组词中");
  });

  it("edits the body inline from the 标注 list entry", async () => {
    const { container } = renderDocPane();
    await ready(container);
    fireEvent.click(tabButton(container, "标注"));
    const entry = await waitFor(() => container.querySelector(".ann-entry") as HTMLElement);
    fireEvent.click(entry.querySelector<HTMLButtonElement>("[aria-label='编辑标注']")!);
    await saveEditor(entry, "列表里改的");
    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0].annotations[0].body).toBe("列表里改的");
    await waitFor(() => expect(entry.textContent).toContain("列表里改的"));
  });

  it("rejects a trim-empty body (save disabled)", async () => {
    const { container } = renderDocPane();
    await ready(container);
    await waitFor(() =>
      expect(container.querySelector("[data-block-id='p-6'] .ann-marker")).toBeTruthy()
    );
    fireEvent.click(
      container.querySelector("[data-block-id='p-6'] .ann-marker") as HTMLButtonElement
    );
    const pop = await waitPopover(container);
    fireEvent.click(
      [...pop.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        b.textContent?.includes("编辑")
      )!
    );
    const ta = pop.querySelector("textarea")!;
    fireEvent.change(ta, { target: { value: "   " } });
    const save = [...pop.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("保存")
    )!;
    expect(save.disabled).toBe(true);
  });

  it("deletes an annotation from the list (no confirmation), updating the block marker", async () => {
    const { container } = renderDocPane();
    await ready(container);
    const p6 = container.querySelector("[data-block-id='p-6']")!;
    await waitFor(() => expect(p6.querySelector(".ann-marker")).toBeTruthy());
    fireEvent.click(tabButton(container, "标注"));
    const entry = await waitFor(() => container.querySelector(".ann-entry") as HTMLElement);
    fireEvent.click(entry.querySelector<HTMLButtonElement>("[aria-label='删除标注']")!);
    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0].annotations).toHaveLength(0);
    await waitFor(() => expect(container.querySelector(".ann-entry")).toBeNull());
    expect(p6.classList.contains("ann-has")).toBe(false);
    expect(tabButton(container, "标注").textContent).not.toContain("1");
  });

  it("clicking a list entry jumps to the target block with flash and activates it", async () => {
    const { container } = renderDocPane();
    await ready(container);
    fireEvent.click(tabButton(container, "标注"));
    const main = await waitFor(
      () => container.querySelector(".ann-entry .ann-entry-main") as HTMLButtonElement
    );
    fireEvent.click(main);
    const p6 = container.querySelector("[data-block-id='p-6']")!;
    await waitFor(() => expect(scrolled).toContain(p6));
    expect(p6.classList.contains("flash")).toBe(true);
    expect(container.querySelector(".ann-entry")!.className).toContain("active");
    expect(p6.classList.contains("ann-active")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("document-level annotations via the panel-top editor", () => {
  it("creates a document annotation from the 添加文档标注 button", async () => {
    const { container } = renderDocPane();
    await ready(container);
    fireEvent.click(tabButton(container, "标注"));
    fireEvent.click(
      await waitFor(() => {
        const b = [...container.querySelectorAll<HTMLButtonElement>("button")].find((x) =>
          x.textContent?.includes("添加文档标注")
        );
        expect(b).toBeTruthy();
        return b!;
      })
    );
    const panel = container.querySelector(".ann-panel")!;
    await saveEditor(panel as HTMLElement, "整篇文档的意见");
    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0].annotations[0].target).toEqual({ type: "document" });
    // listed first, before any structure annotation
    await waitFor(() => expect(container.querySelector(".ann-entry")?.textContent).toContain("整篇文档"));
    expect(container.querySelector(".ann-entry")?.textContent).toContain("整篇文档的意见");
  });
});

// ---------------------------------------------------------------------------

describe("PUT conflict flows (roadmap §5)", () => {
  it('409 "document changed" → toast + coherent reload, never accept the PUT file as IR', async () => {
    const { container } = renderDocPane();
    await ready(container);
    // the doc was re-ingested elsewhere: the server moved to a new epoch with
    // one pre-existing annotation in it
    serverFile = {
      version: 1,
      rev: 0,
      content_fingerprint: "fp-epoch-2",
      annotations: [mkAnn("a_00000009", docTarget, "新纪元里的标注")],
    };
    fireEvent.click(
      container.querySelector("[data-block-id='p-6'] .ann-edge-btn") as HTMLButtonElement
    );
    const pop = await waitPopover(container);
    await saveEditor(pop, "基于旧文档的标注");
    await waitFor(() => expect(putBodies).toHaveLength(1));
    await waitFor(() =>
      expect(container.querySelector(".ann-toast")?.textContent).toContain(
        "文档内容已变化，旧标注已归档"
      )
    );
    // Only the following coherent GET can restore the list; the stale target is dropped
    fireEvent.click(tabButton(container, "标注"));
    await waitFor(() => expect(annEntryIds(container)).toEqual(["a_00000009"]));
  });

  it('409 "rev mismatch" → toast + refetch', async () => {
    const { container } = renderDocPane();
    await ready(container);
    // another writer lands first: the server's file advances behind our back
    serverFile = {
      version: 1,
      rev: 1,
      content_fingerprint: FP,
      annotations: [mkAnn("a_00000008", docTarget, "别人写入的")],
    };
    fireEvent.click(
      container.querySelector("[data-block-id='p-6'] .ann-edge-btn") as HTMLButtonElement
    );
    const pop = await waitPopover(container);
    await saveEditor(pop, "我的标注");
    await waitFor(() => expect(putBodies).toHaveLength(1));
    await waitFor(() =>
      expect(container.querySelector(".ann-toast")?.textContent).toContain(
        "标注已在其他位置更新，请等待同步"
      )
    );
    // refetched: the other writer's annotation is now what the list shows
    fireEvent.click(tabButton(container, "标注"));
    await waitFor(() => expect(annEntryIds(container)).toEqual(["a_00000008"]));
  });

  it("500 → error shown, editor draft and current UI preserved", async () => {
    forcePut500 = true;
    const { container } = renderDocPane();
    await ready(container);
    fireEvent.click(
      container.querySelector("[data-block-id='p-6'] .ann-edge-btn") as HTMLButtonElement
    );
    const pop = await waitPopover(container);
    await saveEditor(pop, "会失败的标注");
    await waitFor(() => expect(putBodies).toHaveLength(1));
    await waitFor(() =>
      expect(container.querySelector(".ann-toast")?.textContent).toContain("标注保存失败")
    );
    // the editor stays open with the draft; the annotation list is untouched
    expect(container.querySelector<HTMLTextAreaElement>("[aria-label='保留的创建草稿']")?.value).toBe("会失败的标注");
    expect(container.querySelector(".ann-popover")).toBeNull();
    expect(container.querySelector(".reader-sync-status")?.textContent).toContain("更新失败");
    expect(container.querySelector("[data-block-id='p-6'] .ann-marker")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("#ann-<id> deep links", () => {
  it("a known id jumps to the target block, activates and opens the popover", async () => {
    serverFile.annotations = [mkAnn("a_00000006", structTarget("p-6", "paragraph"), "深链接目标")];
    const { container, clearPendingAnchor } = renderDocPane("ann-a_00000006");
    await ready(container);
    const p6 = container.querySelector("[data-block-id='p-6']")!;
    await waitFor(() => expect(scrolled).toContain(p6));
    await waitFor(() => expect(clearPendingAnchor).toHaveBeenCalled());
    const pop = await waitPopover(container);
    expect(pop.textContent).toContain("深链接目标");
    expect(p6.classList.contains("ann-active")).toBe(true);
  });

  it("a document-level annotation opens its popover without jumping", async () => {
    serverFile.annotations = [mkAnn("a_00000002", docTarget, "整篇深链接")];
    const { container } = renderDocPane("ann-a_00000002");
    await ready(container);
    const pop = await waitPopover(container);
    expect(pop.textContent).toContain("整篇深链接");
    expect(scrolled.length).toBe(0);
  });

  it("an unknown/deleted id is consumed silently (no jump, no popover)", async () => {
    serverFile.annotations = [mkAnn("a_00000006", structTarget("p-6", "paragraph"), "x")];
    const { container, clearPendingAnchor } = renderDocPane("ann-a_ffffffff");
    await ready(container);
    await waitFor(() => expect(clearPendingAnchor).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector(".ann-popover")).toBeNull();
    expect(scrolled.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("annotation.changed refetch", () => {
  it("refetches when the broadcast names this doc; ignores other docs", async () => {
    serverFile.annotations = [mkAnn("a_00000006", structTarget("p-6", "paragraph"), "初始")];
    const { container } = renderDocPane();
    await ready(container);
    // deterministic settle: the marker renders only after the initial GET's
    // file is applied to the provider state
    await waitFor(() =>
      expect(container.querySelector("[data-block-id='p-6'] .ann-marker")).toBeTruthy()
    );
    const getsBefore = getCount;
    expect(getsBefore).toBeGreaterThan(0);

    // another doc's change: no refetch
    act(() => wsMock.annotationChangedCbs.forEach((cb) => cb("other-doc")));
    await new Promise((r) => setTimeout(r, 30));
    expect(getCount).toBe(getsBefore);

    // this doc changed externally: refetch picks up the new file
    serverFile = {
      ...serverFile,
      rev: 2,
      annotations: [
        ...serverFile.annotations,
        mkAnn("a_00000077", docTarget, "外部新增的"),
      ],
    };
    act(() => wsMock.annotationChangedCbs.forEach((cb) => cb(DOC)));
    await waitFor(() => expect(getCount).toBe(getsBefore + 1));
    fireEvent.click(tabButton(container, "标注"));
    await waitFor(() =>
      expect(annEntryIds(container)).toEqual(["a_00000077", "a_00000006"])
    );
  });

  it("a 404 refetch (doc deleted externally) clears the annotations quietly", async () => {
    serverFile.annotations = [mkAnn("a_00000006", structTarget("p-6", "paragraph"), "会被清的")];
    const { container } = renderDocPane();
    await ready(container);
    await waitFor(() =>
      expect(container.querySelector("[data-block-id='p-6'] .ann-marker")).toBeTruthy()
    );
    getStatus = 404; // the watcher fired "external" for the removed current.json
    act(() => wsMock.annotationChangedCbs.forEach((cb) => cb(DOC)));
    await waitFor(() =>
      expect(container.querySelector("[data-block-id='p-6'] .ann-marker")).toBeNull()
    );
    await waitFor(() => expect(container.querySelector(".reader-sync-status")?.textContent).toContain("文档不存在"));
    expect(container.querySelector("main.reader")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("review probes (MS3 fix round)", () => {
  it("an externally deleted annotation auto-closes its viewing popover", async () => {
    serverFile.annotations = [mkAnn("a_00000006", structTarget("p-6", "paragraph"), "会被外部删除")];
    const { container } = renderDocPane();
    await ready(container);
    await waitFor(() =>
      expect(container.querySelector("[data-block-id='p-6'] .ann-marker")).toBeTruthy()
    );
    fireEvent.click(
      container.querySelector("[data-block-id='p-6'] .ann-marker") as HTMLButtonElement
    );
    await waitPopover(container);
    // the annotation vanishes server-side; the ws-driven refetch removes it
    serverFile = { ...serverFile, rev: 1, annotations: [] };
    act(() => wsMock.annotationChangedCbs.forEach((cb) => cb(DOC)));
    await waitFor(() => expect(container.querySelector(".ann-popover")).toBeNull());
  });

  it("saving an unchanged body is a no-op: no PUT, updated_at untouched, editor just closes", async () => {
    serverFile.annotations = [mkAnn("a_00000006", structTarget("p-6", "paragraph"), "原样")];
    const { container } = renderDocPane();
    await ready(container);
    await waitFor(() =>
      expect(container.querySelector("[data-block-id='p-6'] .ann-marker")).toBeTruthy()
    );
    fireEvent.click(
      container.querySelector("[data-block-id='p-6'] .ann-marker") as HTMLButtonElement
    );
    const pop = await waitPopover(container);
    fireEvent.click(
      [...pop.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        b.textContent?.includes("编辑")
      )!
    );
    const ta = pop.querySelector("textarea")!;
    expect(ta.value).toBe("原样");
    fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true }); // save without touching the draft
    await new Promise((r) => setTimeout(r, 30));
    expect(putBodies).toHaveLength(0);
    expect(serverFile.annotations[0].updated_at).toBe("2026-09-10T08:00:00.000Z");
    // back to the view mode, popover still open
    expect(pop.querySelector("textarea")).toBeNull();
    expect(pop.textContent).toContain("原样");
  });

  it("create → edit → delete rides the server-bumped rev chain", async () => {
    const { container } = renderDocPane();
    await ready(container);
    fireEvent.click(
      container.querySelector("[data-block-id='p-6'] .ann-edge-btn") as HTMLButtonElement
    );
    const pop = await waitPopover(container);
    await saveEditor(pop, "链上的创建");
    await waitFor(() => expect(putBodies).toHaveLength(1));
    // the popover now views the created annotation — edit it in place
    fireEvent.click(
      [...pop.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        b.textContent?.includes("编辑")
      )!
    );
    await waitFor(() => expect(pop.querySelector("textarea")?.value).toBe("链上的创建"));
    fireEvent.change(pop.querySelector("textarea")!, { target: { value: "链上的修改" } });
    fireEvent.click(
      [...pop.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        b.textContent?.includes("保存")
      )!
    );
    await waitFor(() => expect(putBodies).toHaveLength(2));
    // delete from the same popover
    fireEvent.click(
      [...pop.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        b.textContent?.includes("删除")
      )!
    );
    await waitFor(() => expect(putBodies).toHaveLength(3));
    expect(putBodies.map((b) => b.rev)).toEqual([0, 1, 2]);
    expect(putBodies[1].annotations[0].body).toBe("链上的修改");
    expect(putBodies[2].annotations).toHaveLength(0);
    expect(serverFile.rev).toBe(3);
    await waitFor(() => expect(container.querySelector(".ann-popover")).toBeNull());
  });

  it("annotations whose target block is missing from the IR sort last, in stable file order", async () => {
    serverFile.annotations = [
      mkAnn("a_00000011", structTarget("p-999", "paragraph"), "缺失块一"),
      mkAnn("a_00000006", structTarget("p-6", "paragraph"), "存在的"),
      mkAnn("a_00000002", docTarget, "文档级"),
      mkAnn("a_00000012", structTarget("sec-999", "section"), "缺失块二"),
    ];
    const { container } = renderDocPane();
    await ready(container);
    fireEvent.click(tabButton(container, "标注"));
    await waitFor(() =>
      expect(annEntryIds(container)).toEqual([
        "a_00000002", // document-level first
        "a_00000006", // existing block in document order
        "a_00000011", // missing blocks last, stable in file order
        "a_00000012",
      ])
    );
  });

  it("an edit in progress keeps its draft across a 409 document-changed (target archived)", async () => {
    serverFile.annotations = [mkAnn("a_00000006", structTarget("p-6", "paragraph"), "原始内容")];
    const { container } = renderDocPane();
    await ready(container);
    await waitFor(() =>
      expect(container.querySelector("[data-block-id='p-6'] .ann-marker")).toBeTruthy()
    );
    fireEvent.click(
      container.querySelector("[data-block-id='p-6'] .ann-marker") as HTMLButtonElement
    );
    const pop = await waitPopover(container);
    fireEvent.click(
      [...pop.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        b.textContent?.includes("编辑")
      )!
    );
    const ta = pop.querySelector("textarea")!;
    fireEvent.change(ta, { target: { value: "改了一半的内容" } });
    // the doc is re-ingested elsewhere before the save lands
    serverFile = { version: 1, rev: 0, content_fingerprint: "fp-epoch-2", annotations: [] };
    fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(putBodies).toHaveLength(1));
    await waitFor(() =>
      expect(container.querySelector(".ann-toast")?.textContent).toContain(
        "文档内容已变化，旧标注已归档"
      )
    );
    expect(container.querySelector(".ann-popover")).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>("[aria-label='保留的编辑草稿 a_00000006']")?.value).toBe("改了一半的内容");
    expect(container.querySelector(".reader-drafts")?.textContent).toContain("不可保存");
    expect(putBodies).toHaveLength(1);

  });

  it("a create draft requires a fresh target and explicit reuse after coherent reload", async () => {
    const { container } = renderDocPane();
    await ready(container);
    fireEvent.click(
      container.querySelector("[data-block-id='eq-1'] .ann-edge-btn") as HTMLButtonElement
    );
    const pop = await waitPopover(container);
    fireEvent.change(pop.querySelector("textarea")!, { target: { value: "跨纪元的创建" } });
    // re-ingest lands between opening the popover and saving
    serverFile = { version: 1, rev: 0, content_fingerprint: "fp-epoch-2", annotations: [] };
    fireEvent.keyDown(pop.querySelector("textarea")!, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(putBodies).toHaveLength(1));
    await waitFor(() =>
      expect(container.querySelector(".ann-toast")?.textContent).toContain("文档内容已变化")
    );
    await waitFor(() => expect(container.querySelector(".ann-popover")).toBeNull());
    expect(container.querySelector<HTMLTextAreaElement>("[aria-label='保留的创建草稿']")?.value).toBe("跨纪元的创建");
    fireEvent.click(container.querySelector("[data-block-id='eq-1'] .ann-edge-btn")!);
    const fresh = await waitPopover(container);
    expect(fresh.querySelector("textarea")?.value).toBe("");
    fireEvent.click([...fresh.querySelectorAll("button")].find((b) => b.textContent === "使用保留文字")!);
    expect(fresh.querySelector("textarea")?.value).toBe("跨纪元的创建");
    fireEvent.keyDown(fresh.querySelector("textarea")!, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(putBodies).toHaveLength(2));
    const retry = putBodies[1];
    expect(retry.content_fingerprint).toBe("fp-epoch-2");
    expect(retry.rev).toBe(0);
    expect(retry.annotations[0].target).toEqual({
      type: "structure",
      id: "eq-1",
      kind: "equation",
      snapshot: { number: "1", label: "eq:Dist_err", latex: goldenBlock("eq-1").latex },
    });
    // saved: the popover switches to the body view
    await waitFor(() => expect(fresh.querySelector("textarea")).toBeNull());
    expect(fresh.textContent).toContain("跨纪元的创建");
  });

  it("double-clicking 保存 issues a single PUT (busy guards the async hash window)", async () => {
    putHang = true;
    const { container } = renderDocPane();
    await ready(container);
    fireEvent.click(
      container.querySelector("[data-block-id='p-6'] .ann-edge-btn") as HTMLButtonElement
    );
    const pop = await waitPopover(container);
    fireEvent.change(pop.querySelector("textarea")!, { target: { value: "只应保存一次" } });
    const save = [...pop.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("保存")
    )!;
    fireEvent.click(save);
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(putBodies).toHaveLength(1));
    putRelease!();
    await waitFor(() => expect(pop.textContent).toContain("只应保存一次"));
    await new Promise((r) => setTimeout(r, 30));
    expect(putBodies).toHaveLength(1);
    expect(serverFile.annotations).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("asset hashing uses WebCrypto (happy-dom sanity)", () => {
  it("crypto.subtle.digest matches node sha256", async () => {
    const bytes = new TextEncoder().encode("probe");
    const viaWeb = await crypto.subtle.digest("SHA-256", bytes);
    const hex = [...new Uint8Array(viaWeb)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(webcrypto).toBeTruthy();
  });
});
