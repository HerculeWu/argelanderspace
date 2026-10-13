/**
 * The Settings schema as the config file's readers use it: the strict reading's new keys and the order of its
 * faults, the lenient reading, and the key list derived from the schema. The strict reading's long-standing
 * behaviour is pinned by `config.test.ts`, which this ticket leaves as it was.
 */

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
  defaultSettings,
  isAbsoluteOnAnyPlatform,
  SETTING_KEYS,
  SETTINGS_LOG_LEVELS,
  SETTINGS_SCHEMA,
  TOP_LEVEL_SETTING_KEYS,
} from "@argelanderspace/contracts";
import { describe, expect, test } from "vitest";
import {
  CONFIG_KEYS,
  ConfigError,
  configFileKeys,
  loadConfigFile,
  parseConfigToml,
  readSettingsFile,
  readSettingsText,
} from "../src/config.js";
import { LOG_LEVELS } from "../src/log/logger.js";

function fileWith(text: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "aspace-settings-"));
  const path = join(dir, "config.toml");
  writeFileSync(path, text);
  return path;
}

function strictError(toml: string): string {
  try {
    parseConfigToml(toml, "/p/config.toml");
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error("expected a ConfigError");
}

describe("the key list comes from the schema", () => {
  test("CONFIG_KEYS is the schema's top-level keys, the long-standing ones first and in their order", () => {
    expect(CONFIG_KEYS).toBe(TOP_LEVEL_SETTING_KEYS);
    expect([...CONFIG_KEYS]).toEqual([
      "data_dir",
      "port",
      "openalex_api_key",
      "ads_dev_key",
      "global_dir",
      "global_cache_dir",
      "auto_ingest_arxiv",
      "log_level",
      "contact_email",
      "tex_dir",
    ]);
    for (const key of CONFIG_KEYS) expect(SETTINGS_SCHEMA[key].table).toBeNull();
  });

  test("the log levels are the schema's list", () => {
    expect(LOG_LEVELS).toBe(SETTINGS_LOG_LEVELS);
    expect([...LOG_LEVELS]).toEqual(["debug", "info", "warn", "error"]);
  });

  test("configFileKeys: new top-level keys are named; a table is one more entry, and nothing in it is named", () => {
    const path = fileWith(
      [
        'tex_dir = "/opt/tex"',
        'contact_email = "a@example.org"',
        "port = 1",
        'private_name = "v"',
        "[ui]",
        'theme = "dark"',
        'private_ui_name = "v"',
        "[other]",
        "x = 1",
        "",
      ].join("\n")
    );
    // Schema order, not file order. `[ui]`, `[other]` and `private_name` are the three others.
    expect(configFileKeys(path)).toEqual({
      known: ["port", "contact_email", "tex_dir"],
      unknown: 3,
    });
    expect(JSON.stringify(configFileKeys(path))).not.toMatch(/private|theme|ui|other/);
  });
});

describe("the strict reading: the keys added with the schema", () => {
  test("contact_email, tex_dir and [ui] are returned as written", () => {
    const cfg = parseConfigToml(
      [
        'contact_email = "reader@example.org"',
        "tex_dir = 'C:\\texlive\\2025\\bin\\windows'",
        "[ui]",
        'language = "en"',
        'theme = "light"',
        'accent = "teal"',
        'density = "comfy"',
        "labels = false",
        'future = "ignored"',
        "[ui.extra]",
        "x = 1",
      ].join("\n"),
      "/p"
    );
    expect(cfg).toEqual({
      contact_email: "reader@example.org",
      tex_dir: "C:\\texlive\\2025\\bin\\windows",
      ui: { language: "en", theme: "light", accent: "teal", density: "comfy", labels: false },
    });
    expect(parseConfigToml('tex_dir = "/usr/bin"', "/p").tex_dir).toBe("/usr/bin");
    expect(parseConfigToml("[ui]\n", "/p")).toEqual({});
    expect(parseConfigToml('[ui]\ntheme = "dark"', "/p")).toEqual({ ui: { theme: "dark" } });
  });

  test("a blank optional string is not a fault and is returned as written", () => {
    expect(parseConfigToml('tex_dir = ""\ncontact_email = " "', "/p")).toEqual({
      tex_dir: "",
      contact_email: " ",
    });
  });

  test("each new key's fault names the key and what it must be", () => {
    const cases: Array<[string, string]> = [
      ["contact_email = 3", '"contact_email" must be a string'],
      ["tex_dir = 3", '"tex_dir" must be a string'],
      ['tex_dir = "texlive/bin"', '"tex_dir" must be an absolute path'],
      ['tex_dir = "~/texlive"', '"tex_dir" must be an absolute path'],
      ["ui = 3", '"ui" must be a table'],
      ['ui = ["dark"]', '"ui" must be a table'],
      ['[[ui]]\ntheme = "dark"', '"ui" must be a table'],
      ['[ui]\nlanguage = "fr"', '"ui.language" must be one of zh-CN, en'],
      ["[ui]\nlanguage = 1", '"ui.language" must be one of zh-CN, en'],
      ['[ui]\ntheme = "blue"', '"ui.theme" must be one of dark, light'],
      ['[ui]\naccent = "pink"', '"ui.accent" must be one of azure, teal, violet, amber, neutral'],
      ['[ui]\ndensity = "cozy"', '"ui.density" must be one of compact, regular, comfy'],
      ['[ui]\nlabels = "yes"', '"ui.labels" must be a boolean'],
      ['ui.theme = "blue"', '"ui.theme" must be one of dark, light'],
      ['ui = { theme = "blue" }', '"ui.theme" must be one of dark, light'],
    ];
    for (const [toml, sentence] of cases) {
      expect(strictError(toml)).toBe(`/p/config.toml: ${sentence}`);
    }
  });

  test("no fault echoes the value", () => {
    const marker = "MARKER-51c9";
    for (const toml of [
      `contact_email = ["${marker}"]`,
      `tex_dir = "${marker}"`,
      `ui = "${marker}"`,
      `[ui]\ntheme = "${marker}"`,
      `[ui]\naccent = "${marker}"`,
      `[ui]\nlabels = "${marker}"`,
    ]) {
      expect(strictError(toml)).not.toContain(marker);
    }
  });

  test("a file with several faults reports the one it always did, and the new keys come last", () => {
    // The long-standing order: the type of each plain string key (data_dir, openalex_api_key, ads_dev_key,
    // global_dir, global_cache_dir), then port, auto_ingest_arxiv, data_dir's relative-path rule, log_level.
    const faults: Array<[line: string, inUi: boolean, sentence: string]> = [
      ["data_dir = 1", false, '"data_dir" must be a string'],
      ["openalex_api_key = 1", false, '"openalex_api_key" must be a string'],
      ["ads_dev_key = 1", false, '"ads_dev_key" must be a string'],
      ["global_dir = 1", false, '"global_dir" must be a string'],
      ["global_cache_dir = 1", false, '"global_cache_dir" must be a string'],
      ['port = "x"', false, '"port" must be an integer between 0 and 65535'],
      ["auto_ingest_arxiv = 1", false, '"auto_ingest_arxiv" must be a boolean'],
      ['log_level = "x"', false, '"log_level" must be one of debug, info, warn, error'],
      ["contact_email = 1", false, '"contact_email" must be a string'],
      ["tex_dir = 1", false, '"tex_dir" must be a string'],
      ['language = "x"', true, '"ui.language" must be one of zh-CN, en'],
      ['theme = "x"', true, '"ui.theme" must be one of dark, light'],
      ['accent = "x"', true, '"ui.accent" must be one of azure, teal, violet, amber, neutral'],
      ['density = "x"', true, '"ui.density" must be one of compact, regular, comfy'],
      ["labels = 1", true, '"ui.labels" must be a boolean'],
    ];
    // Take the faults away one at a time in the order they should be reported. The file lists them in the
    // reverse order, so the order of the report is not the order of the file.
    for (let i = 0; i < faults.length; i++) {
      const left = faults.slice(i).reverse();
      const toml = [
        ...left.filter(([, inUi]) => !inUi).map(([line]) => line),
        "[ui]",
        ...left.filter(([, inUi]) => inUi).map(([line]) => line),
      ].join("\n");
      expect(strictError(toml)).toBe(`/p/config.toml: ${faults[i]?.[2]}`);
    }
  });

  test("data_dir's relative-path rule comes after port and auto_ingest_arxiv and before log_level and the new keys", () => {
    const all = 'data_dir = "/abs"\nlog_level = "x"\ntex_dir = "rel"\n[ui]\ntheme = "x"';
    expect(strictError(`port = "x"\nauto_ingest_arxiv = 1\n${all}`)).toBe(
      '/p/config.toml: "port" must be an integer between 0 and 65535'
    );
    expect(strictError(`auto_ingest_arxiv = 1\n${all}`)).toBe(
      '/p/config.toml: "auto_ingest_arxiv" must be a boolean'
    );
    expect(strictError(all)).toBe('/p/config.toml: "data_dir" must be a relative path');
    expect(strictError('log_level = "x"\ntex_dir = "rel"\n[ui]\ntheme = "x"')).toBe(
      '/p/config.toml: "log_level" must be one of debug, info, warn, error'
    );
    expect(strictError('tex_dir = "rel"\n[ui]\ntheme = "x"')).toBe(
      '/p/config.toml: "tex_dir" must be an absolute path'
    );
    expect(strictError('openalex_api_key = 1\ndata_dir = "/abs"\nport = "x"')).toBe(
      '/p/config.toml: "openalex_api_key" must be a string'
    );
  });

  test("a relative global_dir is still not a fault of the strict reading (it is judged where the directory is resolved)", () => {
    expect(parseConfigToml('global_dir = "rel"\nglobal_cache_dir = "rel2"', "/p")).toEqual({
      global_dir: "rel",
      global_cache_dir: "rel2",
    });
  });

  test("data_dir as it has always been read: an empty string and a tilde are relative paths", () => {
    expect(parseConfigToml('data_dir = ""', "/p")).toEqual({ data_dir: "" });
    expect(parseConfigToml('data_dir = "~/lit"', "/p")).toEqual({ data_dir: "~/lit" });
  });

  test("a byte order mark is still not TOML to the strict reading", () => {
    expect(strictError("\uFEFFport = 1")).toMatch(/^invalid TOML in \/p\/config\.toml:\n/);
  });

  test("the absolute-path rule is node:path's on both platforms", () => {
    const parts = [
      "",
      "/",
      "\\",
      "C:",
      "c:",
      "a",
      ".",
      "..",
      "~",
      " ",
      "//",
      "\\\\",
      "C:/",
      "Z:\\",
      "1:",
      ":",
    ];
    for (const a of parts) {
      for (const b of parts) {
        for (const c of ["", "x", "/x", "\\x"]) {
          const path = a + b + c;
          expect(isAbsoluteOnAnyPlatform(path), JSON.stringify(path)).toBe(
            posix.isAbsolute(path) || win32.isAbsolute(path)
          );
        }
      }
    }
  });
});

describe("the lenient reading", () => {
  test("a good file: values from the file, the rest defaults, nothing wrong", () => {
    const got = readSettingsText('port = 1900\n[ui]\ntheme = "light"\n');
    expect(got.file).toBe("read");
    expect(got.problems).toEqual([]);
    expect(got.values).toEqual({ ...defaultSettings(), port: 1900, "ui.theme": "light" });
    expect(got.sources.port).toBe("file");
    expect(got.sources.data_dir).toBe("default");
    expect(got.present).toEqual(["port", "ui.theme"]);
  });

  test("a file that is not TOML: every default and one whole-file problem", () => {
    for (const text of ["port = \n", "this is = = not toml", "port = 1\nport = 2", "[ui]\n[ui]"]) {
      const got = readSettingsText(`${text}\nlog_level = "debug"`);
      expect(got.file).toBe("unparseable");
      expect(got.problems).toEqual([{ key: null, reason: "unparseable" }]);
      expect(got.values).toEqual(defaultSettings());
      expect(got.present).toEqual([]);
      for (const key of SETTING_KEYS) expect(got.sources[key]).toBe("default");
    }
  });

  test("one faulty key: that key gets its default, the others keep the file's values", () => {
    const got = readSettingsText('port = 70000\nlog_level = "debug"\ndata_dir = "lit"\n');
    expect(got.file).toBe("read");
    expect(got.problems).toEqual([{ key: "port", reason: "out_of_range" }]);
    expect(got.values).toEqual({ ...defaultSettings(), log_level: "debug", data_dir: "lit" });
    expect(got.sources.port).toBe("default");
  });

  test("several faulty keys: each is listed, in schema order, with its category", () => {
    const got = readSettingsText(
      [
        'log_level = "loud"',
        'tex_dir = "rel"',
        'data_dir = "/abs"',
        "auto_ingest_arxiv = 1",
        'global_dir = "rel"',
        "contact_email = 1",
        'port = "x"',
        "openalex_api_key = 1",
        "[ui]",
        "labels = 1",
        'theme = "blue"',
        'density = "compact"',
      ].join("\n")
    );
    expect(got.problems).toEqual([
      { key: "data_dir", reason: "must_be_relative" },
      { key: "port", reason: "wrong_type" },
      { key: "openalex_api_key", reason: "wrong_type" },
      { key: "global_dir", reason: "must_be_absolute" },
      { key: "auto_ingest_arxiv", reason: "wrong_type" },
      { key: "log_level", reason: "not_one_of" },
      { key: "contact_email", reason: "wrong_type" },
      { key: "tex_dir", reason: "must_be_absolute" },
      { key: "ui.theme", reason: "not_one_of" },
      { key: "ui.labels", reason: "wrong_type" },
    ]);
    expect(got.values).toEqual({ ...defaultSettings(), "ui.density": "compact" });
  });

  test("a table that is not a table is one problem", () => {
    const got = readSettingsText("ui = 3\nport = 1900");
    expect(got.problems).toEqual([{ key: "ui", reason: "not_a_table" }]);
    expect(got.values).toEqual({ ...defaultSettings(), port: 1900 });
  });

  test("a deprecated key the file still has is in `present`", () => {
    const got = readSettingsText('ads_dev_key = "t"\n');
    expect(got.present).toEqual(["ads_dev_key"]);
    expect(got.problems).toEqual([]);
  });

  test("a byte order mark is looked past", () => {
    const got = readSettingsText("\uFEFFport = 1900\r\n");
    expect(got.file).toBe("read");
    expect(got.values.port).toBe(1900);
  });

  test("the problem list never carries a value, a parser message or an unknown key's name", () => {
    const marker = "MARKER-a81e";
    const texts = [
      // not TOML: the parser's message would quote the line
      `openalex_api_key = "${marker}"\n${marker} = = "${marker}"`,
      // faulty keys
      [
        `data_dir = "/${marker}"`,
        `port = "${marker}"`,
        `openalex_api_key = ["${marker}"]`,
        `log_level = "${marker}"`,
        `tex_dir = "${marker}"`,
        `contact_email = { ${marker} = "${marker}" }`,
        `${marker}_unknown = "${marker}"`,
        "[ui]",
        `theme = "${marker}"`,
        `accent = "${marker}"`,
        `${marker}_unknown = "${marker}"`,
      ].join("\n"),
      `ui = "${marker}"`,
    ];
    for (const text of texts) {
      const got = readSettingsText(text);
      expect(got.problems.length).toBeGreaterThan(0);
      expect(JSON.stringify(got)).not.toContain(marker);
    }
    // and from a file
    const got = readSettingsFile(fileWith(texts[0] as string));
    expect(got.file).toBe("unparseable");
    expect(JSON.stringify(got)).not.toContain(marker);
  });

  test("readSettingsFile: a missing file is all defaults with nothing wrong", () => {
    const got = readSettingsFile(join(tmpdir(), "aspace-definitely-missing", "config.toml"));
    expect(got.file).toBe("missing");
    expect(got.problems).toEqual([]);
    expect(got.values).toEqual(defaultSettings());
  });

  test("readSettingsFile: a path that cannot be read is all defaults and one whole-file problem, without the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "aspace-settings-dir-"));
    const got = readSettingsFile(dir);
    expect(got.file).toBe("unreadable");
    expect(got.problems).toEqual([{ key: null, reason: "unreadable" }]);
    expect(got.values).toEqual(defaultSettings());
    expect(JSON.stringify(got)).not.toContain(dir);
  });

  test.skipIf(process.getuid?.() === 0)("readSettingsFile: a file without read permission", () => {
    const path = fileWith("port = 1900\n");
    chmodSync(path, 0o000);
    expect(readSettingsFile(path).problems).toEqual([{ key: null, reason: "unreadable" }]);
    chmodSync(path, 0o600);
  });

  test("the strict reading of the same faulty file still throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "aspace-settings-both-"));
    mkdirSync(join(dir, "argelanderspace"));
    const path = join(dir, "argelanderspace", "config.toml");
    writeFileSync(path, "port = 70000\n");
    expect(readSettingsFile(path).values.port).toBe(1859);
    expect(() => loadConfigFile(path)).toThrow(
      `${path}: "port" must be an integer between 0 and 65535`
    );
  });
});
