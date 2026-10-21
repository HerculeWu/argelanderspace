// The desktop host as its own process, for `desktop-tutorial-host.test.ts` (in-app-tutorial ticket 25): what the CLI
// entry `desktop-host` does (change into `--project`, or choose from the recent projects), with the tutorial sample a
// test made (`TEST_TUTORIAL_SAMPLE`; absent: this installation has none) instead of the one next to the bundle.
// Runs the built server: build first (the four gates do).
import { runDesktopHost } from "../../dist/desktop-host.js";

const project = process.argv[2];
if (project !== undefined) process.chdir(project);
const sample = process.env.TEST_TUTORIAL_SAMPLE;
const host = await runDesktopHost({
  input: process.stdin,
  output: process.stdout,
  version: "9.9.9-test",
  signals: true,
  ...(project === undefined ? { fromRecent: true } : {}),
  webDist: process.env.TEST_WEB_DIST,
  ...(sample ? { tutorialSampleDir: sample } : {}),
  keychainProbe: async () => ({ state: "unavailable", reason: "no_bus" }),
});
await host.stopped;
process.stdout.write("", () => process.exit(0));
