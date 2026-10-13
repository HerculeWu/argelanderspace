import type { WsMailChanged } from "@argelanderspace/contracts";
import {
  createCredentialStore,
  createMailAccountStore,
  createNodeMailInboxWatcher,
} from "@argelanderspace/infra";
import { type ServerLog, silentLog } from "./log.js";
import { observedCredentials } from "./log-observers.js";
import { MailWatcher, type MailWatcherDeps } from "./mail-watch.js";

/** Everything but the `emit` sink can be replaced (isolated stores, a fake IMAP, a manual clock). */
export type MailWatcherOverrides = Partial<Omit<MailWatcherDeps, "emit" | "log">>;

/** Production wiring over the real global directories and the node IMAP seam. */
export function createDefaultMailWatcher(
  emit: (message: WsMailChanged) => void,
  overrides: MailWatcherOverrides = {},
  /** The user-level log: watch states and how connections ended, by account id and code only. */
  log: ServerLog = silentLog
): MailWatcher {
  return new MailWatcher({
    ...overrides,
    accounts: overrides.accounts ?? createMailAccountStore(),
    credentials: observedCredentials(overrides.credentials ?? createCredentialStore(), log),
    inbox: overrides.inbox ?? createNodeMailInboxWatcher(),
    emit,
    log,
  });
}
