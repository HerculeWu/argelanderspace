import { describe, expect, it } from "vitest";
import {
  LIBRARY_OPERATION_ACTIONS,
  LibraryImportWorksSchema,
  LibraryReadOperationSchema,
  LibrarySetMainDocSchema,
  LibraryViewActionSchema,
  libraryImportRequest,
  libraryRefBibtex,
  libraryRefIdentityMatches,
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

describe("import_works operation", () => {
  it("accepts exactly the three import-dialog inputs, as text, and maps to the dialog's request", () => {
    const ok = (op: object) => LibraryImportWorksSchema.safeParse(op).success;
    expect(ok({ action: "import_works", mode: "identifier", text: "arXiv:2603.03522" })).toBe(true);
    expect(ok({ action: "import_works", mode: "bibcode", text: "2020A&A...641A...6P" })).toBe(true);
    expect(ok({ action: "import_works", mode: "bib", text: "@article{k, title={T}}" })).toBe(true);
    const op = LibraryImportWorksSchema.parse({
      action: "import_works",
      mode: "identifier",
      text: " 10.1/x ",
    });
    expect(libraryImportRequest(op)).toEqual({ mode: "identifier", value: "10.1/x" });
  });

  it("rejects local paths, urls-to-fetch fields, unknown modes, empty and oversized input", () => {
    const bad = (op: object) => LibraryImportWorksSchema.safeParse(op).success;
    expect(bad({ action: "import_works", mode: "file", text: "x" })).toBe(false);
    expect(bad({ action: "import_works", mode: "bib", path: "/etc/passwd" })).toBe(false);
    expect(bad({ action: "import_works", mode: "bib", text: "x", path: "/tmp/a.bib" })).toBe(false);
    expect(bad({ action: "import_works", mode: "identifier", text: "   " })).toBe(false);
    expect(bad({ action: "import_works", mode: "identifier", text: "x".repeat(501) })).toBe(false);
    expect(bad({ action: "import_works", mode: "bibcode", text: "x".repeat(65) })).toBe(false);
    expect(bad({ action: "import_works", mode: "bib", text: "x".repeat(1_000_001) })).toBe(false);
    expect(LIBRARY_OPERATION_ACTIONS).toContain("import_works");
  });
});

describe("identity query for read", () => {
  const stub = { id: "arxiv:2603.99999", arxiv_id: "2603.99999" };
  const full = {
    id: "doi:10.1093/mnras/staa9999",
    doi: "10.1093/mnras/staa9999",
    bibcode: "2020MNRAS.499.1234X",
  };
  it("finds a titleless stub by the identifier it was imported with, in every spelling the import accepts", () => {
    for (const q of [
      "arXiv:2603.99999",
      "https://arxiv.org/abs/2603.99999",
      "arxiv:2603.99999v2",
      "2603.99999",
      "arxiv:2603.99999",
    ])
      expect(libraryRefIdentityMatches(stub, q), q).toBe(true);
    for (const q of [
      "10.1093/mnras/staa9999",
      "https://doi.org/10.1093/MNRAS/staa9999",
      "doi:10.1093/mnras/staa9999",
      "2020mnras.499.1234x",
    ])
      expect(libraryRefIdentityMatches(full, q), q).toBe(true);
  });
  it("is exact: other identifiers, fragments and the empty query do not match", () => {
    expect(libraryRefIdentityMatches(stub, "2603.9999")).toBe(false);
    expect(libraryRefIdentityMatches(stub, "arXiv:2603.99998")).toBe(false);
    expect(libraryRefIdentityMatches(full, "10.1093")).toBe(false);
    expect(libraryRefIdentityMatches(full, "")).toBe(false);
  });
});
