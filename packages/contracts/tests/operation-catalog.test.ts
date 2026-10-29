import { describe, expect, it } from "vitest";
import {
  LIBRARY_OPERATION_ACTIONS,
  OPERATION_CATALOG,
  operationCliGroups,
  operationCliName,
  operationDomains,
  operationOptionFlag,
  operationOptions,
  operationsOfCliGroup,
  operationsOfDomain,
  parseCatalogCall,
  READER_OPERATION_ACTIONS,
  WorkspaceViewActionSchema,
} from "../src/index.js";

describe("operation catalog (ADR 0015)", () => {
  it("has unique ids, a Copilot action for each library entry, and the declared metadata", () => {
    const ids = OPERATION_CATALOG.map((op) => op.id);
    expect(new Set(ids).size).toBe(ids.length);
    // `library.open_work` is the CLI's navigation verb; the Copilot has `select_work` (an interface action) for it.
    for (const op of operationsOfDomain("library").filter((entry) => !entry.navigates))
      expect(LIBRARY_OPERATION_ACTIONS as readonly string[]).toContain(op.name);
    expect(operationDomains()).toContain("library");
    expect(operationDomains()).toContain("discovery");
    expect(operationsOfDomain("discovery").map((op) => op.id)).toEqual([
      "discovery.search_ads",
      "discovery.explore",
    ]);
    // The Copilot carries search_ads as an action of the library tool; the interface actions of the explore page are not cataloged.
    expect(LIBRARY_OPERATION_ACTIONS as readonly string[]).toContain("search_ads");
    for (const ui of [
      "filter_discovery",
      "set_discovery_tab",
      "select_candidate",
      "read_discovery",
      "save_candidate",
    ])
      expect(ids).not.toContain(`discovery.${ui}`);
    const read = OPERATION_CATALOG.find((op) => op.id === "library.read");
    const write = OPERATION_CATALOG.find((op) => op.id === "library.set_main_doc");
    expect([read?.effect, read?.confirm, read?.navigates]).toEqual(["read", "none", false]);
    expect([write?.effect, write?.confirm, write?.navigates]).toEqual(["write", "none", false]);
  });

  it("lists the three navigation operations under the CLI group `open`, and nothing else there", () => {
    const navigation = OPERATION_CATALOG.filter((op) => op.navigates);
    expect(navigation.map((op) => [op.id, op.cli?.group, op.cli?.name])).toEqual([
      ["workspace.open_doc", "open", "doc"],
      ["library.open_work", "open", "work"],
      ["argument.open", "open", "argument-graph"],
    ]);
    for (const op of navigation) expect([op.effect, op.confirm]).toEqual(["read", "none"]);
    expect(operationsOfCliGroup("open").map((op) => op.id)).toEqual(navigation.map((op) => op.id));
    expect(operationCliGroups()).toContain("open");
    // Only navigation entries and the annotation writes (ticket 07, group `annotation`) override the derived placement.
    for (const op of OPERATION_CATALOG.filter((entry) => !entry.navigates))
      if (op.cli) expect(op.cli.group).toBe("annotation");
    // anchor is the CLI-only addition to the Copilot's open_doc; the Copilot action itself takes docId only.
    expect(
      parseCatalogCall("workspace", { action: "open_doc", docId: "d", anchor: "sec-1" })
    ).toMatchObject({ match: true, success: true });
    expect(
      WorkspaceViewActionSchema.safeParse({ action: "open_doc", docId: "d", anchor: "x" }).success
    ).toBe(false);
  });

  it("derives CLI names and option flags", () => {
    expect(operationCliName("set_main_doc")).toBe("set-main-doc");
    expect(operationOptionFlag("expectedMainDocId")).toBe("--expected-main-doc-id");
  });

  it("maps flat parameters to options", () => {
    const read = OPERATION_CATALOG[0];
    expect(operationOptions(read).map((o) => [o.flag, o.kind, o.required])).toEqual([
      ["--query", "string", false],
      ["--ref-id", "string", false],
      ["--offset", "integer", false],
      ["--limit", "integer", false],
      ["--links", "boolean", false],
    ]);
    const set = operationOptions(OPERATION_CATALOG[1]);
    expect(set.map((o) => [o.flag, o.required, o.nullable])).toEqual([
      ["--ref-id", true, false],
      ["--doc-id", true, false],
      ["--expected-main-doc-id", true, true],
    ]);
    expect(operationOptions(read).find((o) => o.param === "limit")).toMatchObject({
      min: 1,
      max: 200,
    });
  });

  it("search_ads: flat CLI options, bounded limit, validated fields, strict", () => {
    const search = OPERATION_CATALOG.find((op) => op.id === "discovery.search_ads");
    expect(search && [search.effect, search.confirm, search.navigates]).toEqual([
      "read",
      "none",
      false,
    ]);
    expect(search && operationOptions(search).map((o) => [o.flag, o.kind, o.required])).toEqual([
      ["--query", "string", true],
      ["--limit", "integer", false],
      ["--fields", "string", false],
    ]);
    const call = (extra: Record<string, unknown>) =>
      parseCatalogCall("discovery", { action: "search_ads", ...extra });
    expect(call({ query: "black holes" })).toMatchObject({ match: true, success: true });
    expect(call({ query: "x", limit: 50, fields: "title, abstract,arxiv_id" })).toMatchObject({
      success: true,
    });
    for (const bad of [
      {},
      { query: "" },
      { query: "x", limit: 51 },
      { query: "x", limit: 0 },
      { query: "x", fields: "title,password" },
      { query: "x", fields: "" },
      { query: "x", token: "t" },
      { query: "x", url: "https://example.org" },
    ])
      expect(call(bad), JSON.stringify(bad)).toMatchObject({ match: true, success: false });
    expect(parseCatalogCall("library", { action: "search_ads", query: "x" })).toEqual({
      match: false,
    });
  });

  it("parses a Copilot call against the entry and rejects what the action schema rejected", () => {
    const ok = parseCatalogCall("library", { action: "read", query: "x", limit: 5 });
    expect(ok).toMatchObject({ match: true, success: true, params: { query: "x", limit: 5 } });
    const strict = parseCatalogCall("library", { action: "read", extra: 1 });
    expect(strict).toMatchObject({ match: true, success: false });
    const missing = parseCatalogCall("library", { action: "set_main_doc", refId: "a" });
    expect(missing.match && !missing.success && missing.issues.map((i) => i.path)).toEqual([
      "docId",
      "expectedMainDocId",
    ]);
    expect(parseCatalogCall("library", { action: "import_works" })).toEqual({ match: false });
    // the Reader's view actions are interface actions: not cataloged
    expect(parseCatalogCall("reader", { action: "navigate", docId: "d", anchor: "a" })).toEqual({
      match: false,
    });
    expect(parseCatalogCall("reader", { action: "undo_pdf_annotation" })).toEqual({
      match: false,
    });
  });

  it("reading and annotation entries (ticket 07): what is cataloged, where the CLI puts it", () => {
    const reader = operationsOfDomain("reader");
    expect(
      reader.map((op) => [op.id, op.effect, op.cli ? `${op.cli.group} ${op.cli.name}` : null])
    ).toEqual([
      ["reader.read", "read", null],
      ["reader.read_image", "read", null],
      ["reader.read_svg_image", "read", null],
      ["reader.read_page_image", "read", null],
      ["reader.create_annotation", "write", "annotation create"],
      ["reader.update_annotation", "write", "annotation update"],
      ["reader.delete_annotation", "write", "annotation delete"],
      ["reader.create_pdf_annotation", "write", "annotation create-pdf"],
      ["reader.update_pdf_annotation", "write", "annotation update-pdf"],
      ["reader.delete_pdf_annotation", "write", "annotation delete-pdf"],
    ]);
    expect(operationsOfDomain("text").map((op) => op.id)).toEqual(["text.read_source"]);
    expect(operationCliGroups()).toEqual(expect.arrayContaining(["reader", "annotation", "text"]));
    // none asks a card (a single annotation is deleted at once, as the trash button does) and none navigates
    for (const op of [...reader, ...operationsOfDomain("text")])
      expect([op.confirm, op.navigates]).toEqual(["none", false]);
    // interface actions and the conversation-bound undo history are not operations
    const ids = OPERATION_CATALOG.map((op) => op.id as string);
    for (const ui of [
      "navigate",
      "jump_back",
      "set_panel",
      "set_right_tab",
      "retry_sync",
      "set_text_view",
      "goto_page",
      "zoom",
      "search",
      "download_original",
      "undo_pdf_annotation",
      "redo_pdf_annotation",
    ])
      expect(ids).not.toContain(`reader.${ui}`);
    // every write is a Copilot action of the same name, with the same parameters
    for (const op of reader)
      expect(READER_OPERATION_ACTIONS as readonly string[]).toContain(op.name);
  });

  it("nested annotation parameters are CLI options that take JSON text, the flat ones stay flat", () => {
    const create = OPERATION_CATALOG.find((op) => op.id === "reader.create_annotation");
    expect(create && operationOptions(create).map((o) => [o.flag, o.kind])).toEqual([
      ["--doc-id", "string"],
      ["--fingerprint", "string"],
      ["--rev", "integer"],
      ["--target", "json"],
      ["--body", "string"],
    ]);
    const createPdf = OPERATION_CATALOG.find((op) => op.id === "reader.create_pdf_annotation");
    expect(createPdf && operationOptions(createPdf).map((o) => [o.flag, o.kind])).toEqual([
      ["--doc-id", "string"],
      ["--sha256", "string"],
      ["--rev", "integer"],
      ["--kind", "enum"],
      ["--body", "string"],
      ["--page-index", "integer"],
      ["--rectangle", "json"],
      ["--style", "json"],
      ["--parts", "json"],
      ["--color", "enum"],
    ]);
    for (const op of OPERATION_CATALOG) expect(() => operationOptions(op), op.id).not.toThrow();
  });

  it("the annotation writes keep the refinements of the Copilot actions", () => {
    const epoch = { docId: "d", sha256: "a".repeat(64), rev: 0 };
    const call = (extra: Record<string, unknown>) =>
      parseCatalogCall("reader", { action: "create_pdf_annotation", ...epoch, ...extra });
    expect(call({ kind: "page_comment", body: "b", pageIndex: 0 })).toMatchObject({
      success: true,
    });
    for (const bad of [
      { kind: "page_comment", body: "b" },
      { kind: "document_comment", body: "b", pageIndex: 0 },
      { kind: "rectangle", body: "b", pageIndex: 0 },
      {
        kind: "highlight",
        body: "b",
        parts: [
          { pageIndex: 1, quote: "q" },
          { pageIndex: 0, quote: "q" },
        ],
      },
      { kind: "page_comment", body: "  ", pageIndex: 0 },
    ])
      expect(call(bad), JSON.stringify(bad)).toMatchObject({ match: true, success: false });
    const update = (extra: Record<string, unknown>) =>
      parseCatalogCall("reader", {
        action: "update_pdf_annotation",
        ...epoch,
        annotationId: "a_0000aaaa",
        expectedUpdatedAt: "2026-09-10T10:00:00.000Z",
        ...extra,
      });
    expect(update({})).toMatchObject({ match: true, success: false });
    expect(update({ body: "x" })).toMatchObject({ success: true });
    // the text annotation target is validated as the Copilot's is
    const text = parseCatalogCall("reader", {
      action: "create_annotation",
      docId: "d",
      fingerprint: "f",
      rev: 0,
      target: { type: "text", block: "p-1", start: 0, end: 1 },
      body: "b",
    });
    expect(text).toMatchObject({ match: true, success: false });
  });
});
