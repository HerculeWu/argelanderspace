import { describe, expect, it } from "vitest";
import {
  ARGUMENT_TOOL_ACTIONS,
  ARGUMENT_TOOL_WRITE_ACTIONS,
  LIBRARY_OPERATION_ACTIONS,
  LibraryImportWorksParamsSchema,
  LibraryImportWorksSchema,
  OPERATION_CATALOG,
  operationCliGroups,
  operationCliName,
  operationDomains,
  operationJsonOnlyParams,
  operationOptionFlag,
  operationOptions,
  operationsOfCliGroup,
  operationsOfDomain,
  parseCatalogCall,
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
    // Only navigation entries override the derived placement.
    for (const op of OPERATION_CATALOG.filter((entry) => !entry.navigates))
      expect(op.cli).toBeUndefined();
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
    expect(parseCatalogCall("library", { action: "import_works" })).toMatchObject({
      match: true,
      success: false,
    });
    expect(parseCatalogCall("library", { action: "filter_library", query: "x" })).toEqual({
      match: false,
    });
    expect(parseCatalogCall("reader", { action: "read" })).toEqual({ match: false });
  });

  it("catalogs every library business action of the Copilot tool, and none of its interface actions", () => {
    const names = operationsOfDomain("library").map((op) => op.name);
    for (const business of [
      "read",
      "set_main_doc",
      "import_works",
      "attach_local_pdf",
      "list_ads_libraries",
      "read_ads_library",
      "acquire_arxiv_pdf",
      "attach_arxiv",
      "read_jobs",
      "delete_doc",
    ])
      expect(names, business).toContain(business);
    for (const ui of [
      "filter_library",
      "select_work",
      "set_detail_tab",
      "set_sidebar",
      "set_temp_label",
      "save_candidate",
    ])
      expect(names, ui).not.toContain(ui);
    const meta = (id: string) => {
      const op = OPERATION_CATALOG.find((entry) => entry.id === id);
      return op && [op.effect, op.confirm, op.navigates];
    };
    expect(meta("library.import_works")).toEqual(["write", "none", false]);
    expect(meta("library.attach_local_pdf")).toEqual(["write", "none", false]);
    expect(meta("library.acquire_arxiv_pdf")).toEqual(["write", "none", false]);
    expect(meta("library.attach_arxiv")).toEqual(["write", "conditional", false]);
    expect(meta("library.list_ads_libraries")).toEqual(["read", "none", false]);
    expect(meta("library.read_ads_library")).toEqual(["read", "none", false]);
    expect(meta("library.read_jobs")).toEqual(["read", "none", false]);
  });

  it("import_works: the catalog parameters keep the action schema's cross-field rules and map to flat options", () => {
    const op = OPERATION_CATALOG.find((entry) => entry.id === "library.import_works");
    expect(op && operationOptions(op).map((o) => [o.flag, o.kind, o.required])).toEqual([
      ["--mode", "enum", true],
      ["--text", "string", true],
      ["--batch", "boolean", false],
    ]);
    const call = (extra: Record<string, unknown>) =>
      parseCatalogCall("library", { action: "import_works", ...extra });
    expect(call({ mode: "bibcode", text: "2020ApJ...900....1H" })).toMatchObject({ success: true });
    expect(call({ mode: "bibcode", text: " , ; " })).toMatchObject({ success: false });
    expect(call({ mode: "bib", text: "@article{a,}", batch: true })).toMatchObject({
      success: false,
    });
    // More than the batch limit is the operation's own `rejected` answer, not a malformed call.
    const many = Array.from(
      { length: 201 },
      (_, i) => `2020ApJ...900.${String(i).padStart(4, "0")}H`
    );
    expect(call({ mode: "bibcode", text: many.join(" ") })).toMatchObject({ success: true });
    // The action schema is built from the same fields and the same check.
    expect(
      LibraryImportWorksSchema.safeParse({ action: "import_works", mode: "bibcode", text: " " })
        .success
    ).toBe(false);
    expect(LibraryImportWorksParamsSchema.safeParse({ mode: "bibcode", text: " " }).success).toBe(
      false
    );
    expect(
      LibraryImportWorksSchema.safeParse({
        action: "import_works",
        mode: "bib",
        text: "x",
        batch: true,
      }).success
    ).toBe(false);
  });

  it("argument entries: the Copilot tool's business actions, parameters from the one action schema, no interface actions", () => {
    const entries = operationsOfDomain("argument");
    expect(entries.map((op) => op.name)).toEqual([
      "open",
      "read",
      "create",
      "update",
      "delete",
      "undo_delete",
      "add_edge",
      "remove_edge",
      "replace",
      "clear",
    ]);
    // the Copilot actions that are not business operations stay out
    for (const out of ["select", "exit", "guide"])
      expect(entries.map((op) => op.name)).not.toContain(out);
    // every entry other than the navigation one is a tool action, and the writes are the tool's write actions
    for (const op of entries.filter((entry) => !entry.navigates))
      expect(ARGUMENT_TOOL_ACTIONS as readonly string[]).toContain(op.name);
    expect(entries.filter((op) => op.effect === "write").map((op) => op.name)).toEqual([
      ...ARGUMENT_TOOL_WRITE_ACTIONS,
    ]);
    // only replace and clear may wait for a card (when the graph has arguments)
    expect(
      entries.filter((op) => op.confirm !== "none").map((op) => [op.name, op.confirm])
    ).toEqual([
      ["replace", "conditional"],
      ["clear", "conditional"],
    ]);
    // the CLI group is the domain, so they sit next to the frozen `argument get` / `put`; `open` goes to `open`
    expect(operationsOfCliGroup("argument").map((op) => op.name)).toEqual(
      entries.filter((op) => !op.navigates).map((op) => op.name)
    );
    for (const frozen of ["get", "put"])
      expect(operationsOfCliGroup("argument").map((op) => operationCliName(op.name))).not.toContain(
        frozen
      );
    // a Copilot call parses to the same parameters the CLI validates
    expect(
      parseCatalogCall("argument", {
        action: "add_edge",
        workId: "w",
        expectedRev: 3,
        from: "a",
        to: "b",
        role: "grounds",
      })
    ).toMatchObject({
      match: true,
      success: true,
      params: { workId: "w", expectedRev: 3, role: "grounds" },
    });
    expect(parseCatalogCall("argument", { action: "read", workId: "w", extra: 1 })).toMatchObject({
      match: true,
      success: false,
    });
    expect(parseCatalogCall("argument", { action: "select", workId: "w" })).toEqual({
      match: false,
    });
  });

  it("flat parameters become options; array and object parameters are --json only", () => {
    const by = (name: string) => entry(`argument.${name}`);
    expect(operationOptions(by("add_edge")).map((o) => [o.flag, o.kind])).toEqual([
      ["--work-id", "string"],
      ["--expected-rev", "integer"],
      ["--from", "string"],
      ["--to", "string"],
      ["--role", "enum"],
    ]);
    expect(operationJsonOnlyParams(by("add_edge"))).toEqual([]);
    expect(operationJsonOnlyParams(by("create"))).toEqual(["argument"]);
    expect(operationJsonOnlyParams(by("update"))).toEqual(["patch"]);
    expect(operationJsonOnlyParams(by("replace"))).toEqual(["graph"]);
    expect(operationJsonOnlyParams(by("read"))).toEqual(["ids"]);
    expect(operationOptions(by("read")).map((o) => o.flag)).toEqual([
      "--work-id",
      "--offset",
      "--edge-offset",
      "--field",
    ]);
  });
});

function entry(id: string) {
  const found = OPERATION_CATALOG.find((op) => op.id === id);
  if (!found) throw new Error(`no catalog entry ${id}`);
  return found;
}
