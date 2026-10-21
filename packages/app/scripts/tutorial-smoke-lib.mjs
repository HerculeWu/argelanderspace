// "The packaged tutorial sample is loadable" (in-app-tutorial ticket 27, spec Testing Decisions 「包冒烟」): the check
// both package smokes run on the `tutorial/` a package carries (smoke-pack.mjs: the installed npm package's
// dist/tutorial; smoke-desktop-package.mjs: the unpacked deb/AppImage's resource tutorial/), with that package's own
// Node and bin.js. Not only "the files are there": a real server takes a temp copy as its project (`--data-dir
// <copy>/literatures`) and must list the five Works and give Jerabkova's three annotations without archiving them.
// The package's own tutorial/ is never the data dir. Its size is reported, not gated (spec §1).
//
// The pure rules are tested by tutorial-smoke.test.mjs, which also runs checkTutorialLoadable on this build.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** What the frozen sample holds (tickets 13, 17): five Works, one Doc (Jerabkova 2021) with three annotations. */
export const TUTORIAL_EXPECT = Object.freeze({
  works: 5,
  docId: "arxiv-2103.12080",
  annotations: 3,
});

/** Files a package's tutorial/ must hold besides being loadable: the marker, the notice, the chapter 2 upload zip. */
const PRESENT = [
  "argelanderspace-tutorial.json",
  "NOTICE.md",
  "tutorial-assets/evans-oh-2022-source.zip",
];

/** `tutorial/<f> is missing` for each of those files `exists(relativePath)` says is not there. */
export function tutorialPresenceProblems(exists) {
  return PRESENT.filter((f) => !exists(f)).map((f) => `tutorial/${f} is missing`);
}

/** Sum of file sizes and number of files under `dir` (symlinks counted by their own size, not followed). */
export function tutorialSize(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (p) => {
    const st = lstatSync(p);
    if (st.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
    else {
      bytes += st.size;
      files += 1;
    }
  };
  walk(dir);
  return { bytes, files };
}

/**
 * What is wrong with what the server answered. `library` and `annotations`: `{status, json}` of GET /api/library and
 * GET /api/paper/<doc>/annotations; `before` / `after`: the Doc's annotation folder before the server started and
 * after the GET (`entries`: its names, `current`: sha256 of current.json or null). An archive appearing, or
 * current.json changing, means the GET found the content fingerprint changed and archived the preset annotations.
 */
export function tutorialLoadProblems({ library, annotations, before, after }) {
  const problems = [];
  const refs = library?.json?.refs;
  if (library?.status !== 200 || !Array.isArray(refs))
    problems.push(`GET /api/library answered ${library?.status}, not a library`);
  else if (refs.length !== TUTORIAL_EXPECT.works)
    problems.push(`GET /api/library lists ${refs.length} Works, not the sample's five`);
  else if (!refs.some((r) => (r.doc_ids ?? []).includes(TUTORIAL_EXPECT.docId)))
    problems.push(`no Work carries the Doc ${TUTORIAL_EXPECT.docId}`);
  const list = annotations?.json?.annotations;
  if (annotations?.status !== 200 || !Array.isArray(list))
    problems.push(
      `GET /api/paper/${TUTORIAL_EXPECT.docId}/annotations answered ${annotations?.status}: ${JSON.stringify(annotations?.json ?? null).slice(0, 200)}`
    );
  else if (list.length !== TUTORIAL_EXPECT.annotations)
    problems.push(
      `GET /api/paper/${TUTORIAL_EXPECT.docId}/annotations gave ${list.length} annotations, not the sample's 3`
    );
  const added = after.entries.filter((e) => !before.entries.includes(e));
  if (added.includes("archive"))
    problems.push(
      `the annotation GET made an archive folder (the preset annotations were archived)`
    );
  else if (added.length) problems.push(`the annotation GET added ${added.join(", ")}`);
  if (after.current !== before.current)
    problems.push(
      `annotations/${TUTORIAL_EXPECT.docId}/current.json changed (or disappeared) on GET`
    );
  return problems;
}

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
function annotationFolder(dir) {
  return existsSync(dir)
    ? {
        entries: readdirSync(dir).sort(),
        current: existsSync(join(dir, "current.json")) ? sha256(join(dir, "current.json")) : null,
      }
    : { entries: [], current: null };
}

/**
 * Copies `tutorialDir` to `<work>/tutorial`, starts `<node> <binJs> serve --port 0 --data-dir <work>/tutorial/literatures`
 * with `env` (the caller's isolated environment), waits for the child's own listen line naming that data dir, reads
 * the library and the Doc's annotations, stops it. Resolves `{problems, works, annotations, port, output}`.
 */
export async function checkTutorialLoadable({
  tutorialDir,
  node,
  binJs,
  env,
  work,
  timeoutMs = 60000,
}) {
  const copy = join(resolve(work), "tutorial");
  mkdirSync(resolve(work), { recursive: true });
  cpSync(tutorialDir, copy, { recursive: true });
  const dataDir = join(copy, "literatures");
  const annotationDir = join(dataDir, "annotations", TUTORIAL_EXPECT.docId);
  const problems = tutorialPresenceProblems((f) => existsSync(join(tutorialDir, f)));
  const before = annotationFolder(annotationDir);
  let output = "";
  const child = spawn(node, [binJs, "serve", "--port", "0", "--data-dir", dataDir], {
    cwd: copy,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  const result = { problems, works: null, annotations: null, port: null, output: "" };
  try {
    const end = Date.now() + timeoutMs;
    let port = 0;
    while (!port) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`the server exited before listening`);
      if (Date.now() > end) throw new Error(`the server did not print its listen line`);
      const url = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      const dir = /data dir: (.+)/.exec(output);
      // Only the child we started, serving the copy: never some other server on some port.
      if (url && dir?.[1]?.trim() === dataDir) port = Number(url[1]);
      else await new Promise((r) => setTimeout(r, 100));
    }
    result.port = port;
    const get = async (path) => {
      if (child.exitCode !== null) throw new Error("the server exited");
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: res.status, json };
    };
    const library = await get("/api/library");
    const annotations = await get(
      `/api/paper/${encodeURIComponent(TUTORIAL_EXPECT.docId)}/annotations`
    );
    result.works = Array.isArray(library.json?.refs) ? library.json.refs.length : null;
    result.annotations = Array.isArray(annotations.json?.annotations)
      ? annotations.json.annotations.length
      : null;
    problems.push(
      ...tutorialLoadProblems({
        library,
        annotations,
        before,
        after: annotationFolder(annotationDir),
      })
    );
  } catch (error) {
    problems.push(`${error.message}: ${output.slice(-1500)}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const ended = await Promise.race([
      exited,
      new Promise((r) => setTimeout(() => r(null), 15000)),
    ]);
    if (ended === null) child.kill("SIGKILL");
    result.output = output;
  }
  return result;
}
