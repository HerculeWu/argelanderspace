/**
 * The contact email of the Crossref and OpenAlex requests (desktop-app ticket 11): sent when config.toml has one,
 * absent from the query and the User-Agent when it has none; no built-in address, no environment variable. The
 * strict reading refuses an address that is not shaped like one; the lenient reading leaves it out.
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  ConfigError,
  configFilePath,
  configOfReading,
  parseConfigToml,
  readContactEmail,
  readSettingsText,
} from "../src/config.js";
import { CrossrefClient } from "../src/sources/crossref.js";
import { OpenAlexClient } from "../src/sources/openalex.js";
import { jsonResponse, stubFetch } from "./helpers.js";

const MARK = "contact.mark-7f3a@example.org";
const temps: string[] = [];

function cacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aspace-contact-"));
  temps.push(dir);
  return dir;
}

function writeConfig(text: string): void {
  const file = configFilePath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  temps.push(dirname(file));
}

afterEach(() => {
  delete process.env.OPENALEX_MAILTO;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const crossrefBody = { message: { DOI: "10.1/x", title: ["T"], author: [] } };
const openalexBody = { id: "https://openalex.org/W1", display_name: "T", referenced_works: ["W2"] };

async function crossrefCall(mailto?: string | null) {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(crossrefBody));
  const client = new CrossrefClient({
    cacheDir: cacheDir(),
    delay: 0,
    fetchImpl,
    ...(mailto !== undefined ? { mailto } : {}),
  });
  await client.resolve({ doi: "10.1/x" });
  expect(calls).toHaveLength(1);
  const [call] = calls;
  if (call === undefined) throw new Error("no request");
  return call;
}

async function openalexCall(mailto?: string | null) {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(openalexBody));
  const client = new OpenAlexClient({
    cacheDir: cacheDir(),
    delay: 0,
    apiKey: null,
    fetchImpl,
    ...(mailto !== undefined ? { mailto } : {}),
  });
  await client.resolve({ doi: "10.1/x" });
  const [call] = calls;
  if (call === undefined) throw new Error("no request");
  return call;
}

/** No address anywhere in what goes out: the URL (query included) and every header. */
function expectNoAddress(call: { url: string; headers: Record<string, string> }) {
  expect(decodeURIComponent(call.url)).not.toContain("@");
  expect(call.url).not.toContain("mailto");
  for (const value of Object.values(call.headers)) {
    expect(value).not.toContain("@");
    expect(value).not.toContain("mailto");
  }
}

describe("the contact email on the wire", () => {
  test("Crossref: the address is in the mailto parameter and the User-Agent when one is given", async () => {
    const call = await crossrefCall(MARK);
    expect(new URL(call.url).searchParams.get("mailto")).toBe(MARK);
    expect(call.headers["User-Agent"]).toBe(`ArgelanderSpace/0.1 (mailto:${MARK})`);
  });

  test("OpenAlex: the address is in the mailto parameter and the User-Agent when one is given", async () => {
    const call = await openalexCall(MARK);
    expect(new URL(call.url).searchParams.get("mailto")).toBe(MARK);
    expect(call.headers["User-Agent"]).toBe(`ArgelanderSpace/0.1 (mailto:${MARK})`);
  });

  test("with none, neither the query nor any header has an address (Crossref and OpenAlex)", async () => {
    expectNoAddress(await crossrefCall(null));
    expectNoAddress(await openalexCall(null));
  });

  test("the default is config.toml's contact_email; no file means none, and $OPENALEX_MAILTO is not read", async () => {
    process.env.OPENALEX_MAILTO = "env.mark@example.org";
    expectNoAddress(await crossrefCall());
    expectNoAddress(await openalexCall());
    writeConfig(`contact_email = "${MARK}"\n`);
    expect(new URL((await crossrefCall()).url).searchParams.get("mailto")).toBe(MARK);
    expect(new URL((await openalexCall()).url).searchParams.get("mailto")).toBe(MARK);
    writeConfig('contact_email = "   "\n');
    expectNoAddress(await crossrefCall());
    expectNoAddress(await openalexCall());
  });

  test("a client made by default with a malformed address in the file stops (the commands' strict reading)", () => {
    writeConfig('contact_email = "not an address"\n');
    expect(() => new CrossrefClient({ cacheDir: cacheDir(), fetchImpl: fetch })).toThrow(
      ConfigError
    );
    expect(
      () => new OpenAlexClient({ cacheDir: cacheDir(), apiKey: null, fetchImpl: fetch })
    ).toThrow(ConfigError);
  });
});

describe("contact_email in the two readings", () => {
  test("strict: a malformed address is a ConfigError naming the key, never the value", () => {
    for (const bad of ["x", "a b@example.org", "a@b", "​a@example.org", "a@example.org\n"]) {
      let error: unknown;
      try {
        parseConfigToml(`contact_email = ${JSON.stringify(bad)}\n`, "/cfg/config.toml");
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toBe(
        '/cfg/config.toml: "contact_email" must be an email address'
      );
    }
    expect(parseConfigToml(`contact_email = "${MARK}"\n`).contact_email).toBe(MARK);
    expect(parseConfigToml('contact_email = ""\n').contact_email).toBe("");
  });

  test("lenient: a malformed address is a problem and is left out of what the server uses", () => {
    const reading = readSettingsText('contact_email = "nobody"\n');
    expect(reading.problems).toEqual([{ key: "contact_email", reason: "must_be_email" }]);
    expect(reading.values.contact_email).toBeNull();
    expect(readContactEmail(configOfReading(reading))).toBeNull();
    const good = readSettingsText(`contact_email = "${MARK}"\n`);
    expect(readContactEmail(configOfReading(good))).toBe(MARK);
    expect(readContactEmail({ contact_email: "  " })).toBeNull();
  });
});

describe("no built-in address in the source", () => {
  const SRC = fileURLToPath(new URL("../../", import.meta.url));

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === "node_modules" || name === "dist" || name === "tests" || name.startsWith("."))
        continue;
      if (statSync(path).isDirectory()) sourceFiles(path, out);
      else if (/\.(ts|tsx|mts|mjs|js)$/.test(name)) out.push(path);
    }
    return out;
  }

  test("packages/*/src and packages/*/scripts hold no email address and read no $OPENALEX_MAILTO", () => {
    const files = readdirSync(SRC).flatMap((pkg) =>
      ["src", "scripts"].flatMap((part) => {
        const dir = join(SRC, pkg, part);
        try {
          return statSync(dir).isDirectory() ? sourceFiles(dir) : [];
        } catch {
          return [];
        }
      })
    );
    expect(files.length).toBeGreaterThan(100);
    // An address in a string: a local part, `@`, a domain with a dot. Allowed: the reserved example domains of RFC 2606
    // (no one's mailbox), and the two example recipients of a tool description, by exact text.
    const address = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
    const allowed = new Set(["a@x.org", "b@y.org"]);
    const found: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf-8");
      for (const match of text.matchAll(address)) {
        if (!allowed.has(match[0]) && !/@example\.(?:org|com|net)$/.test(match[0]))
          found.push(`${relative(SRC, file)}: ${match[0]}`);
      }
      if (text.includes("OPENALEX_MAILTO")) found.push(`${relative(SRC, file)}: OPENALEX_MAILTO`);
    }
    expect(found).toEqual([]);
  });
});
