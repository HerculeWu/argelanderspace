import { describe, expect, test } from "vitest";
import {
  checkSettingValue,
  DEFAULT_PORT,
  defaultSettings,
  evaluateSettings,
  isAbsoluteOnAnyPlatform,
  isSecretSetting,
  isSettingKey,
  redactSettingsValues,
  SECRET_SETTING_KEYS,
  SETTING_KEYS,
  SETTINGS_GROUPS,
  SETTINGS_SCHEMA,
  type SettingKey,
  type SettingValueProblem,
  TOP_LEVEL_SETTING_KEYS,
} from "../src/index.js";

describe("the Settings schema", () => {
  test("the keys, where they sit, and what the page does with them", () => {
    const rows = SETTING_KEYS.map((key) => {
      const d = SETTINGS_SCHEMA[key];
      return [key, d.table, d.name, d.type.kind, d.default, d.group, d.ui, d.restart];
    });
    expect(rows).toEqual([
      ["data_dir", null, "data_dir", "string", "./literatures", "project", "edit", true],
      ["port", null, "port", "integer", 1859, "advanced", "edit", true],
      ["openalex_api_key", null, "openalex_api_key", "string", null, "services", "none", false],
      ["ads_dev_key", null, "ads_dev_key", "string", null, "services", "none", false],
      ["global_dir", null, "global_dir", "string", null, "advanced", "readonly", true],
      ["global_cache_dir", null, "global_cache_dir", "string", null, "advanced", "readonly", true],
      ["auto_ingest_arxiv", null, "auto_ingest_arxiv", "boolean", true, "project", "edit", false],
      ["log_level", null, "log_level", "enum", "info", "diagnostics", "edit", false],
      ["contact_email", null, "contact_email", "string", null, "services", "edit", false],
      ["tex_dir", null, "tex_dir", "string", null, "tex", "edit", false],
      ["ui.language", "ui", "language", "enum", "zh-CN", "appearance", "edit", false],
      ["ui.theme", "ui", "theme", "enum", "dark", "appearance", "edit", false],
      ["ui.accent", "ui", "accent", "enum", "azure", "appearance", "edit", false],
      ["ui.density", "ui", "density", "enum", "regular", "appearance", "edit", false],
      ["ui.labels", "ui", "labels", "boolean", true, "appearance", "edit", false],
    ]);
    expect(SETTINGS_SCHEMA.port.default).toBe(DEFAULT_PORT);
  });

  test("the identifier of a key is its name, prefixed by its table", () => {
    for (const key of SETTING_KEYS) {
      const { table, name } = SETTINGS_SCHEMA[key];
      expect(key).toBe(table === null ? name : `${table}.${name}`);
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    expect(TOP_LEVEL_SETTING_KEYS).toEqual(SETTING_KEYS.filter((key) => !key.includes(".")));
  });

  test("the groups are the nine of the settings page, and every key is in one", () => {
    expect(SETTINGS_GROUPS).toEqual([
      "appearance",
      "project",
      "services",
      "tex",
      "copilot",
      "mail",
      "cli",
      "diagnostics",
      "advanced",
    ]);
    for (const key of SETTING_KEYS) expect(SETTINGS_GROUPS).toContain(SETTINGS_SCHEMA[key].group);
  });

  test("only the ADS key is deprecated; it is still a known key", () => {
    const deprecated = SETTING_KEYS.filter(
      (key) => (SETTINGS_SCHEMA[key] as { deprecated?: true }).deprecated
    );
    expect(deprecated).toEqual(["ads_dev_key"]);
    expect(isSettingKey("ads_dev_key")).toBe(true);
  });

  test("isSettingKey knows the schema's keys and nothing inherited", () => {
    expect(isSettingKey("ui.theme")).toBe(true);
    for (const no of ["theme", "ui", "toString", "__proto__", "constructor", "", 3, null]) {
      expect(isSettingKey(no)).toBe(false);
    }
  });

  test("every default is acceptable for its own key", () => {
    const defaults = defaultSettings();
    for (const key of SETTING_KEYS) {
      if (defaults[key] !== null) expect(checkSettingValue(key, defaults[key])).toBeNull();
    }
    expect(defaultSettings()).not.toBe(defaultSettings());
  });
});

type Case = [SettingKey, unknown, SettingValueProblem | null];

describe("checkSettingValue", () => {
  const cases: Case[] = [
    // data_dir: a string that is not absolute; "" and "~/x" are relative as written
    ["data_dir", "papers", null],
    ["data_dir", "./literatures", null],
    ["data_dir", "../shared", null],
    ["data_dir", "", null],
    ["data_dir", "~/lit", null],
    ["data_dir", "a\\b", null],
    ["data_dir", "/abs", "must_be_relative"],
    ["data_dir", "C:\\lit", "must_be_relative"],
    ["data_dir", "C:/lit", "must_be_relative"],
    ["data_dir", "\\\\host\\share", "must_be_relative"],
    ["data_dir", 3, "wrong_type"],
    ["data_dir", ["x"], "wrong_type"],
    // port
    ["port", 0, null],
    ["port", 1859, null],
    ["port", 65535, null],
    ["port", -1, "out_of_range"],
    ["port", 65536, "out_of_range"],
    ["port", 1.5, "wrong_type"],
    ["port", "1859", "wrong_type"],
    ["port", Number.NaN, "wrong_type"],
    ["port", BigInt(10), "wrong_type"],
    // plain strings
    ["openalex_api_key", "k", null],
    ["openalex_api_key", "", null],
    ["openalex_api_key", 42, "wrong_type"],
    ["ads_dev_key", "k", null],
    ["ads_dev_key", false, "wrong_type"],
    // the global directories: absolute, blank means not set
    ["global_dir", "/g", null],
    ["global_dir", "C:\\g", null],
    ["global_dir", "  ", null],
    ["global_dir", "rel/g", "must_be_absolute"],
    ["global_dir", 1, "wrong_type"],
    ["global_cache_dir", "/c", null],
    ["global_cache_dir", "", null],
    ["global_cache_dir", "c", "must_be_absolute"],
    ["global_cache_dir", {}, "wrong_type"],
    // booleans
    ["auto_ingest_arxiv", true, null],
    ["auto_ingest_arxiv", false, null],
    ["auto_ingest_arxiv", "no", "wrong_type"],
    ["auto_ingest_arxiv", 0, "wrong_type"],
    // log_level
    ["log_level", "debug", null],
    ["log_level", "info", null],
    ["log_level", "warn", null],
    ["log_level", "error", null],
    ["log_level", "loud", "not_one_of"],
    ["log_level", "INFO", "not_one_of"],
    ["log_level", 3, "wrong_type"],
    // contact_email: any string
    ["contact_email", "reader@example.org", null],
    ["contact_email", "", null],
    ["contact_email", 5, "wrong_type"],
    ["contact_email", new Date(0), "wrong_type"],
    // tex_dir: absolute in either writing, blank means not set
    ["tex_dir", "/usr/local/texlive/2025/bin/x86_64-linux", null],
    ["tex_dir", "C:\\texlive\\2025\\bin\\windows", null],
    ["tex_dir", "", null],
    ["tex_dir", " \t", null],
    ["tex_dir", "texlive/bin", "must_be_absolute"],
    ["tex_dir", "~/texlive/bin", "must_be_absolute"],
    ["tex_dir", "C:texlive", "must_be_absolute"],
    ["tex_dir", true, "wrong_type"],
    // [ui]
    ["ui.language", "zh-CN", null],
    ["ui.language", "en", null],
    ["ui.language", "zh", "not_one_of"],
    ["ui.language", "fr", "not_one_of"],
    ["ui.language", 1, "wrong_type"],
    ["ui.theme", "dark", null],
    ["ui.theme", "light", null],
    ["ui.theme", "blue", "not_one_of"],
    ["ui.theme", true, "wrong_type"],
    ["ui.accent", "azure", null],
    ["ui.accent", "teal", null],
    ["ui.accent", "violet", null],
    ["ui.accent", "amber", null],
    ["ui.accent", "neutral", null],
    ["ui.accent", "pink", "not_one_of"],
    ["ui.accent", "toString", "not_one_of"],
    ["ui.accent", 235, "wrong_type"],
    ["ui.density", "compact", null],
    ["ui.density", "regular", null],
    ["ui.density", "comfy", null],
    ["ui.density", "cozy", "not_one_of"],
    ["ui.density", 2, "wrong_type"],
    ["ui.labels", true, null],
    ["ui.labels", false, null],
    ["ui.labels", "true", "wrong_type"],
    ["ui.labels", 1, "wrong_type"],
  ];
  test.each(cases)("%s: case %# → %s", (key, value, expected) => {
    expect(checkSettingValue(key, value)).toBe(expected);
  });

  test("every key has a case that passes and a case that fails", () => {
    for (const key of SETTING_KEYS) {
      expect(cases.some(([k, , r]) => k === key && r === null)).toBe(true);
      expect(cases.some(([k, , r]) => k === key && r !== null)).toBe(true);
    }
  });
});

describe("isAbsoluteOnAnyPlatform", () => {
  test("absolute in POSIX or in Windows writing", () => {
    for (const yes of ["/", "/a", "\\a", "C:\\a", "c:/a", "\\\\host\\share", "//host/share"]) {
      expect(isAbsoluteOnAnyPlatform(yes)).toBe(true);
    }
    for (const no of ["", "a", "./a", "../a", "~/a", "C:", "C:a", "a/b", "a\\b", " /a", "1:/a"]) {
      expect(isAbsoluteOnAnyPlatform(no)).toBe(false);
    }
  });
});

describe("evaluateSettings", () => {
  test("an empty document is every default, from nowhere, with nothing wrong", () => {
    const got = evaluateSettings({});
    expect(got.values).toEqual(defaultSettings());
    expect(new Set(Object.values(got.sources))).toEqual(new Set(["default"]));
    expect(got.problems).toEqual([]);
    expect(got.present).toEqual([]);
  });

  test("acceptable values come from the file; unknown keys and tables are ignored", () => {
    const got = evaluateSettings({
      port: 1900,
      data_dir: "lit",
      future_key: "x",
      other: { theme: "blue" },
      ui: { theme: "light", labels: false, extra: { deep: 1 }, future: 3 },
    });
    expect(got.problems).toEqual([]);
    expect(got.values).toEqual({
      ...defaultSettings(),
      port: 1900,
      data_dir: "lit",
      "ui.theme": "light",
      "ui.labels": false,
    });
    expect(got.present).toEqual(["data_dir", "port", "ui.theme", "ui.labels"]);
    expect(got.sources.port).toBe("file");
    expect(got.sources["ui.theme"]).toBe("file");
    expect(got.sources["ui.accent"]).toBe("default");
    expect(got.sources.log_level).toBe("default");
  });

  test("a faulty key gets its default and a problem; the others keep their values", () => {
    const got = evaluateSettings({
      port: 70000,
      data_dir: "/abs",
      log_level: "debug",
      tex_dir: "rel",
      ui: { theme: "blue", density: "compact", labels: "yes" },
    });
    expect(got.problems).toEqual([
      { key: "data_dir", reason: "must_be_relative" },
      { key: "port", reason: "out_of_range" },
      { key: "tex_dir", reason: "must_be_absolute" },
      { key: "ui.theme", reason: "not_one_of" },
      { key: "ui.labels", reason: "wrong_type" },
    ]);
    expect(got.values).toEqual({
      ...defaultSettings(),
      log_level: "debug",
      "ui.density": "compact",
    });
    expect(got.sources.port).toBe("default");
    expect(got.sources["ui.theme"]).toBe("default");
    expect(got.sources["ui.density"]).toBe("file");
    expect(got.present).toEqual([
      "data_dir",
      "port",
      "log_level",
      "tex_dir",
      "ui.theme",
      "ui.density",
      "ui.labels",
    ]);
  });

  test("a blank optional string is present in the file but not a value", () => {
    const got = evaluateSettings({ contact_email: "  ", tex_dir: "", global_dir: "" });
    expect(got.problems).toEqual([]);
    expect(got.values).toEqual(defaultSettings());
    expect(got.present).toEqual(["global_dir", "contact_email", "tex_dir"]);
    expect(got.sources.contact_email).toBe("default");
    // data_dir has no such rule: "" is a value
    expect(evaluateSettings({ data_dir: "" }).values.data_dir).toBe("");
  });

  test("a table that is not a table is one problem, named by the table", () => {
    for (const ui of [3, "dark", ["dark"], [{ theme: "dark" }], new Date(0), null, true]) {
      const got = evaluateSettings({ ui, port: 1900 });
      expect(got.problems).toEqual([{ key: "ui", reason: "not_a_table" }]);
      expect(got.values).toEqual({ ...defaultSettings(), port: 1900 });
      expect(got.present).toEqual(["port"]);
    }
  });

  test("something that is not a document at all is every default", () => {
    for (const doc of [null, undefined, 3, "x", []]) {
      expect(evaluateSettings(doc).values).toEqual(defaultSettings());
    }
  });

  test("inherited names are not read as keys", () => {
    const got = evaluateSettings(Object.create({ port: 1, ui: { theme: "light" } }));
    expect(got.values).toEqual(defaultSettings());
    expect(got.present).toEqual([]);
  });

  test("no problem carries a value", () => {
    const marker = "MARKER-7f3a";
    const got = evaluateSettings({
      data_dir: `/${marker}`,
      port: marker,
      openalex_api_key: [marker],
      log_level: marker,
      tex_dir: marker,
      contact_email: { [marker]: marker },
      ui: { theme: marker, accent: marker, language: marker, density: marker, labels: marker },
      [marker]: marker,
    });
    expect(got.problems.length).toBe(11);
    expect(JSON.stringify(got.problems)).not.toContain(marker);
    expect(JSON.stringify(got.values)).not.toContain(marker);
    expect(JSON.stringify(got.present)).not.toContain(marker);
  });
});

describe("secret settings", () => {
  test("the two credentials are marked secret in the schema, and no other key is", () => {
    const marked = SETTING_KEYS.filter(
      (key) => (SETTINGS_SCHEMA[key] as { secret?: true }).secret === true
    );
    expect(marked).toEqual(["openalex_api_key", "ads_dev_key"]);
    expect([...SECRET_SETTING_KEYS]).toEqual(marked);
    for (const key of SETTING_KEYS) {
      expect(Object.hasOwn(SETTINGS_SCHEMA[key], "secret"), key).toBe(marked.includes(key));
      expect(isSecretSetting(key), key).toBe(marked.includes(key));
    }
  });

  test("redactSettingsValues: a secret key says only whether it is set; every other value is as it was", () => {
    const marker = "SECRET-MARKER-7f3a";
    const { values } = evaluateSettings({
      openalex_api_key: `${marker}-openalex`,
      ads_dev_key: `${marker}-ads`,
      port: 1900,
      contact_email: "reader@example.org",
      ui: { theme: "light" },
    });
    // the reading itself still has the values (ticket 12 stops reading them)
    expect(values.openalex_api_key).toBe(`${marker}-openalex`);
    const shown = redactSettingsValues(values);
    expect(JSON.stringify(shown)).not.toContain(marker);
    expect(shown.openalex_api_key).toEqual({ secret: true, set: true });
    expect(shown.ads_dev_key).toEqual({ secret: true, set: true });
    expect(Object.keys(shown)).toEqual(SETTING_KEYS);
    for (const key of SETTING_KEYS) {
      if (!isSecretSetting(key)) expect(shown[key], key).toBe(values[key]);
    }
    expect(shown.port).toBe(1900);
    expect(shown["ui.theme"]).toBe("light");
    // the input is not changed
    expect(values.ads_dev_key).toBe(`${marker}-ads`);
  });

  test("redactSettingsValues: not set, and set to nothing but blanks, are both 'not set'", () => {
    const none = redactSettingsValues(defaultSettings());
    expect(none.openalex_api_key).toEqual({ secret: true, set: false });
    expect(none.ads_dev_key).toEqual({ secret: true, set: false });
    const blank = redactSettingsValues(
      evaluateSettings({ openalex_api_key: "", ads_dev_key: " \t" }).values
    );
    expect(blank.openalex_api_key).toEqual({ secret: true, set: false });
    expect(blank.ads_dev_key).toEqual({ secret: true, set: false });
    // a value that should never be there is still not shown
    const odd = redactSettingsValues({
      ...defaultSettings(),
      openalex_api_key: 12345678 as unknown as string,
    });
    expect(odd.openalex_api_key).toEqual({ secret: true, set: true });
    expect(JSON.stringify(odd)).not.toContain("12345678");
  });
});
