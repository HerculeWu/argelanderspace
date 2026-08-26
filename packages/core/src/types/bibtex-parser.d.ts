/**
 * Local declarations for `@retorquere/bibtex-parser` (10.0.1): the published
 * package points its `types` at a `dist/types/` directory it doesn't ship, so
 * the minimal surface `acquire/bibtex.ts` consumes is declared here.
 */
declare module "@retorquere/bibtex-parser" {
  export interface BibtexEntry {
    type: string;
    key: string;
    fields: Record<string, unknown>;
    mode: Record<string, string>;
    input: string;
  }

  export interface BibtexDatabase {
    errors: unknown[];
    entries: BibtexEntry[];
    comments: unknown[];
    strings: Record<string, string>;
    preamble: unknown[];
    jabref: unknown;
  }

  export interface ParseOptions {
    /** Keep raw LaTeX field values (skip translation/case handling). */
    raw?: boolean;
    /** `false` disables title sentence-casing entirely. */
    sentenceCase?: boolean | { guess?: boolean; subSentence?: boolean; preserveQuoted?: boolean };
    /** Fields parsed in verbatim mode (raw string, no creator/title handling). */
    verbatimFields?: readonly (string | RegExp)[];
    /** Per-field mode overrides, e.g. `{ author: "verbatim" }`. */
    fieldMode?: Record<string, string>;
    applyCrossRef?: boolean;
    [option: string]: unknown;
  }

  export function parse(input: string, options?: ParseOptions): BibtexDatabase;
}
