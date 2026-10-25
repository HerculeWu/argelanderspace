/**
 * tutorial-shelf ticket 04: a step may declare the one named product dialog it floats above (`floatsOver`). While that
 * dialog is the only modal open, the card and the highlight stay above its overlay and the anchor is found inside it;
 * every other step and every other modal still yields as before. The product's own Dialog is rendered for real, so the
 * keyboard and click rules the yield protected (focus, click outside, Escape) are tested against it.
 */
import type { TutorialProgress } from "@argelanderspace/contracts";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TutorialRunner, type RunnerDeps } from "../src/tutorial/TutorialLayer";
import type { ChapterDefinition } from "../src/tutorial/types";
import { Dialog } from "../src/ui";
import { fakePage, fakeProgress } from "./tutorial-fixtures";

const AT = "2026-10-25T02:00:00.000Z";
const VISIBLE = () => ({ rect: new DOMRect(10, 10, 40, 20), visible: true });
const IN_DIALOG = { ui: "target-in-dialog", within: { ui: "shelf-dialog" } } as const;

const chapters: ChapterDefinition[] = [
  {
    id: "tour",
    n: 1,
    steps: [
      { id: "tour.floats", kind: "look", anchors: [{ ui: "shelf-dialog" }, IN_DIALOG], floatsOver: "shelf-dialog" },
      { id: "tour.yields", kind: "look", anchors: [{ ui: "shelf-dialog" }, IN_DIALOG] },
      { id: "tour.last", kind: "look", anchors: [] },
    ],
  },
];

function setup(position: string, measure: RunnerDeps["measure"] = VISIBLE) {
  const put = vi.fn(async (_progress: TutorialProgress) => ({}));
  const deps: Partial<RunnerDeps> = { put, checkTex: async () => true, now: () => AT, measure, rendered: () => true };
  const view = render(
    <TutorialRunner initial={fakeProgress({ position })} context={fakePage("library")} onViewAction={vi.fn(async () => ({ ok: true }))} desktop entered chapters={chapters} deps={deps} />,
  );
  return { ...view, put };
}
const ui = (name: string, key?: string) => document.querySelector(`[data-ui="${name}"]${key ? `[data-ui-key="${key}"]` : ""}`) as HTMLElement | null;
const card = () => ui("tutorial-step-card");
const tick = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const DIALOG_HTML = `<div data-ui="dialog-overlay"><div data-ui="shelf-dialog" role="dialog"><button data-ui="target-in-dialog">x</button></div></div>`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "Date"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("a step that floats over the named dialog", () => {
  it("does not yield while that dialog is the only modal open: card anchored beside the control inside it, highlight drawn", async () => {
    setup("tour.floats");
    await tick(16);
    document.body.insertAdjacentHTML("beforeend", DIALOG_HTML);
    await tick(32);
    expect(card()?.className).not.toContain("yielded");
    expect(card()?.getAttribute("data-state")).toBe("anchored");
    expect(ui("tutorial-modal-yield")).toBeNull();
    expect(ui("tutorial-highlight")).not.toBeNull();
  });
  it("finds its anchor inside the dialog only: the same ui name outside it is not the anchor (within)", async () => {
    document.body.insertAdjacentHTML("beforeend", `<button data-ui="target-in-dialog" id="outside">o</button>`);
    const measured: Element[] = [];
    setup("tour.floats", (el) => {
      measured.push(el);
      return VISIBLE();
    });
    document.body.insertAdjacentHTML("beforeend", DIALOG_HTML);
    await tick(32);
    expect(ui("tutorial-highlight")).not.toBeNull();
    expect(card()?.getAttribute("data-state")).toBe("anchored");
    // The rung measured is the button in the dialog, never the one before it in the DOM outside it.
    expect(measured[measured.length - 1]?.closest('[data-ui="shelf-dialog"]')).not.toBeNull();
    expect(measured.some((el) => el.id === "outside")).toBe(false);
  });
  it("yields as before when another modal is open too (a confirmation over the dialog, or any other overlay)", async () => {
    setup("tour.floats");
    document.body.insertAdjacentHTML("beforeend", DIALOG_HTML);
    await tick(32);
    expect(card()?.getAttribute("data-state")).toBe("anchored");
    document.body.insertAdjacentHTML("beforeend", `<div data-ui="dialog-overlay" id="second"><div data-ui="other-dialog" role="dialog"></div></div>`);
    await tick(32);
    expect(card()?.className).toContain("yielded");
    expect(card()?.getAttribute("data-state")).toBe("modal");
    expect(ui("tutorial-highlight")).toBeNull();
    document.getElementById("second")!.remove();
    await tick(32);
    expect(card()?.getAttribute("data-state")).toBe("anchored");
  });
  it("yields to a modal that is not the named dialog", async () => {
    setup("tour.floats");
    await tick(16);
    document.body.insertAdjacentHTML("beforeend", `<div data-ui="dialog-overlay"><div data-ui="other-dialog" role="dialog"></div></div>`);
    await tick(32);
    expect(card()?.className).toContain("yielded");
    expect(ui("tutorial-highlight")).toBeNull();
  });
  it("a Writer modal (its own overlay) still yields", async () => {
    setup("tour.floats");
    await tick(16);
    document.body.insertAdjacentHTML("beforeend", `<div data-ui="writer-dialog-overlay"></div>`);
    await tick(32);
    expect(card()?.className).toContain("yielded");
  });
  it("the chapter rail stays below the overlay, as for any modal", async () => {
    setup("tour.floats");
    document.body.insertAdjacentHTML("beforeend", DIALOG_HTML);
    await tick(32);
    expect(ui("tutorial-chapter-rail")?.classList.contains("yielded")).toBe(true);
  });
});

describe("a step that does not declare it", () => {
  it("still yields to the very same dialog", async () => {
    setup("tour.yields");
    document.body.insertAdjacentHTML("beforeend", DIALOG_HTML);
    await tick(32);
    expect(card()?.className).toContain("yielded");
    expect(card()?.getAttribute("data-state")).toBe("modal");
    expect(ui("tutorial-highlight")).toBeNull();
  });
});

describe("against the product's own Dialog (focus trap, click outside, Escape)", () => {
  function Host({ onClose }: { onClose: () => void }) {
    const [open, setOpen] = useState(true);
    return open ? (
      <Dialog
        uiId="shelf-dialog"
        title="T"
        closeLabel="close"
        onClose={() => {
          onClose();
          setOpen(false);
        }}
      >
        <button type="button" data-ui="target-in-dialog">
          x
        </button>
      </Dialog>
    ) : null;
  }
  function both(onClose: () => void) {
    const put = vi.fn(async (_progress: TutorialProgress) => ({}));
    const deps: Partial<RunnerDeps> = { put, checkTex: async () => true, now: () => AT, measure: VISIBLE, rendered: () => true };
    render(
      <>
        <Host onClose={onClose} />
        <TutorialRunner initial={fakeProgress({ position: "tour.floats" })} context={fakePage("library")} onViewAction={vi.fn(async () => ({ ok: true }))} desktop entered chapters={chapters} deps={deps} />
      </>,
    );
  }
  it("the card is above the dialog; clicking its buttons (Next, Back, the exit cross) neither closes the dialog nor takes its focus away", async () => {
    const onClose = vi.fn();
    both(onClose);
    await tick(32);
    expect(card()?.getAttribute("data-state")).toBe("anchored");
    const dialog = ui("shelf-dialog")!;
    // A real click: the button takes the focus first (the dialog's focus trap pulls it back), then the click is delivered.
    const back = ui("tutorial-previous") as HTMLButtonElement;
    back.focus();
    fireEvent.mouseDown(back);
    fireEvent.click(back);
    await tick(16);
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.click(ui("tutorial-next")!);
    await tick(16);
    expect(onClose).not.toHaveBeenCalled();
    expect(card()?.getAttribute("data-ui-key")).toBe("tour.yields");
    expect(ui("shelf-dialog")).not.toBeNull();
  });
  it("Escape is the dialog's: it closes the dialog and does not ask to leave the tutorial", async () => {
    const onClose = vi.fn();
    both(onClose);
    await tick(32);
    fireEvent.keyDown(ui("shelf-dialog")!, { key: "Escape" });
    await tick(16);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(ui("shelf-dialog")).toBeNull();
    expect(ui("exit-tutorial-dialog")).toBeNull();
  });
  it("a click on the overlay still closes the dialog (the card is not part of it), and the card clicks do not reach it", async () => {
    const onClose = vi.fn();
    both(onClose);
    await tick(32);
    fireEvent.click(ui("dialog-overlay")!);
    await tick(16);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
