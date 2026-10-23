import { useEffect, useRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, Dialog } from "../src/ui";

function DialogHarness({ busy = false, onClose = vi.fn() }: { busy?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    onClose();
    setOpen(false);
  };
  return (
    <>
      <button onClick={() => setOpen(true)}>Open dialog</button>
      {open && (
        <Dialog
          title="Delete document?"
          description="Global physical deletion"
          closeLabel="Close dialog"
          busy={busy}
          initialFocusRef={cancelRef}
          onClose={close}
          footer={
            <>
              <Button ref={cancelRef} disabled={busy} onClick={close}>Cancel</Button>
              <Button variant="danger" busy={busy}>Delete</Button>
            </>
          }
        >
          Body
        </Dialog>
      )}
    </>
  );
}

describe("Dialog public interaction", () => {
  afterEach(cleanup);

  it("names the dialog, focuses the safe action, contains Tab in both directions, and returns focus", () => {
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "Open dialog" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Delete document?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    expect(screen.getByText("Global physical deletion").id).not.toBe("");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));

    const close = screen.getByRole("button", { name: "Close dialog" });
    const remove = screen.getByRole("button", { name: "Delete" });
    dialog.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    dialog.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(remove);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes from the backdrop, but contains focus and blocks all dismissal while busy", () => {
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    fireEvent.click(screen.getByTestId("dialog-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);

    cleanup();
    render(<DialogHarness busy onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(dialog);
    document.body.tabIndex = -1;
    document.body.focus();
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByTestId("dialog-backdrop"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Close dialog" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    document.body.removeAttribute("tabindex");
  });

  it("allows native Tab from disclosure summaries while keeping modal boundaries", () => {
    render(<Dialog title="Settings" closeLabel="Close" onClose={vi.fn()} footer={<Button>Done</Button>}>
      <details open><summary>Provider</summary><input aria-label="Key" /><details><summary>Advanced</summary><input aria-label="Model" /></details></details>
    </Dialog>);
    const summary = screen.getByText("Provider");
    summary.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    summary.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(summary);
    const reverse = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    summary.dispatchEvent(reverse);
    expect(reverse.defaultPrevented).toBe(false);
    const footer = screen.getByRole("button", { name: "Done" });
    footer.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("moves focus to the dialog during an in-flight transition and restores the safe action after failure", () => {
    const view = render(<DialogHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));

    view.rerender(<DialogHarness busy />);
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("dialog"));

    view.rerender(<DialogHarness />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });

  it("focuses the safe action in the commit that shows the dialog, before any passive effect (a later frame is observable under load)", () => {
    // The ticket 28 text Doc test was flaky because the focus moved in a passive effect: React runs those a
    // scheduler task after the commit, and under load a test (or a keystroke) in that gap still saw body focused.
    // Passive effects run children first, so a child's passive effect marks "the passive phase has started".
    const order: string[] = [];
    const focus = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement) {
      order.push(`focus:${this.textContent}`);
    });
    function Probe() {
      useEffect(() => {
        order.push("passive");
      }, []);
      return null;
    }
    function Harness() {
      const cancelRef = useRef<HTMLButtonElement>(null);
      return (
        <Dialog title="Replace?" closeLabel="Close" initialFocusRef={cancelRef} onClose={() => {}} footer={<Button ref={cancelRef}>Cancel</Button>}>
          <Probe />
        </Dialog>
      );
    }
    try {
      render(<Harness />);
      expect(order.indexOf("focus:Cancel")).toBeGreaterThanOrEqual(0);
      expect(order.indexOf("focus:Cancel")).toBeLessThan(order.indexOf("passive"));
    } finally {
      focus.mockRestore();
    }
  });
});

describe("a dialog opened over another (shelf ticket 05: the delete confirmation over the Shelf dialog)", () => {
  afterEach(cleanup);
  function Stacked({ onOuterClose, onInnerClose }: { onOuterClose: () => void; onInnerClose: () => void }) {
    const [inner, setInner] = useState(false);
    const cancelRef = useRef<HTMLButtonElement>(null);
    return (
      <>
        <Dialog title="Outer" closeLabel="Close outer" onClose={onOuterClose}>
          <button onClick={() => setInner(true)}>Open inner</button>
        </Dialog>
        {inner && (
          <Dialog title="Inner" closeLabel="Close inner" initialFocusRef={cancelRef} onClose={() => { onInnerClose(); setInner(false); }}>
            <Button ref={cancelRef}>Inner cancel</Button>
            <Button>Inner delete</Button>
          </Dialog>
        )}
      </>
    );
  }

  it("a new initialFocusRef (another step of the same dialog) does not send the focus back out", () => {
    function Steps() {
      const [step, setStep] = useState<"a" | "b">("a");
      const aRef = useRef<HTMLButtonElement>(null);
      const bRef = useRef<HTMLButtonElement>(null);
      return (
        <Dialog title="Steps" closeLabel="Close" initialFocusRef={step === "a" ? aRef : bRef} onClose={() => {}}>
          {step === "a" ? <Button ref={aRef} onClick={() => setStep("b")}>To B</Button> : <Button ref={bRef}>On B</Button>}
          <Button>Other</Button>
        </Dialog>
      );
    }
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    render(<Steps />);
    fireEvent.click(screen.getByText("To B"));
    expect(document.activeElement).not.toBe(opener);
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    opener.remove();
  });

  it("when the control that opened it is gone, closing gives the focus to the dialog beneath", () => {
    function Gone() {
      const [inner, setInner] = useState(false);
      const [hasOpener, setHasOpener] = useState(true);
      return (
        <>
          <Dialog title="Outer" closeLabel="Close outer" onClose={() => {}}>
            {hasOpener ? <button onClick={() => setInner(true)}>Delete row</button> : <span>gone</span>}
          </Dialog>
          {inner && (
            <Dialog title="Inner" closeLabel="Close inner" onClose={() => {}}>
              <Button onClick={() => { setHasOpener(false); setInner(false); }}>Confirm</Button>
            </Dialog>
          )}
        </>
      );
    }
    render(<Gone />);
    const opener = screen.getByText("Delete row");
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByText("Confirm"));
    const outer = screen.getByRole("dialog");
    expect(outer.contains(document.activeElement)).toBe(true);
  });

  it("owns focus and Escape until it closes; then the dialog beneath has them again", () => {
    const onOuterClose = vi.fn();
    const onInnerClose = vi.fn();
    render(<Stacked onOuterClose={onOuterClose} onInnerClose={onInnerClose} />);
    const opener = screen.getByText("Open inner");
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByText("Inner cancel"));
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(onInnerClose).toHaveBeenCalledTimes(1);
    expect(onOuterClose).not.toHaveBeenCalled();
    expect(screen.queryByText("Inner cancel")).toBeNull();
    expect(document.activeElement).toBe(screen.getByText("Open inner"));
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(onOuterClose).toHaveBeenCalledTimes(1);
  });
});
