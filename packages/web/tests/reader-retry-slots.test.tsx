/**
 * Ticket 32 fix round 1 (B1): a text Doc keeps its source panel and its reading mounted on ONE bridge. Each offers its own
 * Retry while its error is shown; one ending must never withdraw the other's, and `retry_sync` presses every offer present.
 * Real DocPane, real reading session, real publisher bridge: only the HTTP answers are scripted.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReaderViewController } from "../src/doc/reader-bridge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocPane } from "../src/doc/DocPane";
import { WorkspaceProvider, type Workspace } from "../src/argelander/workspace";

vi.mock("../src/api/ws", () => ({
  onTextDocPublished: () => () => {},
  onTextSourceChanged: () => () => {},
  onLibraryChanged: () => () => {},
  onAnnotationChanged: () => () => {},
}));

const DOC = "text-11111111-1111-4111-8111-111111111111";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let sourceStatus = 500;
let readingStatus = 500;
let log: string[] = [];
let controller: ReaderViewController | null = null;

beforeEach(() => {
  sourceStatus = 500;
  readingStatus = 500;
  log = [];
  controller = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      log.push(url);
      if (url === `/api/paper/${DOC}/description`)
        return json({ doc_id: DOC, format: "text", generated: true, source_rev: 1, published_source_rev: 1 });
      if (url === `/api/paper/${DOC}/source`)
        return sourceStatus === 200
          ? json({ doc_id: DOC, rev: 1, input_version: 1, markdown: "# T", assets: [], created_at: "2026-10-05T00:00:00.000Z", updated_at: "2026-10-05T00:00:00.000Z", generated: true, published_source_rev: 1 })
          : json({ detail: "boom" }, sourceStatus);
      if (url.startsWith(`/api/paper/${DOC}/annotations?coherent=1`)) return json({ detail: "boom" }, readingStatus);
      return json({ detail: "unexpected" }, 500);
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const count = (suffix: string) => log.filter((url) => url.includes(suffix)).length;
function mount() {
  const workspace: Workspace = {
    papers: [DOC], currentDoc: DOC, setCurrentDoc: () => {}, openDoc: () => {},
    pendingAnchor: null, clearPendingAnchor: () => {}, docDeleted: () => {},
    tweaks: { theme: "dark", accent: "azure", density: "regular", labels: true },
  };
  return render(
    <WorkspaceProvider value={workspace}>
      <DocPane paneId={1} onController={(_pane, next) => { controller = next; }} />
    </WorkspaceProvider>
  );
}
const ui = (id: string) => document.querySelector(`[data-ui="${id}"]`);
const retry = () => controller!.apply({ action: "retry_sync", docId: DOC });

describe("retry_sync with the source panel and the reading both failing", () => {
  it("reaches a visible Retry when the source error shows while the reading's cleanup/rerender happens first (scenario 1)", async () => {
    mount();
    await waitFor(() => expect(ui("retry-text-source")).toBeTruthy());
    await waitFor(() => expect(count("annotations?coherent=1")).toBeGreaterThan(0));
    const sourceBefore = count("/source");
    const readingBefore = count("annotations?coherent=1");
    expect(await retry()).toEqual({ ok: true });
    // the visible source Retry was pressed (and the reading's too): neither answer is "disabled"
    await waitFor(() => expect(count("/source")).toBe(sourceBefore + 1));
    await waitFor(() => expect(count("annotations?coherent=1")).toBeGreaterThan(readingBefore));
  });

  it("keeps the reading banner's Retry reachable after the source retry succeeded (scenario 2, a regression before the fix)", async () => {
    mount();
    await waitFor(() => expect(ui("retry-text-source")).toBeTruthy());
    await waitFor(() => expect(count("annotations?coherent=1")).toBeGreaterThan(0));
    sourceStatus = 200; // the source recovers; the reading stays broken
    expect(await retry()).toEqual({ ok: true });
    await waitFor(() => expect(ui("retry-text-source")).toBeNull());
    await waitFor(() => expect(ui("retry-latex-sync")).toBeTruthy());
    const before = count("annotations?coherent=1");
    expect(await retry()).toEqual({ ok: true });
    await waitFor(() => expect(count("annotations?coherent=1")).toBeGreaterThan(before));
  });

});
