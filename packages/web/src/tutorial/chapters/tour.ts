import type { ChapterDefinition, WorkbenchSnapshot } from "../types";

const panesOf = (s: WorkbenchSnapshot) => s.page.workspace?.panes.length ?? 1;
const onePane = (s: WorkbenchSnapshot) => panesOf(s) === 1;
const split = (s: WorkbenchSnapshot) => panesOf(s) >= 2;

const PRIMARY_NAVIGATION = { ui: "primary-navigation" } as const;
const NAV_LIBRARY = { ui: "navigate-view", key: "library" } as const;
/** The title bar's split button (the pane headers have their own once there are two panes). */
const SPLIT_PANE = { ui: "split-pane", within: { ui: "titlebar-actions" } } as const;
/** The pane header and its view chooser of the active pane (the header element itself carries no key). */
const PANE_HEADER = { ui: "pane-header", scope: "active-pane" } as const;
const CHOOSE_PANE_VIEW = { ui: "choose-pane-view", scope: "active-pane" } as const;
/** The close button of the active pane: right after a split, the new pane on the right. */
const CLOSE_ACTIVE_PANE = { ui: "close-pane", scope: "active-pane" } as const;
/** The command palette (spec addendum 3): the title bar has no control that opens it, so the rung below is the navigation. */
const COMMAND_PALETTE = { ui: "command-palette" } as const;
const OPEN_TWEAKS = { ui: "open-tweaks" } as const;

/**
 * Chapter 1, "tour" (appendix A; order revised by the user 2026-10-21): split first, so the pane header the next step
 * points at exists, then close the new pane. No agent card.
 */
export const TOUR: ChapterDefinition = {
  id: "tour",
  n: 1,
  steps: [
    {
      id: "tour.library",
      kind: "do",
      anchors: [PRIMARY_NAVIGATION, NAV_LIBRARY],
      gate: (s) => s.page.view === "library",
    },
    {
      id: "tour.split",
      kind: "do",
      anchors: [SPLIT_PANE],
      gate: split,
    },
    {
      id: "tour.pane-views",
      kind: "look",
      anchors: [PANE_HEADER, CHOOSE_PANE_VIEW],
    },
    {
      id: "tour.close-pane",
      kind: "do",
      // One pane (the user came here some other way): the split button first; two or more: the new pane's close.
      anchors: [
        { ...SPLIT_PANE, when: onePane },
        { ...CLOSE_ACTIVE_PANE, when: split },
      ],
      // The process gate of the former "split, then close" step, kept for its closing half: two panes or more seen
      // during this showing, and now one (arriving with one pane, the user splits and closes again).
      gate: (s, run) => {
        if (split(s)) run.memo.sawSplit = true;
        return run.memo.sawSplit === true && onePane(s);
      },
    },
    {
      id: "tour.palette",
      kind: "do",
      anchors: [PRIMARY_NAVIGATION, COMMAND_PALETTE],
      gate: (s) => s.paletteOpen,
    },
    {
      id: "tour.tweaks",
      kind: "look",
      anchors: [OPEN_TWEAKS],
    },
  ],
};
