/**
 * The Copilot tool registry (architecture-deepening ticket 06): one table says which tools a run has, in which order,
 * what each one is given and which paragraphs the base instruction carries; the session's `tools` / `customTools`, the
 * footprint's measured tool set, the log's closed tool-name enum and the prompt switches are all derived from it.
 * Tested on the registry's own interface: no app, no host, no Pi session, no model.
 */
import { FILE_TOOL_NAMES } from "@argelanderspace/contracts";
import { describe, expect, test, vi } from "vitest";

// A factory that needs its dependencies at creation (none does today): the footprint keeps what it built and says so.
const failing = vi.hoisted(() => ({ mail: false }));
vi.mock("../src/copilot-mail-tool.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/copilot-mail-tool.js")>();
  return {
    ...real,
    createMailTool: (context: Parameters<typeof real.createMailTool>[0]) => {
      if (failing.mail) throw new Error("needs its dependencies");
      return real.createMailTool(context);
    },
  };
});

const { fileToolNames } = await import("../src/copilot-file-tools.js");
const {
  assembleRunTools,
  contextOf,
  COPILOT_TOOL_NAMES,
  fileFootprintTools,
  footprintTools,
  promptSwitches,
  TOOL_TABLE,
} = await import("../src/copilot-tool-registry.js");
type Registry = typeof import("../src/copilot-tool-registry.js");
type Gates = Parameters<Registry["promptSwitches"]>[0];
type Deps = Parameters<Registry["assembleRunTools"]>[0]["deps"];

const CAPS = ["library", "reader", "writer", "text", "mail", "argument", "shelf"] as const;
type Cap = (typeof CAPS)[number];
type Permission = "off" | "ask" | "auto";
const SHARED = ["admitting", "track", "runId", "journal", "confirm"] as const;
const BUSINESS = [
  "plan",
  "workspace",
  "library",
  "reader",
  "writer",
  "text",
  "mail",
  "argument",
  "shelf",
] as const;

const subsets = (): Cap[][] =>
  Array.from({ length: 1 << CAPS.length }, (_, mask) => CAPS.filter((_, i) => mask & (1 << i)));

function workbench(
  caps: readonly Cap[],
  files?: { permission: Permission; platform?: NodeJS.Platform }
) {
  const wb: Record<string, unknown> = { plans: { onChanged: () => {} } };
  for (const cap of caps) wb[cap] = {};
  const permission = vi.fn(() => files?.permission ?? "off");
  const protectedFolders = vi.fn(() => []);
  if (files)
    wb.fileTools = {
      cwd: "/work/project",
      permission,
      protectedFolders,
      ...(files.platform ? { platform: files.platform } : {}),
    };
  return { wb: wb as unknown as NonNullable<Gates["workbench"]>, permission, protectedFolders };
}
function sharedHost() {
  return {
    admitting: vi.fn(() => true),
    track: <T>(work: Promise<T>) => work,
    runId: "run-1",
    journal: { lookup: vi.fn(), begin: vi.fn(), done: vi.fn() } as never,
    confirm: { request: vi.fn() } as never,
  };
}
function fakeDeps(): Deps {
  return {
    conversationId: "conversation-1",
    viewAction: vi.fn(async () => ({ status: "displayed" as const })),
    shellSync: vi.fn(),
    page: vi.fn(() => undefined),
    providerStatus: vi.fn(async () => ({})),
    selectModel: vi.fn(async (choice) => choice),
    modelAcceptsImages: vi.fn(() => true),
    budget: vi.fn(() => 1000),
    reclaim: vi.fn(() => 2000),
    imageBytesUsed: vi.fn(() => 0),
    taskUndo: {} as never,
    taskDeleted: vi.fn(() => "undo-1"),
    sourceCoverage: vi.fn(async () => null),
    wrote: vi.fn(),
    fileAllow: vi.fn(() => false),
    fileLifecycle: { started: vi.fn(), ended: vi.fn() },
  };
}
function fakeLoader() {
  const calls: Array<{ switches: unknown; files: () => unknown }> = [];
  const made = {
    getInstruction: vi.fn(() => null),
    instructionNames: vi.fn(() => ["pdf-transcription"]),
  };
  const loader = (switches: unknown, files: () => unknown) => {
    calls.push({ switches, files });
    return made as never;
  };
  return { loader, calls, made };
}
/** What a run is given, written out independently of the table (today's start()). */
function expectedNames(
  caps: readonly Cap[] | null,
  mail: Gates["mailMount"],
  files?: { permission: Permission; platform?: NodeJS.Platform }
): string[] {
  if (!caps) return [];
  const has = (cap: Cap) => caps.includes(cap);
  return [
    "plan",
    "workspace",
    ...(has("library") ? ["library"] : []),
    ...(has("reader") ? ["reader"] : []),
    ...(has("writer") ? ["writer"] : []),
    ...(has("text") ? ["text"] : []),
    ...(mail === "on" && has("mail") ? ["mail"] : []),
    ...(has("argument") ? ["argument"] : []),
    ...(has("shelf") ? ["shelf"] : []),
    ...(files ? fileToolNames(files.permission, files.platform ?? process.platform) : []),
  ];
}
const nameOf = (tool: { name: string }) => tool.name;

describe("the closed tool-name enum of copilot.tool_called", () => {
  test("is every name a run can register: the contracts' file tool names (powershell included) and the business tools", () => {
    expect([...COPILOT_TOOL_NAMES]).toEqual([...FILE_TOOL_NAMES, ...BUSINESS]);
    const fromTable = TOOL_TABLE.flatMap((entry) => [...entry.names]);
    expect(new Set(COPILOT_TOOL_NAMES)).toEqual(new Set(fromTable));
    expect(COPILOT_TOOL_NAMES).toContain("powershell");
  });
});

describe("the matrix: capability × mail state × file permission × platform", () => {
  test("tools and customTools agree in table order; the footprint measures the same set; the prompt switches follow the tools", () => {
    let combos = 0;
    for (const caps of [null, ...subsets()])
      for (const mail of ["on", "off", "unavailable"] as const)
        for (const permission of [undefined, "off", "ask", "auto"] as const)
          for (const platform of [undefined, "linux", "win32"] as const) {
            // Mail is "on" or "unavailable" only while the workbench has Mail (mailMountState): other states never occur.
            if (mail !== "off" && !caps?.includes("mail")) continue;
            if (!caps && (permission || platform)) continue;
            if (!permission && platform) continue;
            combos++;
            const files = permission
              ? { permission, ...(platform ? { platform } : {}) }
              : undefined;
            const built = caps ? workbench(caps, files) : undefined;
            const gates: Gates = { workbench: built?.wb, mailMount: mail };
            const { loader, calls } = fakeLoader();
            const run = assembleRunTools({
              gates,
              host: sharedHost(),
              deps: fakeDeps(),
              loader,
              hasSkills: () => true,
            });
            const label = `${caps?.join("+") ?? "none"}|${mail}|${permission}|${platform}`;
            const expected = expectedNames(caps, mail, files);
            expect(run.toolNames, label).toEqual(expected);
            if (caps) {
              expect(run.session.tools, label).toEqual(expected);
              expect(run.session.customTools.map(nameOf), label).toEqual(expected);
              expect("noTools" in run.session, label).toBe(false);
            } else
              expect(run.session, label).toEqual({ tools: [], customTools: [], noTools: "all" });
            // one loader, handed the switches the footprint uses too
            expect(calls, label).toHaveLength(1);
            const switches = promptSwitches(gates);
            expect(calls[0]?.switches, label).toEqual(switches);
            for (const entry of TOOL_TABLE)
              if (entry.prompt)
                expect(switches[entry.prompt], `${label} ${entry.id}`).toBe(
                  run.toolNames.includes(entry.id)
                );
            // the footprint's tool set is the session's (the file tools are measured apart, while they are offered)
            const measured = footprintTools(gates);
            expect(measured.threw).toBe(false);
            const config = built?.wb.fileTools;
            const fileNames =
              config && permission !== "off" ? fileFootprintTools(config).map(nameOf) : [];
            expect([...measured.tools.map(nameOf), ...fileNames], label).toEqual(run.toolNames);
          }
    expect(combos).toBeGreaterThan(500);
    // over 500 assembled sessions in one synchronous case: on a loaded machine it passed 5 s (shelf-followups 07)
  }, 30_000);

  test("the run-time names of the file tools come from the tools built for this run, never from a static list", () => {
    for (const permission of ["off", "ask", "auto"] as const)
      for (const platform of ["linux", "win32"] as const) {
        const { wb, permission: read } = workbench(["library"], { permission, platform });
        const run = assembleRunTools({
          gates: { workbench: wb, mailMount: "off" },
          host: sharedHost(),
          deps: fakeDeps(),
          loader: fakeLoader().loader,
          hasSkills: () => true,
        });
        expect(run.toolNames.slice(3)).toEqual(fileToolNames(permission, platform));
        // read once while building (createFileTools); the prompt has not been asked for yet
        expect(read).toHaveBeenCalledTimes(1);
      }
  });

  test("without a workbench nothing is offered (noTools: all) and no paragraph is switched on", () => {
    const { loader, calls } = fakeLoader();
    const run = assembleRunTools({
      gates: { workbench: undefined, mailMount: "off" },
      host: sharedHost(),
      deps: fakeDeps(),
      loader,
      hasSkills: () => true,
    });
    expect(run.toolNames).toEqual([]);
    expect(run.session).toEqual({ tools: [], customTools: [], noTools: "all" });
    expect(calls[0]?.switches).toEqual({
      writer: false,
      text: false,
      mail: false,
      argument: false,
    });
    expect(calls[0]?.files()).toBeUndefined();
    expect(footprintTools({ workbench: undefined, mailMount: "off" })).toEqual({
      tools: [],
      threw: false,
    });
  });

  test("the mail paragraph follows the run's mount decision; the writer, text and argument paragraphs their capability", () => {
    const { wb } = workbench(["writer", "mail"]);
    expect(promptSwitches({ workbench: wb, mailMount: "on" })).toEqual({
      writer: true,
      text: false,
      mail: true,
      argument: false,
    });
    for (const mailMount of ["off", "unavailable"] as const)
      expect(promptSwitches({ workbench: wb, mailMount }).mail).toBe(false);
    expect(
      promptSwitches({ workbench: workbench(["text", "argument"]).wb, mailMount: "off" })
    ).toEqual({ writer: false, text: true, mail: false, argument: true });
  });
});

describe("the closing paragraph about the file tools", () => {
  test("is worked out once per run, lazily, from the tools this run really has", () => {
    for (const permission of ["off", "ask", "auto"] as const)
      for (const platform of ["linux", "win32"] as const)
        for (const skills of [true, false]) {
          const { wb, permission: read } = workbench(["reader"], { permission, platform });
          const hasSkills = vi.fn(() => skills);
          const { loader, calls } = fakeLoader();
          assembleRunTools({
            gates: { workbench: wb, mailMount: "off" },
            host: sharedHost(),
            deps: fakeDeps(),
            loader,
            hasSkills,
          });
          expect(read).toHaveBeenCalledTimes(1);
          expect(hasSkills).not.toHaveBeenCalled();
          const first = calls[0]?.files();
          expect(first).toEqual({
            permission,
            cwd: "/work/project",
            shell: platform === "win32" ? "powershell" : "bash",
            skills: permission !== "off" && skills,
          });
          expect(calls[0]?.files()).toBe(first);
          // the setting is read once more for the paragraph only when the tools are offered; never again after
          expect(read).toHaveBeenCalledTimes(permission === "off" ? 1 : 2);
          expect(hasSkills).toHaveBeenCalledTimes(permission === "off" ? 0 : 1);
        }
  });

  test("a setting changed between building the tools and the paragraph keeps the paragraph honest about the tools", () => {
    const { wb, permission: read } = workbench([], { permission: "ask" });
    const { loader, calls } = fakeLoader();
    assembleRunTools({
      gates: { workbench: wb, mailMount: "off" },
      host: sharedHost(),
      deps: fakeDeps(),
      loader,
      hasSkills: () => false,
    });
    read.mockReturnValue("off");
    // the tools are offered for this run, so the paragraph says they ask (as start() always has)
    expect(calls[0]?.files()).toMatchObject({ permission: "ask" });
  });

  test("a workbench without file tools has no paragraph context", () => {
    const { loader, calls } = fakeLoader();
    assembleRunTools({
      gates: { workbench: workbench(["library"]).wb, mailMount: "off" },
      host: sharedHost(),
      deps: fakeDeps(),
      loader,
      hasSkills: () => true,
    });
    expect(calls[0]?.files()).toBeUndefined();
  });
});

describe("assembly order", () => {
  test("the one resource loader is made before any tool's context is built; the text tool reads its instructions from it", () => {
    const { wb } = workbench([...CAPS], { permission: "ask" });
    const order: string[] = [];
    const deps = fakeDeps();
    const watched = new Proxy(deps, {
      get(target, key, receiver) {
        order.push(`deps.${String(key)}`);
        return Reflect.get(target, key, receiver);
      },
    });
    const { made } = fakeLoader();
    const run = assembleRunTools({
      gates: { workbench: wb, mailMount: "on" },
      host: sharedHost(),
      deps: watched,
      loader: () => {
        order.push("loader");
        return made as never;
      },
      hasSkills: () => true,
    });
    expect(order[0]).toBe("loader");
    expect(order.filter((step) => step === "loader")).toHaveLength(1);
    expect(run.resourceLoader).toBe(made);
    const text = TOOL_TABLE.find((entry) => entry.id === "text");
    if (!text) throw new Error("no text entry");
    const context = contextOf(text, sharedHost(), deps, {
      workbench: wb,
      loader: made as never,
    }) as {
      instruction(name: string): unknown;
      instructionNames(): string[];
    };
    context.instruction("pdf-transcription");
    expect(made.getInstruction).toHaveBeenCalledWith("pdf-transcription");
    expect(context.instructionNames()).toEqual(["pdf-transcription"]);
  });
});

describe("what each tool is given", () => {
  const expectedShare: Record<string, readonly string[]> = {
    plan: SHARED,
    workspace: ["admitting"],
    library: SHARED,
    reader: ["admitting"],
    writer: SHARED,
    text: SHARED,
    mail: SHARED,
    argument: SHARED,
    shelf: SHARED,
    files: ["admitting", "track", "confirm"],
  };

  test("one shared host context: the same functions, never copies; workspace and reader get admitting only, the file tools no journal or runId", () => {
    const { wb } = workbench([...CAPS], { permission: "ask" });
    const host = sharedHost();
    const deps = fakeDeps();
    const { made } = fakeLoader();
    expect(TOOL_TABLE.map((entry) => entry.id)).toEqual([...BUSINESS, "files"]);
    const tracked: string[] = [];
    for (const entry of TOOL_TABLE) {
      const context = contextOf(entry, host, deps, {
        workbench: wb,
        loader: made as never,
      }) as Record<string, unknown>;
      const shared = Object.keys(context).filter((key) =>
        (SHARED as readonly string[]).includes(key)
      );
      expect(shared.sort(), entry.id).toEqual([...(expectedShare[entry.id] ?? [])].sort());
      for (const key of shared)
        expect(context[key], `${entry.id}.${key}`).toBe(host[key as keyof typeof host]);
      // admitting stays a function asked at every call, never a snapshot
      expect(typeof context.admitting, entry.id).toBe("function");
      if (context.track === host.track) tracked.push(entry.id);
    }
    // the seven tools whose work a terminal run state waits for all hand it to the one track (one state.inflight)
    expect(tracked).toEqual([
      "plan",
      "library",
      "writer",
      "text",
      "mail",
      "argument",
      "shelf",
      "files",
    ]);
  });

  test("each tool's own dependencies, wired as the host wired them", async () => {
    const { wb, permission, protectedFolders } = workbench([...CAPS], {
      permission: "ask",
      platform: "win32",
    });
    const host = sharedHost();
    const deps = fakeDeps();
    const { made } = fakeLoader();
    const run = { workbench: wb, loader: made as never };
    const of = (id: string) => {
      const entry = TOOL_TABLE.find((candidate) => candidate.id === id);
      if (!entry) throw new Error(id);
      // biome-ignore lint/suspicious/noExplicitAny: the test pokes at each tool's own context shape
      return contextOf(entry, host, deps, run) as any;
    };
    const viewAction = deps.viewAction as ReturnType<typeof vi.fn>;

    const plan = of("plan");
    expect(plan.plans).toBe(wb.plans);
    expect(plan.taskUndo).toBe(deps.taskUndo);
    expect(plan.conversationId).toBe("conversation-1");
    expect(plan.taskDeleted).toBe(deps.taskDeleted);
    await plan.viewAction({ action: "show_plan" });
    expect(viewAction).toHaveBeenLastCalledWith({ action: "show_plan" });

    const workspace = of("workspace");
    expect(workspace.page).toBe(deps.page);
    expect(workspace.providerStatus).toBe(deps.providerStatus);
    expect(workspace.selectModel).toBe(deps.selectModel);
    await workspace.viewAction({ action: "open_view" });
    expect(viewAction).toHaveBeenLastCalledWith({ action: "open_view" });

    const library = of("library");
    expect(library.library).toBe(wb.library);
    expect(library.page).toBe(deps.page);
    for (const slow of ["explore_work", "explore_candidate", "retry_exploration"]) {
      await library.viewAction({ action: slow });
      expect(viewAction).toHaveBeenLastCalledWith({ action: slow }, { reportMs: 120_000 });
    }
    await library.viewAction({ action: "open_work" });
    expect(viewAction).toHaveBeenLastCalledWith({ action: "open_work" }, {});
    // state sync is not navigation: it never goes through the run's (Stop-cancelled) view action
    viewAction.mockClear();
    library.shellSync({ action: "doc_deleted", docId: "d", remaining: [] });
    expect(deps.shellSync).toHaveBeenCalledWith({
      action: "doc_deleted",
      docId: "d",
      remaining: [],
    });
    expect(viewAction).not.toHaveBeenCalled();

    const reader = of("reader");
    expect(reader.reader).toBe(wb.reader);
    expect(reader.conversationId).toBe("conversation-1");
    for (const key of ["modelAcceptsImages", "page", "budget", "reclaim", "imageBytesUsed"])
      expect(reader[key], key).toBe(deps[key as keyof Deps]);
    await reader.viewAction({ action: "navigate" });
    expect(viewAction).toHaveBeenLastCalledWith({ action: "navigate" }, { reportMs: 30_000 });
    await reader.viewAction({ action: "set_panel" });
    expect(viewAction).toHaveBeenLastCalledWith({ action: "set_panel" }, {});

    const writer = of("writer");
    expect(writer.writer).toBe(wb.writer);
    expect(writer.budget).toBe(deps.budget);
    await writer.viewAction({ action: "open_manuscript" });
    expect(viewAction).toHaveBeenLastCalledWith({ action: "open_manuscript" });

    const text = of("text");
    expect(text.text).toBe(wb.text);
    for (const key of ["sourceCoverage", "page", "budget", "reclaim"])
      expect(text[key], key).toBe(deps[key as keyof Deps]);
    await text.viewAction({ action: "open_doc" });
    expect(viewAction).toHaveBeenLastCalledWith({ action: "open_doc" });

    const mail = of("mail");
    expect(mail.mail).toBe(wb.mail);
    for (const key of ["modelAcceptsImages", "budget", "imageBytesUsed"])
      expect(mail[key], key).toBe(deps[key as keyof Deps]);
    expect("viewAction" in mail).toBe(false);

    const argument = of("argument");
    expect(argument.argument).toBe(wb.argument);
    expect(argument.budget).toBe(deps.budget);
    expect(argument.wrote).toBe(deps.wrote);
    await argument.viewAction({ action: "open_argument" });
    expect(viewAction).toHaveBeenLastCalledWith({ action: "open_argument" });

    const shelf = of("shelf");
    expect(shelf.shelf).toBe(wb.shelf);
    expect("viewAction" in shelf).toBe(false);

    const files = of("files");
    expect(files.cwd).toBe("/work/project");
    expect(files.permission).toBe(permission);
    expect(files.protectedFolders).toBe(protectedFolders);
    expect(files.platform).toBe("win32");
    expect(files.allowed).toBe(deps.fileAllow);
    expect(files.lifecycle).toBe(deps.fileLifecycle);
    // without a platform in the workbench the key is absent (the tools fall back to this process's platform)
    const plain = workbench([], { permission: "ask" });
    const filesEntry = TOOL_TABLE.find((entry) => entry.id === "files");
    if (!filesEntry) throw new Error("files");
    expect(
      "platform" in
        (contextOf(filesEntry, host, deps, {
          workbench: plain.wb,
          loader: made as never,
        }) as object)
    ).toBe(false);
  });
});

describe("the shelf tool is the same in every project (shelf ticket 07, tutorial-shelf 01)", () => {
  test("is offered whenever the Shelf seam is there, whatever the open project is", () => {
    const { wb } = workbench(["library", "shelf"]);
    (wb as unknown as { shelf: object }).shelf = {};
    const names = () =>
      assembleRunTools({
        gates: { workbench: wb, mailMount: "off" },
        host: sharedHost(),
        deps: fakeDeps(),
        loader: fakeLoader().loader,
        hasSkills: () => false,
      }).toolNames;
    expect(names()).toEqual(["plan", "workspace", "library", "shelf"]);
    expect(footprintTools({ workbench: wb, mailMount: "off" }).tools.map(nameOf)).toContain(
      "shelf"
    );
  });
});

describe("the footprint's tool set", () => {
  test("a factory that throws keeps the tools already built and says so (the host adds its generous measure)", () => {
    const { wb } = workbench([...CAPS]);
    failing.mail = true;
    try {
      const measured = footprintTools({ workbench: wb, mailMount: "on" });
      expect(measured.threw).toBe(true);
      expect(measured.tools.map(nameOf)).toEqual([
        "plan",
        "workspace",
        "library",
        "reader",
        "writer",
        "text",
      ]);
    } finally {
      failing.mail = false;
    }
  });

  test("the file tools' footprint stub offers the tools of the platform, as asked each time", () => {
    expect(
      fileFootprintTools({
        cwd: "/w",
        permission: () => "off",
        protectedFolders: () => [],
        platform: "win32",
      }).map(nameOf)
    ).toEqual(fileToolNames("ask", "win32"));
    expect(
      fileFootprintTools({ cwd: "/w", permission: () => "auto", protectedFolders: () => [] }).map(
        nameOf
      )
    ).toEqual(fileToolNames("ask", process.platform));
  });
});
