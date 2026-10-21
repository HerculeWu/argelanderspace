import type { PageContext, TutorialProgress } from "@argelanderspace/contracts";
import type { DomQuery, TutorialAnchor, WorkbenchSnapshot } from "../src/tutorial/types";

/** A page context with just what the tutorial looks at: the active view and the panes. */
export function fakePage(view: string, panes = 1, activePaneId = 1): PageContext {
  const list = Array.from({ length: panes }, (_, i) => ({ paneId: i + 1, view: i + 1 === activePaneId ? view : "plan", share: 1 / panes }));
  return {
    version: 1,
    viewId: "00000000-0000-4000-8000-000000000000",
    revision: 1,
    paneId: activePaneId,
    view,
    otherPanes: list.filter((p) => p.paneId !== activePaneId).map(({ paneId, view: v }) => ({ paneId, view: v })),
    status: "complete",
    workspace: { maxPanes: 3, activePaneId, panes: list, appearance: { theme: "dark", accent: "azure", density: "regular", language: "zh-CN" }, copilotOpen: false },
  } as unknown as PageContext;
}

/** A DOM query over a fixed set of present anchors (`ui` or `ui[key]`) with attributes. */
export function fakeDom(present: Record<string, Record<string, string>> = {}): DomQuery {
  const name = (a: TutorialAnchor) => (a.key !== undefined ? `${a.ui}[${a.key}]` : a.ui);
  return {
    present: (a) => Object.getOwnPropertyDescriptor(present, name(a)) !== undefined,
    attr: (a, attr) => present[name(a)]?.[attr] ?? null,
  };
}

export function fakeSnapshot(over: Partial<WorkbenchSnapshot> & { view?: string; panes?: number } = {}): WorkbenchSnapshot {
  const { view = "plan", panes = 1, ...rest } = over;
  return { page: fakePage(view, panes), modalOpen: false, paletteOpen: false, dom: fakeDom(), data: {}, ...rest };
}

export function fakeProgress(over: Partial<TutorialProgress> = {}): TutorialProgress {
  return {
    version: 1,
    project: { path: "/tmp/tutorial-project" },
    startedAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    position: null,
    steps: {},
    appVersion: "0.0.0-test",
    ...over,
  };
}
