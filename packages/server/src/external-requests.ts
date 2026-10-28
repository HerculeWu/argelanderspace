/**
 * The workbench's queue of confirmation cards raised by an external agent through the CLI (release-0.2 ticket 04;
 * contracts `external-requests.ts`; `docs/operation-catalog.md` "Confirmation cards from the CLI").
 *
 * A cataloged operation with `confirm: "card"` that arrives on the operation route asks here and waits, on the same
 * HTTP request, until a person decides. The queue belongs to no Copilot conversation. Its rules are the approved
 * prototype's (variant A):
 * - requests are handled in arrival order and only the first entry can be decided (there is no "approve all");
 * - the asker leaving (`signal` aborting: Ctrl-C, a lost connection, the workbench closing) withdraws a pending
 *   request: its state becomes `withdrawn` and it can never be approved. The first entry stays until the user closes
 *   it; a withdrawn entry behind another goes by itself after {@link WITHDRAWN_LINGER_MS};
 * - the decision is the commit: once approved, the asker leaving does not undo it. The decision call waits for the
 *   operation's own result (`settle`) so the page can act on it;
 * - nothing is persisted: a restarted workbench has no requests, and the CLI of the old one was told it was interrupted.
 */
import { randomUUID } from "node:crypto";
import type {
  CopilotConfirmation,
  ExternalRequest,
  ExternalRequestClient,
} from "@argelanderspace/contracts";

/** How long a withdrawn entry that is not the first of the queue stays visible (struck through) before it goes. */
export const WITHDRAWN_LINGER_MS = 4000;
/** More waiting requests than this are refused outright: an agent cannot bury the page in cards. */
export const MAX_EXTERNAL_REQUESTS = 20;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A Copilot card as an operation hands it over: everything but the host's ids, which the queue fills in. */
export type ExternalCardFields = DistributiveOmit<
  CopilotConfirmation,
  "id" | "runId" | "toolCallId"
>;

export type ExternalAnswer = "approved" | "denied" | "withdrawn";

/** What `ask` gives the operation: the answer, and the way to report how the approved operation ended. */
export interface ExternalAsk {
  answer: ExternalAnswer;
  /** Report the operation's result (call exactly once after `approved`; ignored otherwise). */
  settle(result: unknown): void;
}

export type ExternalDecisionOutcome =
  | { kind: "decided"; decision: "approve"; result: unknown }
  | { kind: "decided"; decision: "deny" }
  | { kind: "gone" }
  | { kind: "withdrawn" }
  | { kind: "not_first" };

interface Entry {
  view: ExternalRequest;
  answer: (answer: ExternalAnswer) => void;
  settle: (result: unknown) => void;
  result: Promise<unknown>;
}

export interface ExternalRequestQueueOptions {
  /** The queue changed: the server tells the pages to read it again. */
  onChanged: () => void;
  now?: () => Date;
  lingerMs?: number;
  max?: number;
}

export class ExternalRequestQueue {
  private readonly entries: Entry[] = [];
  private readonly onChanged: () => void;
  private readonly now: () => Date;
  private readonly lingerMs: number;
  private readonly max: number;

  constructor(options: ExternalRequestQueueOptions) {
    this.onChanged = options.onChanged;
    this.now = options.now ?? (() => new Date());
    this.lingerMs = options.lingerMs ?? WITHDRAWN_LINGER_MS;
    this.max = options.max ?? MAX_EXTERNAL_REQUESTS;
  }

  /** The queue as the page shows it, in arrival order. */
  list(): ExternalRequest[] {
    return this.entries.map((entry) => entry.view);
  }

  /**
   * Put a card up and wait for the answer. `null`: the queue is full (nothing was put up). An asker that is already
   * gone gets `withdrawn` without a card.
   */
  ask(input: {
    card: ExternalCardFields;
    client?: ExternalRequestClient | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<ExternalAsk> | null {
    if (input.signal?.aborted) return Promise.resolve({ answer: "withdrawn", settle: () => {} });
    if (this.entries.filter((entry) => entry.view.state === "pending").length >= this.max)
      return null;
    const id = randomUUID();
    return new Promise<ExternalAsk>((resolve) => {
      let settle: (result: unknown) => void = () => {};
      const result = new Promise<unknown>((done) => {
        settle = done;
      });
      let answered = false;
      const entry: Entry = {
        view: {
          id,
          state: "pending",
          receivedAt: this.now().toISOString(),
          client: input.client ?? null,
          card: { ...input.card, id, runId: id, toolCallId: "external" } as CopilotConfirmation,
        },
        answer: (answer) => {
          if (answered) return;
          answered = true;
          input.signal?.removeEventListener("abort", onAbort);
          resolve({ answer, settle });
        },
        settle,
        result,
      };
      const onAbort = () => {
        if (entry.view.state !== "pending") return;
        entry.view = { ...entry.view, state: "withdrawn" };
        entry.answer("withdrawn");
        this.changed();
        const timer = setTimeout(() => {
          if (this.entries[0] !== entry && this.entries.includes(entry)) {
            this.remove(entry);
            this.changed();
          }
        }, this.lingerMs);
        timer.unref();
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      this.entries.push(entry);
      this.changed();
    });
  }

  /** A person's decision. Only the first entry of the queue, and only while the asker still waits. */
  async decide(id: string, decision: "approve" | "deny"): Promise<ExternalDecisionOutcome> {
    const entry = this.entries.find((candidate) => candidate.view.id === id);
    if (entry === undefined) return { kind: "gone" };
    if (entry.view.state === "withdrawn") return { kind: "withdrawn" };
    if (this.entries[0] !== entry) return { kind: "not_first" };
    this.remove(entry);
    this.changed();
    entry.answer(decision === "approve" ? "approved" : "denied");
    if (decision === "deny") return { kind: "decided", decision };
    return { kind: "decided", decision, result: await entry.result };
  }

  /** The user closes a withdrawn card. */
  dismiss(id: string): boolean {
    const entry = this.entries.find((candidate) => candidate.view.id === id);
    if (entry === undefined || entry.view.state !== "withdrawn") return false;
    this.remove(entry);
    this.changed();
    return true;
  }

  private remove(entry: Entry): void {
    const at = this.entries.indexOf(entry);
    if (at >= 0) this.entries.splice(at, 1);
  }

  private changed(): void {
    try {
      this.onChanged();
    } catch {
      /* a failed notification must not break a decision */
    }
  }
}
