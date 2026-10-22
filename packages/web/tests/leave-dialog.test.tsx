/**
 * The shared "discard unsaved work?" question (argelander/leave-dialog.tsx): the app's Dialog for the person, a plain
 * refusal for the Copilot, one question at a time, and a no when its host goes away.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocLeaveScope, useLeaveDialog, useLeaveQuestionOpen, useUnsavedSource } from "../src/argelander/leave-dialog";
import { askWorkspaceLeave, type LeaveOrigin } from "../src/argelander/workspace";

afterEach(cleanup);

type Ask = ReturnType<typeof useLeaveDialog>["ask"];
function Host({ expose }: { expose: (ask: Ask) => void }) {
  const { ask, dialog } = useLeaveDialog();
  expose(ask);
  return <div>{dialog}</div>;
}
const mount = () => {
  let ask!: Ask;
  const view = render(<Host expose={(a) => (ask = a)} />);
  return { view, ask: (body: string, origin?: LeaveOrigin) => ask(body, origin) };
};
const dialog = () => document.querySelector('[data-ui="leave-dialog"]');
const click = (ui: string) => fireEvent.click(document.querySelector(`[data-ui="${ui}"]`)!);

describe("useLeaveDialog", () => {
  it("shows the body in the app's dialog; keep editing answers no, discard answers yes", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const { ask } = mount();
    const first = ask("PDF 有未保存内容");
    await waitFor(() => expect(dialog()).toBeTruthy());
    expect(document.querySelector('[data-ui="leave-dialog-body"]')?.textContent).toBe("PDF 有未保存内容");
    expect(document.activeElement).toBe(document.querySelector('[data-ui="leave-dialog-stay"]')); // safe default
    click("leave-dialog-stay");
    expect(await first).toBe(false);
    expect(dialog()).toBeNull();
    const second = ask("again");
    await waitFor(() => expect(dialog()).toBeTruthy());
    click("leave-dialog-discard");
    expect(await second).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("Escape is keep editing", async () => {
    const { ask } = mount();
    const answer = ask("x");
    await waitFor(() => expect(dialog()).toBeTruthy());
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(await answer).toBe(false);
  });

  it("the Copilot is refused at once and no dialog opens", () => {
    const { ask } = mount();
    expect(ask("x", "agent")).toBe(false);
    expect(dialog()).toBeNull();
  });

  it("a later question supersedes an open one: the earlier is answered no, the one dialog carries the new question, and its answer counts", async () => {
    const { ask } = mount();
    const first = ask("x");
    await waitFor(() => expect(dialog()).toBeTruthy());
    const second = ask("y");
    expect(await first).toBe(false);
    await waitFor(() => expect(document.querySelector('[data-ui="leave-dialog-body"]')?.textContent).toBe("y"));
    expect(document.querySelectorAll('[data-ui="leave-dialog"]')).toHaveLength(1);
    click("leave-dialog-discard");
    expect(await second).toBe(true); // no dead dialog: the visible one is the one somebody waits for
  });

  it("never opens over another modal dialog: the question is answered no and no second modal appears", async () => {
    const other = document.createElement("div");
    other.setAttribute("role", "dialog");
    other.setAttribute("aria-modal", "true");
    document.body.appendChild(other);
    const { ask } = mount();
    expect(await ask("x")).toBe(false);
    expect(dialog()).toBeNull();
    // the refusal is not silent: a status toast says why nothing happened
    await waitFor(() => expect(document.querySelector('[data-ui="leave-blocked-notice"]')?.getAttribute("role")).toBe("status"));
    expect(document.querySelector('[data-ui="leave-blocked-notice"]')?.textContent).toContain("对话框");
    other.remove();
  });

  it("the question counts as open from asking until answered, for views that step aside for it", async () => {
    const seen: boolean[] = [];
    function Watcher() {
      seen.push(useLeaveQuestionOpen());
      return null;
    }
    const { ask } = mount();
    render(<Watcher />);
    expect(seen[seen.length - 1]).toBe(false);
    const answer = ask("x");
    await waitFor(() => expect(seen[seen.length - 1]).toBe(true));
    await waitFor(() => expect(dialog()).toBeTruthy());
    click("leave-dialog-stay");
    await answer;
    await waitFor(() => expect(seen[seen.length - 1]).toBe(false));
  });

  it("a modal that is removed in the same event the question was asked in does not block it", async () => {
    const other = document.createElement("div");
    other.setAttribute("role", "dialog");
    other.setAttribute("aria-modal", "true");
    document.body.appendChild(other);
    const { ask } = mount();
    const answer = ask("x");
    other.remove(); // the caller stepped its own dialog aside right after asking
    await waitFor(() => expect(dialog()).toBeTruthy());
    click("leave-dialog-discard");
    expect(await answer).toBe(true);
  });

  it("a question still open when the host goes away is a no", async () => {
    const { ask, view } = mount();
    const answer = ask("x");
    await waitFor(() => expect(dialog()).toBeTruthy());
    view.unmount();
    expect(await answer).toBe(false);
  });
});

describe("DocLeaveScope: one question for everything a Doc holds unsaved", () => {
  /** A view with unsaved work (the PDF Reader, the source editor, the annotation drafts all join like this). */
  function Source({ line, unsaved }: { line: string; unsaved: { current: boolean } }) {
    const own = useUnsavedSource(() => (unsaved.current ? line : null));
    return <>{own}</>;
  }
  const renderScope = (a: { current: boolean }, b: { current: boolean }) =>
    render(
      <DocLeaveScope>
        <Source line="source text not saved" unsaved={a} />
        <Source line="annotation text not saved" unsaved={b} />
      </DocLeaveScope>
    );

  it("two unsaved kinds are one dialog that names both, and one answer settles both", async () => {
    renderScope({ current: true }, { current: true });
    const answer = askWorkspaceLeave();
    expect(answer).toBeInstanceOf(Promise);
    await waitFor(() => expect(dialog()).toBeTruthy());
    expect(document.querySelectorAll('[data-ui="leave-dialog"]')).toHaveLength(1);
    const body = document.querySelector('[data-ui="leave-dialog-body"]')!.textContent;
    expect(body).toContain("source text not saved");
    expect(body).toContain("annotation text not saved");
    click("leave-dialog-discard");
    expect(await answer).toBe(true);
    expect(dialog()).toBeNull(); // no second question
  });

  it("only what is unsaved is named; nothing unsaved leaves at once", async () => {
    const view = renderScope({ current: false }, { current: true });
    const answer = askWorkspaceLeave();
    await waitFor(() => expect(dialog()).toBeTruthy());
    const body = document.querySelector('[data-ui="leave-dialog-body"]')!.textContent;
    expect(body).toContain("annotation text not saved");
    expect(body).not.toContain("source text not saved");
    click("leave-dialog-stay");
    expect(await answer).toBe(false);
    view.unmount();
    renderScope({ current: false }, { current: false });
    expect(askWorkspaceLeave()).toBe(true);
  });

  it("the Copilot's origin reaches the Doc's guard: refused at once, no dialog (drop the origin and this fails)", () => {
    renderScope({ current: true }, { current: false });
    expect(askWorkspaceLeave(undefined, undefined, "agent")).toBe(false);
    expect(dialog()).toBeNull();
    expect(askWorkspaceLeave(undefined, undefined, "agent")).toBe(false); // and nothing is left pending
  });
});
