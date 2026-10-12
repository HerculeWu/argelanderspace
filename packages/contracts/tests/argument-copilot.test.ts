import { describe, expect, test } from "vitest";
import {
  ARGUMENT_PAGE_WRITE_TOOL,
  ARGUMENT_TOOL_ACTIONS,
  ARGUMENT_TOOL_WRITE_ACTIONS,
  ArgumentToolReadSchema,
  ArgumentToolWriteSchema,
  ArgumentViewActionSchema,
  CopilotConfirmationDecisionSchema,
  CopilotConfirmationSchema,
  isArgumentViewAction,
  OperationConfirmationSchema,
  WsCopilotViewActionSchema,
} from "../src/index.js";

const VIEW = "00000000-0000-4000-8000-000000000001";
const UUID = "00000000-0000-4000-8000-0000000000aa";

describe("the argument tool's requests", () => {
  test("every write needs the Work and the rev the model read; unknown keys, approval keys and wrong types are refused", () => {
    const ok = { action: "create", workId: "w", expectedRev: 0, argument: { title: "x" } };
    expect(ArgumentToolWriteSchema.safeParse(ok).success).toBe(true);
    expect(ArgumentToolWriteSchema.safeParse({ ...ok, expectedRev: undefined }).success).toBe(
      false
    );
    expect(ArgumentToolWriteSchema.safeParse({ ...ok, workId: undefined }).success).toBe(false);
    expect(ArgumentToolWriteSchema.safeParse({ ...ok, confirmed: true }).success).toBe(false);
    expect(ArgumentToolWriteSchema.safeParse({ ...ok, argument: {} }).success).toBe(false);
    expect(
      ArgumentToolWriteSchema.safeParse({ ...ok, argument: { title: "x", kind: "huge" } }).success
    ).toBe(false);
    expect(
      ArgumentToolWriteSchema.safeParse({ action: "clear", workId: "w", expectedRev: 3 }).success
    ).toBe(true);
    expect(
      ArgumentToolWriteSchema.safeParse({
        action: "replace",
        workId: "w",
        expectedRev: 3,
        graph: { arguments: [], edges: [] },
      }).success
    ).toBe(true);
    expect(
      ArgumentToolWriteSchema.safeParse({
        action: "replace",
        workId: "w",
        expectedRev: 3,
        graph: { arguments: [], edges: [], rev: 9 },
      }).success
    ).toBe(false);
  });

  test("lengths and blank titles are the graph schema's to refuse, so they are not refused as malformed requests", () => {
    const long = {
      action: "update",
      workId: "w",
      expectedRev: 1,
      id: "a",
      patch: { title: "x".repeat(500), claim: "y".repeat(30_000) },
    };
    expect(ArgumentToolWriteSchema.safeParse(long).success).toBe(true);
    expect(ArgumentToolWriteSchema.safeParse({ ...long, patch: { title: " " } }).success).toBe(
      true
    );
  });

  test("read takes offsets and ids within bounds", () => {
    expect(
      ArgumentToolReadSchema.safeParse({
        action: "read",
        workId: "w",
        offset: 3,
        edgeOffset: 0,
        ids: ["a"],
      }).success
    ).toBe(true);
    expect(
      ArgumentToolReadSchema.safeParse({ action: "read", workId: "w", offset: -1 }).success
    ).toBe(false);
    expect(ArgumentToolReadSchema.safeParse({ action: "read", workId: "w", ids: [] }).success).toBe(
      false
    );
    expect(
      ArgumentToolReadSchema.safeParse({
        action: "read",
        workId: "w",
        ids: Array.from({ length: 51 }, (_, i) => `a${i}`),
      }).success
    ).toBe(false);
  });

  test("every page write maps to an operation that exists and is a write", () => {
    for (const operation of Object.values(ARGUMENT_PAGE_WRITE_TOOL)) {
      expect(ARGUMENT_TOOL_ACTIONS).toContain(operation);
      expect(ARGUMENT_TOOL_WRITE_ACTIONS).toContain(operation);
    }
  });
});

describe("the view actions and the card", () => {
  test("open, select and exit are view actions of the bound view and nothing else is", () => {
    expect(
      ArgumentViewActionSchema.safeParse({ action: "open_argument_graph", workId: "w" }).success
    ).toBe(true);
    expect(
      ArgumentViewActionSchema.safeParse({
        action: "select_argument",
        workId: "w",
        argumentId: null,
      }).success
    ).toBe(true);
    expect(ArgumentViewActionSchema.safeParse({ action: "exit_argument_graph" }).success).toBe(
      true
    );
    expect(
      ArgumentViewActionSchema.safeParse({ action: "exit_argument_graph", workId: "w" }).success
    ).toBe(false);
    expect(isArgumentViewAction({ action: "select_argument" })).toBe(true);
    expect(isArgumentViewAction({ action: "select_work" })).toBe(false);
    const message = {
      type: "copilot.view-action",
      viewId: VIEW,
      actionId: UUID,
      action: { action: "open_argument_graph", workId: "w" },
    };
    expect(WsCopilotViewActionSchema.safeParse(message).success).toBe(true);
  });

  test("the replace card names the Work and both sizes, and its decision and record are part of the contract", () => {
    const card = {
      id: UUID,
      runId: UUID,
      toolCallId: "call",
      baseRev: 4,
      action: "replace_argument_graph",
      object: { kind: "work", id: "w", workId: "w" },
      label: "A paper",
      mode: "replace",
      current: { arguments: 11, edges: 13 },
      next: { arguments: 9, edges: 11 },
      objectDigest: "d",
    };
    expect(CopilotConfirmationSchema.safeParse(card).success).toBe(true);
    expect(CopilotConfirmationSchema.safeParse({ ...card, mode: "merge" }).success).toBe(false);
    expect(CopilotConfirmationSchema.safeParse({ ...card, next: { arguments: 9 } }).success).toBe(
      false
    );
    expect(
      CopilotConfirmationDecisionSchema.safeParse({
        decision: "approve",
        viewId: VIEW,
        action: "replace_argument_graph",
        objectId: "w",
        baseRev: 4,
      }).success
    ).toBe(true);
    const record = {
      version: 1,
      phase: "requested",
      confirmationId: UUID,
      runId: UUID,
      toolCallId: "call",
      baseRev: 4,
      action: "replace_argument_graph",
      workId: "w",
    };
    expect(OperationConfirmationSchema.safeParse(record).success).toBe(true);
    expect(OperationConfirmationSchema.safeParse({ ...record, workId: "" }).success).toBe(false);
  });
});
