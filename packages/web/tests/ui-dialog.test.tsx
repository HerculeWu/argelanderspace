import { useRef, useState } from "react";
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
});
