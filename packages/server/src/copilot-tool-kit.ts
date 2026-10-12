/**
 * What every Copilot tool shares (ticket 34): the lifecycle of one journaled call (`runOperation`: admit, operation
 * id, the journal's three answers, then the tool's own body) and the request for a human confirmation (`askUser`).
 * The model-visible text of each branch lives only here. The kit never reads an archive, ensures, or writes a file,
 * and it gives no way to approve: only the real user answers a card.
 */
import { createHash } from "node:crypto";
import type {
  CopilotOperation,
  DocReplaceImpact,
  TextReplacementImpact,
  WriterDeleteImpact,
} from "@argelanderspace/contracts";

/** What the host remembers about a business write so a repeat or a restart never guesses. */
export type KnownOperation =
  | { state: "done"; hash: string; payload: Record<string, unknown>; operation: CopilotOperation }
  | { state: "begun"; hash: string; jobId?: string; sendId?: string };
export interface OperationJournalPort {
  lookup(operationId: string): KnownOperation | null;
  /** Persist "about to write". Throws when the conversation cannot be saved: then nothing is written. */
  begin(entry: {
    operationId: string;
    toolCallId: string;
    action: string;
    hash: string;
    object?: JournalObject;
    baseRev?: number;
  }): void;
  done(operationId: string, payload: Record<string, unknown>, operation: CopilotOperation): void;
  /** Record the Job-table job a begun operation submitted, so a restart can name it. Best effort. */
  submitted?(operationId: string, jobId: string): void;
}
/** The object a journaled write names. */
export type JournalObject = {
  planId?: string;
  taskId?: string;
  workId?: string;
  manuscriptId?: string;
  sendId?: string;
  summary?: string;
};

/** How a requested confirmation was settled by the human (or by the host when the request stopped being valid). */
export type ConfirmationOutcome =
  | { outcome: "approved" }
  | { outcome: "declined" }
  | { outcome: "expired"; reason: "stale" | "stopped" | "restart" | "closed" }
  /** A system error at click time (data unreadable): not a change, and never reported as one. */
  | { outcome: "expired"; reason: "error"; detail: string };
/** What the confirmation card shows: one of the nine kinds of request below, each with exactly what it binds. */
export type ConfirmationRequest =
  | {
      toolCallId: string;
      /** Mail ticket 09: sending a draft. The card shows this very snapshot and this very snapshot is sent. */
      action: "send_mail";
      accountId: string;
      messageId: string;
      account: { id: string; address: string; displayName: string };
      kind: "new" | "reply" | "forward";
      to: { name: string; address: string }[];
      cc: { name: string; address: string }[];
      bcc: { name: string; address: string }[];
      subject: string;
      text: string;
      attachments: { filename: string; contentType: string; size: number }[];
      inReplyTo: string | null;
      baseRev: number;
      objectDigest: string;
    }
  | {
      toolCallId: string;
      /** Mail ticket 09: moving a message to Trash (or deleting it for good from Trash). */
      action: "delete_mail";
      accountId: string;
      account: { id: string; address: string; displayName: string };
      message: {
        folder: string;
        uid: number;
        uidValidity: number;
        from: { name: string; address: string } | null;
        subject: string;
        date: string | null;
      };
      permanent: boolean;
      baseRev: number;
      objectDigest: string;
    }
  | {
      toolCallId: string;
      /** Mail ticket 09: moving a message to another folder. */
      action: "move_mail";
      accountId: string;
      account: { id: string; address: string; displayName: string };
      message: {
        folder: string;
        uid: number;
        uidValidity: number;
        from: { name: string; address: string } | null;
        subject: string;
        date: string | null;
      };
      destination: string;
      baseRev: number;
      objectDigest: string;
    }
  | {
      toolCallId: string;
      /** Replacing the annotated reading text of a text Doc (copilot ticket 29): the source panel's replacement dialog. */
      action: "replace_text_reading";
      docId: string;
      label: string;
      impact: TextReplacementImpact;
      baseRev: number;
      objectDigest: string;
    }
  | {
      toolCallId: string;
      /** Only a whole Plan waits for the user; a Task delete is immediate like on the Plan page. */
      action: "delete_plan";
      planId: string;
      label: string;
      planName: string;
      impact: { tasks: number; openTasks: number };
      baseRev: number;
      /** Content digest of the target at request time; a change that leaves the rev alone still expires the card. */
      objectDigest: string;
    }
  | {
      toolCallId: string;
      /**
       * Replacing the text of an existing LaTeX Doc: the arXiv refresh. The Files tab dialog's annotation-risk step.
       */
      action: "refresh_arxiv_source";
      workId: string;
      docId: string;
      label: string;
      impact: DocReplaceImpact;
      /** The annotations rev the count was read at (0 when it could not be read). */
      baseRev: number;
      objectDigest: string;
    }
  | {
      toolCallId: string;
      /** The Files tab's "delete document" dialog: the global physical delete of one Doc. */
      action: "delete_doc";
      docId: string;
      format: "pdf" | "latex" | "text";
      works: { id: string; title: string; main: boolean; remaining: number }[];
      impact: DocReplaceImpact;
      /** The annotations revision the count was read at (0 when it could not be read). */
      baseRev: number;
      objectDigest: string;
    }
  | {
      toolCallId: string;
      /** Argument graph ticket 09: replacing or clearing a graph that holds arguments (the page's Clear dialog, widened). */
      action: "replace_argument_graph";
      workId: string;
      label: string;
      mode: "replace" | "clear";
      current: { arguments: number; edges: number };
      next: { arguments: number; edges: number };
      baseRev: number;
      objectDigest: string;
    }
  | {
      toolCallId: string;
      /** The Writer list's delete dialog: the physical delete of one manuscript folder. */
      action: "delete_manuscript";
      manuscriptId: string;
      label: string;
      impact: WriterDeleteImpact;
      baseRev: number;
      objectDigest: string;
    };
/**
 * The only way a delete can proceed. `request` makes the application show a card to the real user and
 * resolves with the user's decision. The tool never sees an id or a way to answer: it cannot approve.
 * It throws when the request cannot be saved, and then nothing was shown or written.
 */
export interface ConfirmationPort {
  request(entry: ConfirmationRequest): Promise<ConfirmationOutcome>;
}

/** What the host gives every tool; each tool's own context extends it. */
export interface ToolHostContext {
  /** Present in the real host; business writes are journaled so a repeated operationId is answered, not rerun. */
  journal?: OperationJournalPort;
  /** Counts an operation as in flight until it settles, so a terminal run state waits for it. */
  track?: <T>(work: Promise<T>) => Promise<T>;
  /** The run this call belongs to; scopes default operation ids. */
  runId?: string;
  /** Present in the real host: confirmations wait here for the user. Without it such a request is refused. */
  confirm?: ConfirmationPort;
  /** False once the host stopped admitting operations (shutdown, Stop). */
  admitting: () => boolean;
}

export type Part =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
export type ToolResult = { content: Part[]; details: CopilotOperation };

/** The model reads the payload as JSON text; a tool may add parts (a page image) after it. */
export function done(operation: CopilotOperation, payload: object, parts?: Part[]): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }, ...(parts ?? [])],
    details: operation,
  };
}

/** The operation row of one call; anything not given is an error until the tool says otherwise. */
export function record(
  tool: string,
  id: string,
  action: string,
  partial: Partial<CopilotOperation>
): CopilotOperation {
  return { id, tool, action, status: "error", ...partial };
}

/** The handle a journaled call's body works with. */
export interface Op {
  operationId: string;
  hash: string;
  /** Journal "about to write". False when the conversation cannot be saved: then nothing may be written. */
  begin(object?: JournalObject, baseRev?: number): boolean;
  /** The result for a write refused because `begin` could not be saved. */
  notSaved(nothing: string): ToolResult;
  /**
   * Journal the result and return it unchanged. The journal keeps `journaled` when given (a tool whose model-visible
   * wording differs from the shared handler's answer), else the result's own JSON payload.
   */
  finish(result: ToolResult, journaled?: Record<string, unknown>): ToolResult;
  done(operation: CopilotOperation, payload: object, parts?: Part[]): ToolResult;
  /** The operation row of this call, for this tool. */
  record(action: string, partial: Partial<CopilotOperation>): CopilotOperation;
  /** Counts submitted work as in flight; the identity without a host. Never wrap a wait for the user in it. */
  track: <T>(work: Promise<T>) => Promise<T>;
}

/**
 * One journaled call: admitted, its operation id (the model's, or one scoped to this run and call), and what the
 * journal already knows about it. A request that reuses an id is rejected, a finished one is answered again, and
 * one that began without a recorded outcome is `unknown`; only an operation the journal does not know runs `body`.
 * The body decides when to `begin`, what to `track` and when to `finish`: the kit tracks nothing by itself, so a
 * wait for the user is never counted as in flight.
 */
export async function runOperation(
  ctx: ToolHostContext,
  call: {
    tool: string;
    toolCallId: string;
    action: string;
    /** The parameters that bind the operation (all but operationId). */
    rest: Record<string, unknown>;
    /** The operationId the model gave, if any. */
    requestedId?: unknown;
    /**
     * Where the model reads back what an unrecorded operation did, e.g. "read the plans to find out"; or, when that
     * depends on what the journal kept (a job id, a send id), the whole detail and any fields to add to the result.
     */
    readBack:
      | string
      | ((known: Extract<KnownOperation, { state: "begun" }>) => {
          detail: string;
          payload?: Record<string, unknown>;
        });
    /**
     * How a finished operation is answered again; by default exactly as it was recorded. A tool whose result names
     * a job still running when it was recorded can answer with what that job did since.
     */
    replay?: (known: Extract<KnownOperation, { state: "done" }>) => {
      operation: CopilotOperation;
      payload: Record<string, unknown>;
    };
    /** The object and label the kit's own records (closed, rejected, unknown, not saved) carry, when given. */
    named?: { object?: CopilotOperation["object"]; label?: string };
  },
  body: (op: Op) => Promise<ToolResult>
): Promise<ToolResult> {
  const { tool, toolCallId, action } = call;
  const row = (name: string, partial: Partial<CopilotOperation>) =>
    record(tool, toolCallId, name, partial);
  const named: Partial<CopilotOperation> = {
    ...(call.named?.object ? { object: call.named.object } : {}),
    ...(call.named?.label !== undefined ? { label: call.named.label } : {}),
  };
  if (!ctx.admitting())
    return done(row(action, { status: "error", ...named }), { ok: false, status: "closed" });
  const journal = ctx.journal;
  const operationId =
    typeof call.requestedId === "string" && call.requestedId
      ? call.requestedId
      : `${ctx.runId ?? "run"}:${toolCallId}`;
  const hash = digest(call.rest);
  const known = journal?.lookup(operationId);
  if (known && known.hash !== hash)
    return done(row(action, { status: "rejected", ...named }), {
      ok: false,
      status: "rejected",
      detail: "operationId was already used for a different request",
    });
  if (known?.state === "done") {
    const again = call.replay ? call.replay(known) : known;
    return done({ ...again.operation, id: toolCallId }, { ...again.payload, duplicate: true });
  }
  if (known) {
    const unrecorded =
      typeof call.readBack === "string"
        ? {
            detail: `this operation started earlier and its outcome was not recorded; ${call.readBack}, do not repeat it blindly`,
          }
        : call.readBack(known);
    return done(row(action, { status: "unknown", ...named }), {
      ok: false,
      status: "unknown",
      ...unrecorded.payload,
      detail: unrecorded.detail,
    });
  }
  const track = ctx.track;
  return body({
    operationId,
    hash,
    begin(object, baseRev) {
      try {
        journal?.begin({
          operationId,
          toolCallId,
          action,
          hash,
          ...(object !== undefined ? { object } : {}),
          ...(baseRev !== undefined ? { baseRev } : {}),
        });
        return true;
      } catch {
        return false;
      }
    },
    notSaved: (nothing) =>
      done(row(action, { status: "error", ...named }), {
        ok: false,
        status: "error",
        detail: `the conversation could not be saved; nothing was ${nothing}`,
      }),
    finish(result, journaled) {
      if (!journal) return result;
      // `done` always puts the payload first, as JSON: what the journal keeps is what the model read.
      const first = result.content[0];
      journal.done(
        operationId,
        journaled ?? JSON.parse(first?.type === "text" ? first.text : "{}"),
        result.details
      );
      return result;
    },
    done,
    record: row,
    track: track ? (work) => track(work) : (work) => work,
  });
}

/**
 * The refusal when no confirmation can be asked here, or null when it can. A tool calls it at the earliest point it
 * can (for some that is before reading the target, for others only once the target or a first answer says a card is
 * needed); `askUser` refuses with this same result on its own.
 */
export function confirmUnavailable(
  ctx: ToolHostContext,
  ask: {
    tool: string;
    toolCallId: string;
    action: string;
    nothing: string;
    object?: CopilotOperation["object"];
    label?: string;
  }
): ToolResult | null {
  return ctx.confirm ? null : unsupported(ask);
}

/** The one wording of "no confirmation can be asked here". */
function unsupported(ask: {
  tool: string;
  toolCallId: string;
  action: string;
  nothing: string;
  object?: CopilotOperation["object"];
  label?: string;
}): ToolResult {
  return refusal(
    ask,
    "unsupported",
    `${ask.action} needs the user's confirmation and none is available here; nothing was ${ask.nothing}`
  );
}

/** A confirmation that did not lead to an approval: the record names the object and label the tool gave. */
function refusal(
  ask: {
    tool: string;
    toolCallId: string;
    action: string;
    object?: CopilotOperation["object"];
    label?: string;
  },
  status: "unsupported" | "error" | "declined" | "expired",
  detail: string
): ToolResult {
  return done(
    record(ask.tool, ask.toolCallId, ask.action, {
      status,
      ...(ask.object ? { object: ask.object } : {}),
      ...(ask.label !== undefined ? { label: ask.label } : {}),
    }),
    { ok: false, status, detail }
  );
}

/**
 * Ask the real user and wait for the answer, holding no lock and tracking nothing (Stop must still end a waiting
 * card). Anything but an approval is a finished result that says what was not done; `release` runs once on each
 * of those branches (a send frees its draft). After an approval the tool checks again itself, then begins.
 */
export async function askUser(
  ctx: ToolHostContext,
  ask: {
    tool: string;
    toolCallId: string;
    action: string;
    object?: CopilotOperation["object"];
    label?: string;
    request: ConfirmationRequest;
    /** What did not happen: "deleted", "sent", "changed and no job was started"… */
    nothing: string;
    /** What may have changed before the click: "plans", "the manuscript"… */
    changed: string;
    release?: () => void;
  }
): Promise<{ approved: true } | { approved: false; result: ToolResult }> {
  const { nothing } = ask;
  const refuse = (status: "error" | "declined" | "expired", detail: string) => {
    ask.release?.();
    return { approved: false as const, result: refusal(ask, status, detail) };
  };
  if (!ctx.confirm) {
    ask.release?.();
    return { approved: false, result: unsupported(ask) };
  }
  let decision: ConfirmationOutcome;
  try {
    decision = await ctx.confirm.request(ask.request);
  } catch {
    return refuse("error", `the confirmation could not be saved; nothing was ${nothing}`);
  }
  if (decision.outcome === "approved") return { approved: true };
  if (decision.outcome === "declined")
    return refuse("declined", `the user declined; nothing was ${nothing}`);
  if (decision.reason === "error")
    return refuse(
      "error",
      `the check made when the user confirmed found a system error (${decision.detail}); nothing was ${nothing}. This is not a change by the user: tell them, and do not retry blindly`
    );
  return refuse(
    "expired",
    decision.reason === "stale"
      ? `${ask.changed} changed before the user confirmed; nothing was ${nothing}. Read again and ask only if it is still wanted`
      : `the request ended before the user confirmed; nothing was ${nothing}`
  );
}

/** The hash an operationId is bound to: the parameters with keys in a stable order. */
export function digest(value: Record<string, unknown>): string {
  const sorted = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(sorted)
      : input && typeof input === "object"
        ? Object.fromEntries(
            Object.entries(input as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, v]) => [key, sorted(v)])
          )
        : input;
  return createHash("sha256")
    .update(JSON.stringify(sorted(value)))
    .digest("hex");
}
