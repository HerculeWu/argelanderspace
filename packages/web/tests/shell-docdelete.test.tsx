/**
 * Shell-level wiring of the Stage 8 §8 workspace transition: `docDeleted`
 * must update the boot-time papers list, migrate currentDoc per the
 * three-state rule, and keep the address bar a valid deep link
 * (`/doc/<next>`, or `/` when nothing remains). The DocPane module is mocked
 * with a probe that captures the current workspace value; the boot fetch
 * serves only /api/papers (the deep-link route opens the doc pane directly,
 * so no other pane's data loads).
 */

import { cleanup, render, waitFor, act, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/argelander/Shell";
import type { Workspace } from "../src/argelander/workspace";
import i18n from "../src/i18n";

const h = vi.hoisted(() => ({ ws: null as Workspace | null }));

vi.mock("../src/doc/DocPane", async () => {
  const { useWorkspace } = await import("../src/argelander/workspace");
  return {
    DocPane: () => {
      h.ws = useWorkspace();
      return null;
    },
  };
});

function installFetch(papers: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/papers") {
        return { ok: true, status: 200, json: async () => ({ papers }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    })
  );
}

async function boot(papers: string[], route: string) {
  installFetch(papers);
  window.history.replaceState(null, "", route);
  render(<Shell />);
  // the doc pane (mock) mounts once /api/papers resolves and the route opens
  await waitFor(() => expect(h.ws).toBeTruthy());
  await waitFor(() => expect(h.ws!.papers).toEqual(papers));
  expect(h.ws!.currentDoc).toBe("d1");
}

beforeEach(() => {
  h.ws = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  localStorage.removeItem("argelander.tweaks");
  void i18n.changeLanguage("zh-CN");
});

describe("Shell docDeleted wiring (Stage 8 §8)", () => {
  it("exposes stable pane/navigation identifiers through locale, theme and density changes", async () => {
    await boot(["d1"], "/doc/d1");
    const pane = document.querySelector('[data-ui="workspace-pane"]');
    expect(pane?.getAttribute("data-ui-key")).toBe("1");
    const nav = document.querySelector('[data-ui="navigate-view"][data-ui-key="library"]') as HTMLButtonElement;
    expect(nav).toBeTruthy();
    fireEvent.click(document.querySelector('[data-ui="open-tweaks"]') as HTMLElement);
    fireEvent.click(document.querySelector('[data-ui="language-option"][data-ui-key="en"]') as HTMLElement);
    fireEvent.click(document.querySelector('[data-ui="theme-option"][data-ui-key="light"]') as HTMLElement);
    fireEvent.click(document.querySelector('[data-ui="density-option"][data-ui-key="compact"]') as HTMLElement);
    expect(document.querySelector('[data-ui="navigate-view"][data-ui-key="library"]')).toBe(nav);
    expect(document.querySelector('[data-ui="workspace-pane"]')?.getAttribute("data-ui-key")).toBe("1");
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
