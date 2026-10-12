/**
 * What a page observation may be written as: only what the history reads back. An argument graph page that does not
 * satisfy the contract is replaced by a legal page without its details (and the problem is logged), never written.
 */
import {
  buildArgumentPage,
  CopilotObservationSchema,
  type PageContext,
} from "@argelanderspace/contracts";
import { describe, expect, test, vi } from "vitest";
import { recordableObservation } from "../src/copilot-observation.js";

const TASK = "7d2f6d2e-5b3b-4f6a-9d7e-0a1b2c3d4e5f";
const graph = {
  version: 1 as const,
  rev: 2,
  work_id: "doi:10.1/x",
  arguments: [
    {
      id: "a0",
      title: "T",
      claim: "c",
      grounds: "",
      warrant: "",
      backing: "",
      qualifier: "",
      rebuttal: "",
      warrant_implicit: false,
      kind: "end" as const,
      sources: [],
    },
  ],
  edges: [],
};
const pageWith = (argument: unknown): PageContext =>
  ({
    version: 1,
    viewId: TASK,
    revision: 3,
    paneId: 1,
    view: "library",
    otherPanes: [],
    status: "complete",
    plan: null,
    argument,
  }) as never;

describe("recordableObservation", () => {
  test("a legal page is recorded as it is", () => {
    const warn = vi.fn();
    const page = pageWith(
      buildArgumentPage({
        workId: "doi:10.1/x",
        title: "W",
        phase: "ready",
        graph,
        selectedId: null,
      })
    );
    const out = recordableObservation(TASK, page, warn);
    expect(out?.degraded).toBe(false);
    expect(CopilotObservationSchema.safeParse(JSON.parse(out?.content ?? "")).success).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  test("an argument page the history would refuse is replaced by a legal one without details, and logged", () => {
    const warn = vi.fn();
    const good = buildArgumentPage({
      workId: "doi:10.1/x",
      title: "W",
      phase: "ready",
      graph,
      selectedId: null,
    });
    // the very shape that made a conversation unreadable: a partial empty page
    const broken = { ...good, phase: "empty", partial: true, counts: { arguments: 0, edges: 0 } };
    expect(
      CopilotObservationSchema.safeParse({
        version: 1,
        taskContextId: TASK,
        page: pageWith(broken),
      }).success
    ).toBe(false);
    const out = recordableObservation(TASK, pageWith(broken), warn);
    expect(out?.degraded).toBe(true);
    const written = JSON.parse(out?.content ?? "");
    expect(CopilotObservationSchema.safeParse(written).success).toBe(true);
    expect(written.page.argument).toMatchObject({ phase: "error", graph: null, outline: null });
    expect(written.page.argument.note).toContain("Library page actions");
    expect(written.page.status).toBe("error");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("doi:10.1/x");
  });

  test("a page that is wrong for another reason is not written at all", () => {
    const warn = vi.fn();
    const page = { ...pageWith(null), paneId: 0 } as PageContext;
    expect(recordableObservation(TASK, page, warn)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
