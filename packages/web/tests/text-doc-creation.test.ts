/**
 * Ticket 12 (architecture deepening): RefDetail's text Doc creation, on the `useTextDocCreation` interface.
 *
 * The operation id rule (docs/library.md, text Doc creation): a retry of the same attempt reuses the id until the
 * creation succeeded or the server answered 409; another Work starts a new id; a response whose Work session is no
 * longer current is dropped (no busy / error change, nothing opens). The seam is the `api/text-docs` module.
 */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateTextDocResult } from "../src/api/text-docs";
import { useTextDocCreation } from "../src/library/text-doc-creation";
import type { WorkJobs, WorkSession } from "../src/library/work-jobs";

const h = vi.hoisted(() => ({
  calls: [] as { workId: string; operationId: string; resolve: (result: CreateTextDocResult) => void }[],
}));
vi.mock("../src/api/text-docs", () => ({
  createTextDoc: (workId: string, operationId: string) =>
    new Promise<CreateTextDocResult>((resolve) => {
      h.calls.push({ workId, operationId, resolve });
    }),
}));

const A = "doi:10.0000/a";
const B = "doi:10.0000/b";
const OK: CreateTextDocResult = { ok: true, docId: "text-new", created: true };
const fail = (status: number, detail = `failed ${status}`): CreateTextDocResult => ({ ok: false, detail, status });

/** A Work session like useWorkJobs': the generation moves on whenever the Work changes. */
function fakeSession() {
  let active: WorkSession = { workId: A, generation: 0 };
  const session: WorkJobs["session"] = {
    current: () => active,
    isCurrent: (s) => s.workId === active.workId && s.generation === active.generation,
  };
  return {
    session,
    switchTo(workId: string) {
      active = { workId, generation: active.generation + 1 };
    },
  };
}

function setup() {
  const work = fakeSession();
  const onOpenDoc = vi.fn();
  const view = renderHook(({ workId }) => useTextDocCreation(workId, work.session, onOpenDoc), {
    initialProps: { workId: A },
  });
  const create = () => act(() => view.result.current.create());
  const answer = async (result: CreateTextDocResult) => {
    await act(async () => {
      h.calls[h.calls.length - 1]!.resolve(result);
    });
  };
  const switchTo = (workId: string) => {
    work.switchTo(workId);
    view.rerender({ workId });
  };
  return { view, onOpenDoc, create, answer, switchTo };
}

const ids = () => h.calls.map((call) => call.operationId);

beforeEach(() => {
  h.calls = [];
});
afterEach(() => cleanup());

describe("useTextDocCreation", () => {
  it("a first create sends a fresh create-<uuid> id for this Work and is busy until the answer", async () => {
    const { view, create, answer } = setup();
    expect(view.result.current).toMatchObject({ busy: false, error: null });
    create();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.workId).toBe(A);
    expect(h.calls[0]!.operationId).toMatch(/^create-[0-9a-f-]{36}$/);
    expect(view.result.current.busy).toBe(true);
    await answer(fail(500));
    expect(view.result.current).toMatchObject({ busy: false, error: "failed 500" });

    const other = setup();
    other.create();
    expect(h.calls[1]!.operationId).not.toBe(h.calls[0]!.operationId);
  });

  it.each([500, 0])("a retry after a %s failure reuses the same id and shows the failure", async (status) => {
    const { view, onOpenDoc, create, answer } = setup();
    create();
    await answer(fail(status, "unreachable"));
    expect(view.result.current).toMatchObject({ busy: false, error: "unreachable" });
    create();
    expect(view.result.current).toMatchObject({ busy: true, error: null });
    expect(ids()).toHaveLength(2);
    expect(ids()[1]).toBe(ids()[0]);
    expect(onOpenDoc).not.toHaveBeenCalled();
  });

  it("a 409 spends the attempt: the next create uses a new id", async () => {
    const { view, onOpenDoc, create, answer } = setup();
    create();
    await answer(fail(409, "gone"));
    expect(view.result.current).toMatchObject({ busy: false, error: "gone" });
    create();
    expect(ids()[1]).not.toBe(ids()[0]);
    expect(onOpenDoc).not.toHaveBeenCalled();
  });

  it("success opens the new Doc and the next create uses a new id", async () => {
    const { view, onOpenDoc, create, answer } = setup();
    create();
    await answer(fail(500));
    create();
    await answer(OK);
    expect(onOpenDoc).toHaveBeenCalledTimes(1);
    expect(onOpenDoc).toHaveBeenCalledWith("text-new");
    expect(view.result.current).toMatchObject({ busy: false, error: null });
    create();
    expect(ids()[1]).toBe(ids()[0]);
    expect(ids()[2]).not.toBe(ids()[1]);
  });

  it("after switching Work a create uses a new id for the new Work", async () => {
    const { create, answer, switchTo } = setup();
    create();
    await answer(fail(500));
    switchTo(B);
    create();
    expect(h.calls[1]!.workId).toBe(B);
    expect(ids()[1]).not.toBe(ids()[0]);
  });

  it("a late answer for a Work session that is no longer current is dropped: nothing opens, no error", async () => {
    const { view, onOpenDoc, create, answer, switchTo } = setup();
    create();
    switchTo(B);
    await answer(OK);
    expect(onOpenDoc).not.toHaveBeenCalled();
    create();
    switchTo(A);
    await answer(fail(500, "late failure"));
    expect(view.result.current.error).toBeNull();
    expect(onOpenDoc).not.toHaveBeenCalled();
  });

  // Ticket 14: busy and error belong to the Work session they were set in; switching Work clears both.
  it("switching Work while a create is in flight: the new Work is not busy and the late answer changes nothing", async () => {
    const { view, onOpenDoc, create, answer, switchTo } = setup();
    create();
    expect(view.result.current.busy).toBe(true);
    switchTo(B);
    expect(view.result.current).toMatchObject({ busy: false, error: null });
    await answer(OK);
    expect(onOpenDoc).not.toHaveBeenCalled();
    expect(view.result.current).toMatchObject({ busy: false, error: null });

    create();
    switchTo(A);
    expect(view.result.current).toMatchObject({ busy: false, error: null });
    await answer(fail(500, "late failure"));
    expect(view.result.current).toMatchObject({ busy: false, error: null });
    expect(onOpenDoc).not.toHaveBeenCalled();
  });

  // Ticket 14 fix round 1: the new Work can now create while the old Work's request is in flight; the old answer
  // must not spend the new Work's attempt.
  it.each([
    ["201", OK],
    ["409", fail(409, "gone")],
  ])("a late %s for the old Work does not spend the new Work's attempt", async (_label, late) => {
    const { view, create, switchTo } = setup();
    create();
    switchTo(B);
    create();
    const idB = h.calls[1]!.operationId;
    await act(async () => {
      h.calls[0]!.resolve(late);
    });
    await act(async () => {
      h.calls[1]!.resolve(fail(0, "unreachable"));
    });
    expect(view.result.current).toMatchObject({ busy: false, error: "unreachable" });
    create();
    expect(h.calls[2]!.workId).toBe(B);
    expect(h.calls[2]!.operationId).toBe(idB);
  });

  it("a failed create's error does not follow to another Work, nor come back with the Work's next session", async () => {
    const { view, create, answer, switchTo } = setup();
    create();
    await answer(fail(500, "failed on A"));
    expect(view.result.current).toMatchObject({ busy: false, error: "failed on A" });
    switchTo(B);
    expect(view.result.current).toMatchObject({ busy: false, error: null });
    switchTo(A);
    expect(view.result.current).toMatchObject({ busy: false, error: null });
  });
});
