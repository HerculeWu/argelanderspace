/**
 * The argument graph page never shows an older version than it has seen (ticket 05 fix round A): the answer to its own
 * write does not cancel a read that is already under way (that read may carry a newer change from elsewhere), and a read
 * or an answer older than what is shown is ignored.
 */
import { type ArgumentGraph } from "@argelanderspace/contracts";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useArgumentGraph } from "../src/argument/useArgumentGraph";
import { ARGUMENT_FIXTURES } from "./fixtures/argument-graphs";
import { graphChanged } from "./fake-ws";

vi.mock("../src/api/ws", async () => (await import("./fake-ws")).wsModule());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
let reads: { release: (g: ArgumentGraph) => void }[];
let served: ArgumentGraph;
let hold: boolean;
beforeEach(() => {
  served = ARGUMENT_FIXTURES.clean();
  reads = [];
  hold = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (!hold) return json(served);
      return new Promise<Response>((resolve) => reads.push({ release: (g) => resolve(json(g)) }));
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const at = (rev: number): ArgumentGraph => ({ ...ARGUMENT_FIXTURES.clean(), rev });
const rev = (r: { current: { state: { phase: string } } }) => (r.current.state.phase === "ready" ? (r.current.state as unknown as { graph: ArgumentGraph }).graph.rev : null);

describe("useArgumentGraph.adopt", () => {
  it("the answer to a write does not drop a read already under way: the newer graph that read carries wins", async () => {
    const { result } = renderHook(() => useArgumentGraph("w"));
    await waitFor(() => expect(rev(result)).toBe(7));
    hold = true;
    await act(async () => graphChanged("w")); // a change from elsewhere: a read starts
    await waitFor(() => expect(reads).toHaveLength(1));
    act(() => result.current.adopt(at(8))); // the answer to our own PUT, older than that read's content
    expect(rev(result)).toBe(8);
    await act(async () => reads[0]!.release(at(9)));
    await waitFor(() => expect(rev(result)).toBe(9));
  });

  it("an older answer, or a read that started before the adopt and is older, never takes the page back", async () => {
    const { result } = renderHook(() => useArgumentGraph("w"));
    await waitFor(() => expect(rev(result)).toBe(7));
    act(() => result.current.adopt(at(9)));
    act(() => result.current.adopt(at(8)));
    expect(rev(result)).toBe(9);
    hold = true;
    await act(async () => graphChanged("w"));
    await waitFor(() => expect(reads).toHaveLength(1));
    act(() => result.current.adopt(at(10)));
    await act(async () => reads[0]!.release(at(9)));
    expect(rev(result)).toBe(10);
  });

  it("a read that started after the last adopt is the server's current word (a file restored by hand)", async () => {
    const { result } = renderHook(() => useArgumentGraph("w"));
    await waitFor(() => expect(rev(result)).toBe(7));
    act(() => result.current.adopt(at(9)));
    hold = true;
    await act(async () => graphChanged("w"));
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => reads[0]!.release(at(3)));
    await waitFor(() => expect(rev(result)).toBe(3));
  });
});
