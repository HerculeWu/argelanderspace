/**
 * The "dismissed" set of the task merge notices across browser tabs (ticket 06 fix round C): a tab that closes a
 * notice must not erase what another tab closed, the other tab hears about it through the `storage` event, and
 * the persisted cap drops the oldest ids, never the latest closed.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  dismissMergeNotice,
  ingestMergeNotice,
  resetMergeNoticesForTests,
  startMergeNotices,
  useMergeNotices,
} from "../src/library/merge-notices";

const KEY = "argelander.dismissedGraphMergeNotices";
const stored = (): string[] => JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[];

const note = {
  outcome: "kept_survivor",
  absorbed_id: "doi:10.1/gone",
  survivor_id: "w1",
  absorbed_file: "argument-graphs/a.json",
  survivor_file: "argument-graphs/b.json",
} as const;
const job = (id: string) =>
  ({
    id,
    kind: "upload",
    status: "done",
    createdAt: "2026-10-12T00:00:00Z",
    startedAt: null,
    finishedAt: null,
    progress: [],
    result: { argument_graph_merges: [note] },
    error: null,
    payload: { workId: "w1" },
  }) as never;

beforeEach(() => {
  localStorage.clear();
  resetMergeNoticesForTests();
});

describe("dismissed merge notices across tabs", () => {
  it("closing a notice keeps what another tab stored meanwhile", () => {
    dismissMergeNotice("job-a");
    // another tab writes its own closing after this page loaded its set
    localStorage.setItem(KEY, JSON.stringify(["job-a", "job-other"]));
    dismissMergeNotice("job-b");
    expect(stored().sort()).toEqual(["job-a", "job-b", "job-other"]);
  });

  it("a storage event from another tab hides the notice it closed", () => {
    startMergeNotices();
    const { result } = renderHook(() => useMergeNotices());
    act(() => ingestMergeNotice(job("job-x")));
    expect(result.current.map((n) => n.jobId)).toEqual(["job-x"]);
    act(() => {
      localStorage.setItem(KEY, JSON.stringify(["job-x"]));
      window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    });
    expect(result.current).toEqual([]);
    act(() => resetMergeNoticesForTests(true));
  });

  it("over the cap the oldest ids go, the latest closed stay", () => {
    const many = Array.from({ length: 300 }, (_, i) => `old-${i}`);
    localStorage.setItem(KEY, JSON.stringify(many));
    resetMergeNoticesForTests(true);
    dismissMergeNotice("newest");
    const s = stored();
    expect(s).toHaveLength(300);
    expect(s[s.length - 1]).toBe("newest");
    expect(s).not.toContain("old-0");
    expect(s).toContain("old-299");
  });
});
