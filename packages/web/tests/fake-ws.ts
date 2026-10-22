/**
 * The `api/ws` module backed by the real routing table (`createFakeBus`, docs/engineering.md) instead of a hand-written
 * mock: a test emits a server message with `fakeBus.emit(type, msg)` and the same dispatch the live socket uses delivers
 * it to the listeners the component registered. Use in a test file as
 *
 *   vi.mock("../src/api/ws", async () => (await import("./fake-ws")).wsModule());
 *
 * and import `fakeBus` from "./fake-ws" to emit.
 */
import type { WsArgumentGraphChanged } from "@argelanderspace/contracts";
import { createFakeBus } from "../src/api/ws-bus";

export const fakeBus = createFakeBus();

/** The exports of `api/ws` the argument graph view, the Library page and the Shell's settings use, on `fakeBus`. */
export function wsModule() {
  return {
    onArgumentGraphChanged: (cb: (msg: WsArgumentGraphChanged) => void, onResync?: () => void) => {
      const offs = [fakeBus.on("argument-graph.changed", cb), ...(onResync ? [fakeBus.onResync(onResync)] : [])];
      return () => offs.forEach((off) => off());
    },
    onLibraryChanged: (cb: () => void) => fakeBus.on("library.changed", () => cb()),
    onJobEvent: (cb: Parameters<typeof fakeBus.onJob>[0]) => fakeBus.onJob(cb),
    onPlanChanged: (cb: () => void) => fakeBus.on("plan.changed", () => cb()),
    onAnnotationChanged: (cb: (docId: string) => void) => fakeBus.on("annotation.changed", (msg) => cb(msg.doc_id)),
    onWriterChanged: (cb: Parameters<typeof fakeBus.on<"writer.changed">>[1]) => fakeBus.on("writer.changed", cb),
    onSettingsChanged: (cb: () => void, onResync?: () => void) => {
      const offs = [fakeBus.on("settings.changed", () => cb()), ...(onResync ? [fakeBus.onResync(onResync)] : [])];
      return () => offs.forEach((off) => off());
    },
    onHostSwitchConfirmation: (cb: Parameters<typeof fakeBus.on<"host.switch-confirmation">>[1]) =>
      fakeBus.on("host.switch-confirmation", cb),
    onHostTutorialResult: (cb: Parameters<typeof fakeBus.on<"host.tutorial-result">>[1]) => fakeBus.on("host.tutorial-result", cb),
  };
}

/** A change of one Work's graph, as the server broadcasts it. */
export const graphChanged = (workId: string, cause: "put" | "external" = "external") =>
  fakeBus.emit("argument-graph.changed", { work_id: workId, cause, at: "2026-10-12T00:00:00.000Z" });
