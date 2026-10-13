/**
 * What the server writes to the user-level log about jobs, the external programs and web services infra calls, the
 * mail servers, and the tools it found when it started (desktop-app ticket 07). The Copilot's and the mail watcher's
 * own records are written where they happen (copilot.ts, mail-watch.ts); the names of all of them are in the
 * catalog (log.ts).
 *
 * Nothing here takes text from what it watches. A job's error message, a program's arguments and output, a request's
 * path, query and body, an answer's body, a mail server's reply: none of them is looked at for the record. What is
 * recorded is an identifier the workbench made from random bytes, a name from a list written in this file (or in the
 * module that owns it), a number, a duration, and the scheme, host and port of a URL.
 *
 * Every function returns the thing it was given when the log is the silent one, so a server without a log — every
 * test server that does not ask for one, and whatever the CLI composes — runs exactly the code it ran before.
 */

import type { Job } from "@argelanderspace/contracts";
import { JobKindSchema, MAIL_ACCOUNT_ID_PATTERN } from "@argelanderspace/contracts";
import {
  ArxivPdfOnlyError,
  type CredentialStore,
  EXTERNAL_PROGRAMS,
  EXTERNAL_SERVICES,
  type ExternalObserver,
  f,
  findOnPath,
  HttpError,
  type LogField,
  NotATarError,
  TarCorruptError,
  TexWorkspaceError,
  ZipError,
} from "@argelanderspace/infra";
import { type ServerLog, silentLog } from "./log.js";
import { MAIL_FAILURES } from "./mail-failures.js";

// --------------------------------------------------------------------------- //
// Jobs
// --------------------------------------------------------------------------- //

/** What the job runner tells whoever watches it (jobs.ts). `error` is what the handler threw, on `failed` only. */
export interface JobTransition {
  type: "created" | "started" | "progress" | "done" | "failed" | "interrupted";
  job: Job;
  error?: unknown;
}

const JOB_KINDS = JobKindSchema.options;

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

/** The machine-readable classes a job puts in its own record (`errorCode`); written in the code that sets them. */
const JOB_ERROR_CODES = ["arxiv_pdf_only"] as const;

function elapsed(from: string | null, to: string | null): LogField | undefined {
  if (from === null || to === null) return undefined;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? f.ms(ms) : undefined;
}

/**
 * Records every change of a job's state. A job id is `<kind>-<random uuid>` (jobs.ts); a failed job is recorded by
 * its id, kind, stage and category — its error message, which may quote TeX source, stays in the job record only.
 */
export function jobLogger(log: ServerLog): ((transition: JobTransition) => void) | undefined {
  if (log === silentLog) return undefined;
  return ({ type, job, error }) => {
    try {
      const base = { job: f.id(job.id), kind: f.oneOf(JOB_KINDS, job.kind) };
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
 */
export function externalObserver(log: ServerLog): ExternalObserver | undefined {
  if (log === silentLog) return undefined;
  return {
    program(call) {
      const fields = {
        program: f.oneOf(EXTERNAL_PROGRAMS, call.program),
        sandboxed: yesNo(call.sandboxed),
        duration_ms: f.ms(call.durationMs),
      };
      if (call.error !== undefined) {
        // Only the system's code for why it could not start (ENOENT, EACCES): the error names the program's path.
        const code = (call.error as { code?: unknown } | null)?.code;
        log.warn("external_program.not_started", {
          ...fields,
          ...(typeof code === "string" ? { code: f.oneOf(SPAWN_CODES, code) } : {}),
        });
        return;
      }
      const record = {
        ...fields,
        ...(call.exitCode === null ? {} : { exit_code: f.num(call.exitCode) }),
        ...(call.signal === null ? {} : { signal: f.oneOf(SIGNALS, call.signal) }),
        timed_out: yesNo(call.timedOut),
      };
      const failed = call.exitCode !== 0 || call.timedOut;
      if (failed) log.warn("external_program.exited", record);
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
}

const SPAWN_CODES = ["ENOENT", "EACCES", "EPERM", "ENOEXEC", "EMFILE", "ENOMEM", "EAGAIN"] as const;

// --------------------------------------------------------------------------- //
// Mail servers
// --------------------------------------------------------------------------- //

/** Every call of infra's four mail protocol interfaces (MailProtocol, MailMailbox, MailManage, MailOutgoing). */
const MAIL_CALLS = [
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
] as const;
const SMTP_CALLS: readonly string[] = ["verifySmtpLogin", "sendSmtp"];
const MAIL_PROTOCOLS = ["imap", "smtp"] as const;
const MAIL_OUTCOMES = ["ok", "failed", "threw"] as const;
/** The failure codes of the one table every Mail route answers from (mail-failures.ts). */
export const MAIL_FAILURE_CODES = Object.keys(MAIL_FAILURES);

function mailServerUrl(protocol: "imap" | "smtp", target: unknown): string {
  const t = (target ?? {}) as { host?: unknown; port?: unknown; security?: unknown };
  const host = typeof t.host === "string" ? t.host : "";
  const port = typeof t.port === "number" ? `:${t.port}` : "";
  return `${protocol}${t.security === "tls" ? "s" : ""}://${host.includes(":") ? `[${host}]` : host}${port}`;
}

/**
 * A mail protocol object whose calls are recorded: which call, to which server (scheme, host and port — never the
 * user name), whether it worked, and if not the failure CODE the protocol layer reduced the error to. The server's
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
      const protocol = SMTP_CALLS.includes(property) ? "smtp" : "imap";
      return async (...args: unknown[]): Promise<unknown> => {
        const started = performance.now();
        const fields = (): Record<string, LogField> => ({
          protocol: f.oneOf(MAIL_PROTOCOLS, protocol),
          call: f.oneOf(MAIL_CALLS, property),
          host: f.url(mailServerUrl(protocol, args[0])),
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

/**
 * A credential store that records whether the OS keychain answered, each time that changes: read from what the
 * store already does for its callers (it tries the keychain first), so nothing asks the keychain on the log's
 * behalf. The account and the password are not looked at.
 */
export function observedCredentials<
  T extends Pick<CredentialStore, "get"> & Partial<Pick<CredentialStore, "set" | "delete">>,
>(store: T, log: ServerLog): T {
  if (log === silentLog) return store;
  const { set, delete: remove } = store;
  let last: (typeof KEYCHAIN_STATES)[number] | undefined;
  const note = (state: (typeof KEYCHAIN_STATES)[number] | undefined): void => {
    if (state === undefined || state === last) return;
    last = state;
    if (state === "available")
      log.info("credentials.keychain_state", { state: f.oneOf(KEYCHAIN_STATES, state) });
    else log.warn("credentials.keychain_state", { state: f.oneOf(KEYCHAIN_STATES, state) });
  };
  const watched: Pick<CredentialStore, "get"> & Partial<Pick<CredentialStore, "set" | "delete">> = {
    async get(accountId) {
      const result = await store.get(accountId);
      note(
        result.status === "keychain-unavailable"
          ? "unavailable"
          : result.status === "not-found" ||
              (result.status === "ok" && result.protection === "keychain")
            ? "available"
            : undefined
      );
      return result;
    },
  };
  if (set)
    watched.set = async (accountId, password, opts) => {
      const result = await set.call(store, accountId, password, opts);
      note(
        result.status === "keychain-unavailable" ||
          (result.status === "stored" && result.protection === "file")
          ? "unavailable"
          : result.status === "stored"
            ? "available"
            : undefined
      );
      return result;
    };
  if (remove) watched.delete = (accountId) => remove.call(store, accountId);
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
