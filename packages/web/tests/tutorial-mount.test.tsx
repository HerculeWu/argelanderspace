/** When the tutorial layer exists at all (spec section 6): only on the project tutorial.json is bound to. */
import type { TutorialState } from "@argelanderspace/contracts";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreferencesProvider, type Preferences } from "../src/argelander/preferences";
import { markTutorialEntry, resetTutorialEntryForTests } from "../src/tutorial/entry";
import { TutorialLayer } from "../src/tutorial/TutorialLayer";
import { fakePage, fakeProgress } from "./tutorial-fixtures";

const h = vi.hoisted(() => ({ state: null as TutorialState | null, put: vi.fn() }));
vi.mock("../src/api/tutorial", () => ({ fetchTutorial: async () => h.state, putTutorial: h.put }));
vi.mock("../src/api/environment", () => ({ fetchEnvironment: async () => null }));
vi.mock("../src/host", () => ({ useHostAnswer: () => ({ mode: "desktop" }) }));

const BOUND = "/home/u/ArgelanderSpace-Tutorial";
function mount(projectRoot: string | null) {
  const prefs = { settings: { running: { project_root: projectRoot ? { path: projectRoot, display: projectRoot } : null } } } as unknown as Preferences;
  return render(
    <PreferencesProvider value={prefs}>
      <TutorialLayer context={fakePage("plan")} onViewAction={async () => ({})} />
    </PreferencesProvider>,
  );
}
const stateFor = (path: string | null): TutorialState => ({
  progress: fakeProgress({ project: path ? { path } : null, position: "tour.split" }),
  project: path ? { path, display: path, state: "ready" } : null,
  sample: { bundled: 1, project: 1 },
});

afterEach(() => {
  cleanup();
  resetTutorialEntryForTests();
  sessionStorage.clear();
});

describe("the tutorial layer's mount condition", () => {
  it("the open project is the bound one, entered another way: the capsule only", async () => {
    h.state = stateFor(BOUND);
    mount(`${BOUND}/`);
    await waitFor(() => expect(document.querySelector('[data-ui="tutorial-capsule"]')).not.toBeNull());
    expect(document.querySelector('[data-ui="tutorial-step-card"]')).toBeNull();
  });
  it("entered through the tutorial's entry (the one-time mark): the card of the recorded step", async () => {
    h.state = stateFor(BOUND);
    markTutorialEntry();
    mount(BOUND);
    await waitFor(() => expect(document.querySelector('[data-ui="tutorial-step-card"]')?.getAttribute("data-ui-key")).toBe("tour.split"));
  });
  it("the user's own project: no layer at all, whatever the mark says", async () => {
    h.state = stateFor(BOUND);
    markTutorialEntry();
    mount("/home/u/my-research");
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector('[data-ui="tutorial-layer"]')).toBeNull();
  });
  it("no progress, or progress bound to nothing: no layer", async () => {
    h.state = { progress: null, project: null, sample: { bundled: null, project: null } };
    mount(BOUND);
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector('[data-ui="tutorial-layer"]')).toBeNull();
    cleanup();
    h.state = stateFor(null);
    mount(BOUND);
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector('[data-ui="tutorial-layer"]')).toBeNull();
  });
  it.each(["unmarked", "missing"] as const)(
    "the open project is the bound path but its folder is %s now (no tutorial marker): no layer, whatever the mark says",
    async (folder) => {
      h.state = { ...stateFor(BOUND), project: { path: BOUND, display: BOUND, state: folder } };
      markTutorialEntry();
      mount(BOUND);
      await new Promise((r) => setTimeout(r, 20));
      expect(document.querySelector('[data-ui="tutorial-layer"]')).toBeNull();
    },
  );
});
