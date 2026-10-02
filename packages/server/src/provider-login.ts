import { randomUUID } from "node:crypto";
import type {
  ProviderLogin,
  ProviderLoginFailure,
  ProviderLoginNotice,
} from "@argelanderspace/contracts";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Raised for caller mistakes; mapped to fixed HTTP codes by the provider router. */
export class ProviderLoginError extends Error {
  constructor(readonly code: "not_found" | "busy" | "stale" | "invalid_input") {
    super(code);
  }
}

export interface LoginHost {
  /** Validates that the provider has an OAuth login and returns the shared Pi runtime. */
  prepare(providerId: string): Promise<ModelRuntime>;
  /**
   * Called after the SDK reports a persisted credential. Verifies the disk and records the
   * catalog-synchronization outcome separately from the login outcome.
   */
  persisted(providerId: string, synchronizationFailed: boolean): Promise<void>;
}

interface Challenge {
  id: string;
  kind: "select" | "manual_code";
  options: { id: string }[];
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}
interface Entry {
  login: ProviderLogin;
  controller: AbortController;
  challenge?: Challenge;
  timer?: ReturnType<typeof setTimeout>;
  waiters: Set<() => void>;
}

const ACTIVE = new Set(["running", "awaiting_user"]);
const text = (value: unknown, max: number): string =>
  typeof value === "string"
    ? // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal controls from SDK text
      value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max)
    : "";
function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

/** SDK/provider text can carry tokens or response bodies: classify internally, never forward. */
function classify(error: unknown): ProviderLoginFailure | "expired" {
  const message = error instanceof Error ? error.message : "";
  if (/timed out|expired/i.test(message)) return "expired";
  if (
    /state mismatch|missing authorization code|accountId|missing fields|invalid openai codex/i.test(
      message
    )
  )
    return "invalid_response";
  if (/fetch|network|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(message)) return "network";
  return "unavailable";
}

/**
 * One in-memory login instance per OAuth provider. Everything a flow produces is written only to
 * its own Entry, so after cancel/replace a late SDK result has nowhere to land.
 */
export class ProviderLogins {
  private readonly current = new Map<string, Entry>();

  constructor(
    private readonly host: LoginHost,
    private readonly ttlMs: number
  ) {}

  snapshot(providerId: string): ProviderLogin | undefined {
    const entry = this.current.get(providerId);
    return entry ? this.view(entry) : undefined;
  }

  private view(entry: Entry): ProviderLogin {
    const { challenge } = entry;
    return structuredClone({
      ...entry.login,
      challenge: challenge
        ? { id: challenge.id, kind: challenge.kind, options: challenge.options }
        : null,
    });
  }

  private find(providerId: string, loginId: string): Entry {
    const entry = this.current.get(providerId);
    if (!entry || entry.login.id !== loginId) throw new ProviderLoginError("not_found");
    return entry;
  }

  private emit(entry: Entry): void {
    for (const waiter of [...entry.waiters]) waiter();
  }

  /** Wait for the next visible change so one HTTP round trip usually returns the new state. */
  private changed(entry: Entry, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        entry.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      entry.waiters.add(done);
    });
  }

  private end(
    entry: Entry,
    status: "succeeded" | "failed" | "cancelled" | "expired",
    failure: ProviderLoginFailure | null = null
  ): void {
    if (!ACTIVE.has(entry.login.status)) return;
    entry.login.status = status;
    entry.login.failure = failure;
    // A finished login keeps only masked state: the state/user code are no longer needed.
    entry.login.notices = [];
    clearTimeout(entry.timer);
    const { challenge } = entry;
    entry.challenge = undefined;
    // Aborting also unwinds the SDK flow (callback server, polling, pending fetch).
    if (status !== "succeeded") entry.controller.abort();
    challenge?.reject(new Error("Login cancelled"));
    this.emit(entry);
  }

  async start(providerId: string): Promise<ProviderLogin> {
    const runtime = await this.host.prepare(providerId);
    const previous = this.current.get(providerId);
    if (previous && ACTIVE.has(previous.login.status)) throw new ProviderLoginError("busy");
    const now = Date.now();
    const entry: Entry = {
      login: {
        id: randomUUID(),
        providerId,
        status: "running",
        challenge: null,
        notices: [],
        failure: null,
        startedAt: now,
        expiresAt: now + this.ttlMs,
      },
      controller: new AbortController(),
      waiters: new Set(),
    };
    this.current.set(providerId, entry);
    entry.timer = setTimeout(() => this.end(entry, "expired"), this.ttlMs);
    entry.timer.unref?.();
    void this.run(entry, runtime);
    await this.changed(entry, 1500);
    return this.view(entry);
  }

  private async run(entry: Entry, runtime: ModelRuntime): Promise<void> {
    const { providerId } = entry.login;
    try {
      const { CredentialSynchronizationError } = await import("@earendil-works/pi-coding-agent");
      let synchronizationFailed = false;
      try {
        await runtime.login(providerId, "oauth", {
          signal: entry.controller.signal,
          prompt: (prompt) => this.prompt(entry, prompt),
          notify: (event) => this.notify(entry, event),
        });
      } catch (error) {
        // The credential is already persisted; only the model catalog could not refresh.
        if (!(error instanceof CredentialSynchronizationError)) throw error;
        synchronizationFailed = true;
      }
      // The SDK reports the credential written, even if the user cancelled meanwhile. The disk
      // (checked in persisted) decides: record the real signed-in state and its side effects.
      await this.host.persisted(providerId, synchronizationFailed);
      if (!ACTIVE.has(entry.login.status)) {
        if (entry.login.status === "cancelled" || entry.login.status === "expired") {
          entry.login.status = "succeeded";
          entry.login.failure = null;
          this.emit(entry);
        }
        return;
      }
      this.end(entry, "succeeded");
    } catch (error) {
      if (!ACTIVE.has(entry.login.status)) return;
      const result = classify(error);
      if (result === "expired") this.end(entry, "expired");
      else this.end(entry, "failed", result);
    }
  }

  private prompt(entry: Entry, prompt: AuthPrompt): Promise<string> {
    if (!ACTIVE.has(entry.login.status) || entry.challenge)
      return Promise.reject(new Error("Login cancelled"));
    if (prompt.type !== "select" && prompt.type !== "manual_code")
      return Promise.reject(new Error("unsupported prompt"));
    return new Promise<string>((resolve, reject) => {
      const challenge: Challenge = {
        id: randomUUID(),
        kind: prompt.type as "select" | "manual_code",
        options:
          prompt.type === "select"
            ? prompt.options.map((item) => ({ id: text(item.id, 100) }))
            : [],
        resolve,
        reject,
      };
      // A callback winning the race withdraws a manual prompt without ending the login.
      prompt.signal?.addEventListener(
        "abort",
        () => {
          if (entry.challenge !== challenge) return;
          entry.challenge = undefined;
          if (ACTIVE.has(entry.login.status)) entry.login.status = "running";
          reject(new Error("prompt withdrawn"));
          this.emit(entry);
        },
        { once: true }
      );
      entry.challenge = challenge;
      entry.login.status = "awaiting_user";
      this.emit(entry);
    });
  }

  private notify(entry: Entry, event: AuthEvent): void {
    if (!ACTIVE.has(entry.login.status)) return;
    let notice: ProviderLoginNotice | null = null;
    if (event.type === "auth_url") {
      const url = httpsUrl(event.url);
      if (url) notice = { type: "auth_url", url };
    } else if (event.type === "device_code") {
      const verificationUri = httpsUrl(event.verificationUri);
      const userCode = text(event.userCode, 64);
      if (verificationUri && userCode)
        notice = {
          type: "device_code",
          userCode,
          verificationUri,
          intervalSeconds: Number.isFinite(event.intervalSeconds)
            ? (event.intervalSeconds ?? null)
            : null,
          expiresInSeconds: Number.isFinite(event.expiresInSeconds)
            ? (event.expiresInSeconds ?? null)
            : null,
        };
    }
    // info/progress text is SDK prose the UI never shows: not forwarded.
    if (!notice) return;
    const type = notice.type;
    entry.login.notices = [...entry.login.notices.filter((item) => item.type !== type), notice];
    this.emit(entry);
  }

  get(providerId: string, loginId: string): ProviderLogin {
    return this.view(this.find(providerId, loginId));
  }

  async answer(
    providerId: string,
    loginId: string,
    challengeId: string,
    value: string
  ): Promise<ProviderLogin> {
    const entry = this.find(providerId, loginId);
    const { challenge } = entry;
    // Instance and challenge both must match; a stale answer never reaches the SDK prompt.
    if (!ACTIVE.has(entry.login.status) || !challenge || challenge.id !== challengeId)
      throw new ProviderLoginError("stale");
    if (challenge.kind === "select" && !challenge.options.some((item) => item.id === value))
      throw new ProviderLoginError("invalid_input");
    entry.challenge = undefined;
    entry.login.status = "running";
    const next = this.changed(entry, 1500);
    challenge.resolve(value);
    await next;
    return this.view(entry);
  }

  /** Cancel an active login, or dismiss a finished one. Idempotent for the same login id. */
  cancel(providerId: string, loginId: string): ProviderLogin {
    const entry = this.find(providerId, loginId);
    this.end(entry, "cancelled");
    return this.view(entry);
  }

  /** Release an active flow (and the SDK credential-operation queue behind it) without forgetting it. */
  cancelActive(providerId: string): void {
    const entry = this.current.get(providerId);
    if (entry) this.end(entry, "cancelled");
  }

  /** Logout/shutdown: end any active flow and forget the finished one. */
  clear(providerId: string): void {
    const entry = this.current.get(providerId);
    if (!entry) return;
    this.end(entry, "cancelled");
    this.current.delete(providerId);
  }

  close(): void {
    for (const providerId of [...this.current.keys()]) this.clear(providerId);
  }
}
