import type { WsMailChanged } from "@argelanderspace/contracts";
import {
  createCredentialStore,
  createMailAccountStore,
  createNodeMailInboxWatcher,
} from "@argelanderspace/infra";
import { MailWatcher, type MailWatcherDeps } from "./mail-watch.js";

/** Everything but the `emit` sink can be replaced (isolated stores, a fake IMAP, a manual clock). */
export type MailWatcherOverrides = Partial<Omit<MailWatcherDeps, "emit">>;

/** Production wiring over the real global directories and the node IMAP seam. */
export function createDefaultMailWatcher(
  emit: (message: WsMailChanged) => void,
  overrides: MailWatcherOverrides = {}
): MailWatcher {
  return new MailWatcher({
    ...overrides,
    accounts: overrides.accounts ?? createMailAccountStore(),
    credentials: overrides.credentials ?? createCredentialStore(),
    inbox: overrides.inbox ?? createNodeMailInboxWatcher(),
    emit,
  });
}
