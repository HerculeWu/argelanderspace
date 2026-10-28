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
