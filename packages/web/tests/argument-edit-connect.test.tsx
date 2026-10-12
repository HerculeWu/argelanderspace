/**
 * The role choice after a drag on the canvas (ticket 05). The canvas is stubbed to hand the view its `onConnect`
 * (the gesture itself is ticket 03's, tested with the canvas); what is checked here is what the view does with the drop:
 * a self-loop is refused with a notice, otherwise a role chooser opens at the drop point with the roles the pair already
 * has disabled, a choice is one write at the rev that was read, and Esc or an outside press writes nothing.
 */
import { type ArgumentGraph, ArgumentGraphSchema } from "@argelanderspace/contracts";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import { ArgumentGraphMode } from "../src/argument/ArgumentGraphMode";
import type { LibraryRef } from "../src/library/types";
import { ARGUMENT_FIXTURES } from "./fixtures/argument-graphs";

vi.mock("../src/api/ws", async () => (await import("./fake-ws")).wsModule());

let drop: ((from: string, to: string, at: { x: number; y: number }) => void) | undefined;
vi.mock("../src/argument/ArgumentGraphCanvas", () => ({
  ArgumentGraphCanvas: (props: { onConnect?: typeof drop }) => {
    drop = props.onConnect;
    return (
      <div data-ui="argument-canvas">
        {["n1", "m1", "m3"].map((id) => (
          <button key={id} type="button" data-ui="argument-node" data-ui-key={id} />
        ))}
      </div>
    );
  },
}));

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
const last = <T,>(a: T[]): T => a[a.length - 1] as T;
const WORK_ID = "arxiv:0000.00001";
const WORK: LibraryRef = { id: WORK_ID, title: "合成星团论文", authors: "Zhang, Li & Wang", year: 2024, venue: "ApJ", type: "article", cite: "zhang2024", tags: [], pdf: false, read: false, star: false, doc_ids: ["arxiv-0000.00001"] };
let store: ArgumentGraph;
let puts: ArgumentGraph[];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => {
  void i18n.changeLanguage("zh-CN");
  vi.stubGlobal("ResizeObserver", RO);
  store = ARGUMENT_FIXTURES.clean();
  puts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as ArgumentGraph;
        puts.push(body);
        if (body.rev !== store.rev) return json(409, { detail: "rev mismatch", rev: store.rev });
        const parsed = ArgumentGraphSchema.safeParse(body);
        if (!parsed.success) return json(400, { detail: "bad" });
        store = { ...parsed.data, rev: store.rev + 1 };
        return json(200, store);
      }
      return json(200, store);
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = async () => {
  const r = render(<ArgumentGraphMode workId={WORK_ID} work={WORK} onExit={() => {}} onOpenDoc={() => {}} />);
  await waitFor(() => expect(r.container.querySelector('[data-ui="argument-graph-view"]')!.getAttribute("data-phase")).toBe("ready"));
  return r;
};
const chooser = () => document.querySelector<HTMLElement>('[data-ui="argument-role-chooser"]');
const role = (r: string) => chooser()!.querySelector<HTMLButtonElement>(`[data-ui="choose-argument-role"][data-ui-key="${r}"]`)!;

describe("drag to connect", () => {
  it("a drop on the argument itself is refused with a notice, no chooser, no write", async () => {
    const { container } = await mount();
    act(() => drop!("m1", "m1", { x: 300, y: 300 }));
    expect(chooser()).toBeNull();
    expect(within(container).getByText("论证不能以自己为依据。")).toBeTruthy();
    expect(puts).toHaveLength(0);
  });

  it("opens the role chooser at the drop point naming both arguments; roles the pair already has are disabled; the first free one has the focus", async () => {
    await mount();
    act(() => drop!("n1", "m1", { x: 300, y: 260 })); // n1 -> m1 is Grounds already
    const box = chooser()!;
    expect(box.textContent).toContain("「Gaia DR3 的自行精度足够」的 Claim 在「候选成员样本」中充当");
    expect(box.style.left).toBe("300px");
    expect(box.style.top).toBe("260px");
    expect(role("grounds").disabled).toBe(true);
    expect(["warrant", "backing", "rebuttal"].every((r) => !role(r).disabled)).toBe(true);
    expect(document.activeElement).toBe(role("warrant"));
  });

  it("choosing a role writes that edge at the rev read and closes the chooser; the same pair may take another role", async () => {
    const { container } = await mount();
    act(() => drop!("n1", "m1", { x: 300, y: 260 }));
    await act(async () => fireEvent.click(role("backing")));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.rev).toBe(7);
    expect(last(puts[0]!.edges)).toEqual({ from: "n1", to: "m1", role: "backing" });
    expect(chooser()).toBeNull();
    await waitFor(() => expect(container.querySelector('[data-ui="argument-graph-counts"]')!.textContent).toBe("11 个论证 · 14 条边"));
    act(() => drop!("n1", "m1", { x: 300, y: 260 }));
    expect(role("backing").disabled).toBe(true);
    expect(role("grounds").disabled).toBe(true);
  });

  it("Esc, an outside press and Cancel close it without writing", async () => {
    await mount();
    act(() => drop!("n1", "m3", { x: 10, y: 10 }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(chooser()).toBeNull();
    act(() => drop!("n1", "m3", { x: 10, y: 10 }));
    fireEvent.pointerDown(document.body);
    expect(chooser()).toBeNull();
    act(() => drop!("n1", "m3", { x: 10, y: 10 }));
    fireEvent.click(chooser()!.querySelector('[data-ui="cancel-argument-role"]')!);
    expect(chooser()).toBeNull();
    expect(puts).toHaveLength(0);
  });

  it("Esc closes only the popover (nothing else hears it) and the focus returns to the node the drag started from; Cancel does the same, an outside press leaves the focus alone", async () => {
    await mount();
    const elsewhere = vi.fn();
    document.addEventListener("keydown", elsewhere);
    const node = () => document.querySelector<HTMLElement>('[data-ui="argument-node"][data-ui-key="n1"]')!;
    act(() => drop!("n1", "m3", { x: 10, y: 10 }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(chooser()).toBeNull();
    expect(elsewhere).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(node()));
    document.removeEventListener("keydown", elsewhere);
    act(() => drop!("n1", "m3", { x: 10, y: 10 }));
    (document.activeElement as HTMLElement).blur();
    fireEvent.click(chooser()!.querySelector('[data-ui="cancel-argument-role"]')!);
    await waitFor(() => expect(document.activeElement).toBe(node()));
    act(() => drop!("n1", "m3", { x: 10, y: 10 }));
    (document.activeElement as HTMLElement).blur();
    fireEvent.pointerDown(document.body);
    expect(chooser()).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(document.activeElement).not.toBe(node());
  });

  it("the chooser's Cancel button fills the row", async () => {
    await mount();
    act(() => drop!("n1", "m3", { x: 10, y: 10 }));
    const cancel = chooser()!.querySelector<HTMLElement>('[data-ui="cancel-argument-role"]')!;
    expect(cancel.className).toContain("ag-chooser-cancel");
    expect(cancel.querySelector("[data-ui]")).toBeNull();
  });

  it("a drop that lost the race to another writer is not written and says so", async () => {
    const { container } = await mount();
    store = { ...store, rev: 10 };
    act(() => drop!("n1", "m3", { x: 10, y: 10 }));
    await act(async () => fireEvent.click(role("grounds")));
    await waitFor(() => expect(within(container).getByText(/这次改动没有写入/)).toBeTruthy());
    expect(store.edges).toHaveLength(13);
  });
});
