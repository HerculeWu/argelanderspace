/**
 * Ticket 05 fix round B: the write queue's "newest graph" is not overwritten by a render that still carries the previous
 * graph. The answer to a write is taken at once; a render before the page has adopted it must not put the old one back.
 */
import { type ArgumentGraph, createArgument } from "@argelanderspace/contracts";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/i18n";
import { useArgumentWrites } from "../src/argument/useArgumentWrites";
import { ARGUMENT_FIXTURES } from "./fixtures/argument-graphs";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useArgumentWrites latest graph", () => {
  it("a re-render with the unchanged (older) graph prop does not put it back over the written one", async () => {
    const g1: ArgumentGraph = ARGUMENT_FIXTURES.clean();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as ArgumentGraph;
        return new Response(JSON.stringify({ ...body, rev: body.rev + 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
      })
    );
    const adopt = vi.fn();
    const { result, rerender } = renderHook(({ graph }) => useArgumentWrites({ workId: "w", graph, adopt, refresh: () => {} }), { initialProps: { graph: g1 as ArgumentGraph | null } });
    await act(async () => {
      const outcome = await result.current.commit((g) => createArgument(g, { title: "x" }));
      expect(outcome.kind).toBe("ok");
    });
    expect(result.current.latest.current?.rev).toBe(g1.rev + 1);
    rerender({ graph: g1 }); // the page has not adopted the answer yet: the prop is still the old graph
    expect(result.current.latest.current?.rev).toBe(g1.rev + 1);
    // a changed prop (the page adopted something, or read the file again) is followed
    rerender({ graph: { ...g1, rev: g1.rev + 5 } });
    expect(result.current.latest.current?.rev).toBe(g1.rev + 5);
  });
});
