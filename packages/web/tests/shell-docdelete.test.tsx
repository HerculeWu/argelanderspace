/**
 * Shell-level wiring of the Stage 8 §8 workspace transition: `docDeleted`
 * must update the boot-time papers list, migrate currentDoc per the
 * three-state rule, and keep the address bar a valid deep link
 * (`/doc/<next>`, or `/` when nothing remains). The DocPane module is mocked
 * with a probe that captures the current workspace value; the boot fetch
 * serves only /api/papers (the deep-link route opens the doc pane directly,
 * so no other pane's data loads).
 */

import { waitFor, act, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../src/argelander/workspace";
import i18n from "../src/i18n";
import { installShellHarness, renderShell, stubShellFetch } from "./shell-harness";

const h = vi.hoisted(() => ({ ws: null as Workspace | null }));

vi.mock("../src/doc/DocPane", async () => (await import("./shell-stubs")).workspaceProbe(h));

async function boot(papers: string[], route: string) {
  stubShellFetch({ papers: () => papers });
  renderShell(route);
  // the doc pane (mock) mounts once /api/papers resolves and the route opens
  await waitFor(() => expect(h.ws).toBeTruthy());
  await waitFor(() => expect(h.ws!.papers).toEqual(papers));
  expect(h.ws!.currentDoc).toBe("d1");
}

installShellHarness({ language: null });
beforeEach(() => {
  h.ws = null;
});

describe("Shell docDeleted wiring (Stage 8 §8)", () => {
  it("exposes stable pane/navigation identifiers through locale, theme and density changes", async () => {
    await boot(["d1"], "/doc/d1");
    const themeButton = document.querySelector('[data-ui="toggle-theme"]') as HTMLButtonElement;
    expect(themeButton.querySelector("svg")?.classList.contains("ui-icon-size--small")).toBe(true);
    expect(themeButton.classList.contains("ui-action")).toBe(false);
    expect(themeButton.textContent).toBe("");
    const originalTheme = document.documentElement.getAttribute("data-theme");
    fireEvent.click(themeButton);
    expect(document.documentElement.getAttribute("data-theme")).not.toBe(originalTheme);
    const pane = document.querySelector('[data-ui="workspace-pane"]');
    expect(pane?.getAttribute("data-ui-key")).toBe("1");
    const nav = document.querySelector('[data-ui="navigate-view"][data-ui-key="library"]') as HTMLButtonElement;
    expect(nav).toBeTruthy();
    expect(nav.textContent).toBe("");
    expect(nav.querySelector("svg")?.classList.contains("ui-icon-size--navigation")).toBe(true);
    for (const key of ["doc", "write"]) {
      expect(document.querySelector(`[data-ui="navigate-view"][data-ui-key="${key}"] svg`)?.classList.contains("ui-icon-size--navigation")).toBe(true);
    }
    expect(document.querySelector('[data-ui="navigate-view"][data-ui-key="plan"] svg')?.classList.contains("ui-icon")).toBe(false);
    expect(document.querySelector('[data-ui="navigate-extensions"]')).toBeNull();
    expect(nav.classList.contains("ui-action")).toBe(false);
    expect(nav.getAttribute("aria-label")).toBe("文献");
    const split = document.querySelector('[data-ui="split-pane"]') as HTMLButtonElement;
    expect(split.querySelector("svg")?.classList.contains("ui-icon-size--small")).toBe(true);
    expect(split.getAttribute("aria-label")).toContain("分屏");
    expect(document.querySelector('[data-ui="control-tooltip"]')?.textContent).toContain("分屏");
    const tweaks = document.querySelector('[data-ui="open-tweaks"]') as HTMLButtonElement;
    expect(tweaks.querySelector("svg")?.classList.contains("ui-icon-size--small")).toBe(true);
    fireEvent.click(tweaks);
    expect(tweaks.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(document.querySelector('[data-ui="language-option"][data-ui-key="en"]') as HTMLElement);
    expect(themeButton.getAttribute("aria-label")).toBe("Toggle theme");
    expect(themeButton.parentElement?.querySelector('[data-ui="control-tooltip"]')?.textContent).toContain("Toggle theme");
    fireEvent.click(document.querySelector('[data-ui="theme-option"][data-ui-key="light"]') as HTMLElement);
    fireEvent.click(document.querySelector('[data-ui="density-option"][data-ui-key="compact"]') as HTMLElement);
    const accent = document.querySelector('[data-ui="accent-option"][data-ui-key="teal"]') as HTMLButtonElement;
    expect(accent.getAttribute("aria-label")).toBe("Teal");
    expect(accent.querySelector("svg")).toBeNull(); // the chip is the colour alone, no ring icon over it
    expect(accent.classList.contains("ui-button")).toBe(false);
    expect((document.querySelector('[data-ui="density-option"]') as HTMLButtonElement).classList.contains("ui-button")).toBe(false);
    expect(document.querySelector('[data-ui="navigate-view"][data-ui-key="library"]')).toBe(nav);
    expect(document.querySelector('[data-ui="workspace-pane"]')?.getAttribute("data-ui-key")).toBe("1");
    expect(document.querySelector('[data-ui="toggle-navigation-labels"]')).toBeNull();
    const iconNav = document.querySelector('[data-ui="navigate-view"][data-ui-key="library"]') as HTMLButtonElement;
    expect(iconNav.textContent).toBe("");
    expect(iconNav.querySelector("svg")).toBeTruthy();
    expect(iconNav.getAttribute("aria-label")).toBe(i18n.t("shell.nav.library"));
    expect(iconNav.parentElement?.querySelector('[data-ui="control-tooltip"]')?.textContent).toBe(i18n.t("shell.nav.library"));
    expect(iconNav.classList.contains("ui-button")).toBe(false);
  });
  it("keeps split instances glyph-only and prevents a fourth pane", async () => {
    await boot(["d1"], "/doc/d1");
    const split = document.querySelector('[data-ui="split-pane"]') as HTMLButtonElement;
    fireEvent.click(split);
    expect(document.querySelectorAll('[data-ui="workspace-pane"]')).toHaveLength(2);
    const splits = document.querySelectorAll('[data-ui="split-pane"]');
    expect(splits).toHaveLength(3);
    for (const button of splits) {
      expect(button.querySelector("svg")?.classList.contains("ui-icon-size--small")).toBe(true);
      expect(button.classList.contains("ui-action")).toBe(false);
      expect(button.textContent).toBe("");
    }
    fireEvent.click(split);
    expect(document.querySelectorAll('[data-ui="workspace-pane"]')).toHaveLength(3);
    expect(split.disabled).toBe(true);
    fireEvent.click(split);
    expect(document.querySelectorAll('[data-ui="workspace-pane"]')).toHaveLength(3);
    fireEvent.click(document.querySelector('[data-ui="close-pane"]') as HTMLButtonElement);
    expect(document.querySelectorAll('[data-ui="workspace-pane"]')).toHaveLength(2);
    expect(split.disabled).toBe(false);
  });

  it("deleting a non-current doc drops it from papers; currentDoc + URL untouched", async () => {
    await boot(["d1", "d2"], "/doc/d1");
    const before = window.location.pathname + window.location.hash;
    act(() => h.ws!.docDeleted("d2", []));
    await waitFor(() => expect(h.ws!.papers).toEqual(["d1"]));
    expect(h.ws!.currentDoc).toBe("d1");
    expect(window.location.pathname + window.location.hash).toBe(before);
  });

  it("deleting the current doc with remaining docs switches to the new main + rewrites the URL", async () => {
    await boot(["d1", "d2"], "/doc/d1");
    act(() => h.ws!.docDeleted("d1", ["d2"]));
    await waitFor(() => expect(h.ws!.currentDoc).toBe("d2"));
    expect(h.ws!.papers).toEqual(["d2"]);
    expect(window.location.pathname).toBe("/doc/d2");
  });

  it("deleting the current doc with none left empties currentDoc and resets the URL", async () => {
    await boot(["d1"], "/doc/d1#fig-1");
    act(() => h.ws!.docDeleted("d1", []));
    await waitFor(() => expect(h.ws!.currentDoc).toBeNull());
    expect(h.ws!.papers).toEqual([]);
    expect(window.location.pathname).toBe("/");
  });
});
