/** Actual CodeMirror wiring. happy-dom cannot prove caret pixels or native IME fidelity. */
import { useState } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { LatexSourceField, type WriterTextTarget } from "../src/writer/latexSource";

// happy-dom fires selectionchange synchronously INSIDE CodeMirror's DOM write,
// unlike a browser. State/caret tests do not use DOM selection inference.
const stopSelection = (e: Event) => e.stopImmediatePropagation();
beforeEach(() => document.addEventListener("selectionchange", stopSelection, true));
afterEach(() => { cleanup(); document.removeEventListener("selectionchange", stopSelection, true); });
it("edits through CodeMirror and exposes a live caret target, without an overlay", async () => {
  let target: WriterTextTarget | undefined;
  function Field() {
    const [value, setValue] = useState("abc");
    return <LatexSourceField id="test-source" label="LaTeX" value={value} onChange={setValue} onCaret={(v) => { target = v; }} />;
  }
  const ui = render(<Field />);
  await waitFor(() => expect(target).toBeDefined());
  const view = EditorView.findFromDOM(ui.container.querySelector(".cm-content")! as HTMLElement)!;
  act(() => view.dispatch({ changes: { from: 3, insert: "\\citep{key}" }, selection: { anchor: 5 } }));
  await waitFor(() => expect(target!.value).toBe("abc\\citep{key}"));
  expect(target!.selectionStart).toBe(5);
  act(() => target!.setSelectionRange(2, 4));
  expect(view.state.selection.main.from).toBe(2);
  expect(view.state.selection.main.to).toBe(4);
  expect(ui.container.querySelector("textarea")).toBeNull();
  expect(ui.container.querySelector(".w-src-highlight")).toBeNull();
});

it("Shift+Enter requests render, but composition Enter does not", async () => {
  const commit = vi.fn();
  const ui = render(<LatexSourceField id="test-ime" label="LaTeX" value="x" onChange={() => {}} onCommit={commit} />);
  const content = ui.container.querySelector(".cm-content")!;
  fireEvent.keyDown(content, { key: "Enter", code: "Enter", shiftKey: true });
  expect(commit).toHaveBeenCalledTimes(1);
  fireEvent.compositionStart(content);
  fireEvent.keyDown(content, { key: "Enter", code: "Enter", shiftKey: true, isComposing: true });
  expect(commit).toHaveBeenCalledTimes(1);
  fireEvent.compositionEnd(content);
});
