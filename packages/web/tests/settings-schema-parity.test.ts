/**
 * The page's own preferences (`argelander/theme.ts`, `argelander/preferences.tsx`, `i18n.ts`) and the `[ui]` keys of
 * the Settings schema describe the same choices. The page's types and starting values are still its own; this file
 * is what turns red when one side gains, loses or renames a choice, or changes a default, without the other.
 */

import {
  SETTINGS_SCHEMA,
  SETTINGS_UI_ACCENTS,
  SETTINGS_UI_DENSITIES,
  SETTINGS_UI_LANGUAGES,
  SETTINGS_UI_THEMES,
} from "@argelanderspace/contracts";
import { beforeEach, describe, expect, test } from "vitest";
import { bootTweaks, DEFAULT_TWEAKS } from "../src/argelander/preferences";
import { ACCENTS, type Density, type ThemeName } from "../src/argelander/theme";
import i18n, { type AppLanguage, DEFAULT_LANGUAGE } from "../src/i18n";

// Each record must name every member of the page's type, and nothing else: adding a member to the type without
// adding it here does not compile, and the runtime comparison below then holds the schema to the same list.
const THEMES: Record<ThemeName, true> = { dark: true, light: true };
const DENSITIES: Record<Density, true> = { compact: true, regular: true, comfy: true };
const LANGUAGES: Record<AppLanguage, true> = { "zh-CN": true, en: true };

// And the other way round: every choice of the schema is a member of the page's type.
const schemaThemes: readonly ThemeName[] = SETTINGS_UI_THEMES;
const schemaDensities: readonly Density[] = SETTINGS_UI_DENSITIES;
const schemaLanguages: readonly AppLanguage[] = SETTINGS_UI_LANGUAGES;

beforeEach(() => {
  localStorage.clear();
});

describe("the [ui] keys of the Settings schema and the page's preferences", () => {
  test("the choices are the same on both sides", () => {
    expect([...schemaThemes].sort()).toEqual(Object.keys(THEMES).sort());
    expect([...schemaDensities].sort()).toEqual(Object.keys(DENSITIES).sort());
    expect([...schemaLanguages].sort()).toEqual(Object.keys(LANGUAGES).sort());
    expect([...SETTINGS_UI_ACCENTS]).toEqual(Object.keys(ACCENTS));
    // the languages the page has a catalog for
    expect(Object.keys(i18n.options.resources ?? {}).sort()).toEqual([...SETTINGS_UI_LANGUAGES].sort());
  });

  test("the schema's choices are what its keys accept", () => {
    expect(SETTINGS_SCHEMA["ui.theme"].type.values).toBe(SETTINGS_UI_THEMES);
    expect(SETTINGS_SCHEMA["ui.density"].type.values).toBe(SETTINGS_UI_DENSITIES);
    expect(SETTINGS_SCHEMA["ui.language"].type.values).toBe(SETTINGS_UI_LANGUAGES);
    expect(SETTINGS_SCHEMA["ui.accent"].type.values).toBe(SETTINGS_UI_ACCENTS);
    expect(SETTINGS_SCHEMA["ui.labels"].type.kind).toBe("boolean");
  });

  test("the defaults are the same on both sides", () => {
    // What a page starts with when neither the server nor this browser says anything.
    const tweaks = bootTweaks();
    expect(tweaks).toEqual(DEFAULT_TWEAKS);
    expect({
      language: tweaks.language,
      theme: tweaks.theme,
      accent: tweaks.accent,
      density: tweaks.density,
      labels: tweaks.labels,
    }).toEqual({
      language: SETTINGS_SCHEMA["ui.language"].default,
      theme: SETTINGS_SCHEMA["ui.theme"].default,
      accent: SETTINGS_SCHEMA["ui.accent"].default,
      density: SETTINGS_SCHEMA["ui.density"].default,
      labels: SETTINGS_SCHEMA["ui.labels"].default,
    });
    expect(DEFAULT_LANGUAGE).toBe(SETTINGS_SCHEMA["ui.language"].default);
    // the page's preferences have exactly the schema's five [ui] keys
    expect(Object.keys(tweaks).sort()).toEqual(
      Object.keys(SETTINGS_SCHEMA)
        .filter((key) => key.startsWith("ui."))
        .map((key) => key.slice(3))
        .sort()
    );
  });
});
