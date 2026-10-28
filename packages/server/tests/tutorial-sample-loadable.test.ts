// "The tutorial sample is loadable" (in-app-tutorial ticket 16, spec Testing Decisions): the frozen sample committed
// at the repository root (tutorial-sample/) still loads with the product's own readers. Run on a temp copy, never on
// the sample itself. ① the Doc's IR, ⑥ the sample carries no ADS discovery cache (no library cache at all, and the
// notice claims none: ADS API terms forbid redistributing data obtained from ADS, the user's ruling of 2026-10-21), ⑦ the library
// graph heals to exactly the citations among the five Works the spec lists (Röser↔Meingast, Jerabkova→Röser/Meingast,
// Kroupa→Röser/Meingast/Jerabkova, Pflamm-Altenburg→Jerabkova/Kroupa: nine directed edges; the spec's count "7" does
// not match its own list, see ticket 16's comments). Ticket 17 adds ② the preset annotations survive an `ensure` (no
// archive) and target blocks the IR has, ③ the argument graph reads and its audit has exactly the one deliberate
// noPathToEnd finding, ④ the Plan and the manuscript read, ⑤ the preset Copilot conversation reads back through
// `readCopilotHistory` and the host's snapshot for both conversations (chapter 8's: three questions, two operation cards, no confirmation; chapter 9's move-in conversation:
// five questions, only decided cards, one declined command).
// A red test here means the sample has to be regenerated with packages/app/scripts/tutorial-sample.mjs (or the
// product changed a format the sample relies on; for ⑤ the conversation is re-run by hand, spec §7).
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { auditArgumentGraph, irIndex } from "@argelanderspace/contracts";
import {
  ensureCurrentAnnotations,
  healGraph,
  LibraryStore,
  libraryPaths,
  loadArgumentGraph,
  loadManuscript,
  loadPlans,
  loadStoredDocIr,
} from "@argelanderspace/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CopilotHost } from "../src/copilot.js";
import { readCopilotHistory } from "../src/copilot-history.js";
import { ProviderSettings } from "../src/providers.js";

const SAMPLE = fileURLToPath(new URL("../../../tutorial-sample", import.meta.url));
const DOC = "arxiv-2103.12080";
const W = {
  roser: "doi:10.1051/0004-6361/201834608",
  meingast: "doi:10.1051/0004-6361/201834622",
  jerabkova: "doi:10.1051/0004-6361/202039949",
  pflamm: "doi:10.1051/0004-6361/202244243",
  kroupa: "doi:10.1093/mnras/stac2563",
};

let root: string;
let dataDir: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "tutorial-sample-"));
  cpSync(SAMPLE, join(root, "sample"), { recursive: true });
  dataDir = join(root, "sample", "literatures");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the tutorial sample's layout", () => {
  it("has the marker with exactly version and sample, the notice and the upload zip", () => {
    const marker = JSON.parse(readFileSync(join(SAMPLE, "argelanderspace-tutorial.json"), "utf8"));
    expect(Object.keys(marker).sort()).toEqual(["sample", "version"]);
    expect(marker.version).toBe(1);
    expect(Number.isInteger(marker.sample)).toBe(true);
    expect(existsSync(join(SAMPLE, "NOTICE.md"))).toBe(true);
    expect(existsSync(join(SAMPLE, "tutorial-assets", "evans-oh-2022-source.zip"))).toBe(true);
    expect(existsSync(join(SAMPLE, "status", "plans.json"))).toBe(true);
  });

  it("carries none of the derived or runtime parts of a project", () => {
    const lit = join(SAMPLE, "literatures");
    for (const absent of [
      "library/graph.json",
      "library/cache",
      "library/library.bib",
      "jobs",
      "logs",
      "input",
      `output/${DOC}/src`,
      `output/${DOC}/build`,
    ])
      expect(existsSync(join(lit, absent)), absent).toBe(false);
    expect(readdirSync(join(lit, "output"))).toEqual([DOC]);
    expect(readdirSync(join(lit, `output/${DOC}`)).sort()).toEqual([
      "arxiv-2103.12080.json",
      "assets",
    ]);
  });
});

describe("the tutorial sample loads", () => {
  it("① the Jerabkova IR reads through loadStoredDocIr", () => {
    const ir = loadStoredDocIr(dataDir, DOC);
    expect(ir.docId).toBe(DOC);
    expect(ir.sections.length).toBeGreaterThan(0);
    const store = LibraryStore.load(libraryPaths(dataDir));
    expect(store.works.find((w) => w.doc_ids.includes(DOC))?.id).toBe(W.jerabkova);
  });

  it("⑥ the sample carries no ADS discovery cache, and its notice claims none", () => {
    expect(existsSync(join(dataDir, "library", "cache")), "literatures/library/cache").toBe(false);
    /** Every path under `dir`, relative, `/`-separated. */
    const walk = (dir: string, rel = ""): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = rel ? `${rel}/${name}` : name;
        return statSync(join(dir, name)).isDirectory()
          ? [path, ...walk(join(dir, name), path)]
          : [path];
      });
    expect(walk(SAMPLE).filter((p) => /ads-discovery/i.test(p))).toEqual([]);
    const notice = readFileSync(join(SAMPLE, "NOTICE.md"), "utf8");
    expect(notice).not.toMatch(/ads-discovery|library\/cache/i);
    expect(notice).not.toMatch(/discovery results/i);
  });

  it("⑦ the healed library graph has exactly the listed citations among the five Works", () => {
    const graph = healGraph(libraryPaths(dataDir));
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(Object.values(W).sort());
    expect(graph.links.map(([a, b]) => `${a} -> ${b}`).sort()).toEqual(
      [
        [W.roser, W.meingast],
        [W.meingast, W.roser],
        [W.jerabkova, W.roser],
        [W.jerabkova, W.meingast],
        [W.kroupa, W.roser],
        [W.kroupa, W.meingast],
        [W.kroupa, W.jerabkova],
        [W.pflamm, W.jerabkova],
        [W.pflamm, W.kroupa],
      ]
        .map(([a, b]) => `${a} -> ${b}`)
        .sort()
    );
  });

  it("② the preset annotations survive an ensure: no archive, every target in the IR", () => {
    const annotationsDir = join(dataDir, "annotations", DOC);
    const before = readFileSync(join(annotationsDir, "current.json"));
    const result = ensureCurrentAnnotations(dataDir, DOC);
    expect(result.invalidated).toBe(false);
    expect(readdirSync(annotationsDir)).toEqual(["current.json"]);
    expect(readFileSync(join(annotationsDir, "current.json"))).toEqual(before);
    expect(result.file.rev).toBe(0);
    expect(result.file.annotations.map((a) => a.target.type).sort()).toEqual([
      "document",
      "structure",
      "text",
    ]);
    const { blocks, sections } = irIndex(loadStoredDocIr(dataDir, DOC));
    for (const a of result.file.annotations) {
      if (a.target.type === "structure")
        expect(blocks.has(a.target.id) || sections.has(a.target.id), a.id).toBe(true);
      if (a.target.type === "text") expect(blocks.has(a.target.block), a.id).toBe(true);
    }
  });

  it("③ the argument graph reads and its audit has exactly one finding: the deliberate unlinked Native", () => {
    const graph = loadArgumentGraph(dataDir, W.jerabkova);
    expect(graph.arguments.length).toBeGreaterThanOrEqual(6);
    expect(graph.arguments.length).toBeLessThanOrEqual(8);
    expect(graph.arguments.filter((a) => a.kind === "end")).toHaveLength(1);
    const audit = auditArgumentGraph(graph);
    expect(audit.noPathToEnd).toHaveLength(1);
    const orphan = graph.arguments.find((a) => a.id === audit.noPathToEnd[0]);
    expect(orphan?.kind).toBe("native");
    expect(audit).toEqual({
      cycles: [],
      noPathToEnd: [orphan?.id],
      noEnd: false,
      endWithOutEdge: [],
      nativeWithInEdge: [],
      incomplete: [],
    });
  });

  it("④ the Plan and the manuscript read", () => {
    const plans = loadPlans(join(root, "sample", "status"));
    expect(plans.plans).toHaveLength(1);
    expect(plans.plans[0]?.tasks.length).toBeGreaterThanOrEqual(2);
    const manuscripts = readdirSync(join(dataDir, "manuscripts"));
    expect(manuscripts).toHaveLength(1);
    const manuscript = loadManuscript(dataDir, manuscripts[0] as string);
    expect(manuscript?.cells.length).toBeGreaterThanOrEqual(3);
    // the review manuscript cites all five Works of the library
    const sources = manuscript?.cells.map((c) => JSON.stringify(c.data)).join("\n") ?? "";
    const store = LibraryStore.load(libraryPaths(dataDir));
    for (const work of store.works) expect(sources, work.id).toContain(work.cite_key);
  });

  it("⑤ the preset Copilot conversations read back: chapter 8's has three questions, two operation cards, no confirmation; chapter 9's move-in conversation has six questions and only approved cards", async () => {
    const records = join(dataDir, "copilot", "conversations");
    expect(
      existsSync(records),
      "tutorial-sample has no preset Copilot conversations: run them by hand (spec §7) and copy their files back"
    ).toBe(true);
    const names = readdirSync(records).sort();
    expect(names).toHaveLength(2);
    const parsed = names.map((n) => JSON.parse(readFileSync(join(records, n), "utf8")));
    const chapter8 = parsed.find((r) => r.id === "85b4af77-56d0-4684-8a1c-b8926dec17d0");
    const intake = parsed.find((r) => r.id === "fee7ecc0-b8e9-49b0-9ac7-a582faaa984c");
    expect(chapter8 && intake, `records: ${parsed.map((r) => r.id)}`).toBeTruthy();
    // one session per record, nothing else
    expect(readdirSync(join(dataDir, "copilot", "sessions")).sort()).toEqual(
      [chapter8.sessionId, intake.sessionId].map((id: string) => `${id}.jsonl`).sort()
    );
    for (const r of [chapter8, intake]) {
      const session = join(dataDir, "copilot", "sessions", `${r.sessionId}.jsonl`);
      expect(readCopilotHistory(session, r.sessionId).length).toBeGreaterThan(0);
    }
    // chapter 8's conversation stays the most recently updated: its 8.1 relies on being selected by default
    expect(Date.parse(chapter8.updatedAt)).toBeGreaterThan(Date.parse(intake.updatedAt));
    const host = new CopilotHost(
      dataDir,
      new ProviderSettings({ configDir: join(root, "provider-config") }),
      () => {}
    );
    try {
      const snapshot = await host.snapshot(chapter8.id);
      const questions = snapshot.messages.filter((m) => m.role === "user" && m.kind !== "resume");
      expect(questions).toHaveLength(3);
      // the first question was asked in the Jerabkova reader and carries that page
      expect(questions[0]?.context?.reader).toBeDefined();
      const operations = snapshot.messages.flatMap((m) => m.operations ?? []);
      expect(operations).toHaveLength(2);
      expect(operations.some((o) => o.fileTool !== undefined)).toBe(false);
      expect(snapshot.confirmations).toEqual([]);

      // the move-in conversation (recorded with file and command permission on "ask", ticket 15): six user turns; every
      // tool card is decided, approved and none failed or was refused (the product's status "ok" or "declined" are all
      // there are); the file tools, one read-only command per step and the library calls are the work
      const move = await host.snapshot(intake.id);
      const turns = move.messages.filter((m) => m.role === "user" && m.kind !== "resume");
      expect(turns).toHaveLength(6);
      expect(turns[0]?.text).toBe("开始迁入已有项目");
      expect(move.confirmations).toEqual([]);
      const cards = move.messages.flatMap((m) => m.operations ?? []);
      expect(cards.filter((c) => c.status !== "ok")).toEqual([]);
      // no command that only fetches the date: the system prompt states it (ticket 13)
      const commands = cards.flatMap((c) =>
        c.fileTool?.kind === "command" ? [c.fileTool.command ?? ""] : []
      );
      expect(commands.length).toBeGreaterThan(0);
      expect(commands.filter((c) => /\bdate\b/.test(c))).toEqual([]);
      expect(cards.some((c) => c.fileTool?.kind === "write")).toBe(true);
      expect(cards.some((c) => c.tool === "library")).toBe(true);
    } finally {
      await host.close();
    }
  });
});
