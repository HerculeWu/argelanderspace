// Child process for the cross-process tests of writeSetting: changes one key of the given file and prints the result.
import { register } from "node:module";

register("./mail/ts-resolve-hook.mjs", import.meta.url);
const { writeSetting } = await import("../src/config-write.ts");
const [path, key, value] = process.argv.slice(2);
// The process's own file-creation mask, for the test of the permission bits (a test worker cannot set one).
if (process.env.ASPACE_TEST_UMASK) process.umask(Number.parseInt(process.env.ASPACE_TEST_UMASK, 8));
const change = value === "--reset" ? { reset: true } : { set: JSON.parse(value) };
console.log(JSON.stringify(await writeSetting(key, change, { path })));
