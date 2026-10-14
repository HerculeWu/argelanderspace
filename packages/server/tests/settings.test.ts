/**
 * Settings over HTTP (desktop-app ticket 10): a real server on an ephemeral port, a config file in a temporary
 * directory, real requests, and the file's bytes looked at afterwards. The watcher's notification is read from a
 * real WebSocket.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SETTING_KEYS,
  SETTINGS_SCHEMA,
  type SettingChangeResponse,
  type SettingsSnapshot,
  type WsServerMessage,
} from "@argelanderspace/contracts";
import { CONFIG_EDIT_REFUSALS, SETTING_WRITE_REFUSALS } from "@argelanderspace/infra";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { createServer, type RunningServer } from "../src/server.js";
import { withAppearance } from "../src/settings.js";
import { makeDataDir, makeWebDist, stubSources } from "./helpers.js";

let srv: RunningServer | undefined;
let port: number;
let dataDir: string;
let configDir: string;
let configPath: string;
let webDist: string | null = null;
const sockets: WebSocket[] = [];

async function start(options: { web?: boolean } = {}): Promise<void> {
  if (options.web) {
    webDist = makeWebDist();
    writeFileSync(
      join(webDist, "index.html"),
      '<!doctype html>\n<html lang="zh-CN">\n  <head><title>ArgelanderSpace</title></head>\n  <body><div id="root"></div></body>\n</html>\n'
    );
  }
  srv = createServer({
    dataDir,
    port: 0,
    heartbeatMs: 0,
    webDist,
    deps: { makeSources: () => stubSources() },
    watchIntervalMs: 40,
    configPath,
  });
  port = await srv.ready();
}

beforeEach(() => {
  dataDir = makeDataDir();
  configDir = mkdtempSync(join(tmpdir(), "aspace-settings-"));
  configPath = join(configDir, "argelanderspace", "config.toml");
  mkdirSync(dirname(configPath));
});

afterEach(async () => {
  // Whatever fails here, the directories of the test are removed.
  try {
    for (const socket of sockets.splice(0)) socket.terminate();
    await srv?.close();
  } finally {
    srv = undefined;
    rmSync(dirname(dataDir), { recursive: true, force: true });
    // A test may have taken the write permission away, or removed the directory altogether.
    if (existsSync(dirname(configPath))) chmodSync(dirname(configPath), 0o700);
    rmSync(configDir, { recursive: true, force: true });
    if (webDist !== null) rmSync(webDist, { recursive: true, force: true });
    webDist = null;
  }
});

const url = (path: string): string => `http://127.0.0.1:${port}${path}`;

async function get(): Promise<{ res: Response; body: SettingsSnapshot; text: string }> {
  const res = await fetch(url("/api/settings"));
  const text = await res.text();
  return { res, body: JSON.parse(text) as SettingsSnapshot, text };
}

async function put(
  key: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ res: Response; body: SettingChangeResponse; text: string }> {
  const res = await fetch(url(`/api/settings/${encodeURIComponent(key)}`), {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { res, body: JSON.parse(text) as SettingChangeResponse, text };
}

/** The `settings.changed` messages a socket receives from now on; `ready` resolves on hello. */
async function listen(): Promise<{ causes: () => string[]; next: (n: number) => Promise<void> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  const causes: string[] = [];
  let wake: () => void = () => {};
  await new Promise<void>((resolveReady, rejectReady) => {
    ws.on("error", rejectReady);
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as WsServerMessage;
      if (msg.type === "hello") resolveReady();
      if (msg.type === "settings.changed") {
        expect(Object.keys(msg).sort()).toEqual(["at", "cause", "type"]);
        causes.push(msg.cause);
        wake();
      }
    });
  });
  return {
    causes: () => [...causes],
    next: (n) =>
      new Promise<void>((resolveNext, rejectNext) => {
        const timer = setTimeout(
          () => rejectNext(new Error(`${causes.length} settings.changed messages, wanted ${n}`)),
          5000
        );
        const check = (): void => {
          if (causes.length < n) return;
          clearTimeout(timer);
          resolveNext();
        };
        wake = check;
        check();
      }),
  };
}

const COMMENTED = [
  "# my workbench — shared with the group",
  "port = 1860   # the lab's port",
  "",
  "mystery_key = [1, 2, 3]",
  "",
  "[ui]",
  "# dark at night",
  'theme = "dark"  # keep',
  'density = "compact"',
  "",
  "[notes]",
  'text = "unknown table, kept"',
  "",
].join("\n");

describe("GET /api/settings", () => {
  test("no file: every key at its default, nothing wrong, nothing read-only, never cached", async () => {
    await start();
    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body.version).toBe(1);
    expect(body.path).toBe(configPath);
    expect(body.file).toBe("missing");
    expect(body.readonly).toBe(false);
    expect(body.problems).toEqual([]);
    expect(body.uneditable).toEqual({});
    expect(body.legacy).toEqual([]);
    expect(Object.keys(body.values)).toEqual(SETTING_KEYS);
    for (const key of SETTING_KEYS) {
      expect(body.sources[key]).toBe("default");
      if (SETTINGS_SCHEMA[key].ui !== "none") {
        expect(body.values[key]).toBe(SETTINGS_SCHEMA[key].default);
      }
    }
  });

  test("the values in effect and where each comes from", async () => {
    writeFileSync(configPath, COMMENTED);
    await start();
    const { body } = await get();
    expect(body.file).toBe("read");
    expect(body.values.port).toBe(1860);
    expect(body.values["ui.theme"]).toBe("dark");
    expect(body.values["ui.density"]).toBe("compact");
    expect(body.values["ui.language"]).toBe("zh-CN");
    expect(body.sources).toMatchObject({
      port: "file",
      "ui.theme": "file",
      "ui.density": "file",
      "ui.language": "default",
      "ui.accent": "default",
      data_dir: "default",
    });
    expect(body.problems).toEqual([]);
    expect(body.uneditable).toEqual({});
  });

  test("a secret key's value never leaves the server, and a legacy key is named", async () => {
    const marker = "zqxmarkSECRETa1";
    const other = "zqxmarkSECRETb2";
    writeFileSync(
      configPath,
      `ads_dev_key = "${marker}"\nopenalex_api_key = "${other}"\nport = "${marker}"\n`
    );
    await start();
    const { body, text } = await get();
    expect(text).not.toContain(marker);
    expect(text).not.toContain(other);
    expect(body.values.ads_dev_key).toEqual({ secret: true, set: true });
    expect(body.values.openalex_api_key).toEqual({ secret: true, set: true });
    expect(body.legacy).toEqual(["ads_dev_key"]);
    // The faulty key is named with a category; what the file has for it is not said.
    expect(body.problems).toEqual([{ key: "port", reason: "wrong_type" }]);
    expect(body.values.port).toBe(SETTINGS_SCHEMA.port.default);
    expect(body.sources.port).toBe("default");
    // A change of another key does not repeat it either.
    const changed = await put("ui.theme", { set: "light" });
    expect(changed.res.status).toBe(200);
    expect(changed.text).not.toContain(marker);
    expect(changed.text).not.toContain(other);
  });

  test("faulty keys: each named with its category, its default in effect, the page still writable", async () => {
    writeFileSync(
      configPath,
      'data_dir = "/abs/elsewhere"\nport = 70000\n[ui]\ndensity = 3\ntheme = "sepia"\n'
    );
    await start();
    const { body } = await get();
    expect(body.readonly).toBe(false);
    expect(body.file).toBe("read");
    expect(body.problems).toEqual([
      { key: "data_dir", reason: "must_be_relative" },
      { key: "port", reason: "out_of_range" },
      { key: "ui.theme", reason: "not_one_of" },
      { key: "ui.density", reason: "wrong_type" },
    ]);
    expect(body.values["ui.theme"]).toBe("dark");
    expect(body.values["ui.density"]).toBe("regular");
    expect(body.sources["ui.theme"]).toBe("default");
    // A faulty key can be put right from the page.
    expect(body.uneditable).toEqual({});
  });

  test("a table written as a value is a problem named by the table", async () => {
    writeFileSync(configPath, "ui = 3\n");
    await start();
    const { body } = await get();
    expect(body.problems).toEqual([{ key: "ui", reason: "not_a_table" }]);
    expect(body.readonly).toBe(false);
    expect(body.uneditable["ui.theme"]).toBe("table_not_a_table");
    expect(body.uneditable.port).toBeUndefined();
  });

  test("a file that is not TOML: read-only, every default, one whole-file problem", async () => {
    const marker = "zqxmarkBROKEN";
    writeFileSync(configPath, `port = 1860\n[ui\ntheme = "${marker}\n`);
    await start();
    const { body, text } = await get();
    expect(text).not.toContain(marker);
    expect(body.file).toBe("unparseable");
    expect(body.readonly).toBe(true);
    expect(body.problems).toEqual([{ key: null, reason: "unparseable" }]);
    expect(body.values.port).toBe(SETTINGS_SCHEMA.port.default);
    expect(body.uneditable).toEqual({});
  });

  test("a key written twice makes the whole file unparseable", async () => {
    writeFileSync(configPath, "port = 1\nport = 2\n");
    await start();
    const { body } = await get();
    expect(body.file).toBe("unparseable");
    expect(body.readonly).toBe(true);
  });

  test("a file that cannot be read: read-only, said as unreadable", async () => {
    // A directory where the file should be: reading it fails whoever runs the test.
    mkdirSync(configPath);
    await start();
    const { body } = await get();
    expect(body.file).toBe("unreadable");
    expect(body.readonly).toBe(true);
    expect(body.problems).toEqual([{ key: null, reason: "unreadable" }]);
  });

  test("keys the page cannot change safely are known when the page reads, with the reason", async () => {
    writeFileSync(
      configPath,
      'auto_ingest_arxiv = false\nui.theme = "light"\ncontact_email = """\nx@example.org"""\n'
    );
    await start();
    const { body } = await get();
    expect(body.readonly).toBe(false);
    expect(body.values["ui.theme"]).toBe("light");
    expect(body.uneditable["ui.theme"]).toBe("dotted_key");
    // The whole table is written with dotted keys: no key of it can be added by the page either.
    expect(body.uneditable["ui.density"]).toBe("dotted_key");
    expect(body.uneditable.contact_email).toBe("multiline_string");
    expect(body.uneditable.auto_ingest_arxiv).toBeUndefined();
    expect(body.uneditable.port).toBeUndefined();
  });

  test("an inline table: its keys cannot be changed by the page", async () => {
    writeFileSync(configPath, 'ui = { theme = "light" }\n');
    await start();
    const { body } = await get();
    expect(body.values["ui.theme"]).toBe("light");
    expect(body.uneditable["ui.theme"]).toBe("inline_table");
    expect(body.uneditable["ui.accent"]).toBe("inline_table");
  });

  test("bytes that are not UTF-8: nothing can be changed, and the reason is said", async () => {
    writeFileSync(configPath, Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
    await start();
    const { body } = await get();
    expect(body.readonly).toBe(false);
    expect(body.uneditable["ui.theme"]).toBe("invalid_encoding");
    const before = readFileSync(configPath);
    const refused = await put("ui.theme", { set: "light" });
    expect(refused.res.status).toBe(500);
    expect(refused.body).toEqual({ ok: false, reason: "invalid_encoding" });
    expect(readFileSync(configPath).equals(before)).toBe(true);
  });
});

describe("PUT /api/settings/:key", () => {
  test("changing one key rewrites that line only: comments, unknown keys and every other byte stay", async () => {
    writeFileSync(configPath, COMMENTED);
    await start();
    const { res, body } = await put("ui.theme", { set: "light" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body.ok).toBe(true);
    if (!body.ok) throw new Error("refused");
    expect(body.changed).toBe(true);
    expect(body.settings.values["ui.theme"]).toBe("light");
    expect(body.settings.sources["ui.theme"]).toBe("file");
    expect(readFileSync(configPath, "utf-8")).toBe(
      COMMENTED.replace('theme = "dark"  # keep', 'theme = "light"  # keep')
    );
    // Nothing is left beside the file.
    expect(readdirSync(dirname(configPath))).toEqual(["config.toml"]);
  });

  test("a key the file does not set is added to its table; restoring the default removes the line", async () => {
    writeFileSync(configPath, COMMENTED);
    await start();
    const added = await put("ui.labels", { set: false });
    expect(added.body).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(configPath, "utf-8")).toBe(
      COMMENTED.replace('density = "compact"\n', 'density = "compact"\nlabels = false\n')
    );
    const reset = await put("ui.labels", { reset: true });
    expect(reset.body).toMatchObject({ ok: true, changed: true });
    if (!reset.body.ok) throw new Error("refused");
    expect(reset.body.settings.sources["ui.labels"]).toBe("default");
    expect(reset.body.settings.values["ui.labels"]).toBe(true);
    expect(readFileSync(configPath, "utf-8")).toBe(COMMENTED);
  });

  test("no file yet: the first change creates it", async () => {
    rmSync(dirname(configPath), { recursive: true });
    await start();
    const { body } = await put("ui.language", { set: "en" });
    expect(body).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(configPath, "utf-8")).toBe('[ui]\nlanguage = "en"\n');
  });

  test("the value the key already has: answered as unchanged, the file untouched", async () => {
    writeFileSync(configPath, COMMENTED);
    await start();
    const { res, body } = await put("ui.theme", { set: "dark" });
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, changed: false });
    expect(readFileSync(configPath, "utf-8")).toBe(COMMENTED);
  });

  test("a layout the page cannot edit safely: refused with the category, the bytes as they were", async () => {
    const text = '# mine\nui.theme = "dark"   # dotted\n';
    writeFileSync(configPath, text);
    await start();
    const { res, body, text: answer } = await put("ui.theme", { set: "light" });
    expect(res.status).toBe(409);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ ok: false, reason: "dotted_key" });
    expect(answer).not.toContain("light");
    expect(readFileSync(configPath, "utf-8")).toBe(text);
    expect(readdirSync(dirname(configPath))).toEqual(["config.toml"]);
  });

  test("a file that is not TOML is never rewritten", async () => {
    const text = 'port = 1860\n[ui\ntheme = "dark"\n';
    writeFileSync(configPath, text);
    await start();
    const { res, body } = await put("ui.theme", { set: "light" });
    expect(res.status).toBe(409);
    expect(body).toEqual({ ok: false, reason: "unparseable" });
    const reset = await put("ui.theme", { reset: true });
    expect(reset.body).toEqual({ ok: false, reason: "unparseable" });
    expect(readFileSync(configPath, "utf-8")).toBe(text);
  });

  test("a value the key does not take, without repeating it", async () => {
    writeFileSync(configPath, COMMENTED);
    await start();
    const marker = "zqxmarkVALUE";
    for (const [key, value] of [
      ["ui.theme", marker],
      ["ui.labels", "yes"],
      ["port", 70000],
      ["port", 1.5],
      ["data_dir", "/abs"],
    ] as const) {
      const { res, body, text } = await put(key, { set: value });
      expect(res.status).toBe(400);
      expect(body).toEqual({ ok: false, reason: "invalid_value" });
      expect(text).not.toContain(marker);
    }
    expect(readFileSync(configPath, "utf-8")).toBe(COMMENTED);
  });

  test("only keys with a control can be changed: read-only and hidden keys are refused, unknown ones are not found", async () => {
    writeFileSync(configPath, COMMENTED);
    await start();
    for (const key of SETTING_KEYS) {
      if (SETTINGS_SCHEMA[key].ui === "edit") continue;
      for (const change of [{ set: "/x/y" }, { reset: true }]) {
        const { res, body } = await put(key, change);
        expect([key, res.status]).toEqual([key, 422]);
        expect(body).toEqual({ ok: false, reason: "not_editable" });
      }
    }
    for (const key of ["nope", "ui", "ui.nope", "__proto__", "constructor", "mystery_key"]) {
      const { res, body } = await put(key, { set: 1 });
      expect([key, res.status]).toEqual([key, 404]);
      expect(body).toEqual({ ok: false, reason: "unknown_key" });
    }
    expect(readFileSync(configPath, "utf-8")).toBe(COMMENTED);
  });

  test("a body that is not a change is refused; the write's own options cannot be asked for", async () => {
    writeFileSync(configPath, COMMENTED);
    await start();
    const elsewhere = join(configDir, "elsewhere.toml");
    const bodies: unknown[] = [
      "not json",
      "",
      "null",
      "[]",
      {},
      { set: null },
      { set: [1] },
      { set: { a: 1 } },
      { reset: false },
      { reset: "true" },
      { set: "light", reset: true },
      { set: "light", path: elsewhere },
      { set: "light", rename: "x" },
      { set: "light", beforeReplace: "x" },
      { set: "light", propose: "x" },
      { value: "light" },
      `{"set":"${"x".repeat(5000)}"}`,
    ];
    for (const body of bodies) {
      const { res, body: answer } = await put("ui.theme", body);
      expect([JSON.stringify(body).slice(0, 40), res.status]).toEqual([
        JSON.stringify(body).slice(0, 40),
        400,
      ]);
      expect(answer).toEqual({ ok: false, reason: "invalid_request" });
    }
    expect(readFileSync(configPath, "utf-8")).toBe(COMMENTED);
    expect(existsSync(elsewhere)).toBe(false);
    // A body sent in chunks with no length: reading stops at the limit. This one sends 8 KiB and then neither sends
    // more nor ends — a server that read to the end before judging the size would never answer.
    let sent = 0;
    let stall: () => void = () => {};
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 8192) return new Promise<void>((resolve) => (stall = resolve));
        sent += 1024;
        controller.enqueue(new Uint8Array(1024).fill(32));
        return undefined;
      },
    });
    const chunked = await fetch(url("/api/settings/ui.theme"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: endless,
      duplex: "half",
    } as RequestInit);
    expect(chunked.status).toBe(400);
    expect(await chunked.json()).toEqual({ ok: false, reason: "invalid_request" });
    stall();
    // A query string is not an option either.
    const res = await fetch(url(`/api/settings/ui.theme?path=${encodeURIComponent(elsewhere)}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ set: "light" }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(elsewhere)).toBe(false);
    expect(readFileSync(configPath, "utf-8")).toContain('theme = "light"');
  });

  test("a file that does not allow writing: refused as such, the bytes as they were", async () => {
    writeFileSync(configPath, COMMENTED);
    chmodSync(configPath, 0o400);
    await start();
    const { res, body } = await put("ui.theme", { set: "light" });
    // Root may write a read-only file's directory but `writeSetting` asks the file itself.
    expect(res.status).toBe(500);
    expect(body).toEqual({ ok: false, reason: "not_writable" });
    expect(readFileSync(configPath, "utf-8")).toBe(COMMENTED);
  });

  test("the same guard as every other write: a cross-site request is rejected and changes nothing", async () => {
    writeFileSync(configPath, COMMENTED);
    await start();
    const evil = await put("ui.theme", { set: "light" }, { Origin: "http://evil.example" });
    expect(evil.res.status).toBe(403);
    expect(evil.body).toEqual({ detail: "cross-site request rejected" });
    const otherPort = await put(
      "ui.theme",
      { set: "light" },
      { Origin: `http://127.0.0.1:${port + 1}` }
    );
    expect(otherPort.res.status).toBe(403);
    expect(readFileSync(configPath, "utf-8")).toBe(COMMENTED);
    const same = await put("ui.theme", { set: "light" }, { Origin: `http://127.0.0.1:${port}` });
    expect(same.res.status).toBe(200);
  });

  test("every refusal the writer and the line editor can give has a status of its own class", async () => {
    // The endpoint passes the category on; this pins that none of them is missing from the page's list.
    const { SETTING_CHANGE_REFUSALS } = await import("@argelanderspace/contracts");
    for (const reason of [...CONFIG_EDIT_REFUSALS, ...SETTING_WRITE_REFUSALS]) {
      expect(SETTING_CHANGE_REFUSALS).toContain(reason);
    }
    await start();
  });
});

describe("the page is told when the file changed", () => {
  test("a file replaced by one of the same size and modification time is a change (its inode differs)", async () => {
    const { renameSync, utimesSync } = await import("node:fs");
    writeFileSync(configPath, '[ui]\ntheme = "dark"\n');
    utimesSync(configPath, 1_000_000, 1_000_000);
    await start();
    const heard = await listen();
    await new Promise((r) => setTimeout(r, 100));
    const fresh = `${configPath}.editor`;
    writeFileSync(fresh, '[ui]\ntheme = "lite"\n');
    utimesSync(fresh, 1_000_000, 1_000_000);
    renameSync(fresh, configPath);
    await heard.next(1);
    expect(heard.causes()).toEqual(["external"]);
  });

  test("the watcher stops when the server closes", async () => {
    const created: unknown[] = [];
    const cleared = new Set<unknown>();
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const setSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
      fn: () => void,
      ms?: number
    ) => {
      const timer = realSet(fn, ms);
      if (ms === 40) created.push(timer);
      return timer;
    }) as typeof setInterval);
    const clearSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(((timer: unknown) => {
      cleared.add(timer);
      realClear(timer as never);
    }) as typeof clearInterval);
    try {
      await start();
      // The library watcher and the config file watcher poll at the injected interval.
      expect(created.length).toBe(2);
      await srv?.close();
      srv = undefined;
      expect(created.filter((timer) => !cleared.has(timer))).toEqual([]);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  test("a change made through the endpoint: told at once, and found on disk by the watcher as well", async () => {
    writeFileSync(configPath, COMMENTED);
    await start();
    const heard = await listen();
    expect((await put("ui.theme", { set: "light" })).res.status).toBe(200);
    await heard.next(2);
    expect(heard.causes().sort()).toEqual(["external", "write"]);
  });

  test("a change that changed nothing, and a refused one, tell nobody", async () => {
    writeFileSync(configPath, COMMENTED);
    await start();
    const heard = await listen();
    await put("ui.theme", { set: "dark" });
    await put("ui.theme", { set: "sepia" });
    await new Promise((r) => setTimeout(r, 250));
    expect(heard.causes()).toEqual([]);
  });

  test("an edit made outside the server: saved in place, replaced by a rename, created, and removed", async () => {
    writeFileSync(configPath, COMMENTED);
    await start();
    const heard = await listen();
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(configPath, COMMENTED.replace('"compact"', '"comfy"'));
    await heard.next(1);
    expect((await get()).body.values["ui.density"]).toBe("comfy");

    // An editor that writes a new file and renames it over the old one (a new inode).
    const fresh = `${configPath}.editor`;
    writeFileSync(fresh, COMMENTED.replace('"dark"', '"light"'));
    const { renameSync } = await import("node:fs");
    renameSync(fresh, configPath);
    await heard.next(2);
    expect((await get()).body.values["ui.theme"]).toBe("light");

    rmSync(configPath);
    await heard.next(3);
    expect((await get()).body.file).toBe("missing");

    writeFileSync(configPath, "port = 1861\n");
    await heard.next(4);
    expect(heard.causes()).toEqual(["external", "external", "external", "external"]);
  });

  test("what a write puts beside the file for a moment is not a change of the file", async () => {
    writeFileSync(configPath, COMMENTED);
    await start();
    const heard = await listen();
    mkdirSync(`${configPath}.lock`);
    writeFileSync(`${configPath}.1234.abcdef.tmp`, "port = 1\n");
    await new Promise((r) => setTimeout(r, 250));
    rmSync(`${configPath}.lock`, { recursive: true });
    rmSync(`${configPath}.1234.abcdef.tmp`);
    await new Promise((r) => setTimeout(r, 250));
    expect(heard.causes()).toEqual([]);
  });
});

describe("the page starts with the configured appearance", () => {
  test("index.html carries the [ui] values on <html>, at / and at a client route, and is not cached", async () => {
    writeFileSync(
      configPath,
      '[ui]\ntheme = "light"\ndensity = "comfy"\nlanguage = "en"\naccent = "teal"\nlabels = false\n'
    );
    await start({ web: true });
    for (const path of ["/", "/index.html", "/doc/some-doc"]) {
      const res = await fetch(url(path));
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const html = await res.text();
      expect([path, html]).toEqual([
        path,
        '<!doctype html>\n<html lang="en" data-theme="light" data-density="comfy" data-accent="teal" data-labels="false" data-ui-from="config">\n  <head><title>ArgelanderSpace</title></head>\n  <body><div id="root"></div></body>\n</html>\n',
      ]);
    }
    // The next page load has what the file says now.
    writeFileSync(configPath, '[ui]\ntheme = "dark"\n');
    expect(await (await fetch(url("/"))).text()).toContain(
      '<html lang="zh-CN" data-theme="dark" data-density="regular" data-accent="azure" data-labels="true" data-ui-from="config">'
    );
  });

  test("a faulty or unparseable file gives the defaults, never text of the file", async () => {
    const marker = "zqxmarkTHEME";
    writeFileSync(configPath, `[ui]\ntheme = "${marker}"\n`);
    await start({ web: true });
    const html = await (await fetch(url("/"))).text();
    expect(html).not.toContain(marker);
    expect(html).toContain('data-theme="dark"');
    writeFileSync(configPath, `[ui\ntheme = "${marker}`);
    const broken = await (await fetch(url("/"))).text();
    expect(broken).not.toContain(marker);
    expect(broken).toContain('data-theme="dark"');
  });

  test("only the first real <html> start tag changes: not one in a comment; attributes of the same name go first", () => {
    const values = {
      "ui.language": "en",
      "ui.theme": "light",
      "ui.density": "comfy",
      "ui.accent": "teal",
      "ui.labels": false,
    } as never;
    const added =
      ' lang="en" data-theme="light" data-density="comfy" data-accent="teal" data-labels="false" data-ui-from="config"';
    expect(
      withAppearance(
        '<!doctype html><!-- <html data-theme="x"> --><HTML class="a" data-labels LANG=zh-CN data-theme=\'dark\' xml:lang="zh"><html>',
        values
      )
    ).toBe(
      `<!doctype html><!-- <html data-theme="x"> --><html class="a" xml:lang="zh"${added}><html>`
    );
    // A name that only begins like one of them is kept.
    expect(withAppearance('<html data-theme-extra="1" data-labelsx>', values)).toBe(
      `<html data-theme-extra="1" data-labelsx${added}>`
    );
    // Whatever a value is, it cannot leave its attribute.
    const odd = { ...(values as object), "ui.theme": '"><script>x</script>' } as never;
    expect(withAppearance("<html>", odd)).toContain(
      'data-theme="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"'
    );
  });

  test("a document without an <html> tag is served as it is", () => {
    const values = { "ui.language": "en", "ui.theme": "light" } as never;
    expect(withAppearance("<!doctype html><title>t</title>", values)).toBe(
      "<!doctype html><title>t</title>"
    );
  });
});
