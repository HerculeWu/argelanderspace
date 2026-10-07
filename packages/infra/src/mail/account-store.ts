/**
 * Mail account list in the global data directory (ADR 0007; Mail ticket 04).
 *
 * `<globalData>/mail/accounts.json` = { version, rev, accounts }. Several
 * workbench processes share it, so every change is a locked read-check-write:
 * the lock (proper-lockfile, a `.lock` directory next to the file) makes the
 * `rev` compare-and-swap atomic across processes; the write itself is
 * tmp + rename. A stale `expectedRev` throws {@link MailRevConflict} and writes
 * nothing. The file holds no passwords.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type MailAccount,
  type MailAccountsFile,
  MailAccountsFileSchema,
} from "@argelanderspace/contracts";
import lockfile from "proper-lockfile";
import { ensureGlobalDirs } from "../global-dirs.js";

export const MAIL_ACCOUNTS_FILE = "accounts.json";

export class MailRevConflict extends Error {
  readonly currentRev: number;
  constructor(currentRev: number) {
    super("mail accounts rev mismatch");
    this.currentRev = currentRev;
  }
}
/** The stored file cannot be read or fails its schema; never overwritten. */
export class MailAccountsUnreadable extends Error {
  constructor() {
    super("mail accounts file is unreadable");
  }
}

export interface MailAccountStore {
  read(): MailAccountsFile;
  /**
   * Under the cross-process lock: verify `expectedRev`, let `fn` compute the
   * new account list (it may do async side effects that must only happen once
   * the rev check passed; if it throws nothing is written), then persist
   * rev+1. Returns the saved file and whatever `fn` returned.
   */
  update<T>(
    expectedRev: number,
    fn: (current: MailAccountsFile) => Promise<{ accounts: MailAccount[]; result: T }>
  ): Promise<{ file: MailAccountsFile; result: T }>;
}

export function createMailAccountStore(opts: { dataDir?: string } = {}): MailAccountStore {
  const dir = () => join(opts.dataDir ?? ensureGlobalDirs().dataDir, "mail");
  const path = () => join(dir(), MAIL_ACCOUNTS_FILE);

  const read = (): MailAccountsFile => {
    let text: string;
    try {
      text = readFileSync(path(), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, rev: 0, accounts: [] };
      throw new MailAccountsUnreadable();
    }
    try {
      return MailAccountsFileSchema.parse(JSON.parse(text));
    } catch {
      throw new MailAccountsUnreadable();
    }
  };

  return {
    read,
    async update(expectedRev, fn) {
      mkdirSync(dir(), { recursive: true, mode: 0o700 });
      const release = await lockfile.lock(dir(), {
        lockfilePath: join(dir(), "accounts.lock"),
        stale: 15_000,
        // Default would throw inside a timer and crash the server; the write
        // below is still atomic, so just let the next caller retake the lock.
        onCompromised: () => {},
        retries: { retries: 40, minTimeout: 25, maxTimeout: 150 },
      });
      try {
        const current = read();
        if (current.rev !== expectedRev) throw new MailRevConflict(current.rev);
        const { accounts, result } = await fn(current);
        const next: MailAccountsFile = MailAccountsFileSchema.parse({
          version: 1,
          rev: current.rev + 1,
          accounts,
        });
        const tmp = `${path()}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
        try {
          writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
          renameSync(tmp, path());
        } catch (e) {
          rmSync(tmp, { force: true });
          throw e;
        }
        return { file: next, result };
      } finally {
        await release().catch(() => {});
      }
    },
  };
}
