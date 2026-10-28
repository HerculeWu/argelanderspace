/**
 * Project-intake acceptance (ticket 08, spec "验收"): a synthetic messy project is moved into a new Project by the real
 * Copilot (real server, real Pi session and file tools, real `library` / `plan` business tools, real PDFium and job
 * runner), driven by a scripted model that follows `skills/argelander-project-intake/SKILL.md`. The only stand-ins are
 * the model and the network (an offline ADS: search, export, biblib). Nothing here touches the repository's own
 * `literatures/`, a real credential store or the network.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryStore, libraryPaths, plansPath } from "@argelanderspace/core";
import { getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  CHECKLIST,
  CONTINUE,
  importLongBib,
  intakeFirstSession,
  intakeFromPrepared,
  intakeResumedSession,
  parse,
  preparationAgent,
  start,
} from "./intake-agent.js";
import {
  ADS_TOKEN,
  buildMessy,
  type Messy,
  OVERLEAF_LINK,
  pathsUnder,
  snapshotTree,
} from "./intake-fixture.js";
import {
  FIXED_DATE,
  newConversation,
  openWorld,
  operationsOf,
  say,
  tool,
  userTurn,
  type World,
} from "./intake-harness.js";

const locale = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../web/src/locales/${name}.json`, import.meta.url), "utf8")
  ) as {
    copilot: { intake: { startMessage: string; resumeMessage: string } };
  };
const ZH = locale("zh-CN").copilot.intake;

/** The acceptance runs the real shell tools the skill names; without them the two shell-driven cases are skipped (a skip is not a pass). */
const haveTool = (cmd: string, arg: string) =>
  spawnSync(cmd, [arg], { stdio: "ignore" }).error === undefined;
const HAVE_SHELL_TOOLS =
  haveTool("pdftotext", "-v") && haveTool("unzip", "-v") && haveTool("rsync", "--version");
/** the skill's one command per PDF folder */
const FIRST_PAGES =
  /^for f in '[^']+'\/\*\.\[pP\]\[dD\]\[fF\]; do printf '=== %s\\n' "\$f"; pdftotext -l 1 "\$f" - \| head -c 2000; done$/;

let w: World;
let fx: Messy;
let fixtureRoot: string;

beforeEach(async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "intake-fixture-"));
  fx = buildMessy(fixtureRoot);
});
afterEach(async () => {
  await w?.close();
});

/** The summary tables in a text: each is the rows `| label | n |` after its header, as numbers in order. */
function tablesIn(text: string): { header: string[]; rows: [string, number][] }[] {
  const out: { header: string[]; rows: [string, number][] }[] = [];
  let current: (typeof out)[number] | null = null;
  for (const line of text.split("\n")) {
    const cells = /^\|(.*)\|$/
      .exec(line.trim())?.[1]
      ?.split("|")
      .map((c) => c.trim());
    if (!cells) {
      current = null;
      continue;
    }
    if (cells.every((c) => /^-+$/.test(c))) continue;
    if (current === null) {
      current = { header: cells, rows: [] };
      out.push(current);
    } else current.rows.push([cells[0] as string, Number(cells[1])]);
  }
  return out;
}
const LABELS = ["新建", "并入已有", "被拒", "失败", "待定"];
const counts = (t: ReturnType<typeof tablesIn>[number]) => t.rows.map((r) => r[1]);

async function assistantTexts(id: string): Promise<string[]> {
  return (await w.host.snapshot(id)).messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.text);
}

const survey = () =>
  [
    "ADS libraries: Thesis refs, Misc",
    `Zotero: ${fx.zoteroBib} ; 附件在同一导出文件夹的 files/ 里`,
    ".bib: 无",
    `PDF 文件夹: ${fx.downloads}`,
    `服务器: lab:/data/thesis/papers ; 本机路径模拟 ${fx.serverPapers} ; 结果文件 lab:/data/thesis/results 只登记`,
    `稿件: Overleaf ${fx.overleafLink} ; 源码 zip ${fx.zip}`,
    `计划: ${fx.todo}`,
    "其他: lab:/data/thesis/sim-runs (代码和结果，只登记)",
  ].join("\n");

test.skipIf(!HAVE_SHELL_TOOLS)(
  "the whole intake: entry message to wrap-up, interrupted and resumed in a new conversation",
  async () => {
    w = await openWorld("ask");
    const beforeFixture = snapshotTree(fx.root);
    const beforePaths = pathsUnder(fx.root);

    // ---- session 1: the entry's fixed message, then up to "enough for today" --------------------------- //
    w.agent(intakeFirstSession());
    const c1 = await newConversation(w);
    const turns1 = [
      await userTurn(w, c1, ZH.startMessage),
      await userTurn(w, c1, "就用这个新建的空文件夹。"),
      await userTurn(w, c1, survey()),
      await userTurn(w, c1, "两个都要。"),
      await userTurn(w, c1, "过期的那条跳过；被拒的那条我之后在页面里处理，先放待定。"),
      await userTurn(w, c1, "桥接那条也先放待定。今天先到这儿。"),
    ];
    for (const t of turns1) expect(t.status).toBe("completed");

    // the model got the fixed message as the user's first message and saw the skill in its list
    const firstSystem = JSON.stringify(w.seen[0]?.messages.find((m) => m.role === "system"));
    expect(firstSystem).toContain("argelander-project-intake");
    expect(JSON.stringify(w.seen[0]?.messages.filter((m) => m.role === "user"))).toContain(
      ZH.startMessage
    );

    // the summary tables of session 1: two columns, five rows, in the skill's order
    const texts1 = await assistantTexts(c1);
    const t1 = texts1.flatMap(tablesIn);
    // the Zotero stop: the PDF line follows its table (attach calls that came back ok or noop, and the noop ones)
    expect(texts1.find((t) => t.startsWith("Zotero 这一批")) ?? "").toMatch(
      /\| 待定 \| 2 \|\n挂上 PDF：2（其中同文件已存在 0）/
    );
    expect(t1.length).toBe(3);
    for (const t of t1) {
      expect(t.header).toEqual(["结果", "数量"]);
      expect(t.rows.map((r) => r[0])).toEqual(LABELS);
    }
    expect(t1.map(counts)).toEqual([
      [4, 0, 0, 1, 0], // ADS Thesis refs: A X Y C created; the stale bibcode fails
      [1, 0, 1, 0, 0], // ADS Misc: N created; M would merge X and Y
      [3, 1, 1, 0, 2], // Zotero: lee rossi park created, smith exists, bridge2023 refused; rossi and park have no file
    ]);

    // the library after session 1, and nothing queued for arXiv
    const paths = libraryPaths(w.dataDir);
    const afterOne = LibraryStore.load(paths);
    expect(afterOne.works.map((x) => x.id).sort()).toEqual(
      [
        "doi:10.5555/smith.a1",
        "doi:10.5555/xavier.x1",
        "arxiv:2101.00002",
        "doi:10.5555/chen.c3",
        "doi:10.5555/nova.n1",
        "doi:10.5555/lee.l1",
        "doi:10.5555/rossi.r1",
        "arxiv:2105.04321",
      ].sort()
    );
    expect(w.arxivFetches).toEqual([]);
    expect(w.arxivIngests).toEqual([]);
    expect(w.runner.list().filter((j) => JSON.stringify(j).includes("arxiv"))).toEqual([]);
    expect(afterOne.get("doi:10.5555/smith.a1")?.doc_ids).toHaveLength(1);
    expect(afterOne.get("doi:10.5555/lee.l1")?.doc_ids).toHaveLength(1);

    // the checklist holds the state: five headings, the sources with their status
    const written = readFileSync(join(w.project, CHECKLIST), "utf8");
    for (const heading of ["## 状态", "## 来源", "## 已带入", "## 待定与跳过", "## 留在原处的材料"])
      expect(written).toContain(heading);
    const mid = parse(written);
    expect(mid.state).toBe("进行中");
    // ticket 13: the date is the one in the system prompt (a fixed clock, not today), the next step is one line under 状态, no sixth section
    expect(written).toContain(`- 最近更新：${FIXED_DATE}，Copilot`);
    expect(written.split("\n").filter((l) => l.startsWith("## "))).toHaveLength(5);
    expect(mid.next).toContain("PDF 文件夹");
    expect(written).not.toMatch(/已与用户(对过|确认)|下一步（/);
    expect(mid.sources.find((s) => s.kind === "ADS libraries")?.status).toBe("已带入");
    expect(mid.sources.find((s) => s.kind === "Zotero")?.status).toBe("部分");
    expect(mid.sources.find((s) => s.kind === "PDF 文件夹")?.status).toBe("未开始");
    expect(mid.pending.join("\n")).toContain("bridge2023");
    expect(mid.pending.join("\n")).toContain("2023MNRAS.521.0007M");

    // ---- session 2: a NEW conversation, "continue": it knows only the checklist ------------------------- //
    w.agent(intakeResumedSession(w.project));
    const c2 = await newConversation(w);
    expect(c2).not.toBe(c1);
    const r1 = await userTurn(w, c2, ZH.resumeMessage);
    expect(
      w.calls
        .filter((x) => x.session === 2)
        .slice(0, 3)
        .map((x) => x.name)
    ).toEqual(["read", "read", "bash"]);
    expect(w.calls.find((x) => x.session === 2)?.args.path).toMatch(/SKILL\.md$/);
    expect(w.calls.filter((x) => x.session === 2)[1]?.args.path).toBe(CHECKLIST);
    expect(w.arxivFetches).toEqual([]);
    const r2 = await userTurn(
      w,
      c2,
      "notes_scan.pdf 的 标题：A note on tidal tails，作者：H. Kowalski, B. Berg；年份：2018，出处：Proceedings of the Synthetic Conference。trap.pdf 是内部备忘录，跳过；blank.pdf 我也不认识，先放待定。"
    );
    // nothing is fetched from arXiv before the one question; each source ends in a stop, the next one waits for the user
    expect(w.arxivFetches).toEqual([]);
    const r3 = await userTurn(w, c2, "好，接着做服务器。");
    const r4 = await userTurn(w, c2, "接着做稿件。");
    expect(w.arxivFetches).toEqual([]);
    const r5 = await userTurn(w, c2, "好，进入 arXiv 这一步。");
    const r6 = await userTurn(w, c2, "2101.00002 和 2105.04321 要，其余不用。");
    // the question named every Work with an arXiv id and no PDF; only the two the user picked were fetched
    const arxivQuestion =
      (await assistantTexts(c2)).find((t) => t.includes("哪些要取 arXiv 正文")) ?? "";
    for (const id of ["2101.00002", "2105.04321", "2208.00033"])
      expect(arxivQuestion).toContain(id);
    expect(arxivQuestion).not.toContain("2108.01234"); // already has its PDF
    expect(w.arxivFetches.sort()).toEqual(["2101.00002", "2105.04321"]);
    const r7 = await userTurn(w, c2, "好，接着整理计划。");
    const r8 = await userTurn(w, c2, "2026-12-15，草案可以，写入吧。");
    const r9 = await userTurn(w, c2, "完成。");
    for (const t of [r1, r2, r3, r4, r5, r6, r7, r8, r9]) expect(t.status).toBe("completed");

    // the server copy was asked for as a command card (the user's agreement) and went where the skill says
    const rsync = [r1, r2, r3].flatMap((t) => t.cards).find((c) => c.detail.startsWith("rsync"));
    expect(rsync?.detail).toContain(`${w.project}/intake-inbox/lab-server/`);
    expect(rsync?.decision).toBe("approve");

    const texts2 = await assistantTexts(c2);
    const t2 = texts2.flatMap(tablesIn);
    // ticket 13: a stop message holds the table, the lines after it and one question, and nothing of the next step
    const stopAfter = (needle: string) => texts2.find((t) => t.includes(needle)) ?? "";
    const pdfStop = stopAfter("PDF 文件夹共");
    const supplementStop = stopAfter("补的一批");
    const serverStop = stopAfter("服务器 papers：");
    const overleafStop = stopAfter("Overleaf zip：");
    for (const stop of [pdfStop, supplementStop, serverStop, overleafStop]) {
      expect(stop).not.toBe("");
      expect(stop).toContain(CONTINUE);
      expect(stop).not.toMatch(/计划草案|哪些要取 arXiv 正文/);
    }
    expect(pdfStop).not.toMatch(/rsync|服务器 papers/);
    expect(overleafStop).not.toContain("哪些要取");
    // the PDF line after the table: attaching is not a row. Folder: 5 attach calls came back ok or noop (the huge one
    // did not), one of them the byte-identical copy of a PDF already on its Work
    expect(pdfStop).toMatch(/\| 待定 \| 4 \|\n挂上 PDF：5（其中同文件已存在 1）/);
    expect(supplementStop).toMatch(/\| 待定 \| 3 \|\n挂上 PDF：1（其中同文件已存在 0）/);
    expect(serverStop).toMatch(/\| 待定 \| 0 \|\n挂上 PDF：1（其中同文件已存在 0）/);
    expect(overleafStop).not.toContain("挂上 PDF");
    const arxivAsk = stopAfter("哪些要取 arXiv 正文");
    expect(arxivAsk).toContain(CONTINUE);
    expect(stopAfter("接着整理计划")).toContain(CONTINUE);
    // the plan draft came only after the user agreed to step 6, and not inside the arXiv message
    expect(texts2.findIndex((t) => t.includes("计划草案"))).toBeGreaterThan(
      texts2.findIndex((t) => t.includes("接着整理计划"))
    );
    for (const t of t2) {
      expect(t.header).toEqual(["结果", "数量"]);
      expect(t.rows.map((r) => r[0])).toEqual(LABELS);
    }
    expect(t2.map(counts)).toEqual([
      [4, 3, 0, 0, 4], // PDF folder: T O H created, trap's reference DOI created too (named, to be deleted); Rossi + two Smith copies exist; huge, blank, trap, notes_scan wait
      [1, 0, 0, 0, 3], // after the user: notes_scan created; huge, blank, trap stay
      [1, 0, 0, 0, 0], // server papers
      [1, 2, 0, 0, 0], // Overleaf zip: newkey created, smith2020 and lee2019 exist
    ]);
    expect(texts2.join("\n")).toContain("ghost2022"); // cited, not in the .bib
    // trap.pdf: the reference's DOI made a Work; it is counted as new and named after the table with the way to remove it
    const trapLine =
      texts2
        .join("\n")
        .split("\n")
        .find((l) => l.includes("A survey of cold gas")) ?? "";
    expect(trapLine).toContain("trap.pdf");
    expect(trapLine).toContain("可能是参考文献里的 DOI，不需要就在文献库页面删除");

    // ---- the library, the Docs, the Plan -------------------------------------------------------------- //
    const store = LibraryStore.load(paths);
    expect(store.works.map((x) => x.id).sort()).toEqual(
      [
        "doi:10.5555/smith.a1",
        "doi:10.5555/xavier.x1",
        "arxiv:2101.00002",
        "doi:10.5555/chen.c3",
        "doi:10.5555/nova.n1",
        "doi:10.5555/lee.l1",
        "doi:10.5555/rossi.r1",
        "arxiv:2105.04321",
        "arxiv:2108.01234",
        "doi:10.5555/ortiz.o5",
        "doi:10.5555/huge.h1",
        "doi:10.5555/lab.s1",
        "doi:10.5555/new.k1",
        "doi:10.5555/refd.r1", // trap.pdf's reference DOI, imported before the title check caught it
        "work:a-note-on-tidal-tails-2018", // no identifier: made from the user's title, authors, year and venue
      ].sort()
    );
    const docs = (id: string) => store.get(id)?.doc_ids.length ?? -1;
    expect(docs("doi:10.5555/smith.a1")).toBe(2); // the Zotero file; the preprint (the byte-identical copy is a no-op)
    expect(docs("doi:10.5555/lee.l1")).toBe(1);
    expect(docs("doi:10.5555/rossi.r1")).toBe(1);
    expect(docs("arxiv:2108.01234")).toBe(1);
    expect(docs("doi:10.5555/ortiz.o5")).toBe(1);
    expect(docs("doi:10.5555/huge.h1")).toBe(0); // over the page limit: registered, not attached
    expect(docs("doi:10.5555/lab.s1")).toBe(1);
    expect(docs("arxiv:2101.00002")).toBe(1); // the arXiv PDFs the user chose
    expect(docs("arxiv:2105.04321")).toBe(1);
    expect(docs("doi:10.5555/xavier.x1")).toBe(0);
    expect(docs("doi:10.5555/chen.c3")).toBe(0);
    expect(docs("doi:10.5555/refd.r1")).toBe(0);
    for (const work of store.works)
      for (const doc of work.doc_ids)
        expect(statSync(join(paths.outputDir, doc)).isDirectory(), `${doc} of ${work.id}`).toBe(
          true
        );

    const plans = JSON.parse(readFileSync(plansPath(w.statusDir), "utf8")) as {
      plans: {
        name: string;
        due: string;
        tasks: { title: string; due: string; links?: unknown[]; docs?: string[] }[];
      }[];
    };
    expect(plans.plans).toHaveLength(1);
    expect(plans.plans[0]).toMatchObject({ name: "Thesis", due: "2027-03-31" });
    expect(plans.plans[0]?.tasks.map((t) => [t.title, t.due])).toEqual([
      ["Draft chapter 3 (dust settling)", "2026-12-01"],
      ["Re-run the gas flow benchmark on the cluster", "2026-12-15"],
    ]);
    const smithMain = store.get("doi:10.5555/smith.a1")?.doc_ids[0] as string;
    expect(JSON.stringify(plans.plans[0]?.tasks[0])).toContain(smithMain);

    // ---- the final checklist ---------------------------------------------------------------------------- //
    const finalText = readFileSync(join(w.project, CHECKLIST), "utf8");
    expect(finalText).toContain(`- 最近更新：${FIXED_DATE}，Copilot`);
    expect(finalText).toContain("- 下一步：无");
    expect(finalText.split("\n").filter((l) => l.startsWith("## "))).toHaveLength(5);
    expect(finalText).not.toContain("## 下一步");
    expect(w.calls.some((x) => x.name === "bash" && /\bdate\b/.test(String(x.args.command)))).toBe(
      false
    );
    const done = parse(finalText);
    expect(done.state).toBe("已完成（用户宣布）");
    for (const kind of ["ADS libraries", "Zotero", "PDF 文件夹", "服务器", "稿件", "计划"])
      expect(done.sources.find((s) => s.kind === kind)?.status, kind).toMatch(/已带入|部分/);
    expect(done.sources.find((s) => s.kind === "PDF 文件夹")?.status).toBe("部分");
    expect(done.left.join("\n")).toContain(OVERLEAF_LINK);
    expect(done.left.join("\n")).toContain("sim-runs");
    expect(done.imported.length).toBeGreaterThanOrEqual(7);
    expect(done.pending.join("\n")).toContain("huge.pdf");
    expect(done.pending.join("\n")).toContain("trap.pdf");
    expect(done.pending.join("\n")).toMatch(/trap\.pdf.*参考文献里的 DOI.*文献库页面删除/);
    expect(done.pending.join("\n")).toContain("blank.pdf");
    expect(done.pending.join("\n")).toContain("ghost2022");

    // ---- what the agent did to the files ---------------------------------------------------------------- //
    // the originals: byte for byte and mtime for mtime, nothing added beside them
    expect(snapshotTree(fx.root)).toEqual(beforeFixture);
    expect(pathsUnder(fx.root)).toEqual(beforePaths);
    // the Project folder: the checklist and intake-inbox/ are all that is new outside the data folder
    const outside = pathsUnder(w.project).filter(
      (p) => p !== "literatures" && !p.startsWith("literatures/")
    );
    expect(outside).toEqual([
      CHECKLIST,
      "intake-inbox",
      "intake-inbox/lab-server",
      "intake-inbox/lab-server/cluster_run.pdf",
    ]);
    // every command was read-only on the originals; the only writes are the copy and the checklist
    const commands = w.calls.filter((x) => x.name === "bash").map((x) => String(x.args.command));
    const allowed = [
      /^ls '[^']+'$/,
      FIRST_PAGES,
      /^unzip -[lp] '[^']+'( '[^']+')?$/,
      /^mkdir -p '[^']*\/intake-inbox\/lab-server'$/,
      /^rsync -a '[^']+\/papers\/' '[^']*\/intake-inbox\/lab-server\/'$/,
    ];
    for (const command of commands)
      expect(
        allowed.some((re) => re.test(command)),
        command
      ).toBe(true);
    expect(commands.some((c) => /argelanderspace/.test(c))).toBe(false);
    // first pages: one command (one card) per PDF folder, the Downloads folder and the fetched copy, never one per file
    const loops = commands.filter((c) => FIRST_PAGES.test(c));
    expect(loops).toHaveLength(2);
    expect(commands.filter((c) => c.includes("pdftotext"))).toEqual(loops);
    // under "ask" every command and every write waited for the user: one card each, in order, and the user said yes
    const cards = [...turns1, r1, r2, r3, r4, r5, r6, r7, r8, r9].flatMap((t) => t.cards);
    expect(cards.filter((c) => c.action === "run_command").map((c) => c.detail)).toEqual(commands);
    expect(cards.every((c) => c.decision === "approve")).toBe(true);
    const writes = w.calls.filter((x) => x.name === "write" || x.name === "edit");
    expect(cards.filter((c) => c.action === "write_file" || c.action === "edit_file")).toHaveLength(
      writes.length
    );
    for (const c of cards.filter((c) => c.action === "write_file"))
      expect(c.detail).toBe(CHECKLIST);
    expect(writes.length).toBeGreaterThan(5);
    for (const x of writes) expect(x.args.path).toBe(CHECKLIST);

    // every migration import is a batch import, so nothing queued an arXiv PDF on its own (the setting was ON)
    const imports = w.calls.filter((x) => x.name === "library" && x.args.action === "import_works");
    for (const x of imports)
      if (x.args.mode !== "bib") expect(x.args.batch, JSON.stringify(x.args)).toBe(true);
    expect(w.arxivIngests).toEqual([]);

    // no credential anywhere in what the agent wrote or the conversation kept
    const everywhere = (dir: string): string[] =>
      readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => join(d.parentPath, d.name));
    for (const file of everywhere(w.project).filter((f) => !f.endsWith(".pdf"))) {
      expect(readFileSync(file, "utf8").includes(ADS_TOKEN), file).toBe(false);
    }
    expect(JSON.stringify(w.seen)).not.toContain(ADS_TOKEN);
    expect((await operationsOf(w, c1)).length).toBeGreaterThan(10);

    // the words the skill's tables and branches rest on really came back from the tools in this run
    const answered = JSON.stringify(w.seen);
    for (const word of [
      '\\"status\\":\\"rejected\\"', // a bib batch refused for a merge
      '\\"reason\\":\\"merge_refused\\"',
      '\\"reason\\":\\"batch_refused\\"',
      '\\"reason\\":\\"not_found\\"', // the stale ADS bibcode
      '\\"status\\":\\"noop\\"', // the byte-identical copy of a PDF already attached
      '\\"reason\\":\\"page_limit\\"',
      '\\"status\\":\\"exists\\"',
      '\\"status\\":\\"created\\"',
      "nextOffset",
    ])
      expect(answered, word).toContain(word);
  },
  240_000
);

// ---- an external agent's preparation, then the Copilot continues ----------------------------------------- //

test.skipIf(!HAVE_SHELL_TOOLS)(
  "preparation mode: an external agent only reads and writes the checklist and intake-inbox/; the Copilot then continues from it",
  async () => {
    w = await openWorld("ask");
    const beforeFixture = snapshotTree(fx.root);
    const dataBefore = pathsUnder(w.dataDir).filter(
      (p) => p !== "copilot" && !p.startsWith("copilot/")
    );
    const libraryBefore = pathsUnder(w.dataDir).includes("library/library.json")
      ? readFileSync(join(w.dataDir, "library", "library.json"), "utf8")
      : null;

    // the external agent: a shell and files (the scripted agent never calls library or plan)
    w.agent(preparationAgent(w.project));
    const prep = await newConversation(w);
    const p1 = await userTurn(
      w,
      prep,
      "帮我准备迁入：按 argelander-project-intake 的准备模式，不要改我的原文件"
    );
    const p2 = await userTurn(w, prep, survey());
    expect(p1.status).toBe("completed");
    expect(p2.status).toBe("completed");
    const prepCalls = w.calls.filter((x) => x.session === 1);
    expect(new Set(prepCalls.map((x) => x.name))).toEqual(new Set(["read", "bash", "write"]));
    const prepCommands = prepCalls
      .filter((x) => x.name === "bash")
      .map((x) => String(x.args.command));
    for (const command of prepCommands)
      expect(
        [
          /^ls '[^']+'$/,
          FIRST_PAGES,
          /^unzip -l '[^']+'$/,
          /^mkdir -p '[^']*\/intake-inbox\/lab-server'$/,
          /^rsync -a '[^']+' '[^']*\/intake-inbox\/lab-server\/'$/,
        ].some((re) => re.test(command)),
        command
      ).toBe(true);
    expect(prepCommands.some((c) => /argelanderspace/.test(c))).toBe(false);
    for (const x of prepCalls.filter((y) => y.name === "write"))
      expect(x.args.path).toBe(CHECKLIST);

    // nothing was written to the library; the only new files are the checklist and the copy
    expect(
      pathsUnder(w.dataDir).filter((p) => p !== "copilot" && !p.startsWith("copilot/"))
    ).toEqual(dataBefore);
    expect(
      pathsUnder(w.dataDir).includes("library/library.json")
        ? readFileSync(join(w.dataDir, "library", "library.json"), "utf8")
        : null
    ).toEqual(libraryBefore);
    expect(snapshotTree(fx.root)).toEqual(beforeFixture);
    expect(
      pathsUnder(w.project).filter((p) => p !== "literatures" && !p.startsWith("literatures/"))
    ).toEqual([
      CHECKLIST,
      "intake-inbox",
      "intake-inbox/lab-server",
      "intake-inbox/lab-server/cluster_run.pdf",
    ]);
    const prepared = parse(readFileSync(join(w.project, CHECKLIST), "utf8"));
    const preparedText = readFileSync(join(w.project, CHECKLIST), "utf8");
    expect(preparedText).toContain("外部 agent");
    // an external agent has no date line to count on: it says so instead of running a command
    expect(preparedText).toContain("- 最近更新：日期未知，外部 agent");
    expect(preparedText).toContain("- 下一步：在工作台让 Copilot 继续迁入");
    expect(preparedText.split("\n").filter((l) => l.startsWith("## "))).toHaveLength(5);
    expect(prepCommands.some((c) => /\bdate\b/.test(c))).toBe(false);
    const table = prepared.sources.find((s) => s.kind === "PDF 文件夹")?.sub ?? [];
    expect(table).toContain("2108.01234v2.pdf → 2108.01234");
    expect(table).toContain("scan_0042.pdf → 10.5555/ortiz.o5");
    expect(table).toContain("blank.pdf → 未识别");
    expect(prepared.sources.find((s) => s.kind === "计划")?.sub?.join("\n")).toContain(
      "Draft chapter 3"
    );

    // "open the workbench and let the Copilot continue": a new conversation reads what was prepared
    w.agent(intakeFromPrepared(w.project));
    const handoff = await newConversation(w);
    const h = await userTurn(w, handoff, ZH.resumeMessage);
    expect(h.status).toBe("completed");
    const handoffText =
      (await assistantTexts(handoff)).find((t) => t.includes("按准备好的清单")) ?? "";
    expect(handoffText).toMatch(/\| 待定 \| 5 \|\n挂上 PDF：5（其中同文件已存在 0）/);
    const store = LibraryStore.load(libraryPaths(w.dataDir));
    for (const id of [
      "arxiv:2108.01234",
      "doi:10.5555/ortiz.o5",
      "doi:10.5555/rossi.r1",
      "doi:10.5555/huge.h1",
      "doi:10.5555/lab.s1",
    ])
      expect(store.get(id), id).toBeDefined();
    expect(store.get("arxiv:2108.01234")?.doc_ids).toHaveLength(1);
    expect(store.get("doi:10.5555/lab.s1")?.doc_ids).toHaveLength(1);
    // the table's wrong entry (trap.pdf carries a cited paper's DOI) was caught by the title check, not attached; the
    // Work the import made is recorded for the user to delete
    expect(store.get("doi:10.5555/refd.r1")?.doc_ids ?? []).toHaveLength(0);
    expect(readFileSync(join(w.project, CHECKLIST), "utf8")).toMatch(/trap\.pdf.*文献库页面删除/);
    // the Copilot that continues puts its own date (from its system prompt) in place of 日期未知
    expect(readFileSync(join(w.project, CHECKLIST), "utf8")).toContain(
      `- 最近更新：${FIXED_DATE}，Copilot`
    );
    expect(snapshotTree(fx.root)).toEqual(beforeFixture);
  },
  240_000
);

// ---- file and command tools off ------------------------------------------------------------------------- //

test("file tools off: the intake skill and the file tools are not offered, and a local PDF is not attached", async () => {
  w = await openWorld("off");
  const result: Record<string, unknown> = {};
  w.agent(
    (function* () {
      yield* start();
      yield* say("(nothing to do without file tools)");
      result.attach = yield* tool("library", {
        action: "attach_local_pdf",
        refId: "doi:10.5555/smith.a1",
        path: join(fx.zoteroDir, "files", "101", "Smith 2020.pdf"),
      });
      yield* say("done");
    })()
  );
  const id = await newConversation(w);
  await userTurn(w, id, ZH.startMessage);
  const system = JSON.stringify(w.seen[0]?.messages.find((m) => m.role === "system"));
  expect(system).not.toContain("argelander-project-intake");
  const toolNames = getCurrentTools((w.seen[0] as TranscriptContext).messages).map((t) => t.name);
  expect(toolNames).toContain("library"); // the business tools are there
  for (const name of ["read", "bash", "write", "edit"]) expect(toolNames).not.toContain(name);
  await userTurn(w, id, "继续");
  expect(result.attach).toMatchObject({ ok: false, reason: "file_tools_off" });
  expect(LibraryStore.load(libraryPaths(w.dataDir)).works).toEqual([]);
  expect(pathsUnder(w.project).filter((p) => !p.startsWith("literatures"))).toEqual([]);
});

// ---- the entry's fixed messages carry the skill's trigger words ------------------------------------------ //

test("the entry's fixed messages (zh-CN and en) contain what the skill's description triggers on", () => {
  const skill = readFileSync(
    new URL("../../../skills/argelander-project-intake/SKILL.md", import.meta.url),
    "utf8"
  );
  const description = /^description: (.*)$/m.exec(skill)?.[1] ?? "";
  const EN = locale("en").copilot.intake;
  expect(description).toContain("import my existing project");
  expect(description).toContain("continue the intake");
  expect(description).toContain("迁入已有项目");
  expect(EN.startMessage.toLowerCase()).toContain("import my existing project");
  expect(EN.resumeMessage.toLowerCase()).toContain("the intake");
  expect(ZH.startMessage).toContain("迁入已有项目");
  expect(ZH.resumeMessage).toContain("迁入已有项目");
});

// ---- a .bib longer than one read window ----------------------------------------------------------------- //

test("a .bib longer than one read window comes in whole, in batches cut at entry boundaries", async () => {
  w = await openWorld("ask");
  const entries = Array.from({ length: 260 }, (_, i) => {
    const n = String(i).padStart(3, "0");
    return [
      `@article{long${n},`,
      `  title = {Synthetic study number ${n}},`,
      `  author = {Writer, Una and Other${n}, Otto},`,
      "  journal = mnras,",
      "  year = {2020},",
      `  doi = {10.7777/long.${n}},`,
      `  abstract = {Line one of the abstract of ${n}.`,
      "    Line two.},",
      "}",
      "",
    ].join("\n");
  });
  const big = join(fixtureRoot, "big.bib");
  writeFileSync(big, `@string{mnras = "MNRAS"}\n\n${entries.join("\n")}`);
  expect(readFileSync(big, "utf8").split("\n").length).toBeGreaterThan(2600); // more than one 2000-line window
  let outcome: { batches: number; keys: string[] } | undefined;
  w.agent(
    (function* () {
      yield* start();
      outcome = yield* importLongBib(big);
      yield* say("done");
    })()
  );
  const id = await newConversation(w);
  const t = await userTurn(w, id, "导入 big.bib");
  expect(t.status).toBe("completed");
  expect(outcome?.batches).toBeGreaterThanOrEqual(2);
  const store = LibraryStore.load(libraryPaths(w.dataDir));
  expect(store.works).toHaveLength(260);
  expect(new Set(outcome?.keys).size).toBe(260);
  expect(store.works.every((x) => x.title.startsWith("Synthetic study number"))).toBe(true);
}, 240_000);

// ---- an ADS library larger than one window ---------------------------------------------------------------- //

test("an ADS library of 230 entries is read in windows of 200 and the count matches", async () => {
  const codes = Array.from(
    { length: 230 },
    (_, i) => `2021MNRAS.${String(i + 1).padStart(4, "0")}....B`
  );
  w = await openWorld("ask", [{ id: "lib_big-3", name: "Big", bibcodes: [], extra: codes }]);
  const held = new Set<string>();
  const windows: [number, number][] = [];
  w.agent(
    (function* () {
      yield* start();
      let offset = 0;
      for (;;) {
        const win = yield* tool("library", {
          action: "read_ads_library",
          libraryId: "lib_big-3",
          offset,
          limit: 200,
        });
        windows.push([win.offset, win.bibcodes.length]);
        for (const b of win.bibcodes) held.add(b);
        if (win.nextOffset == null) break;
        offset = win.nextOffset;
      }
      yield* say("done");
    })()
  );
  const id = await newConversation(w);
  expect((await userTurn(w, id, "读 Big")).status).toBe("completed");
  expect(windows).toEqual([
    [0, 200],
    [200, 30],
  ]);
  expect(held.size).toBe(230);
  // reading is read-only: the library holds nothing, and every request was a GET
  expect(w.ads.requests.every((r) => r.method === "GET")).toBe(true);
  expect(LibraryStore.load(libraryPaths(w.dataDir)).works).toEqual([]);
});
