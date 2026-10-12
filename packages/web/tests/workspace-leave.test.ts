/**
 * The workspace leave guards (ticket 05 fix round A): which guard speaks for which change, answers that come later, and the
 * one-after-the-other order. The Doc views' guards are unscoped and answer at once; the argument graph page's is scoped to
 * the Library view (and its pane) and answers with a promise.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { askWorkspaceLeave, confirmWorkspaceLeave, registerWorkspaceLeaveGuard, whenWorkspaceMayLeave } from "../src/argelander/workspace";

const offs: (() => void)[] = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
});
const guard = <T extends () => boolean | Promise<boolean>>(fn: T, scope?: string | { view?: string; paneId?: number }) => {
  const spy = vi.fn<() => boolean | Promise<boolean>>(fn);
  offs.push(registerWorkspaceLeaveGuard(spy, scope));
  return spy;
};

describe("which guard speaks", () => {
  it("an unscoped guard (a Doc view's) speaks for changing the Doc and leaving a Doc pane, never for the Library page", () => {
    const doc = guard(() => true);
    const library = guard(() => false, { view: "library", paneId: 2 });
    expect(askWorkspaceLeave()).toBe(true);
    expect(askWorkspaceLeave("doc")).toBe(true);
    expect(doc).toHaveBeenCalledTimes(2);
    expect(library).not.toHaveBeenCalled();
  });

  it("a Library guard speaks for its own pane (or when no pane is named), not another's, and not for other views", () => {
    const library = guard(() => false, { view: "library", paneId: 2 });
    expect(askWorkspaceLeave("library", 3)).toBe(true);
    expect(askWorkspaceLeave("plan")).toBe(true);
    expect(library).not.toHaveBeenCalled();
    expect(askWorkspaceLeave("library", 2)).toBe(false);
    expect(askWorkspaceLeave("library")).toBe(false);
    expect(library).toHaveBeenCalledTimes(2);
  });

  it("a refusal stops the asking; a synchronous caller treats a late answer as a no", async () => {
    const first = guard(() => false);
    const second = guard(() => true);
    expect(confirmWorkspaceLeave()).toBe(false);
    expect(second).not.toHaveBeenCalled();
    first.mockReturnValue(true);
    expect(confirmWorkspaceLeave()).toBe(true);
    first.mockReturnValue(Promise.resolve(true) as never);
    expect(confirmWorkspaceLeave()).toBe(false);
  });
});

describe("answers that come later", () => {
  it("guards are asked one after the other; the change waits for the last yes and a no ends it", async () => {
    let answerFirst!: (ok: boolean) => void;
    const first = guard(() => new Promise<boolean>((r) => (answerFirst = r)), "library");
    const second = guard(() => Promise.resolve(true), "library");
    const change = vi.fn();
    expect(whenWorkspaceMayLeave(change, "library")).toBe(false);
    expect(second).not.toHaveBeenCalled();
    answerFirst(true);
    await vi.waitFor(() => expect(change).toHaveBeenCalledTimes(1));
    expect(second).toHaveBeenCalledTimes(1);
    first.mockImplementation(() => Promise.resolve(false));
    whenWorkspaceMayLeave(change, "library");
    await Promise.resolve();
    await Promise.resolve();
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("answers at once when every guard does", () => {
    guard(() => true, "library");
    const change = vi.fn();
    expect(whenWorkspaceMayLeave(change, "library")).toBe(true);
    expect(change).toHaveBeenCalledTimes(1);
  });
});
