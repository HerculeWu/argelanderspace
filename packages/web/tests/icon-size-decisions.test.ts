// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// Shelf follow-up 10 (user decisions on ticket 06's icon review): the shared artwork and the CSS rules that the
// happy-dom component tests cannot see.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const icons = JSON.parse(read("../src/ui/icons.json")) as Record<string, string | Record<string, string>>;
const provenance = JSON.parse(read("../src/ui/icons.provenance.json")).icons as Record<string, { set: string; file: string }>;
const css = read("../src/argelander.css");
const shelfCss = read("../src/shelf/shelf.css");
const rule = (source: string, selector: string) => source.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";

it("Q1: the argument detail's edit/delete and the rail's more use Dazzle artwork shared with their peers", () => {
  expect(icons["delete-argument"]).toBe(icons["clear-argument-graph"]);
  expect(icons["edit-argument"]).toBe(icons["edit-plan"]);
  expect(icons["tutorial-rail-more"]).toBe(icons["mail-account-menu"]);
  expect(provenance["delete-argument"]).toMatchObject({ set: "dazzle-line-icons", file: "trash.svg" });
  expect(provenance["edit-argument"]).toMatchObject({ set: "dazzle-line-icons", file: "pen-line.svg" });
  expect(provenance["tutorial-rail-more"]).toMatchObject({ set: "dazzle-line-icons", file: "dots-horizontal.svg" });
});

it("Q2: the completed fold keeps its 18 px box but lines its label up with the other groups' labels", () => {
  // head: padding 4 + dot 7 + gap 8 = label at 19; fold: 4 + margins (-5, -6) + box 18 + gap 8 = 19
  expect(rule(css, ".plan-list-fold")).toMatch(/width: 18px; height: 18px;/);
  expect(rule(css, ".plan-list-fold")).toMatch(/margin: 0 -6px 0 -5px;/);
});

it("Q5: a Shelf summary value is right-aligned on one line and left-aligned when it wraps", () => {
  expect(rule(shelfCss, ".shelf-meta .shelf-meta-text")).toMatch(/display: inline-flex;.*max-width: 100%;.*text-align: left;/);
});
