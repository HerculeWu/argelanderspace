import { describe, expect, it } from "vitest";
import {
  LIBRARY_OPERATION_ACTIONS,
  LibraryReadOperationSchema,
  LibrarySetMainDocSchema,
  LibraryViewActionSchema,
  libraryRefBibtex,
  libraryRefMatches,
  PageContextSchema,
  summarizeLibraryRef,
} from "../src/index.js";

const ref = {
  id: "doi:10.1/a",
  title: "Rotation invariant networks",
  authors: "Dieleman, Willett & Dambre",
  year: 2015,
  venue: "MNRAS",
  type: "article" as const,
  cite: "dieleman2015",
  tags: ["#CNN"],
  pdf: true,
  read: true,
  star: false,
  note: "private note",
  doc_id: "d1",
  doc_ids: ["d1", "d2"],
};
const base = {
  version: 1 as const,
  viewId: "11111111-1111-4111-8111-111111111111",
  revision: 1,
  paneId: 1,
  view: "library",
  otherPanes: [],
  plan: null,
};
const page = (source: "live" | "demo" | "error") => ({
  graph: { labelsOn: false },
  source,
  query: "",
  total: 1,
  matched: 1,
  refs: [summarizeLibraryRef(ref)],
  links: [],
  selectedRefId: null,
  detail: null,
  temporaryLabels: {},
  sidebarCollapsed: false,
});

describe("closed Library operation union", () => {
  it("accepts the UI-equivalent actions and nothing else", () => {
    expect(
      LibraryReadOperationSchema.safeParse({ action: "read", query: "rot", limit: 5 }).success
    ).toBe(true);
    expect(
      LibrarySetMainDocSchema.safeParse({
        action: "set_main_doc",
        refId: "a",
        docId: "d",
        expectedMainDocId: null,
      }).success
    ).toBe(true);
    for (const ok of [
      { action: "filter_library", query: "x" },
      { action: "select_work", refId: null },
      { action: "set_detail_tab", tab: "bib" },
      { action: "set_sidebar", collapsed: true },
      { action: "set_temp_label", refId: "a", label: "red" },
      { action: "set_temp_label", refId: "a", label: null },
      { action: "set_graph_labels", on: true },
      { action: "graph_control", control: "relayout" },
    ])
      expect(LibraryViewActionSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { action: "set_note", refId: "a", note: "x" },
      { action: "set_label", refId: "a", label: "red" },
      { action: "set_temp_label", refId: "a", label: "pink" },
      { action: "set_detail_tab", tab: "history" },
      { action: "graph_control", control: "drag" },
      { action: "graph_control", control: "zoom_in", x: 1 },
      { action: "select_work", refId: "a", path: "/etc/passwd" },
    ])
      expect(LibraryViewActionSchema.safeParse(bad).success).toBe(false);
    expect(
      LibrarySetMainDocSchema.safeParse({ action: "set_main_doc", refId: "a", docId: "d" }).success
    ).toBe(false);
    expect(LIBRARY_OPERATION_ACTIONS).not.toContain("set_note");
  });

  it("shares the list's search predicate and the BibTeX tab text", () => {
    expect(libraryRefMatches(ref, "")).toBe(true);
    expect(libraryRefMatches(ref, "ROTATION")).toBe(true);
    expect(libraryRefMatches(ref, "dieleman2015")).toBe(true);
    expect(libraryRefMatches(ref, "nothing")).toBe(false);
    expect(libraryRefBibtex(ref)).toContain("@article{dieleman2015,");
    expect(libraryRefBibtex(ref)).toContain("Dieleman, Willett and Dambre");
  });

  it("a list row never carries the note or abstract", () => {
    const summary = summarizeLibraryRef(ref);
    expect(summary).not.toHaveProperty("note");
    expect(summary.doc_ids).toEqual(["d1", "d2"]);
  });
});

describe("Library page coverage", () => {
  it("only a live library counts as complete; demo data is unavailable, not complete", () => {
    expect(
      PageContextSchema.safeParse({ ...base, status: "complete", library: page("live") }).success
    ).toBe(true);
    expect(
      PageContextSchema.safeParse({ ...base, status: "complete", library: page("demo") }).success
    ).toBe(false);
    expect(
      PageContextSchema.safeParse({ ...base, status: "unavailable", library: page("demo") }).success
    ).toBe(true);
    expect(
      PageContextSchema.safeParse({ ...base, status: "complete", library: null }).success
    ).toBe(false);
    expect(PageContextSchema.safeParse({ ...base, status: "error", library: null }).success).toBe(
      true
    );
  });
});
