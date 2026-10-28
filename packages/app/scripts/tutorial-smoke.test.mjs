// The packaged tutorial sample is loadable (in-app-tutorial ticket 27): the rules both package smokes
// (smoke-pack.mjs, smoke-desktop-package.mjs) apply to the `tutorial/` a package carries, and the check itself run
// against this build's dist/tutorial with dist/bin.js (needs the build, like version.test.mjs). The smokes are not
// part of the four gates; these tests are.
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkTutorialLoadable,
  TUTORIAL_EXPECT,
  tutorialLoadProblems,
  tutorialPresenceProblems,
  tutorialSize,
} from "./tutorial-smoke-lib.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const DOC = TUTORIAL_EXPECT.docId;

const works = (n, withDoc = true) =>
  Array.from({ length: n }, (_, i) => ({
    id: `w${i}`,
    ...(withDoc && i === 2 ? { doc_ids: [DOC] } : {}),
  }));
const good = () => ({
  library: { status: 200, json: { refs: works(5) } },
  annotations: { status: 200, json: { annotations: [{}, {}, {}] } },
  before: { entries: ["current.json"], current: "abc" },
  after: { entries: ["current.json"], current: "abc" },
});

test("the sample's expectations: five Works, Jerabkova's Doc, three annotations", () => {
  assert.deepEqual(TUTORIAL_EXPECT, { works: 5, docId: "arxiv-2103.12080", annotations: 3 });
});

test("a loadable sample: five Works, the Doc on one of them, three annotations, no archive, current unchanged", () => {
  assert.deepEqual(tutorialLoadProblems(good()), []);
});

test("each way the sample does not load is named", () => {
  const cases = [
    [{ library: { status: 200, json: { refs: works(4) } } }, /4 Works, not the sample's five/],
    [{ library: { status: 500, json: null } }, /GET \/api\/library.*500/],
    [{ library: { status: 200, json: { refs: works(5, false) } } }, /no Work carries the Doc/],
    [
      { annotations: { status: 200, json: { annotations: [{}, {}] } } },
      /2 annotations, not the sample's 3/,
    ],
    [{ annotations: { status: 500, json: { detail: "x" } } }, /annotations.*500/],
    [{ after: { entries: ["archive", "current.json"], current: "abc" } }, /archive/],
    [{ after: { entries: ["current.json"], current: "def" } }, /current\.json changed/],
    [{ after: { entries: [], current: null } }, /current\.json changed/],
  ];
  for (const [patch, pattern] of cases) {
    const problems = tutorialLoadProblems({ ...good(), ...patch });
    assert.equal(problems.length, 1, `${pattern}: ${problems.join("; ")}`);
    assert.match(problems[0], pattern);
  }
});

test("the files a package's tutorial/ must hold: marker, notice, the upload zip and the two preset conversations", () => {
  const all = new Set([
    "argelanderspace-tutorial.json",
    "NOTICE.md",
    "tutorial-assets/evans-oh-2022-source.zip",
    "literatures/copilot/conversations/85b4af77-56d0-4684-8a1c-b8926dec17d0.json",
    "literatures/copilot/sessions/42a3eeab-d759-46d1-aadd-c7d34cbe4ccc.jsonl",
    "literatures/copilot/conversations/fee7ecc0-b8e9-49b0-9ac7-a582faaa984c.json",
    "literatures/copilot/sessions/616ed294-6e52-48b3-894a-9fd1b8d09486.jsonl",
  ]);
  assert.deepEqual(
    tutorialPresenceProblems((f) => all.has(f)),
    []
  );
  for (const f of all) {
    const problems = tutorialPresenceProblems((g) => g !== f && all.has(g));
    assert.deepEqual(problems, [`tutorial/${f} is missing`]);
  }
});

test("the size of tutorial/ is the sum of its file sizes and its file count", () => {
  const dir = mkdtempSync(join(tmpdir(), "aspace-tutorial-size-"));
  try {
    mkdirSync(join(dir, "a/b"), { recursive: true });
    writeFileSync(join(dir, "x"), "12345");
    writeFileSync(join(dir, "a/b/y"), "123");
    assert.deepEqual(tutorialSize(dir), { bytes: 8, files: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The check itself, on this build (the real server from dist/bin.js on a temp copy of dist/tutorial).
const bin = join(appRoot, "dist/bin.js");
const sample = join(appRoot, "dist/tutorial");
const isolatedEnv = (home) => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local/share"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_STATE_HOME: join(home, ".local/state"),
  XDG_RUNTIME_DIR: join(home, "runtime"),
  DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(home, "no-session-bus")}`,
  NO_COLOR: "1",
});
async function runOn(tutorialDir) {
  const work = mkdtempSync(join(tmpdir(), "aspace-tutorial-smoke-"));
  try {
    const home = join(work, "home");
    mkdirSync(join(home, "runtime"), { recursive: true, mode: 0o700 });
    return await checkTutorialLoadable({
      tutorialDir,
      node: process.execPath,
      binJs: bin,
      env: isolatedEnv(home),
      work: join(work, "run"),
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test("this build's dist/tutorial loads in the real server: five Works, three annotations, no archive", async () => {
  assert.ok(existsSync(bin) && existsSync(sample), "build the app package first");
  const before = readFileSync(join(sample, `literatures/annotations/${DOC}/current.json`));
  const result = await runOn(sample);
  assert.deepEqual(result.problems, []);
  assert.equal(result.works, 5);
  assert.equal(result.annotations, 3);
  // The sample itself is never the data dir: it is unchanged.
  assert.ok(
    before.equals(readFileSync(join(sample, `literatures/annotations/${DOC}/current.json`)))
  );
});

test("control: a sample whose Doc changed under its annotations fails (the GET archived them)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "aspace-tutorial-changed-"));
  try {
    cpSync(sample, join(tmp, "tutorial"), { recursive: true });
    const ir = join(tmp, `tutorial/literatures/output/${DOC}/${DOC}.json`);
    const doc = JSON.parse(readFileSync(ir, "utf8"));
    // A section heading is part of the content fingerprint (core docContentProjection).
    doc.sections[0].heading = `${doc.sections[0].heading ?? ""} (changed)`;
    writeFileSync(ir, JSON.stringify(doc));
    const result = await runOn(join(tmp, "tutorial"));
    assert.ok(
      result.problems.some((p) => /archive/.test(p)) &&
        result.problems.some((p) => /0 annotations, not the sample's 3/.test(p)),
      result.problems.join("; ")
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
