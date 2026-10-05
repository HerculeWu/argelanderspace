/**
 * A text Doc's Reader around a regeneration (copilot ticket 28), through the real DocPane, ReaderSession and
 * annotation layer: the new reading version is accepted only through the shared coherent read, the old layout and
 * the page's drafts survive the update and a failure, and a sync failure after a publish is reported as exactly that
 * (published, not rolled back).
 */

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoherentAnnotationsRead, TextDocIr } from "@argelanderspace/contracts";
import { DocPane } from "../src/doc/DocPane";
import { WorkspaceProvider, type Workspace } from "../src/argelander/workspace";

const DOC = "text-11111111-1111-4111-8111-111111111111";
const events = vi.hoisted(() => ({
  published: new Set<(m: { doc_id: string; published_source_rev: number; at: string; type: "text-doc.published" }) => void>(),
  annotation: new Set<(id: string) => void>(),
  library: new Set<() => void>(),
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
  onTextDocPublished: (cb: never) => {
    events.published.add(cb);
    return () => events.published.delete(cb);
  },
  onTextSourceChanged: () => () => {},
}));

function representation(text: string, rev: number, fp: string): CoherentAnnotationsRead {
  const ir: TextDocIr = {
    version: 1,
    docId: DOC,
    title: `Title ${text}`,
    source: { type: "text", input_version: 1, source_rev: rev + 1, source_fingerprint: "c".repeat(64) },
    meta: {},
    sections: [
      {
        id: "sec-1",
        level: 1,
        heading: "Heading",
        blocks: [{ id: "p-1", type: "paragraph", segments: [{ type: "text", text: `Real body ${text}` }] }],
        children: [],
      },
    ],
    refsManifest: [],
    bib: [],
    citationsByBlock: {},
  };
  return { version: 1, ir, file: { version: 1, rev, content_fingerprint: fp, annotations: [] }, assets: [] };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
interface Pending {
  url: string;
  resolve: (r: Response) => void;
}
let pending: Pending[];

async function answer(index: number, body: unknown, status = 200) {
  for (let turn = 0; pending[index] === undefined && turn < 30; turn++) await act(async () => Promise.resolve());
  expect(pending[index], `expected coherent request ${index}`).toBeDefined();
  await act(async () => pending[index]!.resolve(json(body, status)));
}

beforeEach(() => {
  pending = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const u = String(url);
      if (u.endsWith("/description"))
        return Promise.resolve(json({ doc_id: DOC, format: "text", generated: true, source_rev: 1, published_source_rev: 1 }));
      if (u.endsWith("/source"))
        return Promise.resolve(
          json({
            doc_id: DOC,
            rev: 1,
            input_version: 1,
            markdown: "# T\n",
            assets: [],
            created_at: "2026-10-05T00:00:00.000Z",
            updated_at: "2026-10-05T00:00:00.000Z",
            generated: true,
            published_source_rev: 1,
          })
        );
      return new Promise<Response>((resolve) => pending.push({ url: u, resolve }));
    })
  );
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  events.published.clear();
  events.annotation.clear();
  events.library.clear();
  vi.unstubAllGlobals();
});

function Harness() {
  const ws: Workspace = {
    papers: [DOC],
    currentDoc: DOC,
    setCurrentDoc: () => {},
    openDoc: () => {},
    pendingAnchor: null,
    clearPendingAnchor: () => {},
    docDeleted: () => {},
    tweaks: { theme: "dark", accent: "azure", density: "regular", labels: true },
  };
  return (
    <WorkspaceProvider value={ws}>
      <DocPane />
    </WorkspaceProvider>
  );
}
const publish = () =>
  act(() => {
    for (const cb of events.published) cb({ type: "text-doc.published", doc_id: DOC, published_source_rev: 2, at: "2026-10-05T00:00:00.000Z" });
  });
const status = (c: HTMLElement) => c.querySelector(".reader-sync-status")?.textContent ?? "";

async function opened() {
  const view = render(<Harness />);
  await answer(0, representation("A", 100, "A"));
  await waitFor(() => expect(view.container.querySelector("main.reader")?.textContent).toContain("Real body A"));
  return view;
}

describe("a regenerated text Doc in the shared Reader", () => {
  it("the published event makes the Reader read again; the old text stays until the new coherent read is accepted, then the new epoch (rev 0, no annotations) shows", async () => {
    const view = await opened();
    const main = view.container.querySelector("main.reader")!;
    publish();
    expect(pending).toHaveLength(2);
    expect(pending[1]!.url).toContain("coherent=1");
    // while the read is out: the same element, the old text
    expect(view.container.querySelector("main.reader")).toBe(main);
    expect(main.textContent).toContain("Real body A");
    await answer(1, representation("B", 0, "B"));
    await waitFor(() => expect(main.textContent).toContain("Real body B"));
    expect(main.textContent).not.toContain("Real body A");
    expect(status(view.container)).toBe("");
  });

  it("a draft the user is typing survives the update as a retained draft and is never bound to the new text by itself", async () => {
    const view = await opened();
    const main = view.container.querySelector("main.reader")!;
    fireEvent.click(main.querySelector("[data-block-id='p-1'] .ann-edge-btn")!);
    fireEvent.change(main.querySelector("textarea")!, { target: { value: "my note" } });
    publish();
    await answer(1, representation("B", 0, "B"));
    await waitFor(() => expect(main.textContent).toContain("Real body B"));
    expect(view.container.querySelector<HTMLTextAreaElement>("[aria-label='保留的创建草稿']")?.value).toBe("my note");
    expect(pending).toHaveLength(2); // nothing was saved or re-sent on its own
  });

  it("a read that fails after the publish says so: published, the old text kept, no rollback claimed; the manual retry accepts the new version", async () => {
    const view = await opened();
    const main = view.container.querySelector("main.reader")!;
    publish();
    await answer(1, { detail: "annotations store: the old current was archived but the new current could not be created" }, 500);
    await waitFor(() => expect(status(view.container)).toContain("已发布"));
    expect(status(view.container)).toContain("旧正文");
    expect(main.textContent).toContain("Real body A");
    fireEvent.click(view.container.querySelector<HTMLElement>("[data-ui='retry-latex-sync']")!);
    await answer(2, representation("B", 0, "B"));
    await waitFor(() => expect(main.textContent).toContain("Real body B"));
    expect(status(view.container)).toBe("");
  });

  it("a read that fails without any publish keeps the ordinary wording", async () => {
    const view = await opened();
    act(() => {
      for (const cb of events.library) cb();
    });
    await answer(1, { detail: "boom" }, 500);
    await waitFor(() => expect(status(view.container)).toContain("更新失败"));
    expect(status(view.container)).not.toContain("已发布");
  });
});
