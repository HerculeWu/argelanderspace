/**
 * The Library's intake entries (project-intake ticket 06; approved prototype, ticket 05 review): the empty Library has
 * "Move in an existing project" in the middle of the graph area ("Continue the move-in" when the Project root holds the
 * checklist); a Library with works has only the "Import literature" menu's "Continue the move-in", and only when the
 * checklist exists — never a start entry; `unknown` (unreadable) is not "absent". The server's `intake.changed` updates
 * the page. The tutorial Project's Library has works and no checklist, so it shows neither.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Workspace, WorkspaceProvider } from "../src/argelander/workspace";
import i18n from "../src/i18n";
import { LibraryView } from "../src/library/LibraryView";
import type { LibraryData, LibraryRef } from "../src/library/types";
import { fakeBus } from "./fake-ws";

vi.mock("../src/api/ws", async () => (await import("./fake-ws")).wsModule());
vi.mock("../src/api/ws-instance", async () => ({ bus: (await import("./fake-ws")).fakeBus }));

const REF: LibraryRef = { id: "w1", title: "A Paper", authors: "Able", year: 2020, venue: "ApJ", type: "article", cite: "able2020", tags: [], pdf: false, read: false, star: false };
const FULL: LibraryData = { project: { name: "Test" }, refs: [REF], tags: [], graph: { nodes: [{ id: REF.cite, ref: REF.id, y: 2020, c: 1, a: "Able", v: "ApJ", t: REF.title }], links: [] } };
const EMPTY: LibraryData = { project: { name: "Test" }, refs: [], tags: [], graph: { nodes: [], links: [] } };

let checklist: "present" | "absent" | "unknown" | "unanswered" | "broken";
let library: LibraryData;
const startIntake = vi.fn();
const workspace = (): Workspace => ({ papers: [], currentDoc: null, setCurrentDoc: () => {}, openDoc: () => {}, pendingAnchor: null, clearPendingAnchor: () => {}, docDeleted: () => {}, startIntake, tweaks: { theme: "dark", accent: "azure", density: "regular", labels: true } });

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  startIntake.mockReset();
  checklist = "absent";
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/library") return { ok: true, json: async () => library } as Response;
    if (url === "/api/intake") {
      if (checklist === "broken") return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      if (checklist === "unanswered") return new Promise<Response>(() => {});
      return { ok: true, json: async () => ({ checklist }) } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const mount = () => render(<WorkspaceProvider value={workspace()}><LibraryView /></WorkspaceProvider>);
const menuOptions = () => [...document.querySelectorAll<HTMLElement>('[data-ui="import-option"]')].map((node) => node.getAttribute("data-ui-key"));
const openMenu = async () => { await screen.findByText("A Paper", { selector: ".side-ref-title" }); fireEvent.click(document.querySelector('[data-ui="open-import-menu"]')!); };

describe("an empty Library", () => {
  beforeEach(() => { library = EMPTY; });

  it("shows the start entry in the graph area when there is no checklist, and a click asks for a fresh move-in", async () => {
    mount();
    const entry = await waitFor(() => { const found = document.querySelector<HTMLElement>('[data-ui="start-intake"]'); expect(found).not.toBeNull(); return found!; });
    expect(document.querySelector('[data-ui="library-empty"]')?.parentElement?.getAttribute("data-ui")).toBe("library-graph-area");
    expect(entry.getAttribute("data-ui-key")).toBe("start");
    expect(entry.textContent).toBe("迁入已有项目");
    expect(document.querySelector('[data-ui="library-empty"] h2')?.textContent).toBe("文献库还是空的");
    fireEvent.click(entry);
    expect(startIntake).toHaveBeenCalledExactlyOnceWith("start");
  });

  it("says Continue when the Project root holds the checklist, in the import menu too, and a click asks to resume", async () => {
    checklist = "present";
    mount();
    const entry = await waitFor(() => { const found = document.querySelector<HTMLElement>('[data-ui="start-intake"][data-ui-key="resume"]'); expect(found).not.toBeNull(); return found!; });
    expect(entry.textContent).toBe("继续迁入");
    expect(document.querySelector('[data-ui="library-empty"] p')?.textContent).toContain("迁入清单");
    fireEvent.click(entry);
    expect(startIntake).toHaveBeenCalledExactlyOnceWith("resume");
    fireEvent.click(document.querySelector('[data-ui="open-import-menu"]')!);
    expect(menuOptions()).toEqual(["identifier", "bibcode", "bib", "shelf", "intake"]);
  });

  it("offers no entry before the checklist question is answered, and the start entry when it is unknown (not read as absent, not as present)", async () => {
    checklist = "unanswered";
    mount();
    await screen.findByText("文献库还是空的");
    expect(document.querySelector('[data-ui="start-intake"]')).toBeNull();
    cleanup();
    checklist = "unknown";
    mount();
    const entry = await waitFor(() => { const found = document.querySelector<HTMLElement>('[data-ui="start-intake"]'); expect(found).not.toBeNull(); return found!; });
    expect(entry.getAttribute("data-ui-key")).toBe("start");
    fireEvent.click(document.querySelector('[data-ui="open-import-menu"]')!);
    expect(menuOptions()).toEqual(["identifier", "bibcode", "bib", "shelf"]);
    cleanup();
    checklist = "broken";
    mount();
    await waitFor(() => expect(document.querySelector('[data-ui="start-intake"]')?.getAttribute("data-ui-key")).toBe("start"));
  });

  it("follows the server: the checklist appearing turns Start into Continue, going turns it back", async () => {
    mount();
    await waitFor(() => expect(document.querySelector('[data-ui="start-intake"]')?.getAttribute("data-ui-key")).toBe("start"));
    checklist = "present";
    act(() => fakeBus.emit("intake.changed", { at: "2026-10-27T00:00:00Z" }));
    await waitFor(() => expect(document.querySelector('[data-ui="start-intake"]')?.getAttribute("data-ui-key")).toBe("resume"));
    checklist = "absent";
    act(() => fakeBus.emit("intake.changed", { at: "2026-10-27T00:00:01Z" }));
    await waitFor(() => expect(document.querySelector('[data-ui="start-intake"]')?.getAttribute("data-ui-key")).toBe("start"));
  });

  it("has the English copy", async () => {
    await i18n.changeLanguage("en");
    mount();
    expect((await screen.findByText("Move in an existing project")).getAttribute("data-ui")).toBe("start-intake");
    expect(screen.getByText("The library is empty")).toBeTruthy();
  });
});

describe("a Library with works", () => {
  beforeEach(() => { library = FULL; });

  it("has no empty-state entry and, without a checklist, no intake item in the import menu (the tutorial Project is this case)", async () => {
    mount();
    await openMenu();
    expect(document.querySelector('[data-ui="library-empty"]')).toBeNull();
    expect(document.querySelector('[data-ui="start-intake"]')).toBeNull();
    expect(menuOptions()).toEqual(["identifier", "bibcode", "bib", "shelf"]);
  });

  it("puts Continue last in the import menu when the checklist exists, whatever it says inside; a click closes the menu and asks to resume", async () => {
    checklist = "present";
    mount();
    await screen.findByText("A Paper", { selector: ".side-ref-title" });
    await waitFor(() => { fireEvent.click(document.querySelector('[data-ui="open-import-menu"]')!); expect(menuOptions()).toContain("intake"); });
    expect(menuOptions()).toEqual(["identifier", "bibcode", "bib", "shelf", "intake"]);
    const item = document.querySelector<HTMLElement>('[data-ui="import-option"][data-ui-key="intake"]')!;
    expect(item.textContent).toContain("继续迁入");
    fireEvent.click(item);
    expect(startIntake).toHaveBeenCalledExactlyOnceWith("resume");
    expect(document.querySelector('[data-ui="import-menu"]')).toBeNull();
    // no strip beside the menu: the entry is the menu item alone
    expect(document.querySelector('[data-ui="intake-resume-strip"]')).toBeNull();
  });

  it("shows nothing for an unreadable checklist (it is not known to exist)", async () => {
    checklist = "unknown";
    mount();
    await openMenu();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(menuOptions()).toEqual(["identifier", "bibcode", "bib", "shelf"]);
  });
});
