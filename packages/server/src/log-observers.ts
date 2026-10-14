/**
 * What the server writes to the user-level log about jobs, the external programs and web services infra calls, the
 * mail servers, and the tools it found when it started (desktop-app ticket 07). The Copilot's and the mail watcher's
 * own records are written where they happen (copilot.ts, mail-watch.ts); the names of all of them are in the
 * catalog (log.ts).
 *
 * Nothing here takes text from what it watches. A job's error message, a program's arguments and output, a request's
 * path, query and body, an answer's body, a mail server's reply: none of them is looked at for the record. What is
 * recorded is an identifier the workbench made from random bytes, a name from a list written in this file (or in the
 * module that owns it), a number, a duration, the scheme, host and port of a web service's URL (a constant of the
 * code — a mail server's host is the user's own and is written as a provider's name or `custom`), and, for a job that
 * failed, what it threw as an error field without its message and without the path of a system error.
 *
 * Every function returns the thing it was given when the log is the silent one, so a server without a log — every
 * test server that does not ask for one, and whatever the CLI composes — runs exactly the code it ran before.
 */

import type { Job } from "@argelanderspace/contracts";
import {
  JobKindSchema,
  MAIL_ACCOUNT_ID_PATTERN,
  MAIL_PRESETS,
  MailPresetIdSchema,
} from "@argelanderspace/contracts";
import {
  ArxivPdfOnlyError,
  CREDENTIAL_STORE_METHODS,
  type CredentialStore,
  EXTERNAL_PROGRAMS,
  EXTERNAL_SERVICES,
  type ExternalObserver,
  f,
  findOnPath,
  HttpError,
  type LogField,
  type MailMailbox,
  type MailManage,
  type MailOutgoing,
  type MailProtocol,
  NotATarError,
  TarCorruptError,
  TexWorkspaceError,
  ZipError,
} from "@argelanderspace/infra";
import { JOB_ERROR_CODES, type JobTransition } from "./jobs.js";
import { allOf, type ServerLog, silentLog } from "./log.js";
import { MAIL_FAILURES } from "./mail-failures.js";

// --------------------------------------------------------------------------- //
// Jobs
// --------------------------------------------------------------------------- //

const JOB_KINDS = JobKindSchema.options;

// The only shape the runner gives a job id (jobs.ts `submit`): a kind from the list, then a random uuid.
const JOB_ID = new RegExp(
  `^(?:${JOB_KINDS.join("|")})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`
);
/** What an id of any other shape is written as. */
export const JOB_ID_UNRECOGNIZED = "job-unrecognized";

/**
 * A job id is `<kind>-<random uuid>`. The runner reads the job files of the last run back without checking them
 * (`recover`), so a file that was edited by hand, or put there by something else, can carry any text as its id: an
 * id of another shape is not written.
 */
export function jobIdField(id: unknown): LogField {
  return f.id(typeof id === "string" && JOB_ID.test(id) ? id : JOB_ID_UNRECOGNIZED);
}

/**
 * Where a job was when it ended. A job says what it is doing in progress messages; the stage is the one the last
 * message that names a step belongs to. The message itself is never recorded (a `warning: …` line quotes the TeX
 * log): only whether it starts with one of the words below.
 */
export const JOB_STAGES = [
  "queued",
  "start",
  "download",
  "extract",
  "validate",
  "compile",
  "fuse",
  "figures",
  "attach",
  "publish",
  "other",
] as const;
export type JobStage = (typeof JOB_STAGES)[number];

const STAGE_OF_MESSAGE: ReadonlyArray<readonly [string, JobStage]> = [
  ["Fetching", "download"],
  ["Unpacking", "extract"],
  ["Validating", "validate"],
  ["Compiling", "compile"],
  ["Fusing", "fuse"],
  ["Materializing", "figures"],
  ["Rebuilding library", "attach"],
  ["Publishing", "publish"],
];

export function jobStage(job: Pick<Job, "progress" | "startedAt">): JobStage {
  if (job.startedAt === null) return "queued";
  let named = false;
  for (let i = job.progress.length - 1; i >= 0; i--) {
    const message = job.progress[i]?.message ?? "";
    if (message.startsWith("warning:")) continue;
    named = true;
    for (const [start, stage] of STAGE_OF_MESSAGE) if (message.startsWith(start)) return stage;
  }
  return named ? "other" : "start";
}

/** What kind of failure ended a job, told from the class of what was thrown — never from its message. */
export const JOB_FAILURE_CATEGORIES = [
  "source_has_no_latex",
  "archive",
  "tex_workspace",
  "http_status",
  "timeout",
  "aborted",
  "file_system",
  "unclassified",
] as const;
export type JobFailureCategory = (typeof JOB_FAILURE_CATEGORIES)[number];

export function jobFailureCategory(error: unknown): JobFailureCategory {
  if (error instanceof ArxivPdfOnlyError) return "source_has_no_latex";
  if (
    error instanceof ZipError ||
    error instanceof NotATarError ||
    error instanceof TarCorruptError
  )
    return "archive";
  if (error instanceof TexWorkspaceError) return "tex_workspace";
  if (error instanceof HttpError) return "http_status";
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "timeout";
    if (error.name === "AbortError") return "aborted";
    if (typeof (error as { syscall?: unknown }).syscall === "string") return "file_system";
  }
  return "unclassified";
}

function elapsed(from: string | null, to: string | null): LogField | undefined {
  if (from === null || to === null) return undefined;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? f.ms(ms) : undefined;
}

/**
 * Records every change of a job's state. A job id is `<kind>-<random uuid>` (jobs.ts); a failed job is recorded by
 * its id, kind, stage and category, and by what it threw: the error's name, code and the code locations of its stack
 * (and the same of its causes). Its message, which may quote TeX source, stays in the job record only; the path a
 * system error names is left out too — a job works on the user's own files, in folders that may be named after a
 * paper.
 */
export function jobLogger(log: ServerLog): ((transition: JobTransition) => void) | undefined {
  if (log === silentLog) return undefined;
  return ({ type, job, error }) => {
    try {
      const base = { job: jobIdField(job.id), kind: f.oneOf(JOB_KINDS, job.kind) };
      switch (type) {
        case "created": {
          // The Work and the Doc a job is about, when it says so: written by the Work / Doc id rules (one made
          // from a title or a folder name is a hash).
          const payload = (job.payload ?? {}) as { workId?: unknown; docId?: unknown };
          log.info("job.created", {
            ...base,
            ...(typeof payload.workId === "string" ? { work: f.workId(payload.workId) } : {}),
            ...(typeof payload.docId === "string" ? { doc: f.docId(payload.docId) } : {}),
          });
          break;
        }
        case "started":
          log.info("job.started", { ...base, queued_ms: elapsed(job.createdAt, job.startedAt) });
          break;
        case "progress":
          log.debug("job.progress", {
            ...base,
            step: f.num(job.progress.length),
            stage: f.oneOf(JOB_STAGES, jobStage(job)),
          });
          break;
        case "done":
          log.info("job.done", { ...base, duration_ms: elapsed(job.startedAt, job.finishedAt) });
          break;
        case "failed":
          log.warn("job.failed", {
            ...base,
            stage: f.oneOf(JOB_STAGES, jobStage(job)),
            category: f.oneOf(JOB_FAILURE_CATEGORIES, jobFailureCategory(error)),
            ...(typeof job.errorCode === "string"
              ? { error_code: f.oneOf(JOB_ERROR_CODES, job.errorCode) }
              : {}),
            duration_ms: elapsed(job.startedAt, job.finishedAt),
            error: f.error(error, { omitSystemPath: true }),
          });
          break;
        case "interrupted":
          log.warn("job.interrupted", { ...base, stage: f.oneOf(JOB_STAGES, jobStage(job)) });
          break;
      }
    } catch {
      /* a record that cannot be made is lost; the job carries on */
    }
  };
}

// --------------------------------------------------------------------------- //
// External programs and web services
// --------------------------------------------------------------------------- //

const YES_NO = ["yes", "no"] as const;
const yesNo = (value: boolean): LogField => f.oneOf(YES_NO, value ? "yes" : "no");
/** The signals a child process of ours is ended by; any other is written as the placeholder. */
const SIGNALS = [
  "SIGKILL",
  "SIGTERM",
  "SIGINT",
  "SIGHUP",
  "SIGSEGV",
  "SIGABRT",
  "SIGPIPE",
] as const;
const NO_ANSWER = ["timeout", "aborted", "network"] as const;

/**
 * The observer infra's adapters report to (infra `lib/observe.ts`), writing this server's log. A program is recorded
 * by its name, exit code and duration — never its arguments or output; a request by the service's name, the scheme,
 * host and port of its URL, the status of the answer and the duration — never its path, query, headers or body, nor
 * the answer's.
 *
 * Levels: a figure converter that exits 0 and a request answered below 400 (or with 404, the ordinary answer to
 * "do you know this paper?") are `debug` — one ingest converts every figure and one refresh asks about every
 * reference; latexmk and the sandbox probe are `info`; whatever failed is `warn`.
 *
 * The sandbox probe (`program: bwrap` — the only run reported under that name; a sandboxed compile is `latexmk`) is
 * repeated, at most once a minute, for as long as it fails, and on a machine without bubblewrap (macOS and Windows
 * have none) it fails every time. So: a bwrap that is not there is `info`, not a warning — it is what is expected
 * there, and Writer compiles are simply not offered to the Copilot; any other failed probe is `warn`; and a probe
 * that ends the way the one before it ended is `debug`, so the default log has one line per change, not one a
 * minute.
 *
 * One observer per log: asking again for the same log gives the same object, so a probe two callers wait for is
 * reported once.
 */
export function externalObserver(log: ServerLog): ExternalObserver | undefined {
  if (log === silentLog) return undefined;
  const made = observers.get(log);
  if (made) return made;
  let lastProbe: string | undefined;
  const observer: ExternalObserver = {
    program(call) {
      const fields = {
        program: f.oneOf(EXTERNAL_PROGRAMS, call.program),
        sandboxed: yesNo(call.sandboxed),
        duration_ms: f.ms(call.durationMs),
      };
      const probe = call.program === "bwrap";
      if (call.error !== undefined) {
        // Only the system's code for why it could not start (ENOENT, EACCES): the error names the program's path.
        const code = (call.error as { code?: unknown } | null)?.code;
        const record = {
          ...fields,
          ...(typeof code === "string" ? { code: f.oneOf(SPAWN_CODES, code) } : {}),
        };
        const outcome = `not_started:${typeof code === "string" ? code : ""}`;
        const repeated = probe && outcome === lastProbe;
        if (probe) lastProbe = outcome;
        if (repeated) log.debug("external_program.not_started", record);
        else if (probe && code === "ENOENT") log.info("external_program.not_started", record);
        else log.warn("external_program.not_started", record);
        return;
      }
      const record = {
        ...fields,
        ...(call.exitCode === null ? {} : { exit_code: f.num(call.exitCode) }),
        ...(call.signal === null ? {} : { signal: f.oneOf(SIGNALS, call.signal) }),
        timed_out: yesNo(call.timedOut),
      };
      const failed = call.exitCode !== 0 || call.timedOut;
      const outcome = `exited:${call.exitCode}:${call.signal}:${call.timedOut}`;
      const repeated = probe && failed && outcome === lastProbe;
      if (probe) lastProbe = outcome;
      if (repeated) log.debug("external_program.exited", record);
      else if (failed) log.warn("external_program.exited", record);
      else if (call.program === "pdftocairo" || call.program === "gs")
        log.debug("external_program.exited", record);
      else log.info("external_program.exited", record);
    },
    service(call) {
      const fields = {
        service: f.oneOf(EXTERNAL_SERVICES, call.service),
        host: f.url(call.url),
        duration_ms: f.ms(call.durationMs),
      };
      if (call.status === null) {
        const name = call.error instanceof Error ? call.error.name : "";
        log.warn("external_service.no_answer", {
          ...fields,
          reason: f.oneOf(
            NO_ANSWER,
            name === "TimeoutError" ? "timeout" : name === "AbortError" ? "aborted" : "network"
          ),
        });
        return;
      }
      const record = { ...fields, status: f.num(call.status) };
      if (call.status >= 400 && call.status !== 404) log.warn("external_service.answered", record);
      else log.debug("external_service.answered", record);
    },
  };
  observers.set(log, observer);
  return observer;
}

const observers = new WeakMap<ServerLog, ExternalObserver>();

const SPAWN_CODES = ["ENOENT", "EACCES", "EPERM", "ENOEXEC", "EMFILE", "ENOMEM", "EAGAIN"] as const;

// --------------------------------------------------------------------------- //
// Mail servers
// --------------------------------------------------------------------------- //

/**
 * Every call of infra's four mail protocol interfaces (MailProtocol, MailMailbox, MailManage, MailOutgoing); a
 * method added to one of them and left out here is a type error.
 */
type MailCall = keyof MailProtocol | keyof MailMailbox | keyof MailManage | keyof MailOutgoing;
export const MAIL_CALLS = allOf<MailCall>()([
  "verifyImapLogin",
  "verifySmtpLogin",
  "listFolders",
  "listHeaders",
  "openMessage",
  "setFlag",
  "move",
  "remove",
  "search",
  "saveDraft",
  "findDraft",
  "deleteDraft",
  "appendSent",
  "sendSmtp",
]);
const SMTP_CALLS: readonly MailCall[] = ["verifySmtpLogin", "sendSmtp"];
const MAIL_PROTOCOLS = ["imap", "smtp"] as const;
const MAIL_OUTCOMES = ["ok", "failed", "threw"] as const;
/** The failure codes of the one table every Mail route answers from (mail-failures.ts). */
export const MAIL_FAILURE_CODES = Object.keys(MAIL_FAILURES);

/**
 * The providers a mail server can be recorded as: the ids of the account dialog's presets (contracts `MAIL_PRESETS`),
 * of which `custom` is the one for every server that is not a preset's.
 */
export const MAIL_PROVIDERS = MailPresetIdSchema.options;
export type MailProvider = (typeof MAIL_PROVIDERS)[number];

/**
 * Whose server a call went to. A mail server's host is not written: a university's, an institute's or a person's own
 * domain says who the user is. It is named only when it is the IMAP (for an IMAP call) or SMTP (for an SMTP call)
 * host of one of the presets written in contracts `MAIL_PRESETS` — the whole host name, letters in either case, and
 * nothing looser (no suffix or substring: `imap.gmail.com.example.org` is `custom`). Everything else, and a target
 * that cannot be read, is `custom`.
 */
export function mailProvider(protocol: "imap" | "smtp", target: unknown): MailProvider {
  const host = (target as { host?: unknown } | null | undefined)?.host;
  if (typeof host !== "string") return "custom";
  const asked = host.toLowerCase();
  for (const id of MAIL_PROVIDERS) {
    const known = MAIL_PRESETS[id][protocol]?.host;
    if (known !== undefined && known.toLowerCase() === asked) return id;
  }
  return "custom";
}

/**
 * A mail protocol object whose calls are recorded: which call, to which provider's server (a preset's name or
 * `custom` — never the host or the user name), whether it worked, and if not the failure CODE the protocol layer
 * reduced the error to. The server's
 * reply text never reaches this function: infra drops it before it answers. The call's arguments (folder names,
 * message ids, the message itself) and its result are passed through untouched and not looked at beyond `ok` and
 * `code`; a throw is passed on as it is.
 */
export function observedMail<T extends object>(impl: T, log: ServerLog): T {
  if (log === silentLog) return impl;
  return new Proxy(impl, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (
        typeof value !== "function" ||
        typeof property !== "string" ||
        !(MAIL_CALLS as readonly string[]).includes(property)
      )
        return value;
      const protocol = (SMTP_CALLS as readonly string[]).includes(property) ? "smtp" : "imap";
      return async (...args: unknown[]): Promise<unknown> => {
        const started = performance.now();
        const fields = (): Record<string, LogField> => ({
          protocol: f.oneOf(MAIL_PROTOCOLS, protocol),
          call: f.oneOf(MAIL_CALLS, property),
          provider: f.oneOf(MAIL_PROVIDERS, mailProvider(protocol, args[0])),
          duration_ms: f.ms(performance.now() - started),
        });
        let result: unknown;
        try {
          result = await (value as (...a: unknown[]) => unknown).apply(target, args);
        } catch (error) {
          try {
            log.warn("mail.remote_call", { ...fields(), outcome: f.oneOf(MAIL_OUTCOMES, "threw") });
          } catch {
            /* as below */
          }
          throw error;
        }
        try {
          const r = (result ?? {}) as { ok?: unknown; code?: unknown };
          if (r.ok === true)
            log.debug("mail.remote_call", { ...fields(), outcome: f.oneOf(MAIL_OUTCOMES, "ok") });
          else
            log.warn("mail.remote_call", {
              ...fields(),
              outcome: f.oneOf(MAIL_OUTCOMES, "failed"),
              ...(typeof r.code === "string" ? { code: f.oneOf(MAIL_FAILURE_CODES, r.code) } : {}),
            });
        } catch {
          /* recording a call never changes its result */
        }
        return result;
      };
    },
  });
}

/** A mail account id is `acc-<12 hex digits>`, made here from random bytes; anything else is not written. */
export function mailAccountField(id: string): LogField {
  return f.id(MAIL_ACCOUNT_ID_PATTERN.test(id) ? id : "acc-unrecognized");
}

const KEYCHAIN_STATES = ["available", "unavailable"] as const;

type KeychainState = (typeof KEYCHAIN_STATES)[number];
type StoreMethod = (typeof CREDENTIAL_STORE_METHODS)[number];

/**
 * What each method's result says about the keychain. Keyed by every method of the store (infra
 * `CREDENTIAL_STORE_METHODS`), so a method added to the store must be named here or the build fails: the wrapper
 * below is made from this table and loses no method (desktop-app ticket 07 warned that rebuilding get/set/delete by
 * hand would silently drop a new one; ticket 12 added `status`).
 */
const KEYCHAIN_STATE_OF: {
  [K in StoreMethod]: (
    result: Awaited<ReturnType<CredentialStore[K]>>
  ) => KeychainState | undefined;
} = {
  get: (result) =>
    result.status === "keychain-unavailable"
      ? "unavailable"
      : result.status === "not-found" ||
          (result.status === "ok" && result.protection === "keychain")
        ? "available"
        : undefined,
  set: (result) =>
    result.status === "keychain-unavailable" ||
    (result.status === "stored" && result.protection === "file")
      ? "unavailable"
      : result.status === "stored"
        ? "available"
        : undefined,
  // A removal does not tell whether the keychain answered in every case; nothing is recorded for it.
  delete: () => undefined,
  status: (result) => (result.status === "error" ? undefined : result.keychain),
};

/**
 * A credential store that records whether the OS keychain answered, each time that changes: read from what the
 * store already does for its callers (it tries the keychain first), so nothing asks the keychain on the log's
 * behalf. The id and the secret are not looked at. Every method the store has is passed through (wrapped); the
 * wrapper has exactly the store's methods.
 */
export function observedCredentials<T extends Partial<CredentialStore>>(
  store: T,
  log: ServerLog
): T {
  if (log === silentLog) return store;
  let last: KeychainState | undefined;
  const note = (state: KeychainState | undefined): void => {
    if (state === undefined || state === last) return;
    last = state;
    if (state === "available")
      log.info("credentials.keychain_state", { state: f.oneOf(KEYCHAIN_STATES, state) });
    else log.warn("credentials.keychain_state", { state: f.oneOf(KEYCHAIN_STATES, state) });
  };
  const watched: Record<string, unknown> = {};
  for (const name of CREDENTIAL_STORE_METHODS) {
    const method = store[name] as ((...args: unknown[]) => Promise<unknown>) | undefined;
    if (typeof method !== "function") continue;
    const stateOf = KEYCHAIN_STATE_OF[name] as (result: unknown) => KeychainState | undefined;
    watched[name] = async (...args: unknown[]) => {
      const result = await method.apply(store, args);
      try {
        note(stateOf(result));
      } catch {
        /* recording a call never changes its result */
      }
      return result;
    };
  }
  return watched as T;
}

// --------------------------------------------------------------------------- //
// What the server found when it started
// --------------------------------------------------------------------------- //

/** The programs the workbench runs or needs on PATH (the full check with versions is a later ticket). */
export const PROBED_TOOLS = [
  "latexmk",
  "pdflatex",
  "xelatex",
  "bibtex",
  "biber",
  "kpsewhich",
  "pdftocairo",
  "gs",
  "bwrap",
] as const;

/** Which of the tools are on PATH — found or not, nothing more (not where: a path names the user's directories). */
export function logEnvironment(
  log: ServerLog,
  pathEnv: string | undefined = process.env.PATH
): void {
  if (log === silentLog) return;
  try {
    const found = PROBED_TOOLS.filter((tool) => findOnPath(tool, pathEnv) !== null);
    const missing = PROBED_TOOLS.filter((tool) => !found.includes(tool));
    log.info("server.environment", {
      tools_found: f.someOf(PROBED_TOOLS, found),
      tools_missing: f.someOf(PROBED_TOOLS, missing),
    });
  } catch {
    /* the start is recorded without it */
  }
}
