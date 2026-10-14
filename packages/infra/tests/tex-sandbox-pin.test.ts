/**
 * `sandbox-view.ts` repeats the rule by which `sandbox.ts` builds the sandbox's PATH (ticket 13; `sandbox.ts` is not
 * changed). This pins the two together through `sandbox.ts`'s own exports: its probe discovers the TeX directories on a
 * constructed PATH (the probe's bubblewrap is replaced by /bin/true, nothing else is run — discovery only looks at
 * files), and the PATH that `writerSandboxCommand` hands the sandbox must be the one the view computes. The PATH holds
 * a directory whose program is a link into /usr/bin (under /usr: left out), one under /tmp (not bindable: left out) and
 * one whose program is a link to a file under /opt (bindable: kept).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  __resetWriterSandboxProbeForTests,
  ensureWriterSandboxProbe,
  writerSandboxCommand,
} from "../src/tex/sandbox.js";
import { SANDBOX_SYSTEM_DIRS, sandboxPathDirs } from "../src/tex/sandbox-view.js";

const ORIGINAL_PATH = process.env.PATH;
const root = mkdtempSync(join(tmpdir(), "aspace-sbpin-"));
afterAll(async () => {
  process.env.PATH = ORIGINAL_PATH;
  await __resetWriterSandboxProbeForTests(null);
  rmSync(root, { recursive: true, force: true });
});

/**
 * Any plain file one level down in /opt: the target the bindable directory's program links to (it is never run —
 * the probe's discovery only looks at files). /opt is a place the sandbox may bind; a machine with nothing there
 * cannot pin the bindable case, and the test says so instead of passing.
 */
function fileUnderOpt(): string | null {
  try {
    for (const entry of readdirSync("/opt", { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join("/opt", entry.name);
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue; // a directory this user cannot read: the next one
      }
      for (const name of names) {
        const file = join(dir, name);
        try {
          if (statSync(file).isFile()) return realpathSync(file);
        } catch {
          /* unreadable: the next one */
        }
      }
    }
  } catch {
    /* no /opt */
  }
  return null;
}
const OPT_FILE = fileUnderOpt();
const CAN = existsSync("/usr/bin/latexmk") && OPT_FILE !== null && existsSync("/bin/true");
if (!CAN)
  console.warn(
    "tex-sandbox-pin: skipped (needs /usr/bin/latexmk, a file under /opt, /bin/true) — a skip is not a pass"
  );

test.skipIf(!CAN)(
  "the sandbox's PATH (sandbox.ts) is the one the environment check computes (sandbox-view.ts)",
  async () => {
    const underUsr = join(root, "under-usr");
    const inTmp = join(root, "in-tmp");
    const inOpt = join(root, "in-opt");
    for (const dir of [underUsr, inTmp, inOpt]) mkdirSync(dir);
    symlinkSync("/usr/bin/latexmk", join(underUsr, "latexmk"));
    writeFileSync(join(inTmp, "pdflatex"), "not run");
    symlinkSync(OPT_FILE as string, join(inOpt, "xelatex"));
    const hostPath = [underUsr, inTmp, inOpt].join(":");
    process.env.PATH = hostPath;
    await __resetWriterSandboxProbeForTests("/bin/true");
    expect(await ensureWriterSandboxProbe()).toBe(true);
    const { fdInput } = writerSandboxCommand(join(root, "work"), {}, "latexmk", []);
    const args = fdInput.toString("utf8").split("\0");
    const at = args.findIndex((arg, i) => arg === "--setenv" && args[i + 1] === "PATH");
    const sandboxPath = args[at + 2]?.split(":");
    expect(sandboxPath).toEqual(sandboxPathDirs({ hostPath }));
    expect(sandboxPath).toEqual([...SANDBOX_SYSTEM_DIRS, dirname(OPT_FILE as string)]);
  }
);
