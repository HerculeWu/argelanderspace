// A process that dies the way a long-running one can: `node crash.mjs <throw|reject|reject-value> <log|plain>`.
// With `log` it first opens the log `serve` opens (the built server's own function); with `plain` it does nothing
// of the kind — that run is what Node does when left alone.
import { getConfig } from "@argelanderspace/infra";
import { openServeLog } from "@argelanderspace/server";

const [kind, mode] = process.argv.slice(2);
if (mode === "log") openServeLog(getConfig());

function die() {
  if (kind === "throw") throw new Error("CRASH-MARKER while handling a private thing");
  if (kind === "reject") void Promise.reject(new TypeError("CRASH-MARKER in a promise"));
  if (kind === "reject-value") void Promise.reject("CRASH-MARKER as a bare string");
}
setTimeout(die, 10);
// Keeps the process alive: only the error ends it.
setInterval(() => {}, 1000);
