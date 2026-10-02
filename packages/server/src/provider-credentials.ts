import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";

/** Pi owns authentication; this store only provides serialized, atomic persistence. */
export class ProviderCredentialStore implements CredentialStore {
  constructor(
    private readonly path: string,
    private readonly guard: () => void,
    private readonly validate: (path: string) => void
  ) {}

  private data(): Record<string, Credential> {
    this.guard();
    try {
      return JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private literal(credential: Credential | undefined): Credential | undefined {
    return credential?.type === "api_key" && credential.key !== undefined
      ? { ...credential, key: credential.key.replaceAll("$$", "$") }
      : credential;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return this.literal(this.data()[providerId]);
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return Object.entries(this.data()).map(([providerId, value]) => ({
      providerId,
      type: value.type,
    }));
  }

  private async update(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    remove: boolean,
    options?: AuthOperationOptions
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    this.guard();
    try {
      if (lstatSync(`${this.path}.lock`).isSymbolicLink())
        throw new Error("unsafe credential lock");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let compromised = false;
    const pending = lockfile.lock(this.path, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 10, minTimeout: 10, maxTimeout: 2000 },
      onCompromised: () => {
        compromised = true;
      },
    });
    // A cancelled waiter must release any lock that arrives after it has returned.
    const acquired = pending.then(async (release) => {
      if (options?.signal?.aborted) {
        await release();
        options.signal.throwIfAborted();
      }
      return release;
    });
    const release = await abortable(acquired, options?.signal);
    const stage = `${this.path}.tmp-${randomUUID()}`;
    try {
      const data = this.data();
      const current = this.literal(data[providerId]);
      const next = await fn(current);
      options?.signal?.throwIfAborted();
      if (compromised) throw new Error("credential lock compromised");
      if (remove) delete data[providerId];
      else if (next !== undefined)
        data[providerId] =
          next.type === "api_key" && next.key !== undefined
            ? { ...next, key: next.key.replaceAll("$", () => "$$") }
            : next;
      else return current;
      writeFileSync(stage, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      this.validate(stage);
      this.guard();
      options?.signal?.throwIfAborted();
      if (compromised) throw new Error("credential lock compromised");
      renameSync(stage, this.path);
      return remove ? undefined : next;
    } finally {
      try {
        rmSync(stage, { force: true });
      } finally {
        await release().catch(() => {});
      }
    }
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions
  ): Promise<Credential | undefined> {
    return this.update(providerId, fn, false, options);
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    await this.update(providerId, async () => undefined, true, options);
  }
}

function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
