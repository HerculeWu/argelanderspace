import { describe, expect, it } from "vitest";
import {
  CopilotConfirmationDecisionSchema,
  CopilotConfirmationSchema,
  CopilotOperationSchema,
  DocDeletedViewActionSchema,
  LIBRARY_OPERATION_ACTIONS,
  LibraryAcquireArxivPdfSchema,
  LibraryAttachArxivSchema,
  LibraryAttachLocalPdfSchema,
  LibraryDeleteDocSchema,
  LibraryImportWorksSchema,
  LibraryListAdsLibrariesSchema,
  LibraryReadAdsLibrarySchema,
  LibraryReadJobsSchema,
  LibraryReadOperationSchema,
  LibrarySetMainDocSchema,
  LibraryViewActionSchema,
  libraryBibcodeTokens,
  libraryImportRequest,
  libraryRefBibtex,
  libraryRefIdentityMatches,
  libraryRefMatches,
  libraryToolImportRequest,
  MANUAL_BIBCODES_MAX,
  ManualWorkRequestSchema,
  OperationConfirmationSchema,
  PageContextSchema,
  summarizeLibraryRef,
  WsCopilotViewActionSchema,
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

describe("import_works bibcode batch", () => {
  const op = (text: string) =>
    LibraryImportWorksSchema.parse({ action: "import_works", mode: "bibcode", text });
  it("splits a bibcode text on whitespace, commas and semicolons; one token stays the single import", () => {
    expect(libraryBibcodeTokens(" a,b;\n c\td ")).toEqual(["a", "b", "c", "d"]);
    expect(libraryToolImportRequest(op(" 2020A&A...641A...6P "))).toEqual({
      mode: "bibcode",
      bibcode: "2020A&A...641A...6P",
    });
    expect(libraryToolImportRequest(op("a b\nc"))).toEqual({
      mode: "bibcodes",
      bibcodes: ["a", "b", "c"],
    });
  });
  it("the import dialog's request never batches; the request schema caps a batch at the limit", () => {
    expect(libraryImportRequest(op("a b"))).toEqual({ mode: "bibcode", bibcode: "a b" });
    const many = (n: number) => Array.from({ length: n }, (_, i) => `b${i}`);
    expect(
      ManualWorkRequestSchema.safeParse({ mode: "bibcodes", bibcodes: many(MANUAL_BIBCODES_MAX) })
        .success
    ).toBe(true);
    expect(
      ManualWorkRequestSchema.safeParse({
        mode: "bibcodes",
        bibcodes: many(MANUAL_BIBCODES_MAX + 1),
      }).success
    ).toBe(false);
    expect(ManualWorkRequestSchema.safeParse({ mode: "bibcodes", bibcodes: [] }).success).toBe(
      false
    );
  });
  it("batch is accepted for bibcode and identifier, never for bib", () => {
    const parse = (mode: string, text: string) =>
      LibraryImportWorksSchema.safeParse({ action: "import_works", mode, text, batch: true })
        .success;
    expect(parse("bibcode", "2020A&A...641A...6P")).toBe(true);
    expect(parse("identifier", "arXiv:2105.00001")).toBe(true);
    expect(parse("bib", "@article{k,}")).toBe(false);
  });
  it("the tool's schema lets a text over the limit through (the call answers it as rejected) but not an over-long token", () => {
    const over = Array.from({ length: MANUAL_BIBCODES_MAX + 50 }, (_, i) => `b${i}`).join(" ");
    expect(
      LibraryImportWorksSchema.safeParse({ action: "import_works", mode: "bibcode", text: over })
        .success
    ).toBe(true);
    expect(
      LibraryImportWorksSchema.safeParse({
        action: "import_works",
        mode: "bibcode",
        text: `${"x".repeat(65)} b1`,
      }).success
    ).toBe(false);
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

  it("the acquisition actions take a work id and nothing else: no path, URL, file or bytes field exists", () => {
    expect(
      LibraryAcquireArxivPdfSchema.safeParse({ action: "acquire_arxiv_pdf", refId: "arxiv:2603.1" })
        .success
    ).toBe(true);
    expect(
      LibraryAttachArxivSchema.safeParse({ action: "attach_arxiv", refId: "arxiv:2603.1" }).success
    ).toBe(true);
    expect(LibraryReadJobsSchema.safeParse({ action: "read_jobs" }).success).toBe(true);
    expect(
      LibraryReadJobsSchema.safeParse({ action: "read_jobs", refId: "w", limit: 50 }).success
    ).toBe(true);
    for (const extra of [
      { path: "/etc/passwd" },
      { url: "https://x.example/a.pdf" },
      { file: "a.pdf" },
      { bytes: "AAAA" },
      { source: "zip" },
    ]) {
      expect(
        LibraryAcquireArxivPdfSchema.safeParse({
          action: "acquire_arxiv_pdf",
          refId: "w",
          ...extra,
        }).success
      ).toBe(false);
      expect(
        LibraryAttachArxivSchema.safeParse({ action: "attach_arxiv", refId: "w", ...extra }).success
      ).toBe(false);
      expect(LibraryReadJobsSchema.safeParse({ action: "read_jobs", ...extra }).success).toBe(
        false
      );
    }
    expect(LibraryAcquireArxivPdfSchema.safeParse({ action: "acquire_arxiv_pdf" }).success).toBe(
      false
    );
    expect(LibraryReadJobsSchema.safeParse({ action: "read_jobs", limit: 51 }).success).toBe(false);
    for (const action of ["acquire_arxiv_pdf", "attach_arxiv", "read_jobs"])
      expect(LIBRARY_OPERATION_ACTIONS).toContain(action);
  });

  it("attach_local_pdf takes a work id and an absolute-path string and nothing else", () => {
    const ok = { action: "attach_local_pdf", refId: "doi:10.1/a", path: "/home/u/a.pdf" };
    expect(LibraryAttachLocalPdfSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { action: "attach_local_pdf", refId: "w" },
      { action: "attach_local_pdf", path: "/a.pdf" },
      { ...ok, path: "" },
      { ...ok, path: "x".repeat(4097) },
      { ...ok, url: "https://x.example/a.pdf" },
      { ...ok, bytes: "AAAA" },
      { ...ok, docId: "pdf-1" },
    ])
      expect(LibraryAttachLocalPdfSchema.safeParse(bad).success).toBe(false);
    expect(LIBRARY_OPERATION_ACTIONS).toContain("attach_local_pdf");
    // The page's import menu still takes no path: only this action does.
    expect(
      LibraryImportWorksSchema.safeParse({
        action: "import_works",
        mode: "bib",
        text: "x",
        path: "/a",
      }).success
    ).toBe(false);
  });

  it("list_ads_libraries takes nothing; read_ads_library takes a slug id and a page, never a token or URL", () => {
    expect(LibraryListAdsLibrariesSchema.safeParse({ action: "list_ads_libraries" }).success).toBe(
      true
    );
    expect(
      LibraryListAdsLibrariesSchema.safeParse({ action: "list_ads_libraries", token: "x" }).success
    ).toBe(false);
    const ok = { action: "read_ads_library", libraryId: "abc_-9Z", offset: 200, limit: 200 };
    expect(LibraryReadAdsLibrarySchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { action: "read_ads_library" },
      { ...ok, libraryId: "../x" },
      { ...ok, libraryId: "a b" },
      { ...ok, libraryId: "" },
      { ...ok, limit: 201 },
      { ...ok, offset: -1 },
      { ...ok, url: "https://api.adsabs.harvard.edu/v1/biblib/libraries" },
      { ...ok, token: "x" },
    ])
      expect(LibraryReadAdsLibrarySchema.safeParse(bad).success).toBe(false);
    for (const action of ["list_ads_libraries", "read_ads_library"])
      expect(LIBRARY_OPERATION_ACTIONS).toContain(action);
  });

  it("an operation record can carry the real job and Doc and a pending status; a confirmation decision can name the refresh", () => {
    expect(
      CopilotOperationSchema.safeParse({
        id: "c1",
        tool: "library",
        action: "attach_arxiv",
        status: "pending",
        job: { id: "ingest-1", status: "running" },
      }).success
    ).toBe(true);
    expect(
      CopilotOperationSchema.safeParse({
        id: "c1",
        tool: "library",
        action: "acquire_arxiv_pdf",
        status: "ok",
        job: { id: "upload-1", status: "done" },
        docId: "pdf-1",
      }).success
    ).toBe(true);
    expect(
      CopilotOperationSchema.safeParse({
        id: "c1",
        tool: "library",
        action: "attach_arxiv",
        status: "ok",
        job: { id: "x", status: "finished" },
      }).success
    ).toBe(false);
    const decision = {
      decision: "approve",
      viewId: "00000000-0000-4000-8000-000000000001",
      objectId: "arxiv-2603.1",
      baseRev: 3,
    };
    expect(
      CopilotConfirmationDecisionSchema.safeParse({ ...decision, action: "refresh_arxiv_source" })
        .success
    ).toBe(true);
    expect(
      CopilotConfirmationDecisionSchema.safeParse({ ...decision, action: "attach_arxiv" }).success
    ).toBe(false);
  });

  it("a durable confirmation record is discriminated by action: delete_plan needs a plan, a refresh needs a Work and a Doc", () => {
    const base = {
      version: 1,
      phase: "requested",
      confirmationId: "00000000-0000-4000-8000-000000000001",
      runId: "00000000-0000-4000-8000-000000000002",
      toolCallId: "call_1",
      baseRev: 0,
    };
    expect(
      OperationConfirmationSchema.safeParse({
        ...base,
        action: "delete_plan",
        planId: "p_0000000a",
      }).success
    ).toBe(true);
    expect(OperationConfirmationSchema.safeParse({ ...base, action: "delete_plan" }).success).toBe(
      false
    );
    expect(
      OperationConfirmationSchema.safeParse({
        ...base,
        action: "delete_plan",
        planId: "p",
        docId: "d",
      }).success
    ).toBe(false);
    expect(
      OperationConfirmationSchema.safeParse({
        ...base,
        action: "refresh_arxiv_source",
        workId: "w",
        docId: "d",
      }).success
    ).toBe(true);
    expect(
      OperationConfirmationSchema.safeParse({
        ...base,
        action: "refresh_arxiv_source",
        workId: "w",
      }).success
    ).toBe(false);
  });
});

describe("Doc deletion (copilot ticket 16)", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const card = {
    id,
    runId: "00000000-0000-4000-8000-000000000002",
    toolCallId: "c",
    baseRev: 3,
    action: "delete_doc",
    object: { kind: "doc", id: "arxiv-2603.1" },
    format: "latex",
    works: [{ id: "w1", title: "T", main: true, remaining: 1 }],
    impact: { annotations: "known", count: 2 },
    objectDigest: "d",
  };
  it("delete_doc takes a Doc id and nothing else (no path, no work, no unlink variant)", () => {
    expect(LibraryDeleteDocSchema.safeParse({ action: "delete_doc", docId: "d" }).success).toBe(
      true
    );
    for (const bad of [
      { action: "delete_doc" },
      { action: "delete_doc", docId: "" },
      { action: "delete_doc", docId: "d", refId: "w" },
      { action: "delete_doc", docId: "d", path: "/etc" },
      { action: "unlink_doc", docId: "d", refId: "w" },
    ])
      expect(LibraryDeleteDocSchema.safeParse(bad).success).toBe(false);
    expect(LIBRARY_OPERATION_ACTIONS).toContain("delete_doc");
    expect(LIBRARY_OPERATION_ACTIONS).not.toContain("unlink_doc");
  });
  it("its card names every work, shows an unknown count as unknown, and is bound in the decision and the record", () => {
    expect(CopilotConfirmationSchema.safeParse(card).success).toBe(true);
    expect(
      CopilotConfirmationSchema.safeParse({ ...card, impact: { annotations: "unknown" } }).success
    ).toBe(true);
    expect(
      CopilotConfirmationSchema.safeParse({ ...card, impact: { annotations: "unknown", count: 0 } })
        .success
    ).toBe(false);
    expect(CopilotConfirmationSchema.safeParse({ ...card, approved: true }).success).toBe(false);
    expect(
      CopilotConfirmationDecisionSchema.safeParse({
        decision: "approve",
        viewId: id,
        action: "delete_doc",
        objectId: "arxiv-2603.1",
        baseRev: 3,
      }).success
    ).toBe(true);
    const record = {
      version: 1,
      phase: "requested",
      confirmationId: id,
      runId: card.runId,
      toolCallId: "c",
      baseRev: 3,
      action: "delete_doc",
      docId: "arxiv-2603.1",
    };
    expect(OperationConfirmationSchema.safeParse(record).success).toBe(true);
    expect(OperationConfirmationSchema.safeParse({ ...record, docId: undefined }).success).toBe(
      false
    );
  });
  it("the shell update is a service-to-view action that no tool schema accepts", () => {
    const action = { action: "doc_deleted", docId: "d", remaining: ["x"] };
    expect(DocDeletedViewActionSchema.safeParse(action).success).toBe(true);
    expect(DocDeletedViewActionSchema.safeParse({ ...action, extra: 1 }).success).toBe(false);
    expect(LibraryViewActionSchema.safeParse(action).success).toBe(false);
    expect(LIBRARY_OPERATION_ACTIONS).not.toContain("doc_deleted");
    expect(
      WsCopilotViewActionSchema.safeParse({
        type: "copilot.view-action",
        viewId: id,
        actionId: "00000000-0000-4000-8000-000000000003",
        action,
      }).success
    ).toBe(true);
    expect(
      CopilotOperationSchema.safeParse({
        id: "c",
        tool: "library",
        action: "delete_doc",
        status: "ok",
        object: { kind: "doc", id: "d" },
      }).success
    ).toBe(true);
  });
});
