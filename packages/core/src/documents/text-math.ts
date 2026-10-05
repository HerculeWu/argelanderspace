/**
 * Formula validation for the text codec: the same KaTeX, with the same options as the Reader's shared math display
 * (`web/src/lib/math.tsx`, both from contracts `math.ts`), but throwing, so a formula the Reader would paint as an
 * error is reported at the line that wrote it. `trust` stays off: KaTeX asks the `trust` function before it honours
 * `\href`, `\url`, `\includegraphics` or `\html*`; ours records the command and answers no, which is exactly the
 * situation in which the Reader paints the source red and drops the content.
 */
import { findMacroCommand, mathBaseOptions } from "@argelanderspace/contracts";
import katex from "katex";

/** The same cleaning the Reader applies before rendering: delimiters, `\tag{}` and `\label{}` are not typeset. */
export function cleanLatex(src: string): string {
  let s = (src ?? "").trim();
  s = s
    .replace(/^\$\$?/, "")
    .replace(/\$\$?$/, "")
    .trim();
  s = s.replace(/\\tag\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
  s = s.replace(/\\label\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
  return s.trim();
}

export type MathVerdict =
  | { kind: "ok" }
  /** Macro definitions are not typeset (see contracts `math.ts`): an error, the Reader would not paint them either. */
  | { kind: "macro"; command: string }
  /** Needs trust (an active command): the Reader paints it as red source. */
  | { kind: "trust"; command: string }
  | { kind: "error"; message: string };

/** What KaTeX makes of a formula (bounded in expansions; see the caller for the size and time budgets). */
export function checkFormula(latex: string, displayMode: boolean): MathVerdict {
  const cleaned = cleanLatex(latex);
  const macro = findMacroCommand(cleaned);
  if (macro !== null) return { kind: "macro", command: macro };
  let untrusted: string | null = null;
  try {
    katex.renderToString(cleaned, {
      ...mathBaseOptions(displayMode),
      throwOnError: true,
      trust: (context: { command: string }) => {
        untrusted ??= context.command;
        return false;
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const line = message.replace(/\s+/g, " ").trim();
    return { kind: "error", message: line.length > 200 ? `${line.slice(0, 197)}...` : line };
  }
  return untrusted === null ? { kind: "ok" } : { kind: "trust", command: untrusted };
}
