import { afterEach, describe, expect, it, vi } from "vitest";
import { ENTRY_MARK_KEY, ENTRY_MARK_TTL_MS, markTutorialEntry, takeTutorialEntry } from "../src/tutorial/entry";
import { createProgressWriter, samePath } from "../src/tutorial/progress";
import { fakeProgress } from "./tutorial-fixtures";

afterEach(() => sessionStorage.clear());

describe("progress writes", () => {
  it("writes in order, never retries, and reports only the first failure", async () => {
    const order: (string | null)[] = [];
    const put = vi.fn(async (p: { position: string | null }) => {
      order.push(p.position);
      if (p.position !== "ok") throw new Error("write_failed");
    });
    const failed = vi.fn();
    const writer = createProgressWriter(put as never, failed);
    void writer.save(fakeProgress({ position: "a" }));
    void writer.save(fakeProgress({ position: "ok" }));
    await writer.save(fakeProgress({ position: "b" }));
    expect(order).toEqual(["a", "ok", "b"]);
    expect(put).toHaveBeenCalledTimes(3);
    expect(failed).toHaveBeenCalledTimes(1);
  });
  it("the bound folder matches the open project, a trailing separator aside", () => {
    expect(samePath("/home/u/ArgelanderSpace-Tutorial", "/home/u/ArgelanderSpace-Tutorial/")).toBe(true);
    expect(samePath("/home/u/ArgelanderSpace-Tutorial", "/home/u/Other")).toBe(false);
    expect(samePath(null, "/x")).toBe(false);
  });
});

describe("the one-time entry mark", () => {
  it("is taken once: present and fresh → true, then gone", () => {
    markTutorialEntry(1000);
    expect(takeTutorialEntry(2000)).toBe(true);
    expect(sessionStorage.getItem(ENTRY_MARK_KEY)).toBeNull();
    expect(takeTutorialEntry(2000)).toBe(false);
  });
  it("a stale or malformed mark does not count and is removed", () => {
    markTutorialEntry(0);
    expect(takeTutorialEntry(ENTRY_MARK_TTL_MS + 1)).toBe(false);
    sessionStorage.setItem(ENTRY_MARK_KEY, "{not json");
    expect(takeTutorialEntry(1)).toBe(false);
    expect(sessionStorage.getItem(ENTRY_MARK_KEY)).toBeNull();
  });
  it("no mark: entered some other way", () => {
    expect(takeTutorialEntry()).toBe(false);
  });
});
