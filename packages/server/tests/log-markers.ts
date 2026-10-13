/**
 * The search the reverse privacy tests of the user-level log share (logging-coverage*.test.ts): marker strings are put
 * in the data that goes through a flow, and afterwards nothing of them may be anywhere in what was logged.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Every marker contains this word, in some case: one search for it finds any of them, however it was respelled. */
export const ROOT = "zqxmark";

/** The spellings a marker may take on its way: as it is, lower case, a slug, URL-encoded, base64. */
export function spellings(marker: string): string[] {
  const slug = marker
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return [
    ...new Set([
      marker,
      marker.toLowerCase(),
      marker.toUpperCase(),
      slug,
      slug.replaceAll("-", "_"),
      encodeURIComponent(marker),
      encodeURIComponent(marker).toLowerCase(),
      marker.replaceAll(" ", "+"),
      Buffer.from(marker).toString("base64"),
    ]),
  ];
}

/** Everything in a log directory, as one text. */
export function logText(dir: string): string {
  return readdirSync(dir)
    .sort()
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n");
}

/** Every spelling of a marker found in `text` (empty = the log can be handed on). */
export function markersInText(text: string, markers: readonly string[]): string[] {
  const found: string[] = [];
  if (text.toLowerCase().includes(ROOT)) found.push(`<${ROOT}>`);
  for (const marker of markers)
    for (const spelling of spellings(marker)) if (text.includes(spelling)) found.push(spelling);
  return found;
}
