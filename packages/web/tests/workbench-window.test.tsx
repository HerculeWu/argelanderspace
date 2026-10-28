/**
 * This window as the CLI's navigation target (release-0.2 ticket 05) at the hook seam: the frames it sends about its own
 * attention, and what it does with a `workbench.navigate` frame. Real focus, scrolling to an anchor and the pane switch
 * are proven in the real browser, not here.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fakeBus } from "./fake-ws";

vi.mock("../src/api/ws-instance", async () => ({ bus: (await import("./fake-ws")).fakeBus }));

import { runNavigation, useWorkbenchWindow, WINDOW_ID } from "../src/navigation/workbench-window";

const ours = (kind: string, extra: object = {}) => ({ type: kind, windowId: WINDOW_ID, ...extra });
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const setVisibility = (state: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(() => {
  fakeBus.sent.length = 0;
  setVisibility("visible");
});
afterEach(() => cleanup());

test("a window tells the server when it is active or hidden, and again on every reconnect", () => {
  const run = vi.fn(async () => ({ ok: true }));
  renderHook(() => useWorkbenchWindow(run));
  expect(fakeBus.sent[fakeBus.sent.length - 1]).toEqual(ours("window.active")); // connected visible
  act(() => { window.dispatchEvent(new Event("focus")); });
  expect(fakeBus.sent[fakeBus.sent.length - 1]).toEqual(ours("window.active"));
  fakeBus.sent.length = 0;
  act(() => { document.dispatchEvent(new Event("pointerdown")); document.dispatchEvent(new Event("keydown")); });
  expect(fakeBus.sent).toEqual([ours("window.active")]); // used: reported once, not per event
  act(() => setVisibility("hidden"));
  expect(fakeBus.sent[fakeBus.sent.length - 1]).toEqual(ours("window.hidden"));
  act(() => setVisibility("visible"));
  expect(fakeBus.sent[fakeBus.sent.length - 1]).toEqual(ours("window.active"));
  act(() => setVisibility("hidden"));
  fakeBus.sent.length = 0;
  act(() => fakeBus.emit("hello", { jobs: [] })); // the server forgot this window with its old socket
  expect(fakeBus.sent).toEqual([ours("window.hidden")]);
});

test("a navigation addressed to another window is not ours; ours runs and is answered with what the page did", async () => {
  const run = vi.fn(async () => ({ ok: true }));
  renderHook(() => useWorkbenchWindow(run));
  fakeBus.sent.length = 0;
  act(() => fakeBus.emit("workbench.navigate", { windowId: "someone-else", navId: "n0", target: { op: "library.open_work", params: { refId: "r1" } } }));
  await flush();
  expect(run).not.toHaveBeenCalled();
  expect(fakeBus.sent).toEqual([]);
  act(() => fakeBus.emit("workbench.navigate", { windowId: WINDOW_ID, navId: "n1", target: { op: "library.open_work", params: { refId: "r1" } } }));
  await flush();
  expect(run).toHaveBeenCalledWith({ action: "select_work", refId: "r1" });
  expect(fakeBus.sent).toEqual([ours("window.navigated", { navId: "n1", ok: true })]);
});

test("the page's refusal and a thrown action are reported, not hidden", async () => {
  const run = vi.fn(async () => ({ ok: false, detail: "not_found" }));
  renderHook(() => useWorkbenchWindow(run));
  fakeBus.sent.length = 0;
  act(() => fakeBus.emit("workbench.navigate", { windowId: WINDOW_ID, navId: "n1", target: { op: "argument.open", params: { workId: "w1" } } }));
  await flush();
  expect(run).toHaveBeenCalledWith({ action: "open_argument_graph", workId: "w1" });
  expect(fakeBus.sent).toEqual([ours("window.navigated", { navId: "n1", ok: false, detail: "not_found" })]);
  run.mockRejectedValueOnce(new Error("boom"));
  fakeBus.sent.length = 0;
  act(() => fakeBus.emit("workbench.navigate", { windowId: WINDOW_ID, navId: "n2", target: { op: "argument.open", params: { workId: "w1" } } }));
  await flush();
  expect(fakeBus.sent).toEqual([ours("window.navigated", { navId: "n2", ok: false, detail: "unavailable" })]);
});

test("a Doc with an anchor is opened first, then placed; a missing Doc stops there, a missing anchor says so", async () => {
  const calls: unknown[] = [];
  const ok = async (action: unknown) => { calls.push(action); return { ok: true }; };
  const target = { op: "workspace.open_doc", params: { docId: "d1", anchor: "sec-2" } } as const;
  expect(await runNavigation(target, ok as never)).toEqual({ ok: true });
  expect(calls).toEqual([{ action: "open_doc", docId: "d1" }, { action: "navigate", docId: "d1", anchor: "sec-2" }]);

  const missingDoc = vi.fn(async () => ({ ok: false, detail: "not_found" }));
  expect(await runNavigation(target, missingDoc)).toEqual({ ok: false, detail: "not_found" });
  expect(missingDoc).toHaveBeenCalledTimes(1);

  const missingAnchor = vi.fn(async (action: { action: string }) => (action.action === "open_doc" ? { ok: true } : { ok: false, detail: "not_found" }));
  expect(await runNavigation(target, missingAnchor as never)).toEqual({ ok: false, detail: "anchor_not_found" });

  const plain = vi.fn(async () => ({ ok: true }));
  await runNavigation({ op: "workspace.open_doc", params: { docId: "d1" } }, plain);
  expect(plain).toHaveBeenCalledTimes(1);
});
