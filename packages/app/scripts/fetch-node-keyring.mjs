#!/usr/bin/env node
// Downloads the keyring the Node download's signature is checked with (desktop-sidecar.mjs `--node-keyring`):
// gpg/pubring.kbx of github.com/nodejs/release-keys at the commit pinned in desktop-package-lib.mjs
// (`NODE_RELEASE_KEYS`), and refuses any other bytes than the pinned sha256 (desktop-app ticket 26; the release
// workflow's source of the keyring). NOT part of the four gates (network).
//
//   node packages/app/scripts/fetch-node-keyring.mjs --out <file>
//
// Exit: 0 written; 1 the download failed or the bytes are not the pinned ones (nothing written).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { keyringProblem, NODE_RELEASE_KEYS, parseStrictArgs } from "./desktop-package-lib.mjs";

let out;
try {
  out = parseStrictArgs(process.argv.slice(2), { valued: ["--out"] }).values["--out"];
  if (!out) throw new Error("--out <file> is required");
} catch (e) {
  console.error(`fetch-node-keyring: ${e.message}`);
  process.exit(1);
}
const res = await fetch(NODE_RELEASE_KEYS.url);
if (!res.ok) {
  console.error(`fetch-node-keyring: ${NODE_RELEASE_KEYS.url}: HTTP ${res.status}`);
  process.exit(1);
}
const bytes = Buffer.from(await res.arrayBuffer());
const problem = keyringProblem(bytes);
if (problem) {
  console.error(`fetch-node-keyring: ${problem}; nothing written`);
  process.exit(1);
}
mkdirSync(dirname(resolve(out)), { recursive: true });
writeFileSync(resolve(out), bytes);
console.log(
  `fetch-node-keyring: nodejs/release-keys@${NODE_RELEASE_KEYS.commit.slice(0, 8)} gpg/pubring.kbx (sha256 ${NODE_RELEASE_KEYS.sha256.slice(0, 12)}…) -> ${resolve(out)}`
);
