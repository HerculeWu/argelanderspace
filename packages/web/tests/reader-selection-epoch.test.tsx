/**
 * A selection belongs to the epoch it was made in (copilot ticket 18): the session binds it to the accepted
 * fingerprint and drops it when the epoch is frozen, and the page publisher refuses to pair a selection with a
 * reading of another fingerprint even if one were carried over.
 */
import { act, cleanup, render } from "@testing-library/react";
import type { AnnotationTextTarget, CoherentAnnotationsRead, ReaderPage } from "@argelanderspace/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderSessionController, type ReaderSessionState } from "../src/doc/ReaderSession";
import { type ReaderBridge, useReaderPublisher } from "../src/doc/reader-bridge";

vi.mock("../src/api/ws", () => ({ onLibraryChanged: () => () => {}, onAnnotationChanged: () => () => {} }));

const representation = (fp: string): CoherentAnnotationsRead => ({
  version: 1,
  ir: {
    version: 1,
    docId: "d",
    title: "T",
    source: { type: "latex", origin: "x", main_tex: "main.tex" },
    meta: {},
    sections: [{ id: "sec-1", level: 1, heading: "H", blocks: [{ id: "p-1", type: "paragraph", segments: [{ type: "text", text: "Real body" }] }], children: [] }],
    refsManifest: [],
    bib: [],
    citationsByBlock: {},
  },
  file: { version: 1, rev: 0, content_fingerprint: fp, annotations: [] },
  assets: [],
});
const target: AnnotationTextTarget = { type: "text", block: "p-1", container: { type: "content" }, start: 0, end: 4, quote: "Real" };
const last = <T,>(items: T[]) => items[items.length - 1];
let fp: string;
beforeEach(() => {
  fp = "fp-A";
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => representation(fp) }) as Response));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function ready() {
  const controller = new ReaderSessionController("d");
  controller.start();
  await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("ready"));
  return controller;
}

describe("ReaderSessionController selection", () => {
  it("binds a settled selection to the accepted fingerprint", async () => {
    const controller = await ready();
    controller.setSelection(target);
    expect(controller.getSnapshot().selection).toEqual({ fingerprint: "fp-A", target });
    controller.setSelection(null);
    expect(controller.getSnapshot().selection).toBeNull();
    controller.stop();
  });

  it("is dropped when the epoch is frozen for a new read, and cannot be set while the Reader is not ready", async () => {
    const controller = await ready();
    controller.setSelection(target);
    fp = "fp-B";
    controller.requestSync();
    expect(controller.getSnapshot().phase).toBe("syncing");
    expect(controller.getSnapshot().selection).toBeNull();
    controller.setSelection(target);
    expect(controller.getSnapshot().selection).toBeNull();
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("ready"));
    expect(controller.getSnapshot().selection).toBeNull();
    expect(controller.getSnapshot().accepted?.file.content_fingerprint).toBe("fp-B");
    controller.stop();
  });
});

describe("the page publisher", () => {
  function publisher() {
    const pages: (ReaderPage | null)[] = [];
    let bridge!: ReaderBridge;
    function Probe() {
      bridge = useReaderPublisher(1, (_pane, page) => pages.push(page), undefined, () => "d");
      return null;
    }
    render(<Probe />);
    return { pages, bridge: () => bridge };
  }
  it("publishes a selection only when it names the epoch of the reading it travels with", async () => {
    const controller = await ready();
    const state = controller.getSnapshot();
    const { pages, bridge } = publisher();
    const stale: ReaderSessionState = { ...state, selection: { fingerprint: "fp-OLD", target } };
    act(() => bridge().setSession("d", stale));
    expect(last(pages)?.reading?.epoch.fingerprint).toBe("fp-A");
    expect(last(pages)?.selection).toBeNull();
    act(() => bridge().setSession("d", { ...state, selection: { fingerprint: "fp-A", target } }));
    expect(last(pages)?.selection).toEqual({ fingerprint: "fp-A", target });
    controller.stop();
  });

  it("publishes no reading (and so no selection) for a Reader that is not ready", async () => {
    const controller = await ready();
    const state = controller.getSnapshot();
    const { pages, bridge } = publisher();
    act(() => bridge().setSession("d", { ...state, phase: "syncing", selection: { fingerprint: "fp-A", target } }));
    expect(last(pages)).toMatchObject({ sync: { phase: "syncing" }, reading: null, selection: null, position: null });
    act(() => bridge().setSession("d", null));
    expect(last(pages)).toBeNull();
    controller.stop();
  });
});
