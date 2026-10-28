import { describe, expect, it } from "vitest";
import {
  LIBRARY_OPERATION_ACTIONS,
  OPERATION_CATALOG,
  operationCliName,
  operationDomains,
  operationOptionFlag,
  operationOptions,
  operationsOfDomain,
  parseCatalogCall,
} from "../src/index.js";

describe("operation catalog (ADR 0015)", () => {
  it("has unique ids, a Copilot action for each library entry, and the declared metadata", () => {
    const ids = OPERATION_CATALOG.map((op) => op.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const op of operationsOfDomain("library"))
      expect(LIBRARY_OPERATION_ACTIONS as readonly string[]).toContain(op.name);
    expect(operationDomains()).toEqual(["library", "discovery"]);
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
    expect(parseCatalogCall("reader", { action: "read" })).toEqual({ match: false });
  });
});
