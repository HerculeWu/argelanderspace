/**
 * Module stand-ins for the Shell tests, for `vi.mock` factories (the other half of the Shell test fixture is
 * `shell-harness.tsx`). `vi.mock` is hoisted per test file, so each file still declares which modules it replaces;
 * the factory delegates here, as fake-ws.ts does for `api/ws`:
 *
 *   vi.mock("../src/plan/PlanView", async () => (await import("./shell-stubs")).pageStub("plan"));
 *   vi.mock("../src/copilot/Copilot", async () => (await import("./shell-stubs")).copilotProbe(h));
 *
 * This module must not import any module a test replaces (a factory that imports it would wait on itself), nor
 * `argelander/panes/`: the pane manager stays real in every Shell test. A page a test does not name stays real.
 */
import type { PageContext } from "@argelanderspace/contracts";
import type { ReactNode } from "react";
import { useWorkspace, type Workspace } from "../src/argelander/workspace";
import type { Copilot } from "../src/copilot/Copilot";
import type { CopilotSubscription } from "../src/api/ws-bus";

/** The five workspace pages (the settings page is never replaced). */
export type WorkspacePage = "plan" | "write" | "library" | "doc" | "mail";
const PAGE_EXPORT = { plan: "PlanView", write: "WriterView", library: "LibraryView", doc: "DocPane", mail: "MailView" } as const;

/** One page's module, its page an empty element named `ui` (data-ui; by default `stub-<page>`). */
export function pageStub(page: WorkspacePage, ui = `stub-${page}`) {
  return { [PAGE_EXPORT[page]]: () => <div data-ui={ui} /> };
}

export type CopilotProps = Parameters<typeof Copilot>[0];

/** The Copilot panel's module, the panel nothing (by default), an empty element named `show`, or what `show` draws. */
export function copilotStub(show: string | null | ((props: CopilotProps) => ReactNode) = null) {
  return {
    Copilot: (props: CopilotProps) => (typeof show === "function" ? show(props) : show === null ? null : <div data-ui={show} />),
  };
}

/** Where the Copilot probe writes what the Shell gives the panel: a test file's `vi.hoisted` object. */
export interface CopilotRecord {
  /** The props of the latest render. */
  props?: CopilotProps | null;
  /** `onViewAction` of the latest render: the bound view's actions. */
  viewAction: unknown;
  /** `context` of the latest render: the page the assistant is told. */
  context?: PageContext | null;
  /** When given: each context the panel was rendered with, in order, once per change. */
  seen?: PageContext[];
}

/**
 * The Copilot panel's module, the panel a probe that writes each render's props into `record`; `also` takes more from
 * them, and the panel is nothing unless `show` draws something.
 */
export function copilotProbe(record: CopilotRecord, opts: { also?: (props: CopilotProps) => void; show?: (props: CopilotProps) => ReactNode } = {}) {
  return {
    Copilot: (props: CopilotProps) => {
      record.props = props;
      record.viewAction = props.onViewAction;
      record.context = props.context;
      if (record.seen && record.seen[record.seen.length - 1] !== props.context) record.seen.push(props.context);
      opts.also?.(props);
      return opts.show ? opts.show(props) : null;
    },
  };
}

/** The Doc page's module, the page a probe that keeps the workspace it is given (the Shell's `useWorkspace()`) and shows nothing. */
export function workspaceProbe(record: { ws: Workspace | null }) {
  return {
    DocPane: () => {
      record.ws = useWorkspace();
      return null;
    },
  };
}

const unsubscribed = () => () => {};

/**
 * A hand-written `api/ws` module: the five subscriptions the pages use, each a no-op unless `over` gives it (or adds
 * another). It has nothing else — no `onSettingsChanged`, no `onHostSwitchConfirmation` — so the Shell's own
 * subscriptions fail and it runs without a live channel (the catch in preferences.tsx and welcome/ProjectSwitch.tsx).
 * For the real routing of server messages use fake-ws.ts.
 */
export function quietWs(over: Record<string, (...args: never[]) => () => void> = {}) {
  return {
    onPlanChanged: unsubscribed,
    onLibraryChanged: unsubscribed,
    onJobEvent: unsubscribed,
    onAnnotationChanged: unsubscribed,
    onWriterChanged: unsubscribed,
    ...over,
  };
}

/** Where `copilotWs` keeps the Copilot panel's subscription: a test file's `vi.hoisted` object. */
export interface CopilotChannel {
  subscription: CopilotSubscription | null;
  /** Called with each new subscription (a test's own resolver). */
  subscribed?: (subscription: CopilotSubscription) => void;
}

/**
 * `quietWs` with the real Copilot panel's own subscription: `subscribeCopilot` keeps it in `channel` (ready at once), so
 * a test delivers a view action the way the server's message would (`channel.subscription.viewAction(...)`).
 */
export function copilotWs(channel: CopilotChannel, over: Record<string, (...args: never[]) => () => void> = {}) {
  return {
    ...quietWs(over),
    subscribeCopilot: (subscription: CopilotSubscription) => {
      channel.subscription = subscription;
      queueMicrotask(subscription.ready);
      channel.subscribed?.(subscription);
      return () => {
        if (channel.subscription === subscription) channel.subscription = null;
      };
    },
  };
}
