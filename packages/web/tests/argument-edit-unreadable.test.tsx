/**
 * Ticket 05 fix round B: the graph file turns unreadable (or the Work disappears) while a draft is open. The panel and the
 * draft stay, Save is off with the reason in words, and when the file is readable again the draft is saveable (or in the
 * ordinary conflict flow when its argument was changed meanwhile). With no draft the page is the error state as before.
 */
import { type ArgumentGraph, ArgumentGraphSchema } from "@argelanderspace/contracts";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import { ArgumentGraphMode } from "../src/argument/ArgumentGraphMode";
import type { LibraryRef } from "../src/library/types";
import { ARGUMENT_FIXTURES } from "./fixtures/argument-graphs";
import { graphChanged } from "./fake-ws";

vi.mock("../src/api/ws", async () => (await import("./fake-ws")).wsModule());

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
const WORK_ID = "arxiv:0000.00001";
const WORK: LibraryRef = { id: WORK_ID, title: "合成星团论文", authors: "Zhang, Li & Wang", year: 2024, venue: "ApJ", type: "article", cite: "zhang2024", tags: [], pdf: false, read: false, star: false, doc_ids: [] };
let store: ArgumentGraph;
let mode: "ok" | "corrupt" | "404";
let puts: ArgumentGraph[];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  void i18n.changeLanguage("zh-CN");
  vi.stubGlobal("ResizeObserver", RO);
  store = ARGUMENT_FIXTURES.clean();
  mode = "ok";
  puts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).endsWith("/argument-graph")) return json(404, { detail: "no" });
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as ArgumentGraph;
        puts.push(body);
        if (mode === "404") return json(404, { detail: "no work" });
        if (mode === "corrupt") return json(500, { detail: "argument graph file is unreadable: x" });
        if (body.rev !== store.rev) return json(409, { detail: "rev mismatch", rev: store.rev });
        store = { ...ArgumentGraphSchema.parse(body), rev: store.rev + 1 };
        return json(200, store);
      }
      if (mode === "404") return json(404, { detail: "no work" });
      if (mode === "corrupt") return json(500, { detail: "argument graph file is unreadable: x" });
      return json(200, store);
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const q = <T extends HTMLElement = HTMLElement>(root: ParentNode, ui: string): T | null => root.querySelector<T>(`[data-ui="${ui}"]`);
const must = <T extends HTMLElement = HTMLElement>(root: ParentNode, ui: string): T => {
  const el = q<T>(root, ui);
  if (!el) throw new Error(`no [data-ui=${ui}]`);
  return el;
};
const phase = (c: HTMLElement) => must(c, "argument-graph-view").getAttribute("data-phase");
async function editing(title: string) {
  const { container: c } = render(<ArgumentGraphMode workId={WORK_ID} work={WORK} onExit={() => {}} onOpenDoc={() => {}} />);
  await waitFor(() => expect(phase(c)).toBe("ready"));
  fireEvent.click(c.querySelector('[data-ui="argument-outline-row"][data-ui-key="m2"]')!);
  await waitFor(() => expect(q(c, "argument-detail")).not.toBeNull());
  fireEvent.click(must(c, "edit-argument"));
  fireEvent.change(must(c, "argument-title-input"), { target: { value: title } });
  return c;
}
const refresh = async (to: typeof mode) => {
  mode = to;
  await act(async () => graphChanged(WORK_ID));
};

describe("a draft survives the file turning unreadable", () => {
  for (const [kind, expected] of [
    ["corrupt", "不可读"],
    ["404", "已不存在"],
  ] as const) {
    it(`${kind}: the panel and the draft stay, Save is off with the reason; when it is readable again the draft saves`, async () => {
      const c = await editing("写到一半");
      await refresh(kind);
      await waitFor(() => expect(q(c, "argument-save-unavailable")).not.toBeNull());
      expect(q(c, "argument-detail")).not.toBeNull();
      expect(must<HTMLInputElement>(c, "argument-title-input").value).toBe("写到一半");
      expect(must<HTMLButtonElement>(c, "save-argument").disabled).toBe(true);
      expect(must(c, "argument-save-unavailable").textContent).toContain(expected);
      // the leave guard still covers the draft
      expect(c.querySelector("[data-ui=argument-graph-corrupt], [data-ui=argument-graph-not-found]")).not.toBeNull();
      await refresh("ok");
      await waitFor(() => expect(q(c, "argument-save-unavailable")).toBeNull());
      expect(phase(c)).toBe("ready");
      expect(must<HTMLInputElement>(c, "argument-title-input").value).toBe("写到一半");
      expect(must<HTMLButtonElement>(c, "save-argument").disabled).toBe(false);
      await act(async () => fireEvent.click(must(c, "save-argument")));
      await waitFor(() => expect(store.arguments.find((a) => a.id === "m2")!.title).toBe("写到一半"));
    });
  }

  it("the argument was changed while the file was unreadable: on recovery it is the ordinary conflict, never an overwrite", async () => {
    const c = await editing("写到一半");
    await refresh("corrupt");
    await waitFor(() => expect(q(c, "argument-save-unavailable")).not.toBeNull());
    store = { ...store, rev: store.rev + 1, arguments: store.arguments.map((a) => (a.id === "m2" ? { ...a, claim: "别处改的" } : a)) };
    await refresh("ok");
    await waitFor(() => expect(q(c, "argument-save-conflict")).not.toBeNull());
    expect(q(c, "argument-save-unavailable")).toBeNull();
    expect(must<HTMLInputElement>(c, "argument-title-input").value).toBe("写到一半");
    expect(must<HTMLButtonElement>(c, "save-argument").disabled).toBe(true);
    expect(puts).toHaveLength(0);
  });

  it("with no draft the page is the error state, as before", async () => {
    const { container: c } = render(<ArgumentGraphMode workId={WORK_ID} work={WORK} onExit={() => {}} onOpenDoc={() => {}} />);
    await waitFor(() => expect(phase(c)).toBe("ready"));
    fireEvent.click(c.querySelector('[data-ui="argument-outline-row"][data-ui-key="m2"]')!);
    await waitFor(() => expect(q(c, "argument-detail")).not.toBeNull());
    await refresh("corrupt");
    await waitFor(() => expect(q(c, "argument-graph-corrupt")).not.toBeNull());
    expect(q(c, "argument-detail")).toBeNull();
    expect(q(c, "argument-save-unavailable")).toBeNull();
  });

  it("a new argument being written survives too", async () => {
    const { container: c } = render(<ArgumentGraphMode workId={WORK_ID} work={WORK} onExit={() => {}} onOpenDoc={() => {}} />);
    await waitFor(() => expect(phase(c)).toBe("ready"));
    fireEvent.click(must(c, "create-argument"));
    fireEvent.change(await waitFor(() => must(c, "argument-title-input")), { target: { value: "新的" } });
    await refresh("404");
    await waitFor(() => expect(q(c, "argument-save-unavailable")).not.toBeNull());
    expect(must<HTMLInputElement>(c, "argument-title-input").value).toBe("新的");
    expect(must<HTMLButtonElement>(c, "save-argument").disabled).toBe(true);
  });
});
