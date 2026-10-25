import type { CopilotViewAction, PageContext } from "@argelanderspace/contracts";

/**
 * A tutorial anchor (spec section 5): `{ui, key?}` names `[data-ui="ui"]`, with `[data-ui-key="key"]` when a key is
 * given, looked up in the whole document. `scope: "active-pane"` looks only inside the active workspace pane
 * (`[data-ui="workspace-pane"][data-ui-key=<active pane id>]`): the instance of a per-pane element such as the pane
 * header, whose own element carries no key (the Shell's convention for repeated per-pane elements); `within` looks
 * only inside another named element.
 */
export interface TutorialAnchor {
  readonly ui: string;
  readonly key?: string;
  readonly scope?: "active-pane";
  /** Look only inside this element (the title bar's split button, not the pane headers' ones). */
  readonly within?: { readonly ui: string; readonly key?: string };
  /**
   * A ladder rung may apply only in some states of the workbench: a rung whose condition is false now is skipped, as
   * if it were not present (step 1.4: the split button while there is one pane, the new pane's close button after).
   */
  readonly when?: (snapshot: WorkbenchSnapshot) => boolean;
}

/** An anchor ladder: the first entry is the step's primary anchor; the last one present right now is highlighted. */
export type AnchorLadder = readonly TutorialAnchor[];

/** The DOM layer of the observation (L3): only what the other two layers do not have. */
export interface DomQuery {
  /** Whether the anchor resolves to at least one element now. */
  present(anchor: TutorialAnchor): boolean;
  /** An attribute of the first element the anchor resolves to; null when absent. */
  attr(anchor: TutorialAnchor, name: string): string | null;
}

/**
 * The workbench snapshot every gate and requirement is a function of (spec section 5): the page context as the Shell
 * gives it to the Copilot, whether a product modal or the command palette is open, the DOM query, and the data read
 * back for the step's L2 sources (keyed by source id; absent until the first read answered).
 */
export interface WorkbenchSnapshot {
  readonly page: PageContext;
  readonly modalOpen: boolean;
  readonly paletteOpen: boolean;
  readonly dom: DomQuery;
  readonly data: Readonly<Record<string, unknown>>;
  /**
   * The folder of the tutorial Project the layer is mounted in (`tutorial.json`'s binding, equal to the open project's
   * root): what a gate compares a record's origin with (step 2.7: the Shelf entry must have been added from here).
   */
  readonly projectRoot?: string | null;
}

/** One showing of a gated step: the snapshot at its start (baselines) and a scratch record for process gates. */
export interface GateRun {
  readonly baseline: WorkbenchSnapshot;
  readonly memo: Record<string, unknown>;
}

export type Gate = (snapshot: WorkbenchSnapshot, run: GateRun) => boolean;

/** Where a requirement sends the user back to (`tutorial.ui.where.*`; the copy test checks every one). */
export const WHERE_KEYS = ["library", "workDetail", "reader", "plan", "writer", "settings", "argumentGraph", "copilot", "shelfDialog"] as const;
export type WhereKey = (typeof WHERE_KEYS)[number];

/** The interface state a step needs before its anchor can be shown. */
export interface Requirement {
  readonly test: (snapshot: WorkbenchSnapshot) => boolean;
  readonly where: WhereKey;
  /** Interpolation values of the `where` copy (a Work's name), as i18n-free data. */
  readonly whereValues?: Readonly<Record<string, string>>;
  /** The registered view action that takes the user there; absent: only the hint is shown. */
  readonly takeMeThere?: CopilotViewAction;
}

/**
 * An L2 source (spec section 5): an existing `/ws` event triggers a read back through an existing GET. Subscribed only
 * while its step is shown; read once when the step starts, then once per event (never polled).
 */
export interface L2Source<T = unknown> {
  readonly id: string;
  readonly subscribe: (changed: () => void) => () => void;
  readonly read: (signal: AbortSignal) => Promise<T>;
}

/**
 * What a step asks of the user: do something (gated or not), look, or the chapter's agent card (`intro`, a copyable
 * `prompt` and the `skill` line; no gate, never counted as skipped).
 */
export type StepKind = "do" | "look" | "agent";

/**
 * The product dialogs a step may float above (their `data-ui`): the Shelf dialog, whose Delete button step 2.9 points at.
 * Not a switch for "any modal": a new entry is a new, deliberate exception.
 */
export const FLOATABLE_DIALOGS = ["shelf-dialog"] as const;
export type FloatableDialog = (typeof FLOATABLE_DIALOGS)[number];

export interface StepDefinition {
  /** Stable string id, `<chapter id>.<name>`; its copy is `tutorial.steps.<id>.*`. */
  readonly id: string;
  readonly kind: StepKind;
  /** Empty: no anchor, the card docks at the bottom right (agent cards, the finish page). */
  readonly anchors: AnchorLadder;
  /** In the browser form, a different ladder (empty: docked) and the browser variants of the copy. */
  readonly browser?: { readonly anchors: AnchorLadder; readonly copy: "browser" };
  readonly gate?: Gate;
  /**
   * The named product dialog this step floats above (tutorial-shelf ticket 04). By default a product modal makes the card
   * yield (below its overlay, no highlight); a step that names its dialog keeps the card and the highlight above that
   * overlay while that dialog is the only modal open — any other modal, or a second one over it, still makes it yield.
   * The anchors are looked up in the whole document as usual (give a rung `within` the dialog to pin it there).
   */
  readonly floatsOver?: FloatableDialog;
  readonly sources?: readonly L2Source[];
  readonly requires?: Requirement;
  /**
   * A registered view action the anchored card offers as "take me there" (step 8.3: the plan page the operation card
   * wrote to). Navigation only, like a requirement's: it records nothing and is never a gate.
   */
  readonly takeMeThere?: CopilotViewAction;
  readonly needsTex?: boolean;
  /** Language-neutral prepared text (the BibTeX constant); a translated one is `tutorial.steps.<id>.prepared.text`. */
  readonly preparedText?: string;
  /** The step has a translated prepared text (`prepared.label`, `prepared.text`). */
  readonly preparedCopy?: boolean;
  /** Something to do when the gate passes: read the environment again (step 0.2). */
  readonly onPass?: "recheckEnvironment";
}

export interface ChapterDefinition {
  /** Stable id; its title is `tutorial.chapters.<id>.title`. */
  readonly id: string;
  /** The number shown ("Chapter N"). */
  readonly n: number;
  readonly steps: readonly StepDefinition[];
}
