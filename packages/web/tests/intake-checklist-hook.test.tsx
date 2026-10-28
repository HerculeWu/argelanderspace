/**
 * `useIntakeChecklist` (project-intake ticket 06): reads on mount, again on `intake.changed`, again on every
 * reconnect (events may have been missed), and only the newest read decides when answers arrive out of order.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useIntakeChecklist } from "../src/library/intake-entry";
import { fakeBus } from "./fake-ws";

vi.mock("../src/api/ws-instance", async () => ({ bus: (await import("./fake-ws")).fakeBus }));

type Answer = (value: "present" | "absent") => void;
let answers: Answer[];
let reads: number;
let parsed: number; // answers whose body the hook has been given

beforeEach(() => {
  answers = []; reads = 0; parsed = 0;
  vi.stubGlobal("fetch", vi.fn(() => {
    reads++;
    return new Promise<Response>((resolve) => { answers.push((checklist) => resolve({ ok: true, json: async () => { parsed++; return { checklist }; } } as Response)); });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("a reconnect (hello) reads again, and the answer replaces the state", async () => {
  const { result } = renderHook(() => useIntakeChecklist());
  expect(reads).toBe(1);
  answers[0]!("absent");
  await waitFor(() => expect(result.current).toBe("absent"));
  act(() => fakeBus.emit("hello", { jobs: [] }));
  expect(reads).toBe(2);
  answers[1]!("present");
  await waitFor(() => expect(result.current).toBe("present"));
});

test("intake.changed reads again", async () => {
  const { result } = renderHook(() => useIntakeChecklist());
  answers[0]!("absent");
  await waitFor(() => expect(result.current).toBe("absent"));
  act(() => fakeBus.emit("intake.changed", { at: "2026-10-27T00:00:00Z" }));
  expect(reads).toBe(2);
  answers[1]!("present");
  await waitFor(() => expect(result.current).toBe("present"));
});

test("answers out of order: the older read, answering last, does not overwrite the newer one", async () => {
  const { result } = renderHook(() => useIntakeChecklist());
  act(() => fakeBus.emit("intake.changed", { at: "2026-10-27T00:00:00Z" }));
  expect(reads).toBe(2);
  answers[1]!("present"); // the newer read answers first
  await waitFor(() => expect(result.current).toBe("present"));
  // the late answer is handed over, and one macrotask lets everything the hook does with it run: no fixed wait
  await act(async () => { answers[0]!("absent"); await waitFor(() => expect(parsed).toBe(2)); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(result.current).toBe("present");
});

test("after unmount nothing is read again and a late answer is dropped", async () => {
  const { unmount } = renderHook(() => useIntakeChecklist());
  unmount();
  act(() => fakeBus.emit("intake.changed", { at: "2026-10-27T00:00:00Z" }));
  act(() => fakeBus.emit("hello", { jobs: [] }));
  expect(reads).toBe(1);
  answers[0]!("present");
});
