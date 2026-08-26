/**
 * Test-local implementations of the HTML pipeline ports
 * (`packages/core/src/pipelines/html/ports.ts`). Core cannot import infra
 * (dependency direction is infra -> core), so the golden/unit tests wire their
 * own adapters:
 *
 * - **fetcher** — replays the archived page cache in `tests/fixtures/htmlcache/`
 *   (the exact `sha1(url)[:16]` key scheme of `ingest_html/fetch.py`; see the
 *   manifest there for why this subset is sufficient). Asset downloads write a
 *   fixed placeholder and succeed: only the deterministic `assets/<fn>` string
 *   flows into the Document JSON, never the image bytes (the publishers are
 *   bot-walled, so real downloads are impossible — and unnecessary — offline).
 * - **mathml** — spawns the real `pandoc` binary with the exact CLI contract of
 *   infra's `latex/pandoc.ts` `mathmlToLatex` (`-f html -t latex`, `<p>`-wrapped
 *   fragment, 20s timeout, katexify applied). The adapter's own edge cases are
 *   covered by infra's pandoc.test.ts; here we only need the stable CLI surface.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripMathDelims } from "../../src/pipelines/html/mathml.js";
import type { HtmlMathmlPort, HtmlPagePort } from "../../src/pipelines/html/ports.js";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
const HTMLCACHE = join(FIXTURES, "htmlcache");
const ASTRO_BIN = "/home/wwu/miniforge3/envs/astro/bin";

// Make the astro env's pandoc discoverable BEFORE collection: `skipIf` is
// evaluated when the test module loads, so a beforeAll would run too late.
function probePandoc(): boolean {
  const r = spawnSync("pandoc", ["--version"], { encoding: "utf-8" });
  return !r.error && r.status === 0;
}
if (!probePandoc() && existsSync(`${ASTRO_BIN}/pandoc`)) {
  process.env.PATH = `${ASTRO_BIN}${delimiter}${process.env.PATH ?? ""}`;
}
export const HAVE_PANDOC = probePandoc();

// --------------------------------------------------------------------------- //
// fetcher (fixture-backed, offline; cache-key identical to infra's Fetcher)
// --------------------------------------------------------------------------- //

/** sha1(url)[:16] — the Python/infra page-cache key. */
export function htmlcacheKey(url: string): string {
  return createHash("sha1").update(url, "utf-8").digest("hex").slice(0, 16);
}

/** 1x1 transparent PNG, 68 bytes (asset placeholder; bytes never enter the JSON). */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

export const testHtmlFetcher: HtmlPagePort = {
  get(url: string) {
    const key = htmlcacheKey(url);
    const htmlPath = join(HTMLCACHE, `${key}.html`);
    const urlPath = join(HTMLCACHE, `${key}.url`);
    if (!existsSync(htmlPath) || !existsSync(urlPath)) {
      throw new Error(
        `htmlcache fixture miss for ${url} (key ${key}) — the archived subset ` +
          "only covers the two golden docs; see fixtures/htmlcache/manifest.json"
      );
    }
    return Promise.resolve({
      finalUrl: readFileSync(urlPath, "utf-8").trim(),
      text: readFileSync(htmlPath, "utf-8"),
    });
  },
  download(_url: string, dest: string) {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, TINY_PNG);
    return Promise.resolve(true);
  },
};

// --------------------------------------------------------------------------- //
// mathml (CLI contract mirrors infra's latex/pandoc.ts mathmlToLatex)
// --------------------------------------------------------------------------- //

function runPandoc(
  args: readonly string[],
  opts: { stdin?: string; timeout?: number } = {}
): string {
  const proc = spawnSync("pandoc", [...args], {
    input: opts.stdin,
    encoding: "utf-8",
    timeout: (opts.timeout ?? 20) * 1000,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (proc.error) throw new Error(`pandoc invocation failed: ${proc.error.message}`);
  if (proc.status !== 0) {
    const tail = proc.stderr.trim().split("\n").slice(-3);
    throw new Error(tail.join("; ") || `pandoc rc=${proc.status}`);
  }
  return proc.stdout;
}

const MSPACE_RE = /\\mspace\s*\{[^}]*\}/g;

/** infra `katexify`: `\mspace{6mu}` → `\;` etc. */
function katexify(latex: string): string {
  return latex
    .replace(MSPACE_RE, "\\;")
    .replaceAll("\\medspace", "\\;")
    .replaceAll("\\thickspace", "\\;");
}

export const testMathml: HtmlMathmlPort = {
  mathmlToLatex(mathHtml: string): string | undefined {
    if (!HAVE_PANDOC || !mathHtml?.includes("<math")) return undefined;
    const doc = `<!DOCTYPE html><html><body><p>${mathHtml}</p></body></html>`;
    let out: string;
    try {
      out = runPandoc(["-f", "html", "-t", "latex"], { stdin: doc, timeout: 20 });
    } catch {
      return undefined; // pandoc failure degrades to "no math", like the Python
    }
    return katexify(stripMathDelims(out.trim()));
  },
};
