/**
 * Whether the mail tool is mounted (Mail ticket 09): the production decision is "does at least one account exist",
 * read from the real account service. The suite's setup installs a default probe that answers "no" so no test reads
 * the machine's real account store; here that default is removed on purpose, against a throwaway global directory.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCredentialStore,
  createMailAccountStore,
  type KeychainBackend,
} from "@argelanderspace/infra";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CopilotHost } from "../src/copilot.js";
import { mailAccountProbe } from "../src/mail-account-probe.js";
import { MailAccountService } from "../src/mail-accounts.js";
import type { MailOpDeps } from "../src/mail-copilot.js";

const account = {
  id: "acc-aaaaaaaaaaaa" as never,
  displayName: "Real Person",
  address: "real@example.test",
  preset: "custom" as const,
  imap: { host: "127.0.0.1", port: 1, security: "tls" as const },
  smtp: { host: "127.0.0.1", port: 1, security: "tls" as const },
  imapUser: "u",
  smtpUser: "u",
  credentialRef: "acc-aaaaaaaaaaaa" as never,
  credentialProtection: "keychain" as const,
};
let saved: (() => boolean) | undefined;
let root: string;
beforeEach(() => {
  saved = mailAccountProbe.default;
  root = mkdtempSync(join(tmpdir(), "mail-mount-"));
});
afterEach(() => {
  mailAccountProbe.default = saved;
});

function mailDeps(dir: string): MailOpDeps {
  const backend: KeychainBackend = { get: () => null, set: () => {}, delete: () => false };
  const service = new MailAccountService({
    store: createMailAccountStore({ dataDir: dir }),
    credentials: createCredentialStore({ backend, dataDir: dir }),
    protocol: {
      verifyImapLogin: async () => ({ ok: true }),
      verifySmtpLogin: async () => ({ ok: true }),
    },
    cacheDir: () => join(dir, "cache"),
  });
  return {
    accounts: () => service,
    read: () => ({}) as never,
    manage: () => ({}) as never,
    services: () => ({}) as never,
  };
}
function hostWith(mail: MailOpDeps, probe?: () => boolean): CopilotHost {
  const host = new CopilotHost(join(root, "copilot"), undefined, () => {}, probe);
  host.useWorkbench({ mail, plans: {} as never });
  return host;
}
const state = (host: CopilotHost) =>
  (host as unknown as { mailMountState(): string }).mailMountState();

test("the suite default answers no: a host without its own probe never reads the account store, even one that holds an account", async () => {
  const dir = join(root, "with-account");
  await createMailAccountStore({ dataDir: dir }).update(0, async () => ({
    accounts: [account],
    result: null,
  }));
  const host = hostWith(mailDeps(dir));
  expect(state(host)).toBe("off");
  await host.close();
});

test("production decision (no probe anywhere): an account mounts the tool, no account does not, a failing read mounts nothing and says unavailable", async () => {
  mailAccountProbe.default = undefined;
  const withDir = join(root, "with");
  await createMailAccountStore({ dataDir: withDir }).update(0, async () => ({
    accounts: [account],
    result: null,
  }));
  const emptyDir = join(root, "empty");
  mkdirSync(emptyDir, { recursive: true });
  const hosts = [
    hostWith(mailDeps(withDir)),
    hostWith(mailDeps(emptyDir)),
    hostWith({
      ...mailDeps(emptyDir),
      accounts: () => {
        throw new Error("store unreadable");
      },
    }),
  ];
  expect(hosts.map(state)).toEqual(["on", "off", "unavailable"]);
  await Promise.all(hosts.map((host) => host.close()));
});

test("a damaged account file is unavailable, not 'no account'", async () => {
  mailAccountProbe.default = undefined;
  const dir = join(root, "damaged");
  mkdirSync(join(dir, "mail"), { recursive: true });
  writeFileSync(join(dir, "mail", "accounts.json"), "{ not json");
  const host = hostWith(mailDeps(dir));
  expect(state(host)).toBe("unavailable");
  await host.close();
});
