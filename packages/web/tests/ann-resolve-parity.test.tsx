vi.mock("../src/doc/ReaderSession", () => import("./reader-unit-session"));
import { AnnotationProvider } from "../src/annotations/AnnotationStore";
/**
 * (Copilot ticket 19, F8) The page's DOM selection mapper and the server-side `resolveTextTarget` must give the SAME
 * stored target for every range: this runs both over the real rendered DOM of the shared fixture, for every start/end
 * pair of the mixed text/math/cite/xref paragraph, a caption and a list item.
 *
 * Stage 8 MS4: the offset ↔ DOM Range primitive (`annotations/textmap.ts`)
 * tested EXHAUSTIVELY against the real rendered DOM (StoreProvider + Reader,
 * same harness shape as annotations.test.tsx) — the renderer's byte-exact
 * output is what the mapper aligns to, so hand-built DOM would drift.
 *
 * Covered: mixed text/math/cite/xref paragraph alignment, caption containers
 * (cap-label exclusion), list-item addressing, atomic boundary expansion in
 * both directions, cite-chip visible-text offsets, skipped subtrees
 * (.ann-edge/.cap-label), cross-container rejection, misalignment failures,
 * range→offsets→range round-trips, and the highlight painter's registry
 * mechanics (faked deps — happy-dom has no CSS Custom Highlight API).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  canonicalSegmentsText,
  resolveTextTarget,
  type TexDocIr,
} from "@argelanderspace/contracts";
import { StoreProvider } from "../src/store";
import { Reader } from "../src/components/Reader";
import {
  buildContainerMap,
  offsetsForRange,
  rangeForOffsets,
} from "../src/annotations/textmap";
import {
  FIG_CAPTION,
  fixtureBlock,
  fixtureIr,
  IOStub,
  P1_SEGMENTS,
} from "./ann-fixture";

vi.mock("../src/api/ws", () => ({
  onAnnotationChanged: () => () => {},
  onLibraryChanged: () => () => {},
  onPlanChanged: () => () => {},
  onJobEvent: () => () => {},
}));

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: 1, rev: 0, content_fingerprint: "fp", annotations: [] }),
    }))
  );
}

async function renderReader() {
  const utils = render(
    <StoreProvider ir={fixtureIr}><AnnotationProvider>
      <Reader />
    </AnnotationProvider></StoreProvider>
  );
  await waitFor(() => expect(utils.container.querySelector("[data-block-id='p-1']")).toBeTruthy());
  await act(async () => {}); // flush the annotation provider's load
  return utils;
}

const block = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-block-id='${id}']`)!;

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", IOStub);
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe("DOM selection mapper and resolveTextTarget agree on every range", () => {
  const ir = fixtureIr as unknown as TexDocIr;
  async function check(
    el: (c: HTMLElement) => Element,
    segments: Parameters<typeof canonicalSegmentsText>[0],
    blockId: string,
    container: { type: "content" } | { type: "caption" } | { type: "list_item"; index: number }
  ) {
    const { container: root } = await renderReader();
    const map = buildContainerMap(el(root), segments);
    const length = map.canonical.length;
    let checked = 0;
    for (let s = 0; s < length; s++)
      for (let e = s + 1; e <= length; e++) {
        const range = rangeForOffsets(map, s, e);
        expect(range, `range ${s}..${e}`).not.toBeNull();
        const dom = offsetsForRange(map, range!);
        const server = resolveTextTarget(ir, { block: blockId, container, start: s, end: e });
        expect(server.ok, `server ${s}..${e}`).toBe(true);
        if (!server.ok) return;
        expect({ start: server.target.start, end: server.target.end }, `${s}..${e}`).toEqual(dom);
        expect(server.target.quote).toBe(map.canonical.slice(dom!.start, dom!.end));
        checked += 1;
      }
    expect(checked).toBeGreaterThan(100);
  }

  it("a mixed text/math/cite/xref paragraph", async () => {
    await check((c) => block(c, "p-1"), P1_SEGMENTS, "p-1", { type: "content" });
  });

  it("a caption with math", async () => {
    await check((c) => block(c, "fig-1").querySelector("figcaption")!, FIG_CAPTION, "fig-1", { type: "caption" });
  });

  it("a list item with math", async () => {
    const b = fixtureBlock("list-1");
    if (b.type !== "list") throw new Error("fixture");
    await check((c) => block(c, "list-1").querySelectorAll(".doc-list > li")[0]!, b.items[0]!.segments, "list-1", { type: "list_item", index: 0 });
  });
});
