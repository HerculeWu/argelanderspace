import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { expect, it } from "vitest";

// Stage 9: user-visible copy lives in src/locales/*.json. Any CJK left in
// src/**/*.ts(x) — including comments — fails this test. The whitelist lists
// the pre-migration files and shrinks as domains migrate; it must be EMPTY
// by the end of the stage.
// (node:url's URL, not happy-dom's, so fileURLToPath accepts it.)
const SRC = fileURLToPath(new NodeURL("../src", import.meta.url));

const WHITELIST: string[] = [];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (/\.tsx?$/.test(entry.name)) yield p;
  }
}

it("no CJK hardcoded in src outside the migration whitelist", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file);
    if (WHITELIST.includes(rel)) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/[\u4e00-\u9fff]/.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
  }
  expect(offenders).toEqual([]);
});
