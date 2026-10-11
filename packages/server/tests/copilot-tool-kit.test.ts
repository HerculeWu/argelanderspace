/**
 * The Copilot tool kit (ticket 34): one call's lifecycle (`runOperation`) and the request for a human confirmation
 * (`askUser`), with an in-memory journal and a scripted confirmation port. Every branch a tool used to copy is
 * exercised here once, with the exact text the model reads.
 */
import type { CopilotOperation } from "@argelanderspace/contracts";
import { beforeEach, describe, expect, test } from "vitest";
import {
  askUser,
  type ConfirmationOutcome,
  type ConfirmationPort,
  type ConfirmationRequest,
  confirmUnavailable,
  digest,
  type KnownOperation,
  type Op,
  type OperationJournalPort,
  runOperation,
  type ToolHostContext,
  type ToolResult,
} from "../src/copilot-tool-kit.js";

const payloadOf = (result: ToolResult) =>
  JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}");

let known: Map<string, KnownOperation>;
let begun: Parameters<OperationJournalPort["begin"]>[0][];
let finished: { id: string; payload: Record<string, unknown>; operation: CopilotOperation }[];
const journal = (failBegin = false): OperationJournalPort => ({
  lookup: (id) => known.get(id) ?? null,
  begin: (entry) => {
    if (failBegin) throw new Error("disk full");
    begun.push(entry);
    known.set(entry.operationId, { state: "begun", hash: entry.hash });
  },
  done: (id, payload, operation) => {
    finished.push({ id, payload, operation });
    known.set(id, { state: "done", hash: known.get(id)?.hash ?? "", payload, operation });
  },
});

beforeEach(() => {
  known = new Map();
  begun = [];
  finished = [];
});

const rest = { action: "rename", planId: "p_1", name: "New" };
const call = {
  tool: "plan",
  toolCallId: "c1",
  action: "rename",
  rest,
  readBack: "read the plans to find out",
};
const okBody = async (op: Op) =>
  op.done(op.record("rename", { status: "ok" }), { ok: true, status: "ok" });

describe("runOperation", () => {
  test("not admitting: closed, the body never runs and nothing is journaled", async () => {
    let ran = false;
    const result = await runOperation(
      { journal: journal(), admitting: () => false },
      call,
      async (op) => {
        ran = true;
        return okBody(op);
      }
    );
    expect(ran).toBe(false);
    expect(result.details).toEqual({ id: "c1", tool: "plan", action: "rename", status: "error" });
    expect(payloadOf(result)).toEqual({ ok: false, status: "closed" });
    expect(begun).toEqual([]);
  });

  test("the default operationId is scoped by the run and the call; the hash is the digest of the parameters", async () => {
    let seen: { operationId: string; hash: string } | undefined;
    await runOperation(
      { journal: journal(), runId: "r9", admitting: () => true },
      call,
      async (op) => {
        seen = { operationId: op.operationId, hash: op.hash };
        return okBody(op);
      }
    );
    expect(seen).toEqual({ operationId: "r9:c1", hash: digest(rest) });
    await runOperation({ admitting: () => true }, call, async (op) => {
      seen = { operationId: op.operationId, hash: op.hash };
      return okBody(op);
    });
    expect(seen?.operationId).toBe("run:c1");
    await runOperation({ admitting: () => true }, { ...call, requestedId: "op-7" }, async (op) => {
      seen = { operationId: op.operationId, hash: op.hash };
      return okBody(op);
    });
    expect(seen?.operationId).toBe("op-7");
    // an empty or non-string id is not an id
    await runOperation(
      { runId: "r9", admitting: () => true },
      { ...call, requestedId: "" },
      async (op) => {
        seen = { operationId: op.operationId, hash: op.hash };
        return okBody(op);
      }
    );
    expect(seen?.operationId).toBe("r9:c1");
  });

  test("digest ignores key order", () => {
    expect(digest({ a: 1, b: { d: [1, { f: 2, e: 3 }], c: 2 } })).toBe(
      digest({ b: { c: 2, d: [1, { e: 3, f: 2 }] }, a: 1 })
    );
    expect(digest({ a: 1 })).not.toBe(digest({ a: 2 }));
  });

  test("lookup: the same id for a different request is rejected and the body never runs", async () => {
    known.set("op-1", { state: "begun", hash: "something else" });
    let ran = false;
    const result = await runOperation(
      { journal: journal(), admitting: () => true },
      { ...call, requestedId: "op-1" },
      async (op) => {
        ran = true;
        return okBody(op);
      }
    );
    expect(ran).toBe(false);
    expect(result.details).toEqual({
      id: "c1",
      tool: "plan",
      action: "rename",
      status: "rejected",
    });
    expect(payloadOf(result)).toEqual({
      ok: false,
      status: "rejected",
      detail: "operationId was already used for a different request",
    });
  });

  test("lookup: a done operation replays its result with duplicate, under this call's id", async () => {
    const operation: CopilotOperation = {
      id: "c0",
      tool: "plan",
      action: "rename",
      status: "ok",
      rev: 5,
    };
    known.set("op-1", {
      state: "done",
      hash: digest(rest),
      payload: { ok: true, rev: 5 },
      operation,
    });
    let ran = false;
    const result = await runOperation(
      { journal: journal(), admitting: () => true },
      { ...call, requestedId: "op-1" },
      async (op) => {
        ran = true;
        return okBody(op);
      }
    );
    expect(ran).toBe(false);
    expect(result.details).toEqual({ ...operation, id: "c1" });
    expect(payloadOf(result)).toEqual({ ok: true, rev: 5, duplicate: true });
  });

  test("lookup: begun without a result is unknown and names where to read back", async () => {
    known.set("op-1", { state: "begun", hash: digest(rest) });
    let ran = false;
    const result = await runOperation(
      { journal: journal(), admitting: () => true },
      { ...call, requestedId: "op-1" },
      async (op) => {
        ran = true;
        return okBody(op);
      }
    );
    expect(ran).toBe(false);
    expect(result.details).toEqual({ id: "c1", tool: "plan", action: "rename", status: "unknown" });
    expect(payloadOf(result)).toEqual({
      ok: false,
      status: "unknown",
      detail:
        "this operation started earlier and its outcome was not recorded; read the plans to find out, do not repeat it blindly",
    });
  });

  test("lookup: begun, with a read-back that depends on what the journal kept", async () => {
    known.set("op-1", { state: "begun", hash: digest(rest), jobId: "j_1" });
    const seen: KnownOperation[] = [];
    const result = await runOperation(
      { journal: journal(), admitting: () => true },
      {
        ...call,
        requestedId: "op-1",
        readBack: (k) => {
          seen.push(k);
          return {
            detail: "its job is j_1: read_jobs shows its state",
            payload: { jobId: k.state === "begun" ? k.jobId : undefined },
          };
        },
      },
      okBody
    );
    expect(seen).toEqual([{ state: "begun", hash: digest(rest), jobId: "j_1" }]);
    expect(result.details).toMatchObject({ status: "unknown" });
    // the added fields come before the detail, as the tools wrote them
    expect(result.content[0]).toEqual({
      type: "text",
      text: '{"ok":false,"status":"unknown","jobId":"j_1","detail":"its job is j_1: read_jobs shows its state"}',
    });
  });

  test("finish can journal the handler's own answer instead of the wording the model read", async () => {
    const result = await runOperation(
      { journal: journal(), runId: "r1", admitting: () => true },
      call,
      async (op) => {
        expect(op.begin()).toBe(true);
        const shown = op.done(op.record("rename", { status: "expired" }), {
          ok: false,
          status: "expired",
          detail: "changed",
        });
        expect(op.finish(shown, { ok: false, status: "conflict", currentRev: 6 })).toBe(shown);
        return shown;
      }
    );
    expect(finished).toEqual([
      {
        id: "r1:c1",
        payload: { ok: false, status: "conflict", currentRev: 6 },
        operation: result.details,
      },
    ]);
    expect(payloadOf(result)).toMatchObject({ status: "expired" });
  });

  test("begin journals the call and finish records its result; finish returns the result unchanged", async () => {
    const result = await runOperation(
      { journal: journal(), runId: "r1", admitting: () => true },
      call,
      async (op) => {
        expect(op.begin({ planId: "p_1" }, 4)).toBe(true);
        return op.finish(
          op.done(op.record("rename", { status: "ok", rev: 5 }), { ok: true, rev: 5 })
        );
      }
    );
    expect(begun).toEqual([
      {
        operationId: "r1:c1",
        toolCallId: "c1",
        action: "rename",
        hash: digest(rest),
        object: { planId: "p_1" },
        baseRev: 4,
      },
    ]);
    expect(finished).toEqual([
      {
        id: "r1:c1",
        payload: { ok: true, rev: 5 },
        operation: { id: "c1", tool: "plan", action: "rename", status: "ok", rev: 5 },
      },
    ]);
    expect(payloadOf(result)).toEqual({ ok: true, rev: 5 });
  });

  test("begin that cannot be saved is false, and notSaved says nothing was done", async () => {
    const result = await runOperation(
      { journal: journal(true), admitting: () => true },
      call,
      async (op) => {
        if (!op.begin()) return op.notSaved("written");
        throw new Error("unreachable");
      }
    );
    expect(result.details).toEqual({ id: "c1", tool: "plan", action: "rename", status: "error" });
    expect(payloadOf(result)).toEqual({
      ok: false,
      status: "error",
      detail: "the conversation could not be saved; nothing was written",
    });
    expect(finished).toEqual([]);
  });

  test("without a journal: begin succeeds and finish only returns the result", async () => {
    const result = await runOperation({ admitting: () => true }, call, async (op) => {
      expect(op.begin({ planId: "p_1" })).toBe(true);
      const settled = await okBody(op);
      expect(op.finish(settled)).toBe(settled);
      return settled;
    });
    expect(payloadOf(result)).toEqual({ ok: true, status: "ok" });
  });

  test("done puts the payload first and any extra parts after it", async () => {
    await runOperation({ admitting: () => true }, call, async (op) => {
      const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
      const result = op.done(op.record("rename", { status: "ok" }), { ok: true }, [image]);
      expect(result.content).toEqual([{ type: "text", text: '{"ok":true}' }, image]);
      expect(op.done(op.record("rename", {}), { ok: true }).content).toHaveLength(1);
      expect(op.record("other", {})).toEqual({
        id: "c1",
        tool: "plan",
        action: "other",
        status: "error",
      });
      return result;
    });
  });

  test("track passes the work through the host's track, and is the identity without one", async () => {
    const tracked: Promise<unknown>[] = [];
    await runOperation(
      {
        admitting: () => true,
        track: (work) => {
          tracked.push(work);
          return work;
        },
      },
      call,
      async (op) => {
        const work = Promise.resolve(3);
        expect(await op.track(work)).toBe(3);
        expect(tracked).toEqual([work]);
        return okBody(op);
      }
    );
    await runOperation({ admitting: () => true }, call, async (op) => {
      const work = Promise.resolve(4);
      expect(op.track(work)).toBe(work);
      return okBody(op);
    });
    // the kit never tracks the body by itself
    expect(tracked).toHaveLength(1);
  });
});

describe("askUser", () => {
  const request: ConfirmationRequest = {
    toolCallId: "c1",
    action: "delete_plan",
    planId: "p_1",
    label: "Alpha",
    planName: "Alpha",
    impact: { tasks: 2, openTasks: 1 },
    baseRev: 4,
    objectDigest: "d",
  };
  const object = { kind: "plan", id: "p_1" } as NonNullable<CopilotOperation["object"]>;
  const ask = (released: { n: number }) => ({
    tool: "plan",
    toolCallId: "c1",
    action: "delete_plan",
    object,
    label: "Alpha",
    request,
    nothing: "deleted",
    changed: "plans",
    release: () => {
      released.n++;
    },
  });
  const port = (
    answer: ConfirmationOutcome | Error,
    asked: ConfirmationRequest[] = []
  ): ConfirmationPort => ({
    request: async (entry) => {
      asked.push(entry);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  const refused = async (context: ToolHostContext, released: { n: number }) => {
    const answer = await askUser(context, ask(released));
    if (answer.approved) throw new Error("approved");
    return answer.result;
  };

  test("confirmUnavailable: the same refusal before anything is read, null when a card can be asked", () => {
    const base = { tool: "plan", toolCallId: "c1", action: "delete_plan", nothing: "deleted" };
    expect(
      confirmUnavailable({ admitting: () => true, confirm: port({ outcome: "approved" }) }, base)
    ).toBeNull();
    const result = confirmUnavailable({ admitting: () => true }, base);
    expect(result?.details).toEqual({
      id: "c1",
      tool: "plan",
      action: "delete_plan",
      status: "unsupported",
    });
    expect(result && payloadOf(result)).toEqual({
      ok: false,
      status: "unsupported",
      detail:
        "delete_plan needs the user's confirmation and none is available here; nothing was deleted",
    });
    expect(
      confirmUnavailable({ admitting: () => true }, { ...base, object, label: "Alpha" })?.details
    ).toMatchObject({ object, label: "Alpha" });
  });

  test("approved: the card shows the request as given, and nothing is released", async () => {
    const released = { n: 0 };
    const asked: ConfirmationRequest[] = [];
    const answer = await askUser(
      { admitting: () => true, confirm: port({ outcome: "approved" }, asked) },
      ask(released)
    );
    expect(answer).toEqual({ approved: true });
    expect(asked).toEqual([request]);
    expect(released.n).toBe(0);
  });

  test("no confirmation port: unsupported", async () => {
    const released = { n: 0 };
    const result = await refused({ admitting: () => true }, released);
    expect(result.details).toEqual({
      id: "c1",
      tool: "plan",
      action: "delete_plan",
      status: "unsupported",
      object,
      label: "Alpha",
    });
    expect(payloadOf(result)).toEqual({
      ok: false,
      status: "unsupported",
      detail:
        "delete_plan needs the user's confirmation and none is available here; nothing was deleted",
    });
    expect(released.n).toBe(1);
  });

  test("a request that cannot be saved: error", async () => {
    const released = { n: 0 };
    const result = await refused(
      { admitting: () => true, confirm: port(new Error("disk full")) },
      released
    );
    expect(result.details).toEqual({
      id: "c1",
      tool: "plan",
      action: "delete_plan",
      status: "error",
      object,
      label: "Alpha",
    });
    expect(payloadOf(result)).toEqual({
      ok: false,
      status: "error",
      detail: "the confirmation could not be saved; nothing was deleted",
    });
    expect(released.n).toBe(1);
  });

  test("declined", async () => {
    const released = { n: 0 };
    const result = await refused(
      { admitting: () => true, confirm: port({ outcome: "declined" }) },
      released
    );
    expect(result.details).toEqual({
      id: "c1",
      tool: "plan",
      action: "delete_plan",
      status: "declined",
      object,
      label: "Alpha",
    });
    expect(payloadOf(result)).toEqual({
      ok: false,
      status: "declined",
      detail: "the user declined; nothing was deleted",
    });
    expect(released.n).toBe(1);
  });

  test("expired because the object changed", async () => {
    const released = { n: 0 };
    const result = await refused(
      { admitting: () => true, confirm: port({ outcome: "expired", reason: "stale" }) },
      released
    );
    expect(result.details).toEqual({
      id: "c1",
      tool: "plan",
      action: "delete_plan",
      status: "expired",
      object,
      label: "Alpha",
    });
    expect(payloadOf(result)).toEqual({
      ok: false,
      status: "expired",
      detail:
        "plans changed before the user confirmed; nothing was deleted. Read again and ask only if it is still wanted",
    });
    expect(released.n).toBe(1);
  });

  test.each(["stopped", "restart", "closed"] as const)(
    "expired because the request ended (%s)",
    async (reason) => {
      const released = { n: 0 };
      const result = await refused(
        { admitting: () => true, confirm: port({ outcome: "expired", reason }) },
        released
      );
      expect(result.details).toMatchObject({ status: "expired", object, label: "Alpha" });
      expect(payloadOf(result)).toEqual({
        ok: false,
        status: "expired",
        detail: "the request ended before the user confirmed; nothing was deleted",
      });
      expect(released.n).toBe(1);
    }
  );

  test("a system error at the click is an error, never a change", async () => {
    const released = { n: 0 };
    const result = await refused(
      {
        admitting: () => true,
        confirm: port({ outcome: "expired", reason: "error", detail: "plans.json unreadable" }),
      },
      released
    );
    expect(result.details).toEqual({
      id: "c1",
      tool: "plan",
      action: "delete_plan",
      status: "error",
      object,
      label: "Alpha",
    });
    expect(payloadOf(result)).toEqual({
      ok: false,
      status: "error",
      detail:
        "the check made when the user confirmed found a system error (plans.json unreadable); nothing was deleted and nothing was changed. This is not a change by the user: tell them, and do not retry blindly",
    });
    expect(released.n).toBe(1);
  });

  test("without object or label the records carry neither, and release is optional", async () => {
    const answer = await askUser(
      { admitting: () => true, confirm: port({ outcome: "declined" }) },
      {
        tool: "text",
        toolCallId: "c2",
        action: "generate",
        request,
        nothing: "published",
        changed: "x",
      }
    );
    if (answer.approved) throw new Error("approved");
    expect(answer.result.details).toEqual({
      id: "c2",
      tool: "text",
      action: "generate",
      status: "declined",
    });
  });

  test("waiting for the user is never tracked", async () => {
    const tracked: unknown[] = [];
    await askUser(
      {
        admitting: () => true,
        confirm: port({ outcome: "approved" }),
        track: (work) => {
          tracked.push(work);
          return work;
        },
      },
      ask({ n: 0 })
    );
    expect(tracked).toEqual([]);
  });
});
