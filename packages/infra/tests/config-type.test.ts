/**
 * `AppConfig` / `AppUiConfig` are derived from the Settings schema, on types only: every key of the schema is an
 * optional property of the type its schema type gives, and nothing else is. Checked by `tsc` (the typecheck covers
 * the tests); the runtime part only keeps vitest from finding an empty file.
 */

import type {
  SETTINGS_COPILOT_FILE_TOOLS,
  SETTINGS_UI_ACCENTS,
  SETTINGS_UI_DENSITIES,
  SETTINGS_UI_LANGUAGES,
  SETTINGS_UI_THEMES,
  TOP_LEVEL_SETTING_KEYS,
} from "@argelanderspace/contracts";
import { describe, expect, expectTypeOf, test } from "vitest";
import type { AppConfig, AppUiConfig } from "../src/config.js";
import type { LogLevel } from "../src/log/logger.js";

describe("AppConfig follows the schema", () => {
  test("every key of the schema is an optional property of its type", () => {
    expectTypeOf<AppConfig>().toEqualTypeOf<{
      data_dir?: string;
      port?: number;
      openalex_api_key?: string;
      ads_dev_key?: string;
      global_dir?: string;
      global_cache_dir?: string;
      auto_ingest_arxiv?: boolean;
      log_level?: LogLevel;
      contact_email?: string;
      tex_dir?: string;
      copilot_file_tools?: (typeof SETTINGS_COPILOT_FILE_TOOLS)[number];
      ui?: AppUiConfig;
    }>();
    expectTypeOf<AppUiConfig>().toEqualTypeOf<{
      language?: (typeof SETTINGS_UI_LANGUAGES)[number];
      theme?: (typeof SETTINGS_UI_THEMES)[number];
      accent?: (typeof SETTINGS_UI_ACCENTS)[number];
      density?: (typeof SETTINGS_UI_DENSITIES)[number];
      labels?: boolean;
    }>();
    expectTypeOf<NonNullable<AppConfig["log_level"]>>().toEqualTypeOf<LogLevel>();
    // The top-level keys of the schema, and `ui`, are exactly the properties.
    expectTypeOf<keyof AppConfig>().toEqualTypeOf<(typeof TOP_LEVEL_SETTING_KEYS)[number] | "ui">();
  });

  test("a key the schema does not have is not a property", () => {
    const config: AppConfig = {};
    // @ts-expect-error not a key of the schema
    void config.mystery_key;
    // @ts-expect-error a key of [ui] is not a top-level property
    void config.theme;
    const ui: AppUiConfig = {};
    // @ts-expect-error a top-level key is not a property of [ui]
    void ui.port;
    // @ts-expect-error the value has the schema's type
    const wrong: AppConfig = { port: "1859" };
    // @ts-expect-error an enum takes only its values
    const level: AppConfig = { log_level: "verbose" };
    expect([config, ui, wrong, level].length).toBe(4);
  });
});
