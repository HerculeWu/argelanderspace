/**
 * Instrumentation setup (Stage 5 MS1): copy `argelander.sty` next to the
 * main file inside the workspace and generate the wrapper
 * `__argelander_wrap.tex` that loads it before `\input`-ing the main file.
 *
 * The wrapper compiles with `-jobname=<main base>` (see compile.ts), so
 * all artifacts keep the clean-build names (paper.aux/paper.fls/...).
 *
 * The .sty is a real shipped file resolved via `new URL("./argelander.sty",
 * import.meta.url)`: from src/ under vitest and from dist/ after the
 * package build copies it over. App bundlers must carry this asset — when
 * it is missing, {@link prepareTexInstrumentation} throws and the compile
 * port falls back to a clean (uninstrumented) compile with a warning.
 */
import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { writeTexFileIfChanged } from "./cache.js";

/** Writer opts in; no changes to the reader event stream or printed output. */
const WRITER_STYLE_PROBE = String.raw`
\makeatletter
\newwrite\argelanderstyleout
\AddToHook{begindocument/end}{%
  \immediate\openout\argelanderstyleout=\jobname.argelander-citation.tex
  \@ifpackageloaded{natbib}{%
    \immediate\write\argelanderstyleout{\string\argelandercitestyle
      {\ifNAT@numbers numbers\else authoryear\fi}
      {\NAT@open}{\NAT@close}{\NAT@sep}{\NAT@aysep}{\NAT@yrsep}{\NAT@cmt}
      {\number\NAT@sort}{\number\NAT@cmprs}
      {\ifNAT@longnames 1\else 0\fi}{\ifNAT@super 1\else 0\fi}}%
  }{%
    \immediate\write\argelanderstyleout{\string\argelandercitestyle{numeric}{[}{]}{,}{}{,}{, }{0}{0}{0}{0}}%
  }%
  \immediate\closeout\argelanderstyleout
}
\makeatother
`;

export const TEX_WRAPPER_NAME = "__argelander_wrap.tex";
export const TEX_STY_NAME = "argelander.sty";

/** Absolute path of the shipped argelander.sty, or null if it is missing. */
export function texStyPath(): string | null {
  const p = fileURLToPath(new URL(`./${TEX_STY_NAME}`, import.meta.url));
  return existsSync(p) ? p : null;
}

/**
 * Copy the .sty next to the main file inside the workspace and write the
 * wrapper (the compile target). `styPath` overrides the shipped asset —
 * used by tests to force an instrumentation failure.
 */
export async function prepareTexInstrumentation(
  mainAbsInWorkspace: string,
  styPath?: string,
  renderProfile?: "writer"
): Promise<string> {
  const sty = styPath ?? texStyPath();
  if (sty === null) {
    throw new Error(
      `instrumentation package ${TEX_STY_NAME} not found next to ${path.dirname(fileURLToPath(import.meta.url))} ` +
        "(app bundling must carry this asset)"
    );
  }
  const dir = path.dirname(mainAbsInWorkspace);
  await writeTexFileIfChanged(path.join(dir, TEX_STY_NAME), await fs.readFile(sty));
  const wrapper = path.join(dir, TEX_WRAPPER_NAME);
  await writeTexFileIfChanged(
    wrapper,
    `% Auto-generated instrumentation wrapper (Stage 5 MS1). Do not edit.\n` +
      `\\RequirePackage{argelander}\n` +
      (renderProfile === "writer" ? WRITER_STYLE_PROBE : "") +
      `\\input{${path.basename(mainAbsInWorkspace)}}\n`
  );
  return wrapper;
}
