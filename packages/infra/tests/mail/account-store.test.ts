import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MailAccount } from "@argelanderspace/contracts";
import { beforeEach, expect, test } from "vitest";
import {
  createMailAccountStore,
  MAIL_ACCOUNTS_FILE,
  MailAccountsUnreadable,
  MailRevConflict,
} from "../../src/mail/account-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mail-store-"));
});

const acct = (n: number): MailAccount => ({
  id: `acc-${n.toString(16).padStart(12, "0")}`,
  displayName: `A${n}`,
  address: `a${n}@example.test`,
  preset: "custom",
  imap: { host: "imap.example.test", port: 993, security: "tls" },
  smtp: { host: "smtp.example.test", port: 465, security: "tls" },
  imapUser: `a${n}`,
  smtpUser: `a${n}`,
  credentialRef: `acc-${n.toString(16).padStart(12, "0")}`,
  credentialProtection: "keychain",
});

test("empty store reads rev 0; update bumps rev and persists 0600 without leftovers", async () => {
  const s = createMailAccountStore({ dataDir: dir });
  expect(s.read()).toEqual({ version: 1, rev: 0, accounts: [] });
  const { file } = await s.update(0, async () => ({ accounts: [acct(1)], result: null }));
  expect(file.rev).toBe(1);
  expect(s.read().accounts).toHaveLength(1);
  const files = readdirSync(join(dir, "mail"));
  expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("stale rev throws MailRevConflict and writes nothing; fn is not called", async () => {
  const s = createMailAccountStore({ dataDir: dir });
  await s.update(0, async () => ({ accounts: [acct(1)], result: null }));
  let called = false;
  await expect(
    s.update(0, async () => {
      called = true;
      return { accounts: [], result: null };
    })
  ).rejects.toMatchObject({ currentRev: 1 });
  expect(called).toBe(false);
  expect(s.read().accounts).toHaveLength(1);
});

test("fn throwing leaves the file untouched", async () => {
  const s = createMailAccountStore({ dataDir: dir });
  await s.update(0, async () => ({ accounts: [acct(1)], result: null }));
  await expect(
    s.update(1, async () => {
      throw new Error("boom");
    })
  ).rejects.toThrow("boom");
  expect(s.read().rev).toBe(1);
});

test("corrupt or schema-invalid file is unreadable and never overwritten", async () => {
  const s = createMailAccountStore({ dataDir: dir });
  await s.update(0, async () => ({ accounts: [], result: null }));
  const p = join(dir, "mail", MAIL_ACCOUNTS_FILE);
  writeFileSync(p, "{not json");
  expect(() => s.read()).toThrow(MailAccountsUnreadable);
  await expect(s.update(1, async () => ({ accounts: [], result: null }))).rejects.toThrow(
    MailAccountsUnreadable
  );
  expect(readFileSync(p, "utf8")).toBe("{not json");
  expect(existsSync(p)).toBe(true);
});

test("two processes racing with the same rev: exactly one wins, the other gets 409-equivalent", async () => {
  const worker = fileURLToPath(new URL("./store-worker.mjs", import.meta.url));
  const run = (n: number) =>
    new Promise<string>((resolve, reject) => {
      const p = spawn(process.execPath, ["--no-warnings", worker, dir, String(n)], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      p.stdout.on("data", (d) => {
        out += d;
      });
      p.on("error", reject);
      p.on("close", () => resolve(out.trim()));
    });
  const results = await Promise.all([run(1), run(2), run(3), run(4)]);
  expect(results.filter((r) => r === "ok")).toHaveLength(1);
  expect(results.filter((r) => r === "conflict")).toHaveLength(3);
  const s = createMailAccountStore({ dataDir: dir });
  expect(s.read().rev).toBe(1);
  expect(s.read().accounts).toHaveLength(1);
  expect(MailRevConflict).toBeDefined();
}, 30_000);
