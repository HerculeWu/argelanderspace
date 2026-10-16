import { describe, expect, it } from "vitest";
import { planResize, resizeDivider, shareOf } from "../src/argelander/layout";

const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i] as number, 9));

describe("divider rule shared by drag and the Copilot resize", () => {
  it("moves one divider and keeps both sides above the minimum share", () => {
    close(resizeDivider([1, 1], 0, 0.5), [1.5, 0.5]);
    close(resizeDivider([1, 1], 0, 5), [6, 0.32]); // the drag clamps the shrinking side, as before
    close(resizeDivider([1, 1, 1], 1, 0.2), [1, 1.2, 0.8]);
  });
  it("a resize request is one divider move taking from the right neighbour (left for the last pane)", () => {
    close(planResize([1, 1], 0, 0.6)!, [1.2, 0.8]);
    close(planResize([1, 1, 1], 1, 0.5)!, [1, 1.5, 0.5]);
    close(planResize([1, 1, 1], 2, 0.5)!, [1, 0.5, 1.5]);
  });
  it("refuses what a drag could not reach: no neighbour, or a neighbour squeezed below the minimum", () => {
    expect(planResize([1], 0, 0.5)).toBeNull();
    expect(planResize([1, 1, 1], 0, 0.84)).toBeNull(); // would leave the middle pane at a negative width
    expect(planResize([1, 1], 0, 0.1)).toBeNull();
    expect(planResize([1, 1], 5, 0.5)).toBeNull();
  });
  it("reports a rounded share of the total", () => {
    expect(shareOf([1, 2], 1)).toBe(0.667);
  });
});

describe("the option lists the Copilot may choose from are the Tweaks popover's own", () => {
  it("accents, densities, themes and languages match the Shell's controls", async () => {
    const contracts = await import("@argelanderspace/contracts");
    const { ACCENTS } = await import("../src/argelander/theme");
    expect(Object.keys(ACCENTS)).toEqual([...contracts.APPEARANCE_ACCENTS]);
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const popover = readFileSync(fileURLToPath(import.meta.url).replace(/tests[\\/]shell-layout\.test\.ts$/, "src/argelander/TweaksPopover.tsx"), "utf8").replace(/\s+/g, "");
    expect(popover).toContain(`DENSITIES:Density[]=${JSON.stringify([...contracts.APPEARANCE_DENSITIES])}`);
    expect(popover).toContain(`THEMES:ThemeName[]=${JSON.stringify([...contracts.APPEARANCE_THEMES])}`);
    expect(popover).toContain(`LANGUAGES:AppLanguage[]=${JSON.stringify([...contracts.APPEARANCE_LANGUAGES])}`);
    expect(contracts.WORKSPACE_VIEWS).toEqual(["plan", "library", "doc", "write", "mail"]); // the activity bar's NAV
  });
});

describe("the accent swatch is one oklch() value, shared by the Tweaks popover and the settings page", () => {
  it("accentSwatch gives oklch(L c h) per theme, and both surfaces take it from there", async () => {
    const { accentSwatch, ACCENTS } = await import("../src/argelander/theme");
    expect(accentSwatch("teal", "dark")).toBe("oklch(0.72 0.11 178)");
    expect(accentSwatch("teal", "light")).toBe("oklch(0.55 0.11 178)");
    expect(accentSwatch("nonesuch", "dark")).toBe("oklch(0.72 0.13 235)"); // unknown falls back to azure
    for (const k of Object.keys(ACCENTS)) expect(accentSwatch(k, "light")).toMatch(/^oklch\(0\.55 [\d.]+ \d+\)$/);
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = (f: string) => readFileSync(fileURLToPath(import.meta.url).replace(/tests[\\/]shell-layout\.test\.ts$/, f), "utf8");
    for (const f of ["src/argelander/TweaksPopover.tsx", "src/settings/SettingsView.tsx"]) {
      expect(src(f)).toContain("background: accentSwatch(");
    }
  });
});
