/**
 * The server's log catalog (log.ts `SERVER_LOG_EVENTS`) through the logger it makes: each event lists its fields and
 * the constructor each is made by, so a field an event does not have is a type error however the call put its fields
 * together — written in the call, built beforehand, spread in, or in one branch of a conditional spread — and so is a
 * field of another kind. The negative cases are pinned by the typecheck (`@ts-expect-error`); the shapes copy the real
 * call sites named beside them. The shell's events come from the host's table (shell-events.ts), not a second list.
 */

import { createLogger, f, installProcessLogging } from "@argelanderspace/infra";
import { describe, expect, test } from "vitest";
import { createMemorySink } from "../../infra/tests/log-memory-sink.js";
import { SERVER_LOG_EVENTS, type ServerLogFields } from "../src/log.js";
import { SHELL_EVENTS } from "../src/shell-events.js";

function setup() {
  const sink = createMemorySink();
  return { sink, log: createLogger({ events: SERVER_LOG_EVENTS, sink, level: "debug" }) };
}

describe("the catalog", () => {
  test("names the server's events and the shell's, the shell's with the fields of the host's table", () => {
    const names = Object.keys(SERVER_LOG_EVENTS);
    expect(names).toHaveLength(60);
    const shell = names.filter((name) => name.startsWith("shell."));
    expect(shell.sort()).toEqual(Object.keys(SHELL_EVENTS).sort());
    const writers = { id: f.id, num: f.num, ms: f.ms } as const;
    for (const [event, spec] of Object.entries(SHELL_EVENTS)) {
      const fields = (SERVER_LOG_EVENTS as Record<string, Record<string, unknown>>)[event];
      const kinds = spec.fields as Record<string, string | readonly string[]>;
      expect(Object.keys(fields ?? {}), event).toEqual(Object.keys(kinds));
      for (const [name, kind] of Object.entries(kinds))
        expect(fields?.[name], `${event}.${name}`).toBe(
          typeof kind === "string" ? writers[kind as keyof typeof writers] : f.oneOf
        );
    }
  });
});

describe("what the types refuse", () => {
  test("a field the event does not list, wherever it comes from, and a field of another kind", () => {
    const { sink, log } = setup();
    const failed = sink.lines.length === 0;

    // As the call sites write them: accepted.
    const base = { job: f.id("upload-x"), kind: f.oneOf(["upload"], "upload") };
    log.info("job.created", { ...base, ...(failed ? { doc: f.docId("pdf-1") } : {}) });
    const finished = {
      conversation: f.id("c1"),
      run: f.id("r1"),
      status: f.oneOf(["failed"], "failed"),
      ...(failed ? { code: f.oneOf(["provider"], "provider") } : {}),
      duration_ms: f.ms(1),
    };
    log.warn("copilot.run_finished", finished);
    const who: ServerLogFields<"tex.compile_failed"> = { source: f.oneOf(["ingest"], "ingest") };
    log.warn("tex.compile_failed", { ...who, log_file: f.id("jobs/upload-x.compile.log") });
    log.warn("tex.compile_failed", { ...who, log_file: f.oneOf(["fixed"], "fixed") });
    log.info("shell.host_exited", { exit_code: f.num(1), expected: f.oneOf(["no"], "no") });
    log.info("desktop.switch_cancelled", {});

    // @ts-expect-error a misspelt name written in the call (desktop-host `desktop.leaving`)
    log.info("desktop.leaving", { sourse: f.oneOf(["picked"], "picked") });
    const state = {
      account: f.id("acc-0"),
      state: f.oneOf(["idle"], "idle"),
      previus: f.oneOf(["idle"], "idle"),
    };
    // @ts-expect-error a misspelt name in fields built beforehand (mail-watch `mail_watch.state_changed`)
    log.info("mail_watch.state_changed", state);
    const misspeltBase = { job: f.id("upload-x"), knid: f.oneOf(["upload"], "upload") };
    // @ts-expect-error a misspelt name spread in from an object built beforehand (log-observers `...base`)
    log.info("job.started", { ...misspeltBase, queued_ms: f.ms(1) });
    const finishedTypo = {
      conversation: f.id("c1"),
      run: f.id("r1"),
      status: f.oneOf(["failed"], "failed"),
      ...(failed ? { cdoe: f.oneOf(["provider"], "provider") } : {}),
    };
    // @ts-expect-error a misspelt name in one branch of a conditional spread (copilot `copilot.run_finished`)
    log.warn("copilot.run_finished", finishedTypo);
    // @ts-expect-error a field of another event (`error` is `job.failed`'s, not `job.done`'s)
    log.info("job.done", { ...base, error: f.error(new Error("x")) });
    // @ts-expect-error a shell event's field the host's table does not list
    log.info("shell.host_exited", { exitcode: f.num(1) });
    // @ts-expect-error an event outside the catalog
    log.info("job.vanished", { ...base });
    // @ts-expect-error a path field made by another constructor (`server.started` `project_root`)
    log.info("server.started", { project_root: f.id("/srv/project") });
    // @ts-expect-error a duration made as a plain number
    log.info("job.done", { ...base, duration_ms: f.num(1) });
    // @ts-expect-error a field made by neither of its constructors (`tex.compile_failed` `log_file`)
    log.warn("tex.compile_failed", { ...who, log_file: f.path("/srv/x.log") });

    // The run-time checks are the ones they were: all of the above got a record.
    expect(sink.records()).toHaveLength(16);
  });

  test("the process watch takes only events with an error field", () => {
    const { log } = setup();
    installProcessLogging(log, {
      uncaughtException: "process.uncaught_exception",
      unhandledRejection: "process.unhandled_rejection",
    })();
    installProcessLogging(log, {
      // @ts-expect-error `request.completed` has no `error` field
      uncaughtException: "request.completed",
      unhandledRejection: "process.unhandled_rejection",
    })();
  });
});
