import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { mailAccountProbe } from "../src/mail-account-probe.js";

// Every path that resolves the global directories goes to a throwaway tmp dir, never the real ones: set
// unconditionally, so a real directory exported in the shell running the tests is not kept. Tests that need their own
// directories set these (or inject stores) in their own body, which runs after this setup file. Removed when the test
// file ends.
const scratch = mkdtempSync(join(tmpdir(), "argelander-test-global-"));
process.env.ARGELANDERSPACE_GLOBAL_DIR = join(scratch, "data");
process.env.ARGELANDERSPACE_GLOBAL_CACHE_DIR = join(scratch, "cache");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
// Mail tool mounting asks "is there an account?": tests answer "no" unless they inject their own probe.
mailAccountProbe.default = () => false;
