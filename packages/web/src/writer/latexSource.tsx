/** Mature LaTeX source editing; no textarea/highlight overlay or bespoke completion. */
import { useCallback, useMemo, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { EditorView, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";

/** Both native text fields and CodeMirror expose this small caret interface. */
export interface WriterTextTarget {
  readonly value: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  readonly isConnected: boolean;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
}

const latex = StreamLanguage.define(stex);
const basicSetup = { foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false, autocompletion: false };
const editorTheme = EditorView.theme({
  "&": { fontSize: "13px", backgroundColor: "transparent", color: "inherit" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono, monospace)", lineHeight: "1.6" },
  ".cm-content": { minHeight: "160px", padding: "10px 0" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--paper-muted)", border: "none" },
});

function caretTarget(view: EditorView): WriterTextTarget {
  return {
    get value() { return view.state.doc.toString(); },
    get selectionStart() { return view.state.selection.main.from; },
    get selectionEnd() { return view.state.selection.main.to; },
    get isConnected() { return view.dom.isConnected; },
    focus: () => view.focus(),
    setSelectionRange: (start, end) => {
      const length = view.state.doc.length;
      view.dispatch({ selection: { anchor: Math.min(start, length), head: Math.min(end, length) }, scrollIntoView: true });
    },
  };
}

export function LatexSourceField({
  id, value, onChange, onCaret, onCommit, label, readOnly = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onCaret?: (target: WriterTextTarget) => void;
  onCommit?: () => void;
  label: string;
  readOnly?: boolean;
}) {
  const target = useRef<WriterTextTarget | null>(null);
  const initialSelection = useRef({ anchor: value.length });
  const commit = useRef(onCommit);
  commit.current = onCommit;
  const change = useRef(onChange);
  change.current = onChange;
  const handleChange = useCallback((next: string) => change.current(next), []);
  const extensions = useMemo(() => [
    latex,
    editorTheme,
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ id, "aria-label": label }),
    Prec.highest(keymap.of([{ key: "Shift-Enter", run: (view) => {
      if (view.compositionStarted || !commit.current) return false;
      commit.current();
      return true;
    } }])),
  ], [id, label]);
  return (
    <CodeMirror
      className="w-source-editor" data-ui="cell-latex-editor"
      value={value}
      selection={initialSelection.current}
      extensions={extensions}
      readOnly={readOnly}
      autoFocus={Boolean(onCaret)}
      basicSetup={basicSetup}
      onCreateEditor={(view) => {
        target.current = caretTarget(view);
        if (onCaret) onCaret(target.current);
      }}
      onFocus={() => { if (target.current) onCaret?.(target.current); }}
      onChange={handleChange}
    />
  );
}
