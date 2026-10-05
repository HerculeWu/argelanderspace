/**
 * The text source editor field: CodeMirror (the same `@uiw/react-codemirror` setup the Writer's LaTeX source field
 * uses), with line numbers and native IME. It is built for large sources (up to 8 MiB): the document is a CodeMirror
 * rope that only renders the viewport, and the full string is built only when a save asks for it ({@link TextSourceApi.get},
 * cached per document state) - never per keystroke and never in a React render.
 */
import { useEffect, useMemo, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { Annotation, EditorState, type Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export interface TextSourceApi {
  /** The whole text (built on demand; cached until the document changes). */
  get(): string;
  /** Replace the whole text. `silent` replacements (loading, adopting a saved version) do not count as typing. */
  set(text: string, options?: { silent?: boolean }): void;
  /** Put the caret at a 1-based line/column and scroll it into view. */
  jump(line: number, column: number): void;
  focus(): void;
}

const external = Annotation.define<boolean>();

const basicSetup = {
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  autocompletion: false,
  // prose, not code: nothing may be inserted for the user (auto-closed brackets) or re-indented
  closeBrackets: false,
  bracketMatching: false,
  indentOnInput: false,
  lineNumbers: true,
};

const editorTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--fs, 13px)", backgroundColor: "var(--surface)", color: "var(--text)" },
  "&.cm-focused": { outline: "2px solid var(--accent)", outlineOffset: "1px" },
  ".cm-scroller": { fontFamily: "var(--font-mono, monospace)", lineHeight: "1.6", overflow: "auto" },
  ".cm-content": { padding: "8px 0", caretColor: "var(--text)" },
  ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--text-faint)", border: "none", borderRight: "1px solid var(--border-soft)" },
  ".cm-cursor": { borderLeftColor: "var(--text)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--accent-soft)" },
});

export function TextSourceField({
  initial,
  readOnly,
  label,
  apiRef,
  onUserChange,
}: {
  /** The text the editor opens with (later replacements go through `apiRef.current.set`). */
  initial: string;
  readOnly: boolean;
  label: string;
  apiRef: { current: TextSourceApi | null };
  /** Called for each edit the user made, with the new length in characters. */
  onUserChange: (length: number) => void;
}) {
  const change = useRef(onUserChange);
  change.current = onUserChange;
  const first = useRef(initial); // the value prop never changes: CodeMirror owns the text from here on
  const extensions = useMemo(
    () => [
      // Only "\n" separates lines, so every other character (a CR of a CRLF file, a lone CR) stays in the text and the
      // saved bytes are exactly what was loaded or typed; CodeMirror would otherwise normalize all line endings to "\n".
      EditorState.lineSeparator.of("\n"),
      editorTheme,
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "false" }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        if (update.transactions.some((tr) => tr.annotation(external))) return;
        change.current(update.state.doc.length);
      }),
    ],
    [label]
  );
  useEffect(
    () => () => {
      apiRef.current = null;
    },
    [apiRef]
  );
  return (
    <CodeMirror
      className="text-source-input"
      // no bundled light/dark base theme: `editorTheme` above follows the app's own theme variables (the bundled light
      // theme painted a white box with near-invisible text in the dark theme)
      theme="none"
      data-ui="text-source-input"
      height="100%"
      value={first.current}
      extensions={extensions}
      readOnly={readOnly}
      basicSetup={basicSetup}
      onCreateEditor={(view) => {
        let cached: { doc: Text; text: string } | null = null;
        apiRef.current = {
          get() {
            const doc = view.state.doc;
            if (cached?.doc !== doc) cached = { doc, text: doc.toString() };
            return cached.text;
          },
          set(text, options) {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: text },
              annotations: options?.silent ? external.of(true) : [],
            });
          },
          jump(line, column) {
            const doc = view.state.doc;
            const target = doc.line(Math.min(Math.max(1, line), doc.lines));
            const pos = target.from + Math.min(Math.max(0, column - 1), target.length);
            view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
            view.focus();
          },
          focus: () => view.focus(),
        };
      }}
    />
  );
}
