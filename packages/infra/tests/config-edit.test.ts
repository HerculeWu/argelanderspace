/**
 * The line editor of config.toml, compared byte for byte: what comes out is the input with one line changed, added
 * or removed, or a refusal with the input untouched.
 */

import { parse as parseToml } from "smol-toml";
import { describe, expect, test } from "vitest";
import { parseConfigToml, readSettingsText } from "../src/config.js";
import {
  CONFIG_EDIT_REFUSALS,
  type ConfigChange,
  type ConfigEditRefusal,
  checkConfigEdit,
  editConfigText,
  proposeConfigEdit,
} from "../src/config-edit.js";

const BOM = "\uFEFF";
const RESET: ConfigChange = { reset: true };
const set = (value: string | number | boolean): ConfigChange => ({ set: value });

/** The edited text; fails the test on a refusal. */
function edited(text: string, key: string, change: ConfigChange): string {
  const got = editConfigText(text, key, change);
  if (!got.ok) throw new Error(`refused: ${got.reason}`);
  expect(got.changed).toBe(got.text !== text);
  return got.text;
}

/**
 * The refusal's category; fails the test when the edit goes through. A refusal has `ok` and `reason` and nothing
 * else, so there is no text in it that could be a changed file. (That the file on disk keeps its bytes is
 * `config-write.test.ts`.)
 */
function refusal(text: string, key: string, change: ConfigChange): ConfigEditRefusal {
  const got = editConfigText(text, key, change);
  if (got.ok) throw new Error(`not refused: ${JSON.stringify(got.text)}`);
  expect(Object.keys(got)).toEqual(["ok", "reason"]);
  expect(CONFIG_EDIT_REFUSALS).toContain(got.reason);
  return got.reason;
}

describe("changing a value in place", () => {
  const FILE = [
    "# ArgelanderSpace — my settings",
    "",
    "# where the papers are",
    'data_dir = "lit"   # relative to the project',
    "port     = 1859   # the default",
    "",
    'future_key = "kept"',
    "auto_ingest_arxiv=true",
    "",
    "[ui]",
    "  # dark at night",
    '  theme = "dark"',
    "  labels = true # show them",
    "",
    "[unknown.table]",
    "port = 1",
    'theme = "x"',
    "",
  ].join("\n");

  test("only the value's bytes change: comments, blank lines, unknown keys and unknown tables stay", () => {
    expect(edited(FILE, "port", set(1900))).toBe(
      FILE.replace("port     = 1859   # the default", "port     = 1900   # the default")
    );
    expect(edited(FILE, "data_dir", set("papers/2026"))).toBe(
      FILE.replace('data_dir = "lit"   #', 'data_dir = "papers/2026"   #')
    );
    expect(edited(FILE, "auto_ingest_arxiv", set(false))).toBe(
      FILE.replace("auto_ingest_arxiv=true", "auto_ingest_arxiv=false")
    );
    expect(edited(FILE, "ui.theme", set("light"))).toBe(
      FILE.replace('  theme = "dark"', '  theme = "light"')
    );
    expect(edited(FILE, "ui.labels", set(false))).toBe(
      FILE.replace("  labels = true # show them", "  labels = false # show them")
    );
  });

  test("exactly one line differs", () => {
    const before = FILE.split("\n");
    const after = edited(FILE, "port", set(1900)).split("\n");
    expect(after.length).toBe(before.length);
    expect(after.filter((line, i) => line !== before[i])).toEqual([
      "port     = 1900   # the default",
    ]);
  });

  test("CRLF line endings stay CRLF", () => {
    const crlf = FILE.replace(/\n/g, "\r\n");
    expect(edited(crlf, "port", set(1900))).toBe(
      crlf.replace("port     = 1859   # the default", "port     = 1900   # the default")
    );
    expect(edited(crlf, "ui.theme", set("light"))).toBe(crlf.replace('"dark"', '"light"'));
  });

  test("a byte order mark stays", () => {
    expect(edited(`${BOM}port = 1\n`, "port", set(2))).toBe(`${BOM}port = 2\n`);
    expect(edited(`${BOM}${FILE}`, "ui.theme", set("light"))).toBe(
      `${BOM}${FILE.replace('"dark"', '"light"')}`
    );
    const crlf = `${BOM}${FILE.replace(/\n/g, "\r\n")}`;
    expect(edited(crlf, "port", set(7))).toBe(crlf.replace("= 1859 ", "= 7 "));
  });

  test("a file whose last line has no line ending", () => {
    expect(edited("port = 1", "port", set(2))).toBe("port = 2");
    expect(edited("a = 1\nport = 1 # c", "port", set(2))).toBe("a = 1\nport = 2 # c");
  });

  test("the ways a value can be written: the value alone is replaced", () => {
    const cases: Array<[string, string, ConfigChange, string]> = [
      ["port = 0x10", "port", set(17), "port = 17"],
      ["port = 1_000", "port", set(1001), "port = 1001"],
      ["port = +1", "port", set(2), "port = 2"],
      ["port = 0o17 # octal", "port", set(1), "port = 1 # octal"],
      ["port=1#c", "port", set(2), "port=2#c"],
      ["port =\t1\t# c", "port", set(2), "port =\t2\t# c"],
      ["\t port = 1", "port", set(2), "\t port = 2"],
      [
        'data_dir = "a # not a comment" # a comment',
        "data_dir",
        set("b"),
        'data_dir = "b" # a comment',
      ],
      ['data_dir = "a \\" b" # c', "data_dir", set("b"), 'data_dir = "b" # c'],
      ['data_dir = "a\\\\"# c', "data_dir", set("b"), 'data_dir = "b"# c'],
      ["data_dir = 'a # \" \\' # c", "data_dir", set("b"), 'data_dir = "b" # c'],
      ["data_dir = ''", "data_dir", set("b"), 'data_dir = "b"'],
      ["auto_ingest_arxiv = false", "auto_ingest_arxiv", set(true), "auto_ingest_arxiv = true"],
      // a value of the wrong type is still a scalar on one line: it can be put right
      ['port = "eighty" # oops', "port", set(80), "port = 80 # oops"],
      ["port = 1.5", "port", set(2), "port = 2"],
      ["port = 1979-05-27 07:32:00 # a date", "port", set(2), "port = 2 # a date"],
      ["port = inf", "port", set(2), "port = 2"],
      ['log_level = "loud"', "log_level", set("warn"), 'log_level = "warn"'],
      ["[ui]\ntheme = 3", "ui.theme", set("dark"), '[ui]\ntheme = "dark"'],
    ];
    for (const [text, key, change, expected] of cases) {
      expect(edited(text, key, change), text).toBe(expected);
    }
  });

  test("what follows a bare value on its line stays, whatever the parser trims", () => {
    // The parser ends a bare value with JavaScript's `trimEnd`: more than the blank and the tab TOML allows.
    const cases: Array<[string, string]> = [
      ["port = 80\u00a0# c\n", "port = 81\u00a0# c\n"],
      ["port = 80\r# c\n", "port = 81\r# c\n"],
      ["port = 80\r", "port = 81\r"],
      ["port = 80\f\n", "port = 81\f\n"],
      ["port = 80\u2028# c\n", "port = 81\u2028# c\n"],
      ["port = 80\ufeff\n", "port = 81\ufeff\n"],
      ["port = 80\u00a0", "port = 81\u00a0"],
      ["port = 80 \u00a0\t\u3000 # c\r\n", "port = 81 \u00a0\t\u3000 # c\r\n"],
      [
        "port = 80\v\u2029\u202f\u205f\u1680\u2003\nx = 1\n",
        "port = 81\v\u2029\u202f\u205f\u1680\u2003\nx = 1\n",
      ],
    ];
    for (const [text, expected] of cases) {
      // the parser does read the value, so this is a file the editor is asked about
      expect(parseToml(text).port, JSON.stringify(text)).toBe(80);
      expect(edited(text, "port", set(81)), JSON.stringify(text)).toBe(expected);
      // and removing the line removes what trails the value with it
      expect(edited(`a = 1\n${text}`, "port", RESET), JSON.stringify(text)).toBe(
        text.includes("x = 1") ? "a = 1\nx = 1\n" : "a = 1\n"
      );
    }
    // the parser trims after a number and a date, not after a boolean: that file is not TOML
    expect(refusal("[ui]\nlabels = true\u00a0# c\n", "ui.labels", set(false))).toBe("unparseable");
    // a quoted value never had this: the parser does not trim after it
    expect(refusal('data_dir = "a"\u00a0# c\n', "data_dir", set("b"))).toBe("unparseable");
  });

  test("minus zero is zero", () => {
    expect(edited("", "port", set(-0))).toBe("port = 0\n");
    expect(edited("port = 1 # c\n", "port", set(-0))).toBe("port = 0 # c\n");
    expect(editConfigText("port = 0\n", "port", set(-0))).toEqual({
      ok: true,
      text: "port = 0\n",
      changed: false,
    });
    expect(checkConfigEdit("port = 1\n", "port = 0\n", "port", set(-0))).toBe(true);
  });

  test("a quoted key is the key; its own bytes are kept", () => {
    expect(edited('"port" = 1 # c', "port", set(2))).toBe('"port" = 2 # c');
    expect(edited("'port' = 1", "port", set(2))).toBe("'port' = 2");
    expect(edited('"p\\u006frt" = 1', "port", set(2))).toBe('"p\\u006frt" = 2');
    expect(edited('[ui]\n"theme" = "dark"', "ui.theme", set("light"))).toBe(
      '[ui]\n"theme" = "light"'
    );
    // and it is seen when it must not be written a second time
    expect(edited('"port" = 1', "port", RESET)).toBe("");
  });

  test("the ways a table header can be written", () => {
    for (const header of [
      "[ui]",
      "[ ui ]",
      '["ui"]',
      "['ui']",
      "[ui] # looks",
      "  [ui]\t",
      '[ "u\\u0069" ]',
    ]) {
      expect(edited(`${header}\ntheme = "dark"\n`, "ui.theme", set("light")), header).toBe(
        `${header}\ntheme = "light"\n`
      );
      expect(edited(`${header}\nlabels = true\n`, "ui.theme", set("light")), header).toBe(
        `${header}\nlabels = true\ntheme = "light"\n`
      );
    }
  });

  test("asking for the value the key already has changes nothing, however it is written", () => {
    for (const [text, key, value] of [
      ["port = 0x10 # hex", "port", 16],
      ["port = 1_000", "port", 1000],
      ["port = +7", "port", 7],
      ["data_dir = 'lit'", "data_dir", "lit"],
      ['data_dir = "l\\u0069t"', "data_dir", "lit"],
      ["[ui]\nlabels = true", "ui.labels", true],
    ] as const) {
      expect(editConfigText(text, key, set(value))).toEqual({ ok: true, text, changed: false });
    }
  });
});

describe("the key's name elsewhere in the file is not the key", () => {
  test("in a comment, in a string, in another table, in a table inside an array, in a sub-table", () => {
    const text = [
      "# port = 1",
      'data_dir = "port = 2"',
      'openalex_api_key = """',
      "port = 3",
      'theme = "x"',
      '"""',
      "tex_dir = '''",
      "port = 4",
      "[ui]",
      "'''",
      "language = 5 # not ui.language: this is the top level",
      "[other]",
      "port = 6",
      "[[rows]]",
      "port = 7",
      "[ui.extra]",
      "theme = 8",
      "port = 9",
      "",
    ].join("\n");
    // `port` is not set at the top level: the new line goes after the last top-level key.
    expect(edited(text, "port", set(1900))).toBe(
      text.replace("[other]\n", "port = 1900\n[other]\n")
    );
    expect(edited(text, "port", RESET)).toBe(text);
    // `[ui]` only exists as the parent of `[ui.extra]`: a new `[ui]` goes at the end.
    expect(edited(text, "ui.theme", set("light"))).toBe(`${text}\n[ui]\ntheme = "light"\n`);
    expect(edited(text, "ui.language", set("en"))).toBe(`${text}\n[ui]\nlanguage = "en"\n`);
  });

  test("the top-level key and the key of the same name in a table are two keys", () => {
    // `language` and `theme` at the top level are unknown keys there
    const text =
      'language = "top"\ntheme = "top"\n[ui]\nlanguage = "zh-CN"\n[other]\nlanguage = "o"\n';
    expect(edited(text, "ui.language", set("en"))).toBe(
      'language = "top"\ntheme = "top"\n[ui]\nlanguage = "en"\n[other]\nlanguage = "o"\n'
    );
    expect(edited(text, "ui.theme", set("light"))).toBe(
      'language = "top"\ntheme = "top"\n[ui]\nlanguage = "zh-CN"\ntheme = "light"\n[other]\nlanguage = "o"\n'
    );
    expect(edited(text, "ui.language", RESET)).toBe(
      'language = "top"\ntheme = "top"\n[ui]\n[other]\nlanguage = "o"\n'
    );
  });

  test("a line inside a multi-line array that looks like the key", () => {
    const text = 'list = [\n  "a", # port = 1\n  "port = 2",\n]\nport = 3\n';
    expect(edited(text, "port", set(4))).toBe(text.replace("port = 3", "port = 4"));
  });

  test("a multi-line string that ends with quotes, and escaped quotes inside one", () => {
    const text = 'a = """x""""\nb = """\n\\"""\nport = 1\n"""\nc = \'\'\'y\'\'\'\'\'\nport = 2\n';
    expect(edited(text, "port", set(3))).toBe(text.replace("port = 2", "port = 3"));
  });
});

describe("adding a key the file does not have", () => {
  test("an empty file, a file of a byte order mark, a file of comments", () => {
    expect(edited("", "port", set(1900))).toBe("port = 1900\n");
    expect(edited(BOM, "port", set(1900))).toBe(`${BOM}port = 1900\n`);
    expect(edited("# only a comment\n", "port", set(1900))).toBe("# only a comment\nport = 1900\n");
    expect(edited("# only a comment", "port", set(1900))).toBe("# only a comment\nport = 1900");
    expect(edited("# a\r\n\r\n# b\r\n", "port", set(1))).toBe("# a\r\n\r\n# b\r\nport = 1\r\n");
    expect(edited("\n\n", "port", set(1))).toBe("\n\nport = 1\n");
    expect(edited("", "ui.theme", set("light"))).toBe('[ui]\ntheme = "light"\n');
    expect(edited(BOM, "ui.theme", set("light"))).toBe(`${BOM}[ui]\ntheme = "light"\n`);
  });

  test("a top-level key goes after the last top-level key, before blank lines and comments that follow it", () => {
    const text = '# top\ndata_dir = "lit"\n\n# about the page\n[ui]\ntheme = "dark"\n';
    expect(edited(text, "port", set(1900))).toBe(
      '# top\ndata_dir = "lit"\nport = 1900\n\n# about the page\n[ui]\ntheme = "dark"\n'
    );
  });

  test("it takes the indentation of the line it follows", () => {
    expect(edited("  data_dir = 'lit'\n", "port", set(1))).toBe("  data_dir = 'lit'\n  port = 1\n");
    expect(edited('[ui]\n\ttheme = "dark"\n', "ui.labels", set(false))).toBe(
      '[ui]\n\ttheme = "dark"\n\tlabels = false\n'
    );
  });

  test("it follows the whole of a value that spans lines", () => {
    const text = "list = [\n  1,\n  2,\n] # end\n\n[t]\nx = 1\n";
    expect(edited(text, "port", set(1))).toBe(
      "list = [\n  1,\n  2,\n] # end\nport = 1\n\n[t]\nx = 1\n"
    );
    const ml = 'openalex_api_key = """\nk\n"""\n';
    expect(edited(ml, "port", set(1))).toBe(`${ml}port = 1\n`);
  });

  test("a top level without keys: above the first header and the comment lines attached to it", () => {
    expect(edited('[ui]\ntheme = "dark"\n', "port", set(1))).toBe(
      'port = 1\n[ui]\ntheme = "dark"\n'
    );
    expect(edited(`${BOM}[ui]\r\ntheme = "dark"\r\n`, "port", set(1))).toBe(
      `${BOM}port = 1\r\n[ui]\r\ntheme = "dark"\r\n`
    );
    expect(edited("# my settings\n\n# the page\n  # (colours)\n[ui]\n", "port", set(1))).toBe(
      "# my settings\n\nport = 1\n# the page\n  # (colours)\n[ui]\n"
    );
    expect(edited("# the page\n[ui]\n", "port", set(1))).toBe("port = 1\n# the page\n[ui]\n");
    expect(edited(`${BOM}# the page\n[ui]\n`, "port", set(1))).toBe(
      `${BOM}port = 1\n# the page\n[ui]\n`
    );
    expect(edited("\n[[rows]]\nx = 1", "port", set(1))).toBe("\nport = 1\n[[rows]]\nx = 1");
  });

  test("a table's key goes after the table's last key, before what follows it", () => {
    const text = '[ui]\ntheme = "dark"\n\n# next\n[other]\nx = 1\n';
    expect(edited(text, "ui.labels", set(false))).toBe(
      '[ui]\ntheme = "dark"\nlabels = false\n\n# next\n[other]\nx = 1\n'
    );
  });

  test("a table without keys gets it right after the header", () => {
    expect(edited("[ui] # the page\n\n# c\n[other]\n", "ui.theme", set("light"))).toBe(
      '[ui] # the page\ntheme = "light"\n\n# c\n[other]\n'
    );
    expect(edited("[ui]", "ui.theme", set("light"))).toBe('[ui]\ntheme = "light"');
    expect(edited("port = 1\r\n[ui]\r\n", "ui.theme", set("light"))).toBe(
      'port = 1\r\n[ui]\r\ntheme = "light"\r\n'
    );
  });

  test("a table that is the last thing in the file", () => {
    expect(edited('port = 1\n[ui]\ntheme = "dark"', "ui.labels", set(true))).toBe(
      'port = 1\n[ui]\ntheme = "dark"\nlabels = true'
    );
    expect(edited('port = 1\n[ui]\ntheme = "dark"\n\n\n', "ui.labels", set(true))).toBe(
      'port = 1\n[ui]\ntheme = "dark"\nlabels = true\n\n\n'
    );
  });

  test("a table the file does not have is added at the end, after one blank line", () => {
    expect(edited("port = 1\n", "ui.theme", set("light"))).toBe(
      'port = 1\n\n[ui]\ntheme = "light"\n'
    );
    expect(edited("port = 1\n\n", "ui.theme", set("light"))).toBe(
      'port = 1\n\n[ui]\ntheme = "light"\n'
    );
    expect(edited("port = 1\n  \n", "ui.theme", set("light"))).toBe(
      'port = 1\n  \n[ui]\ntheme = "light"\n'
    );
    expect(edited("port = 1", "ui.theme", set("light"))).toBe('port = 1\n\n[ui]\ntheme = "light"');
    expect(edited("port = 1\r\n", "ui.theme", set("light"))).toBe(
      'port = 1\r\n\r\n[ui]\r\ntheme = "light"\r\n'
    );
    expect(edited("[other]\nx = 1\n[[rows]]\ny = 2\n", "ui.labels", set(false))).toBe(
      "[other]\nx = 1\n[[rows]]\ny = 2\n\n[ui]\nlabels = false\n"
    );
    expect(edited("\n", "ui.theme", set("dark"))).toBe('\n[ui]\ntheme = "dark"\n');
  });

  test("mixed line endings: a new line ends like the line before it; with none before it, like the first line", () => {
    // after a CRLF line
    expect(edited("a = 1\n\ndata_dir = 'x'\r\n[t]\n", "port", set(1))).toBe(
      "a = 1\n\ndata_dir = 'x'\r\nport = 1\r\n[t]\n"
    );
    // after an LF line in a file that is mostly CRLF
    expect(edited("a = 1\r\nb = 2\n[t]\r\n", "port", set(1))).toBe(
      "a = 1\r\nb = 2\nport = 1\n[t]\r\n"
    );
    // nothing before it: the first line ending of the file
    expect(edited("[t]\r\nx = 1\n", "port", set(1))).toBe("port = 1\r\n[t]\r\nx = 1\n");
    // a new table: the line ending the file ends with
    expect(edited("a = 1\r\nb = 2\n", "ui.labels", set(true))).toBe(
      "a = 1\r\nb = 2\n\n[ui]\nlabels = true\n"
    );
    // the last line has none: the first line ending of the file
    expect(edited("a = 1\r\nb = 2", "port", set(1))).toBe("a = 1\r\nb = 2\r\nport = 1");
    // the edited line itself keeps its own
    expect(edited("a = 1\nport = 1\r\nb = 2\n", "port", set(2))).toBe("a = 1\nport = 2\r\nb = 2\n");
  });
});

describe("restoring the default", () => {
  test("the key's line goes, with its comment and its line ending, and nothing else", () => {
    const text =
      '# top\ndata_dir = "lit"\nport = 1900 # mine\n\n[ui]\ntheme = "dark"\nlabels = false\n';
    expect(edited(text, "port", RESET)).toBe(text.replace("port = 1900 # mine\n", ""));
    expect(edited(text, "ui.theme", RESET)).toBe(text.replace('theme = "dark"\n', ""));
    const crlf = text.replace(/\n/g, "\r\n");
    expect(edited(crlf, "port", RESET)).toBe(crlf.replace("port = 1900 # mine\r\n", ""));
    expect(edited(`${BOM}port = 1\n`, "port", RESET)).toBe(BOM);
  });

  test("a key the file does not set: nothing changes", () => {
    for (const text of [
      "",
      BOM,
      "# c\n",
      'data_dir = "x"',
      "[ui]\nlabels = true\n",
      "[other]\nport = 1\n",
    ]) {
      expect(editConfigText(text, "port", RESET)).toEqual({ ok: true, text, changed: false });
      expect(editConfigText(text, "ui.theme", RESET)).toEqual({ ok: true, text, changed: false });
    }
  });

  test("the last key of a table: the header stays", () => {
    expect(edited('port = 1\n\n[ui] # page\ntheme = "dark"\n\n[other]\n', "ui.theme", RESET)).toBe(
      "port = 1\n\n[ui] # page\n\n[other]\n"
    );
    expect(edited('[ui]\ntheme = "dark"', "ui.theme", RESET)).toBe("[ui]\n");
  });

  test("the last line, without a line ending: only that line goes", () => {
    expect(edited("a = 1\nport = 2", "port", RESET)).toBe("a = 1\n");
    expect(edited("port = 2", "port", RESET)).toBe("");
    expect(edited("a = 1\r\nport = 2 # c", "port", RESET)).toBe("a = 1\r\n");
  });

  test("a faulty value can be removed", () => {
    expect(edited('a = 1\nport = "x"\nb = 2\n', "port", RESET)).toBe("a = 1\nb = 2\n");
    expect(edited("log_level = 3\n", "log_level", RESET)).toBe("");
  });

  test("set then restore gives back the original bytes when the key was absent", () => {
    for (const text of [
      "",
      "a = 1\n",
      "a = 1",
      "[ui]\n",
      "[ui]",
      "# c\r\n[ui]\r\nlabels = true\r\n",
    ]) {
      const withPort = edited(text, "port", set(5));
      const withTheme = edited(text, "ui.theme", set("light"));
      // A file whose last line had no line ending gets the removed line's separator left behind.
      const open = text !== "" && !text.endsWith("\n");
      if (!open) expect(edited(withPort, "port", RESET), text).toBe(text);
      if (!open && text.includes("[ui]")) expect(edited(withTheme, "ui.theme", RESET)).toBe(text);
    }
  });
});

describe("writing a string value", () => {
  test("quotes and backslashes are escaped; everything else is written as it is", () => {
    const cases: Array<[string, string]> = [
      ["/plain", '"/plain"'],
      ['/say "hi"', '"/say \\"hi\\""'],
      ["C:\\texlive\\2025\\bin\\windows", '"C:\\\\texlive\\\\2025\\\\bin\\\\windows"'],
      ["\\\\host\\share\\tex", '"\\\\\\\\host\\\\share\\\\tex"'],
      ["/opt/tex live/bin # not a comment", '"/opt/tex live/bin # not a comment"'],
      ["/home/吴/文献/tex", '"/home/吴/文献/tex"'],
      ["/opt/😀/'q'", "\"/opt/😀/'q'\""],
      ['/a\\"b', '"/a\\\\\\"b"'],
      ["/trailing\\", '"/trailing\\\\"'],
      ["/\u0085\u2028\u00a0", '"/\u0085\u2028\u00a0"'],
    ];
    for (const [value, written] of cases) {
      const text = edited("", "tex_dir", set(value));
      expect(text).toBe(`tex_dir = ${written}\n`);
      // and it reads back as the same value
      expect(parseConfigToml(text).tex_dir).toBe(value);
      expect(parseConfigToml(edited("tex_dir = '/old' # c\n", "tex_dir", set(value))).tex_dir).toBe(
        value
      );
    }
    expect(edited("", "data_dir", set('"a b"/x'))).toBe('data_dir = "\\"a b\\"/x"\n');
    expect(edited("", "data_dir", set(""))).toBe('data_dir = ""\n');
  });

  test("a control character or an unpaired surrogate is refused, not escaped", () => {
    for (const bad of [
      "a\nb",
      "a\rb",
      "a\tb",
      "a\u0000b",
      "a\u001fb",
      "a\u007fb",
      "a\u001bb",
      "\ud800",
      "x\udfffy",
    ]) {
      expect(refusal("", "data_dir", set(bad))).toBe("unrepresentable_value");
      expect(refusal('data_dir = "x"\n', "data_dir", set(bad))).toBe("unrepresentable_value");
      expect(refusal("", "tex_dir", set(`/${bad}`))).toBe("unrepresentable_value");
    }
    // a paired surrogate is a character
    expect(edited("", "data_dir", set("\ud83d\ude00"))).toBe('data_dir = "😀"\n');
  });
});

describe("refusals: nothing is changed", () => {
  test("a key the schema does not have", () => {
    for (const key of [
      "nope",
      "ui",
      "theme",
      "ui.nope",
      "other.port",
      "toString",
      "__proto__",
      "",
    ]) {
      expect(refusal("port = 1\n", key, set(1))).toBe("unknown_key");
      expect(refusal("port = 1\n", key, RESET)).toBe("unknown_key");
    }
  });

  test("a value the key does not take", () => {
    const cases: Array<[string, string | number | boolean]> = [
      ["port", 70000],
      ["port", -1],
      ["port", 1.5],
      ["port", "1859"],
      ["port", true],
      ["port", Number.NaN],
      ["port", Number.POSITIVE_INFINITY],
      ["data_dir", "/abs"],
      ["data_dir", "C:\\abs"],
      ["data_dir", 1],
      ["tex_dir", "rel"],
      ["global_dir", "rel"],
      ["auto_ingest_arxiv", "true"],
      ["log_level", "loud"],
      ["ui.language", "fr"],
      ["ui.theme", "blue"],
      ["ui.accent", "pink"],
      ["ui.density", "cozy"],
      ["ui.labels", "yes"],
      ["ui.labels", 1],
    ];
    for (const [key, value] of cases) {
      expect(refusal("", key, set(value)), key).toBe("invalid_value");
      expect(refusal('port = 1\n[ui]\ntheme = "dark"\n', key, set(value)), key).toBe(
        "invalid_value"
      );
    }
  });

  test("a file that is not TOML", () => {
    for (const text of [
      "port = \n",
      "this is = = not toml",
      'data_dir = "unterminated\nport = 1\n',
      "port = 1\n[ui\n",
      "port = 1 2\n",
      "a = 1\rport = 2\n",
      "x = 9007199254740993\nport = 1\n",
      'x = """never closed\nport = 1\n',
      "[ui]\n[ui]\n",
      "a = 1\na = 2\nport = 1\n",
    ]) {
      expect(refusal(text, "port", set(2)), text).toBe("unparseable");
      expect(refusal(text, "port", RESET), text).toBe("unparseable");
      expect(refusal(text, "ui.theme", set("dark")), text).toBe("unparseable");
    }
  });

  test("the key written more than once", () => {
    expect(refusal("port = 1\nport = 2\n", "port", set(3))).toBe("duplicate_key");
    expect(refusal("port = 1\nport = 2\n", "port", RESET)).toBe("duplicate_key");
    expect(refusal('port = 1\n"port" = 2\n', "port", set(3))).toBe("duplicate_key");
    expect(refusal('[ui]\ntheme = "dark"\ntheme = "light"\n', "ui.theme", set("dark"))).toBe(
      "duplicate_key"
    );
    expect(refusal('[ui]\ntheme = "dark"\n[ui]\ntheme = "light"\n', "ui.theme", RESET)).toBe(
      "duplicate_key"
    );
    // another key written twice is a file that is not TOML
    expect(refusal("port = 1\nport = 2\n", "data_dir", set("x"))).toBe("unparseable");
  });

  test("the key, or its table, written with a dotted key", () => {
    expect(refusal('ui.theme = "dark"\n', "ui.theme", set("light"))).toBe("dotted_key");
    expect(refusal('ui.theme = "dark"\n', "ui.theme", RESET)).toBe("dotted_key");
    expect(refusal('ui . "theme" = "dark"\n', "ui.theme", set("light"))).toBe("dotted_key");
    // the table exists only through dotted keys: another key of it cannot be added either
    expect(refusal('ui.theme = "dark"\n', "ui.labels", set(false))).toBe("dotted_key");
    expect(refusal("ui.extra.x = 1\n", "ui.theme", set("dark"))).toBe("dotted_key");
    // the key itself is the head of a dotted key
    expect(refusal("port.x = 1\n", "port", set(1))).toBe("dotted_key");
    expect(refusal("[ui]\ntheme.x = 1\n", "ui.theme", set("dark"))).toBe("dotted_key");
    // a dotted key somewhere else is nobody's business
    expect(edited("[other]\nui.theme = 1\na.port = 2\n", "ui.theme", set("dark"))).toBe(
      '[other]\nui.theme = 1\na.port = 2\n\n[ui]\ntheme = "dark"\n'
    );
  });

  test("the key's value, or its table, written as an inline table", () => {
    expect(refusal('ui = { theme = "dark" }\n', "ui.theme", set("light"))).toBe("inline_table");
    expect(refusal('ui = { theme = "dark" }\n', "ui.theme", RESET)).toBe("inline_table");
    expect(refusal('ui = { theme = "dark" }\n', "ui.labels", set(true))).toBe("inline_table");
    expect(refusal("ui = {}\n", "ui.labels", set(true))).toBe("inline_table");
    expect(refusal("port = { x = 1 }\n", "port", set(1))).toBe("inline_table");
    expect(refusal("port = { x = 1 }\n", "port", RESET)).toBe("inline_table");
    expect(refusal("[ui]\ntheme = { x = 1 }\n", "ui.theme", set("dark"))).toBe("inline_table");
  });

  test("the key's value written as a multi-line string, even on one line", () => {
    for (const value of [
      '"""\nlit\n"""',
      "'''\nlit\n'''",
      '"""lit"""',
      "'''lit'''",
      '"""a\\\n  b"""',
    ]) {
      expect(refusal(`data_dir = ${value}\nport = 1\n`, "data_dir", set("x")), value).toBe(
        "multiline_string"
      );
      expect(refusal(`data_dir = ${value}\nport = 1\n`, "data_dir", RESET), value).toBe(
        "multiline_string"
      );
      // another key of the same file is edited as usual
      expect(edited(`data_dir = ${value}\nport = 1\n`, "port", set(2))).toBe(
        `data_dir = ${value}\nport = 2\n`
      );
    }
    expect(refusal('[ui]\ntheme = """\ndark"""\n', "ui.theme", set("dark"))).toBe(
      "multiline_string"
    );
  });

  test("the key's table written as an array of tables", () => {
    expect(refusal('[[ui]]\ntheme = "dark"\n', "ui.theme", set("light"))).toBe("array_of_tables");
    expect(refusal('[[ui]]\ntheme = "dark"\n', "ui.theme", RESET)).toBe("array_of_tables");
    expect(
      refusal('[[ui]]\ntheme = "dark"\n[[ui]]\ntheme = "light"\n', "ui.labels", set(true))
    ).toBe("array_of_tables");
    expect(refusal("[[ port ]]\nx = 1\n", "port", set(1))).toBe("array_of_tables");
    // an array of tables elsewhere that holds the name is not the key
    expect(edited("[[rows]]\nport = 1\n", "port", RESET)).toBe("[[rows]]\nport = 1\n");
  });

  test("the key's value is an array or a table", () => {
    expect(refusal("port = [1, 2]\n", "port", set(1))).toBe("not_a_scalar");
    expect(refusal("port = [\n  1,\n]\n", "port", RESET)).toBe("not_a_scalar");
    expect(refusal("[port]\nx = 1\n", "port", set(1))).toBe("not_a_scalar");
    expect(refusal("[port.deep]\nx = 1\n", "port", set(1))).toBe("not_a_scalar");
    expect(refusal("[ui.theme]\nx = 1\n", "ui.theme", set("dark"))).toBe("not_a_scalar");
    expect(refusal("[ui]\n[ui.theme.deep]\nx = 1\n", "ui.theme", RESET)).toBe("not_a_scalar");
    expect(refusal('[ui]\ntheme = ["dark"]\n', "ui.theme", set("dark"))).toBe("not_a_scalar");
  });

  test("the key's table written as a plain value", () => {
    expect(refusal("ui = 3\n", "ui.theme", set("dark"))).toBe("table_not_a_table");
    expect(refusal('ui = "dark"\n', "ui.theme", RESET)).toBe("table_not_a_table");
    expect(refusal('ui = [{ theme = "dark" }]\n', "ui.theme", set("dark"))).toBe(
      "table_not_a_table"
    );
  });

  test("every refusal the editor can give has a case above or below", () => {
    // self_check_failed is the check further down, and one corner of real text (two tests on). unsupported_layout
    // is the next test.
    expect([...CONFIG_EDIT_REFUSALS].sort()).toEqual(
      [
        "array_of_tables",
        "dotted_key",
        "duplicate_key",
        "inline_table",
        "invalid_value",
        "multiline_string",
        "not_a_scalar",
        "self_check_failed",
        "table_not_a_table",
        "unknown_key",
        "unparseable",
        "unrepresentable_value",
        "unsupported_layout",
      ].sort()
    );
  });

  test("a wrongly typed number followed by what only a number may be followed by: the self-check refuses", () => {
    // The parser trims a no-break space, a form feed, … after a number, and takes none of them after a boolean or
    // a string. Keeping those bytes (they are not the value's) and writing a boolean or a string before them gives
    // text that is not TOML; the candidate never leaves the editor.
    expect(refusal("data_dir = 12\u00a0\n", "data_dir", set("lit"))).toBe("self_check_failed");
    expect(refusal("auto_ingest_arxiv = 1\u00a0# c\n", "auto_ingest_arxiv", set(true))).toBe(
      "self_check_failed"
    );
    expect(refusal("[ui]\nlabels = 0\f\n", "ui.labels", set(false))).toBe("self_check_failed");
    // a number in its place, or no line at all, is fine
    expect(editConfigText("port = 80\u00a0# c\n", "port", set(81))).toEqual({
      ok: true,
      text: "port = 81\u00a0# c\n",
      changed: true,
    });
    expect(editConfigText("data_dir = 12\u00a0\n", "data_dir", RESET)).toEqual({
      ok: true,
      text: "",
      changed: true,
    });
  });

  test("text the parser lets through and the line scan does not follow", () => {
    // smol-toml 1.8.0 is lenient in two places; the scan is not, and the file is left alone.
    // A quoted key that is not followed by `=`: the parser reads the key as `a=b` with the next line's value.
    expect(parseToml('"a=b"\nport = 80\n')).toEqual({ "a=b": 80 });
    // A `[[` closed by one `]`: the parser takes whatever one character follows as the second `]` and reads an
    // array of tables. (With the line's own ending as that character the next line must be empty, or the parser
    // gives up: `[[a]\nport = 1\n` is not TOML to it either.)
    expect(parseToml("[[a]\n\nport = 1\n")).toEqual({ a: [{ port: 1 }] });
    expect(parseToml("[[a]x\nport = 1\n")).toEqual({ a: [{ port: 1 }] });
    expect(refusal("[[a]\nport = 1\n", "port", set(81))).toBe("unparseable");
    for (const text of ['"a=b"\nport = 80\n', "[[a]\n\nport = 1\n", "[[a]x\nport = 1\n"]) {
      expect(refusal(text, "port", set(81)), text).toBe("unsupported_layout");
      expect(refusal(text, "port", RESET), text).toBe("unsupported_layout");
      expect(refusal(text, "ui.theme", set("dark")), text).toBe("unsupported_layout");
    }
  });

  test("a change that is not a change: neither `set` nor `reset`, or both", () => {
    const shapes = [
      {},
      null,
      undefined,
      { set: 1, reset: true },
      { reset: false },
      { set: undefined },
      { set: null },
      { set: [1] },
      { set: { toString: () => "1" } },
      { set: 1, extra: 2 },
      "reset",
      7,
    ] as unknown as ConfigChange[];
    for (const change of shapes) {
      for (const text of ["", "port = 1\n", "port = 1\n[ui]\ntheme = 3\n"]) {
        expect(refusal(text, "port", change), JSON.stringify(change)).toBe("invalid_value");
        expect(refusal(text, "ui.theme", change), JSON.stringify(change)).toBe("invalid_value");
      }
      expect(checkConfigEdit("port = 1\n", "port = 1\n", "port", change)).toBe(false);
    }
    // the key is looked at first
    expect(refusal("", "nope", {} as ConfigChange)).toBe("unknown_key");
  });

  test("no refusal carries text of the file or the value", () => {
    const marker = "MARKER-c04d";
    const got = [
      editConfigText(`openalex_api_key = "${marker}"\n= ${marker}`, "port", set(1)),
      editConfigText(`port = 1\nport = 2 # ${marker}`, "port", set(1)),
      editConfigText(`ui = { theme = "${marker}" }`, "ui.theme", set("dark")),
      editConfigText("", "ui.theme", set(marker)),
      editConfigText("", "contact_email", set(`${marker}\n`)),
      editConfigText("", marker, set(1)),
    ];
    for (const result of got) expect(result.ok).toBe(false);
    expect(JSON.stringify(got)).not.toContain(marker);
  });
});

describe("the self-check", () => {
  const ORIGINAL = 'data_dir = "lit"\nport = 1\n\n[ui]\ntheme = "dark"\n';

  test("it accepts what the editor proposes", () => {
    const proposed = proposeConfigEdit(ORIGINAL, "port", set(2));
    expect(proposed).toEqual({
      ok: true,
      changed: true,
      text: ORIGINAL.replace("port = 1", "port = 2"),
    });
    expect(
      checkConfigEdit(ORIGINAL, ORIGINAL.replace("port = 1", "port = 2"), "port", set(2))
    ).toBe(true);
    expect(checkConfigEdit(ORIGINAL, ORIGINAL.replace("port = 1\n", ""), "port", RESET)).toBe(true);
    expect(
      checkConfigEdit(ORIGINAL, ORIGINAL.replace('theme = "dark"\n', ""), "ui.theme", RESET)
    ).toBe(true);
    expect(
      checkConfigEdit("port = 1\n", 'port = 1\n\n[ui]\ntheme = "dark"\n', "ui.theme", set("dark"))
    ).toBe(true);
  });

  test("a candidate that changes another key is refused", () => {
    // the asked change is there, and so is one nobody asked for
    const candidates = [
      'data_dir = "other"\nport = 2\n\n[ui]\ntheme = "dark"\n',
      'data_dir = "lit"\nport = 2\n\n[ui]\ntheme = "light"\n',
      'port = 2\n\n[ui]\ntheme = "dark"\n',
      'data_dir = "lit"\nport = 2\nextra = 1\n\n[ui]\ntheme = "dark"\n',
      'data_dir = "lit"\nport = 2\n\n[ui]\ntheme = "dark"\nlabels = true\n',
      'data_dir = "lit"\nport = 2\n',
      'data_dir = "lit"\nport = 2\n\n[ui]\ntheme = "dark"\n[other]\n',
      // the new line landed in the wrong table: `port` is right, but so is a second, unasked `ui.port`
      'data_dir = "lit"\nport = 2\n\n[ui]\ntheme = "dark"\nport = 2\n',
    ];
    for (const candidate of candidates) {
      expect(checkConfigEdit(ORIGINAL, candidate, "port", set(2)), candidate).toBe(false);
    }
  });

  test("a candidate where the key does not get the asked value is refused", () => {
    expect(checkConfigEdit(ORIGINAL, ORIGINAL, "port", set(2))).toBe(false);
    expect(
      checkConfigEdit(ORIGINAL, ORIGINAL.replace("port = 1", "port = 3"), "port", set(2))
    ).toBe(false);
    expect(
      checkConfigEdit(ORIGINAL, ORIGINAL.replace("port = 1", 'port = "2"'), "port", set(2))
    ).toBe(false);
    expect(
      checkConfigEdit(ORIGINAL, ORIGINAL.replace("port = 1", "port = 2.5"), "port", set(2))
    ).toBe(false);
    expect(checkConfigEdit(ORIGINAL, ORIGINAL, "port", RESET)).toBe(false);
    // the line went into another table: the key itself is still absent
    expect(
      checkConfigEdit('[ui]\ntheme = "dark"\n', '[ui]\ntheme = "dark"\nport = 2\n', "port", set(2))
    ).toBe(false);
    // a value that swallowed the rest of its line
    expect(
      checkConfigEdit(
        'data_dir = "a" # c\nport = 1\n',
        'data_dir = "b # c\nport = 1\n',
        "data_dir",
        set("b")
      )
    ).toBe(false);
  });

  test("a candidate that is not TOML, or that lost or gained the byte order mark, is refused", () => {
    expect(checkConfigEdit(ORIGINAL, `${ORIGINAL}port = 2\n`, "port", set(2))).toBe(false);
    expect(checkConfigEdit(ORIGINAL, "port = 2\nport = 2\n", "port", set(2))).toBe(false);
    expect(checkConfigEdit(ORIGINAL, "port = \n", "port", set(2))).toBe(false);
    expect(checkConfigEdit(`${BOM}port = 1\n`, "port = 2\n", "port", set(2))).toBe(false);
    expect(checkConfigEdit("port = 1\n", `${BOM}port = 2\n`, "port", set(2))).toBe(false);
    expect(checkConfigEdit(`${BOM}port = 1\n`, `${BOM}port = 2\n`, "port", set(2))).toBe(true);
  });

  test("values the comparison must not confuse", () => {
    const before =
      "a = 1\nb = [1, 2]\nc = 1979-05-27T07:32:00Z\nd = { x = 1 }\ne = nan\nport = 1\n";
    const ok = (candidate: string): boolean => checkConfigEdit(before, candidate, "port", set(2));
    expect(ok(before.replace("port = 1", "port = 2"))).toBe(true);
    expect(ok(before.replace("port = 1", "port = 2").replace("a = 1", "a = 1.5"))).toBe(false);
    expect(ok(before.replace("port = 1", "port = 2").replace("a = 1", 'a = "1"'))).toBe(false);
    expect(ok(before.replace("port = 1", "port = 2").replace("[1, 2]", "[2, 1]"))).toBe(false);
    expect(ok(before.replace("port = 1", "port = 2").replace("07:32:00Z", "07:32:01Z"))).toBe(
      false
    );
    expect(ok(before.replace("port = 1", "port = 2").replace("x = 1", "x = 2"))).toBe(false);
    expect(ok(before.replace("port = 1", "port = 2").replace("e = nan", "e = inf"))).toBe(false);
  });
});

describe("the self-check compares values, not how they are written", () => {
  const before = [
    "d = 1979-05-27",
    "t = 07:32:00",
    "l = 1979-05-27T07:32:00",
    "o = 1979-05-27T07:32:00Z",
    "z = 1979-05-27T07:32:00+02:00",
    "f = 1.0",
    "n = nan",
    "h = 0x10 # sixteen",
    's = "a"',
    "port = 1",
    "",
  ].join("\n");
  const withPort = before.replace("port = 1", "port = 2");
  const ok = (candidate: string): boolean => checkConfigEdit(before, candidate, "port", set(2));

  test("a date that became another kind of date is a changed value", () => {
    expect(ok(withPort)).toBe(true);
    for (const [from, to] of [
      // a local date to a date-time of the same instant, in each writing
      ["d = 1979-05-27", "d = 1979-05-27T00:00:00"],
      ["d = 1979-05-27", "d = 1979-05-27T00:00:00Z"],
      // a local time to a time with an offset (the parser reads `07:32:00Z` as a time on 0000-01-01)
      ["l = 1979-05-27T07:32:00", "l = 1979-05-27T07:32:00Z"],
      ["o = 1979-05-27T07:32:00Z", "o = 1979-05-27T07:32:00"],
      // the same instant under another offset
      ["o = 1979-05-27T07:32:00Z", "o = 1979-05-27T09:32:00+02:00"],
      ["z = 1979-05-27T07:32:00+02:00", "z = 1979-05-27T05:32:00Z"],
    ] as const) {
      expect(before).toContain(`${from}\n`);
      expect(ok(withPort.replace(`${from}\n`, `${to}\n`)), to).toBe(false);
    }
    // inside an array and inside a table too
    expect(
      checkConfigEdit(
        "a = [1979-05-27]\n[t]\nx = 1979-05-27\nport = 1\n",
        "a = [1979-05-27T00:00:00]\n[t]\nx = 1979-05-27\n",
        "port",
        RESET
      )
    ).toBe(false);
    expect(
      checkConfigEdit(
        "a = [1979-05-27]\n[t]\nx = 1979-05-27\nport = 1\n",
        "a = [1979-05-27]\n[t]\nx = 1979-05-27T00:00:00\n",
        "port",
        RESET
      )
    ).toBe(false);
    // the same date written another way is the same value
    expect(ok(withPort.replace("l = 1979-05-27T07:32:00", "l = 1979-05-27 07:32:00"))).toBe(true);
  });

  test("what the check cannot see: another writing of the same value, comments, the order of keys", () => {
    // These are accepted. The proposing step never touches another line; the check is the second line of defence
    // and compares what the parser returns.
    expect(ok(withPort.replace("f = 1.0", "f = 1"))).toBe(true);
    expect(ok(withPort.replace("n = nan", "n = -nan"))).toBe(true);
    expect(ok(withPort.replace("h = 0x10 # sixteen", "h = 16"))).toBe(true);
    expect(ok(withPort.replace('s = "a"', "s = 'a'"))).toBe(true);
    expect(ok(withPort.replace('s = "a"\nport = 2\n', 'port = 2\ns = "a"\n'))).toBe(true);
  });
});

describe("the self-check stands between the proposer and the caller", () => {
  const ORIGINAL = 'data_dir = "lit"\nport = 1\n\n[ui]\ntheme = "dark"\n';
  const proposing =
    (text: string, changed = true): typeof proposeConfigEdit =>
    () => ({ ok: true, text, changed });

  test("a proposer that also changes another key: refused, and its text is not handed out", () => {
    const bad = 'data_dir = "elsewhere"\nport = 2\n\n[ui]\ntheme = "dark"\n';
    expect(editConfigText(ORIGINAL, "port", set(2), proposing(bad))).toEqual({
      ok: false,
      reason: "self_check_failed",
    });
    // the same proposer with the right text passes: it is the check that decides
    const good = ORIGINAL.replace("port = 1", "port = 2");
    expect(editConfigText(ORIGINAL, "port", set(2), proposing(good))).toEqual({
      ok: true,
      text: good,
      changed: true,
    });
  });

  test("a proposer that drops a line, breaks the syntax, or misses the value: refused", () => {
    for (const bad of [
      'port = 2\n\n[ui]\ntheme = "dark"\n',
      'data_dir = "lit"\nport = 2\n\n[ui\ntheme = "dark"\n',
      'data_dir = "lit"\nport = 3\n\n[ui]\ntheme = "dark"\n',
      ORIGINAL,
      "",
    ]) {
      expect(editConfigText(ORIGINAL, "port", set(2), proposing(bad)), bad).toEqual({
        ok: false,
        reason: "self_check_failed",
      });
    }
    expect(editConfigText(ORIGINAL, "port", RESET, proposing(ORIGINAL))).toEqual({
      ok: false,
      reason: "self_check_failed",
    });
  });

  test("a proposer's own refusal is passed on", () => {
    expect(
      editConfigText(ORIGINAL, "port", set(2), () => ({ ok: false, reason: "dotted_key" }))
    ).toEqual({
      ok: false,
      reason: "dotted_key",
    });
  });
});

describe("what the edited text reads as", () => {
  test("the lenient reading of an edited file has the new value and the rest as before", () => {
    const text = '# c\ndata_dir = "lit"\nport = "bad"\n\n[ui]\ntheme = "dark"\n';
    const fixed = edited(text, "port", set(1900));
    expect(readSettingsText(text).problems).toEqual([{ key: "port", reason: "wrong_type" }]);
    const got = readSettingsText(fixed);
    expect(got.problems).toEqual([]);
    expect(got.values.port).toBe(1900);
    expect(got.values.data_dir).toBe("lit");
    expect(got.values["ui.theme"]).toBe("dark");
  });
});
