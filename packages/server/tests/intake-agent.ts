/**
 * The scripted model of the project-intake acceptance (ticket 08): it follows `skills/argelander-project-intake/SKILL.md`
 * step by step, the way the skill tells a model to, and decides from what the real tools return. Two agents: the intake
 * (a Copilot session; `intakeFirstSession` / `intakeResumedSession`) and an external agent in preparation mode
 * (`preparationAgent`, which has no business tools).
 *
 * The two intake sessions share NOTHING but the checklist file and the user's messages: the second session learns where
 * everything is by reading `argelanderspace-intake.md`, as a model in a new conversation would.
 *
 * Where a model would be free to err, this one is not always careful on purpose, so the skill's guards are exercised:
 * it takes the last DOI on a page (a cited paper's, on `trap.pdf`) and relies on the title comparison to notice.
 */
import { basename, dirname, join, resolve } from "node:path";
import { call, type Feed, type Gen, type Json, say, tool } from "./intake-harness.js";

export const CHECKLIST = "argelanderspace-intake.md";
const TODAY = new Date().toISOString().slice(0, 10);

// ---- the checklist, rendered and parsed ---------------------------------------------------------------- //

export interface Source {
  kind: string;
  detail: string;
  status: string;
  /** indented lines under the source's line (preparation mode writes its findings there) */
  sub?: string[];
}
export interface Checklist {
  state: string;
  agent: string;
  sources: Source[];
  imported: string[];
  pending: string[];
  left: string[];
}

export function render(c: Checklist): string {
  const lines = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "");
  return [
    "# 迁入清单 / Intake checklist",
    "",
    "## 状态",
    `- 状态：${c.state}`,
    `- 最近更新：${TODAY}，${c.agent}`,
    "",
    "## 来源",
    ...c.sources.flatMap((s) => [
      `- ${s.kind}：${s.detail} — ${s.status}`,
      ...(s.sub ?? []).map((l) => `  ${l}`),
    ]),
    "",
    "## 已带入",
    lines(c.imported),
    "",
    "## 待定与跳过",
    lines(c.pending),
    "",
    "## 留在原处的材料",
    lines(c.left),
    "",
  ].join("\n");
}

/** Reads the file back: the five headings, the status lines, the source lines (`kind：detail — status`). */
export function parse(text: string): Checklist {
  const sections = new Map<string, string[]>();
  let at = "";
  for (const line of text.split("\n")) {
    const h = /^## (.+)$/.exec(line);
    if (h) {
      at = (h[1] as string).trim();
      sections.set(at, []);
    } else if (at && line.startsWith("- ")) sections.get(at)?.push(line.slice(2));
    else if (at && /^\s+\S/.test(line)) {
      const list = sections.get(at) ?? [];
      if (list.length) list[list.length - 1] += `\n${line.trim()}`;
    }
  }
  const status = (sections.get("状态") ?? []).find((l) => l.startsWith("状态："));
  return {
    state: status ? status.slice(3) : "进行中",
    agent: "Copilot",
    sources: (sections.get("来源") ?? []).map((l) => {
      const [head = "", ...sub] = l.split("\n");
      const m = /^([^：]+)：(.*) — ([^—]+)$/.exec(head);
      return {
        kind: (m?.[1] ?? head).trim(),
        detail: (m?.[2] ?? "").trim(),
        status: (m?.[3] ?? "").trim(),
        ...(sub.length ? { sub } : {}),
      };
    }),
    imported: sections.get("已带入") ?? [],
    pending: sections.get("待定与跳过") ?? [],
    left: sections.get("留在原处的材料") ?? [],
  };
}

// ---- the summary table --------------------------------------------------------------------------------- //

export interface Counts {
  created: number;
  merged: number;
  refused: number;
  failed: number;
  pending: number;
}
export const zero = (): Counts => ({ created: 0, merged: 0, refused: 0, failed: 0, pending: 0 });
export const table = (c: Counts) =>
  [
    "| 结果 | 数量 |",
    "|---|---|",
    `| 新建 | ${c.created} |`,
    `| 并入已有 | ${c.merged} |`,
    `| 被拒 | ${c.refused} |`,
    `| 失败 | ${c.failed} |`,
    `| 待定 | ${c.pending} |`,
  ].join("\n");

/** SKILL.md "Summary tables", the bibcode batch (`entries`). */
function countEntries(entries: Json[]): Counts {
  const c = zero();
  for (const e of entries) {
    if (e.status === "created") c.created++;
    else if (e.status === "exists" && !e.reason) c.merged++;
    else if (e.reason === "merge_refused") c.refused++;
    else if (e.reason === "ads_unavailable") c.pending++;
    else if (
      e.status === "error" &&
      e.reason !== "repeated" &&
      e.reason !== "same_paper_as_earlier"
    )
      c.failed++;
  }
  return c;
}
/** SKILL.md "Summary tables", a bib import (`results`). */
function countResults(results: Json[]): Counts {
  const c = zero();
  for (const r of results) {
    if (r.status === "created") c.created++;
    else if (r.status === "exists") c.merged++;
    else if (r.reason === "merge_refused") c.refused++;
    else if (r.reason === "batch_refused") continue;
    else if (r.status === "error") c.failed++;
  }
  return c;
}

// ---- BibTeX, only as far as the skill needs it ---------------------------------------------------------- //

export interface BibEntry {
  key: string;
  text: string;
  field(name: string): string | undefined;
}
export function splitBib(text: string): { preamble: string[]; entries: BibEntry[] } {
  const blocks = text.split(/\n(?=@)/).map((b) => b.trim());
  const preamble: string[] = [];
  const entries: BibEntry[] = [];
  for (const block of blocks) {
    if (/^@(string|preamble)\b/i.test(block)) preamble.push(block);
    else {
      const key = /^@\w+\{([^,\s]+),/.exec(block)?.[1];
      if (!key) continue;
      entries.push({
        key,
        text: block,
        field: (name) =>
          new RegExp(`^\\s*${name}\\s*=\\s*\\{(.*)\\}\\s*,?\\s*$`, "im").exec(block)?.[1]?.trim(),
      });
    }
  }
  return { preamble, entries };
}

/** Zotero's `file` field: `description:path:mime`, several separated by `;`; the PDF paths against the export folder. */
export function zoteroPdfs(field: string, exportDir: string): string[] {
  return field
    .split(";")
    .map((part) => part.split(":"))
    .filter((p) => p.length >= 3 && (p.at(-1) === "application/pdf" || /\.pdf$/i.test(p[1] ?? "")))
    .map((p) => resolve(exportDir, p.slice(1, -1).join(":")));
}

// ---- small shared steps -------------------------------------------------------------------------------- //

/** The first `yield` of a session: the first user message (and the system prompt) come back. */
export function* start(): Gen<Feed> {
  return (yield { say: "(waiting for the user)" }) as Feed;
}

function* readChecklist(): Gen<string | null> {
  const text = yield* call("read", { path: CHECKLIST });
  return /ENOENT|no such file/i.test(text) ? null : text;
}
function* save(c: Checklist): Gen<void> {
  const out = yield* call("write", { path: CHECKLIST, content: render(c) });
  if (!/\b(wrote|written|Successfully)/i.test(out))
    throw new Error(`checklist not written: ${out.slice(0, 200)}`);
}

/** The skill is read first, from the location the session's skill list gives. */
function* loadSkill(system: string): Gen<void> {
  const location = /<location>([^<]*argelander-project-intake[^<]*)<\/location>/.exec(system)?.[1];
  if (!location) throw new Error("the intake skill is not in the session's skill list");
  const text = yield* call("read", { path: location });
  if (!text.includes("# argelander-project-intake"))
    throw new Error("the skill read is not the intake skill");
}

const pathsIn = (s: string) => [...s.matchAll(/(\/[^\s;；,，)）]+)/g)].map((m) => m[1] as string);
const find = (c: Checklist, kind: string) => c.sources.find((s) => s.kind.startsWith(kind));

function note(c: Checklist, batch: string, counts: Counts, extra = "") {
  c.imported.push(
    `${TODAY} ${batch}：新建 ${counts.created}，并入 ${counts.merged}，被拒 ${counts.refused}，失败 ${counts.failed}，待定 ${counts.pending}${extra}`
  );
}

/** Looks the Work of an imported entry up: by the key in the results, else by what the skill says (read by DOI / id / title). */
function* workOf(
  entry: { key: string; doi?: string; eprint?: string; title: string },
  results: Json[]
): Gen<string | null> {
  const hit = results.find(
    (r) => r.key === entry.key && r.ref && (r.status === "created" || r.status === "exists")
  );
  const byKey = hit?.ref?.title === entry.title ? hit.ref.id : null;
  if (byKey) return byKey as string;
  const query = entry.doi ?? entry.eprint ?? entry.title;
  const found = yield* tool("library", { action: "read", query });
  const ref = (found.refs ?? []).find((r: Json) => r.title === entry.title);
  return ref ? (ref.id as string) : null;
}

// ======================================================================================================== //
// Session 1: from the entry's fixed message to "enough for today"
// ======================================================================================================== //

export function* intakeFirstSession(): Gen<void> {
  const first = yield* start();
  yield* loadSkill(first.system);
  const checklist = yield* readChecklist();
  if (checklist !== null) throw new Error("a fresh Project must not have a checklist");

  // 2. the Project folder
  const folderReply = yield* say(
    "先确认 Project 文件夹：当前打开的这个文件夹是你的主研究文件夹吗？材料分散在几处，我建议就用这个新建的空文件夹做 Project。文件夹由你在页面里切换，我不切换。"
  );
  if (!/新建|空/.test(folderReply)) throw new Error(`unexpected reply: ${folderReply}`);

  // 3. survey
  const c: Checklist = {
    state: "进行中",
    agent: "Copilot",
    sources: [],
    imported: [],
    pending: [],
    left: [],
  };
  const surveyReply = yield* say(
    "一次问清你有哪些材料：ADS libraries、Zotero、.bib、PDF 文件夹、服务器、稿件（本机 / Overleaf / 别处）、计划或 TODO、其他（代码、数据、结果，只登记）。"
  );
  const answers = new Map<string, string>();
  for (const line of surveyReply.split("\n")) {
    const m = /^([^:：]+)[:：]\s*(.*)$/.exec(line);
    if (m) answers.set((m[1] as string).trim(), (m[2] as string).trim());
  }
  const kinds = ["ADS libraries", "Zotero", ".bib", "PDF 文件夹", "服务器", "稿件", "计划", "其他"];
  for (const kind of kinds) {
    const detail = answers.get(kind) ?? "无";
    c.sources.push({
      kind,
      detail,
      status: kind === "其他" ? "只登记" : detail === "无" ? "跳过" : "未开始",
    });
  }
  // what stays where it is: registered up front, nothing is copied
  for (const kind of ["服务器", "稿件", "其他"]) {
    const d = answers.get(kind);
    if (d) c.left.push(`${kind}：${d}`);
  }
  yield* save(c);

  // 4. ADS libraries
  const libs = yield* tool("library", { action: "list_ads_libraries" });
  const chosen = yield* say(
    `你的 ADS libraries：${(libs.libraries as Json[]).map((l) => `${l.name}（${l.numDocuments} 条）`).join("、")}。要带入哪几个？我建议都要。`
  );
  const tables: string[] = [];
  const open: string[] = [];
  for (const lib of libs.libraries as Json[]) {
    if (!chosen.includes(lib.name) && !/两个都要|都要/.test(chosen)) continue;
    // read the whole library, 200 per window, until the count matches
    const held = new Set<string>();
    let offset = 0;
    let total = 0;
    for (;;) {
      const win = yield* tool("library", {
        action: "read_ads_library",
        libraryId: lib.id,
        offset,
        limit: 200,
      });
      if (!win.ok) throw new Error(`read_ads_library: ${JSON.stringify(win)}`);
      for (const b of win.bibcodes) held.add(b);
      total = win.total;
      if (win.nextOffset === undefined || win.nextOffset === null) break;
      offset = win.nextOffset;
    }
    if (held.size !== total)
      throw new Error(`library ${lib.name}: ${held.size} read, ${total} said`);
    const entries: Json[] = [];
    const codes = [...held];
    for (let i = 0; i < codes.length; i += 200) {
      const r = yield* tool("library", {
        action: "import_works",
        mode: "bibcode",
        text: codes.slice(i, i + 200).join(" "),
        batch: true,
      });
      entries.push(...(r.entries ?? []));
    }
    const counts = countEntries(entries);
    tables.push(`${lib.name}\n${table(counts)}`);
    for (const e of entries) {
      if (e.reason === "merge_refused") {
        // read the Works involved before telling the user what they are
        const named: string[] = [];
        for (const id of e.works as string[]) {
          const w = yield* tool("library", { action: "read", refId: id });
          named.push(`${id}《${w.ref?.title}》`);
        }
        open.push(
          `被拒：${e.bibcode} 会合并 ${named.join(" 与 ")}，请你在页面里合并，或先放待定。`
        );
        c.pending.push(
          `ADS ${lib.name} ${e.bibcode}：会合并 Work（${(e.works as string[]).join("、")}）被拒`
        );
      } else if (e.status === "error") {
        open.push(`失败：${e.bibcode}（${e.reason}）。`);
        c.pending.push(`ADS ${lib.name} ${e.bibcode}：${e.reason}`);
      }
    }
    note(c, `ADS ${lib.name}`, counts);
  }
  const adsLine = find(c, "ADS libraries");
  if (adsLine) adsLine.status = "已带入";
  yield* save(c);
  const settle = yield* say(`${tables.join("\n\n")}\n\n${open.join("\n")}\n这些怎么处理？`);
  if (!/过期|跳过/.test(settle)) throw new Error(`unexpected reply: ${settle}`);

  // Zotero
  const zline = find(c, "Zotero");
  const bibPath = pathsIn(zline?.detail ?? "").find((p) => p.endsWith(".bib"));
  if (!bibPath) throw new Error("no Zotero .bib path in the survey");
  const exportDir = dirname(bibPath);
  const bibText = yield* call("read", { path: bibPath });
  const { preamble, entries: all } = splitBib(bibText);
  let batch = [...all];
  const removed: { key: string; works: string[] }[] = [];
  let results: Json[] = [];
  for (;;) {
    const r = yield* tool("library", {
      action: "import_works",
      mode: "bib",
      text: [...preamble, ...batch.map((e) => e.text)].join("\n\n"),
    });
    results = r.results ?? [];
    if (r.status !== "rejected") break;
    const bad = results.filter((x) => x.reason === "merge_refused").map((x) => x.key as string);
    if (bad.length === 0) throw new Error("rejected without a merge_refused entry");
    for (const x of results.filter((y) => y.reason === "merge_refused"))
      removed.push({ key: x.key, works: x.works });
    batch = batch.filter((e) => !bad.includes(e.key));
  }
  const zCounts = countResults(results);
  zCounts.refused = removed.length;
  // attach the PDFs named by the `file` fields; entries without one wait for the PDF folder
  const waiting: string[] = [];
  let attached = 0;
  for (const e of batch) {
    const field = e.field("file");
    if (!field) {
      waiting.push(e.key);
      continue;
    }
    const id = yield* workOf(
      { key: e.key, doi: e.field("doi"), eprint: e.field("eprint"), title: e.field("title") ?? "" },
      results
    );
    if (!id) throw new Error(`no Work found for ${e.key}`);
    for (const pdf of zoteroPdfs(field, exportDir)) {
      const a = yield* tool("library", { action: "attach_local_pdf", refId: id, path: pdf });
      if (!(a.ok && (a.status === "ok" || a.status === "noop")))
        throw new Error(`attach ${pdf}: ${JSON.stringify(a)}`);
      attached++;
    }
  }
  zCounts.pending = waiting.length;
  const refusedLines: string[] = [];
  for (const x of removed) {
    const named: string[] = [];
    for (const id of x.works) {
      const w = yield* tool("library", { action: "read", refId: id });
      named.push(`${id}《${w.ref?.title}》`);
    }
    refusedLines.push(`被拒：${x.key} 会合并 ${named.join(" 与 ")}。`);
    c.pending.push(`Zotero ${x.key}：会合并 Work（${x.works.join("、")}）被拒`);
  }
  for (const key of waiting) c.pending.push(`Zotero ${key}：没有 file 字段，到 PDF 文件夹里找`);
  note(c, "Zotero", zCounts, `，挂 PDF ${attached}`);
  if (zline) zline.status = "部分";
  yield* save(c);
  const stop = yield* say(
    `Zotero 这一批：\n${table(zCounts)}\n\n${refusedLines.join("\n")}\n${waiting.join("、")} 没有 file 字段，我会在 PDF 文件夹里按 DOI 找。接着做 PDF 文件夹吗？`
  );
  if (!/先到这|今天/.test(stop)) throw new Error(`unexpected reply: ${stop}`);
  yield* say("好，进度已记在迁入清单里。下次说「继续迁入」，我读清单接着做。");
}

/** The skill's one command per PDF folder: every first page, each after its `=== <path>` line (one confirmation card). */
function* firstPages(folder: string): Gen<Map<string, string>> {
  const out = yield* call("bash", {
    command: `for f in '${folder}'/*.[pP][dD][fF]; do printf '=== %s\\n' "$f"; pdftotext -l 1 "$f" - | head -c 2000; done`,
  });
  const pages = new Map<string, string>();
  const parts = out.split(/(?:^|\f)=== (.*)$/m);
  for (let i = 1; i < parts.length; i += 2)
    pages.set(parts[i] as string, (parts[i + 1] ?? "").replace(/^\n/, ""));
  return pages;
}

// ======================================================================================================== //
// Session 2: "continue the intake" - everything it knows it reads from the checklist
// ======================================================================================================== //

export function* intakeResumedSession(project: string): Gen<void> {
  const first = yield* start();
  yield* loadSkill(first.system);
  const text = yield* readChecklist();
  if (text === null) throw new Error("no checklist to continue from");
  const c = parse(text);
  const todo = c.sources
    .filter((s) => s.status === "未开始" || s.status === "部分")
    .map((s) => s.kind);
  if (!todo.includes("PDF 文件夹"))
    throw new Error(`the checklist does not say the PDF folder is next: ${todo}`);

  // PDF folder
  const folder = pathsIn(find(c, "PDF 文件夹")?.detail ?? "")[0] as string;
  const listing = yield* call("bash", { command: `ls '${folder}'` });
  const files = listing.split("\n").filter((f) => /\.pdf$/i.test(f));
  const counts = zero();
  const candidates: { file: string; why: string }[] = [];
  const overLimit: string[] = [];
  const attachedWorks: string[] = [];
  const pages = yield* firstPages(folder);
  const extra: string[] = [];
  for (const file of files) {
    const path = join(folder, file);
    const page = pages.get(path) ?? "";
    const title = page.split("\n")[0]?.trim() ?? "";
    // an arXiv id in the file name first, then a DOI on the first page (the LAST one on the page: not careful on purpose)
    const arxiv = /^(\d{4}\.\d{4,5})(v\d+)?\.pdf$/i.exec(file)?.[1];
    const dois = [...page.matchAll(/10\.\d{4,9}\/[^\s,;)]+/g)].map((m) => m[0]);
    const text1 = arxiv ? `arXiv:${arxiv}` : dois.at(-1);
    if (!text1) {
      candidates.push({
        file,
        why: title ? `没有 DOI / arXiv，标题猜测「${title}」` : "没有文字层，识别不出",
      });
      continue;
    }
    const imp = yield* tool("library", {
      action: "import_works",
      mode: "identifier",
      text: text1,
      batch: true,
    });
    const ref = imp.results?.[0]?.ref;
    if (imp.status === "rejected" || imp.results?.[0]?.status === "error" || !ref) {
      counts.pending++;
      c.pending.push(`PDF ${file}：导入失败 ${JSON.stringify(imp).slice(0, 120)}`);
      continue;
    }
    if (ref.title !== title) {
      // the id was probably a cited paper's: unidentified, the closest Work is the candidate. The import already made
      // that Work (created): it is counted as new, named after the table and recorded in 待定
      candidates.push({ file, why: `取到的 id 对应《${ref.title}》，与 PDF 标题「${title}」不符` });
      if (imp.results[0].status === "created") {
        counts.created++;
        extra.push(
          `《${ref.title}》（来自 ${file}）可能是参考文献里的 DOI，不需要就在文献库页面删除`
        );
        c.pending.push(
          `PDF ${file}：取到的《${ref.title}》可能是参考文献里的 DOI，已建 Work，不需要就在文献库页面删除`
        );
      }
      continue;
    }
    if (imp.results[0].status === "created") counts.created++;
    else counts.merged++;
    const a = yield* tool("library", { action: "attach_local_pdf", refId: ref.id, path });
    if (a.ok && (a.status === "ok" || a.status === "noop")) attachedWorks.push(ref.id);
    else if (a.reason === "too_large" || a.reason === "page_limit") {
      overLimit.push(file);
      counts.pending++;
      c.pending.push(`PDF ${file}：超出上传上限（${a.reason}），Work 已建，PDF 未挂`);
    } else throw new Error(`attach ${file}: ${JSON.stringify(a)}`);
  }
  counts.pending += candidates.length;
  if (attachedWorks.includes("doi:10.5555/rossi.r1"))
    c.pending = c.pending.filter((p) => !p.startsWith("Zotero rossi2022"));
  for (const cand of candidates) c.pending.push(`PDF ${cand.file}：${cand.why}`);
  note(c, `PDF 文件夹 ${basename(folder)}`, counts, `，挂 PDF ${attachedWorks.length}`);
  const pdfLine = find(c, "PDF 文件夹");
  if (pdfLine) pdfLine.status = "部分";
  yield* save(c);
  const userReply = yield* say(
    `PDF 文件夹共 ${files.length} 个 PDF：\n${table(counts)}\n\n${extra.join("\n")}\n超限：${overLimit.join("、")}（只登记）。\n需要你确认的候选：\n${candidates.map((x) => `- ${x.file}：${x.why}`).join("\n")}\n识别不了的请给我标题、作者、年份和出处，或者先放待定。`
  );

  // the user confirmed one of them with title, authors, year and venue: a BibTeX entry, then the PDF
  const counts2 = zero();
  const scan = candidates.find((x) => x.file === "notes_scan.pdf");
  const m =
    /标题[:：]\s*([^，,;；\n]+)[，,;；]\s*作者[:：]\s*([^;；\n]+)[;；]\s*年份[:：]\s*(\d{4})[，,;；]\s*出处[:：]\s*([^\n。]+)/.exec(
      userReply
    );
  if (scan && m) {
    const [, title, authors, year, venue] = m as unknown as string[];
    const entry = `@inproceedings{kowalski${year},\n  title = {${title}},\n  author = {${authors?.replace(/\s*,\s*/g, " and ")}},\n  booktitle = {${venue}},\n  year = {${year}}\n}`;
    const r = yield* tool("library", { action: "import_works", mode: "bib", text: entry });
    const created = r.results?.[0];
    if (created?.status !== "created") throw new Error(`manual entry: ${JSON.stringify(r)}`);
    const a = yield* tool("library", {
      action: "attach_local_pdf",
      refId: created.ref.id,
      path: join(folder, scan.file),
    });
    if (!a.ok) throw new Error(`attach ${scan.file}: ${JSON.stringify(a)}`);
    counts2.created++;
    // it is no longer pending
    const at = c.pending.findIndex((p) => p.startsWith(`PDF ${scan.file}`));
    if (at >= 0) c.pending.splice(at, 1);
  }
  counts2.pending = candidates.filter((x) => x !== scan).length + overLimit.length;
  note(c, "PDF 文件夹（用户确认后补）", counts2);
  yield* save(c);

  // servers: only what is to be imported, copied once the user has agreed to the command (the confirmation card)
  const serverLine = find(c, "服务器");
  // offline: the "server" is a local folder named after 本机路径模拟 (a real run would be scp / rsync over ssh)
  const serverCopy = /本机路径模拟\s*(\S+)/.exec(serverLine?.detail ?? "")?.[1] as string;
  const inbox = join(project, "intake-inbox", "lab-server");
  yield* call("bash", { command: `mkdir -p '${inbox}'` });
  const out = yield* call("bash", { command: `rsync -a '${serverCopy}/' '${inbox}/'` });
  if (/error|rsync:/i.test(out)) throw new Error(`rsync: ${out}`);
  const copies = (yield* call("bash", { command: `ls '${inbox}'` }))
    .split("\n")
    .filter((f) => f.endsWith(".pdf"));
  const sCounts = zero();
  const copyPages = yield* firstPages(inbox);
  for (const file of copies) {
    const path = join(inbox, file);
    const page = copyPages.get(path) ?? "";
    const doi = /10\.\d{4,9}\/[^\s,;)]+/.exec(page)?.[0];
    const title = page.split("\n")[0]?.trim();
    const imp = yield* tool("library", {
      action: "import_works",
      mode: "identifier",
      text: doi ?? "",
      batch: true,
    });
    const ref = imp.results?.[0]?.ref;
    if (!ref || ref.title !== title)
      throw new Error(`server copy ${file}: ${JSON.stringify(imp).slice(0, 200)}`);
    sCounts.created += imp.results[0].status === "created" ? 1 : 0;
    sCounts.merged += imp.results[0].status === "exists" ? 1 : 0;
    const a = yield* tool("library", { action: "attach_local_pdf", refId: ref.id, path });
    if (!a.ok) throw new Error(`attach ${file}: ${JSON.stringify(a)}`);
  }
  if (serverLine) {
    serverLine.status = "已带入";
    serverLine.detail = `${serverLine.detail}；副本在 intake-inbox/lab-server/`;
  }
  note(c, "服务器 papers", sCounts);
  yield* save(c);

  // manuscript: Overleaf. The zip is read in place.
  const msLine = find(c, "稿件");
  const zip = pathsIn(msLine?.detail ?? "").find((p) => p.endsWith(".zip")) as string;
  const names = (yield* call("bash", { command: `unzip -l '${zip}'` })).split("\n");
  const texFiles = names.map((l) => /\s(\S+\.tex)$/.exec(l)?.[1]).filter(Boolean) as string[];
  const bibFiles = names.map((l) => /\s(\S+\.bib)$/.exec(l)?.[1]).filter(Boolean) as string[];
  const cited = new Set<string>();
  for (const tex of texFiles) {
    const src = yield* call("bash", { command: `unzip -p '${zip}' '${tex}'` });
    for (const g of src.matchAll(/\\cite[a-z]*\*?(?:\[[^\]]*\])*\{([^}]*)\}/g))
      for (const k of (g[1] as string).split(",")) cited.add(k.trim());
  }
  const oCounts = zero();
  const keysSeen = new Set<string>();
  for (const bib of bibFiles) {
    const src = yield* call("bash", { command: `unzip -p '${zip}' '${bib}'` });
    const { preamble, entries } = splitBib(src);
    const r = yield* tool("library", {
      action: "import_works",
      mode: "bib",
      text: [...preamble, ...entries.map((e) => e.text)].join("\n\n"),
    });
    const res: Json[] = r.results ?? [];
    const cc = countResults(res);
    oCounts.created += cc.created;
    oCounts.merged += cc.merged;
    oCounts.failed += cc.failed;
    // an entry counts as in the library by the import result's status, not by the key it echoes; when no result
    // carries the entry's key, the Work is looked up (never matched by position)
    for (const e of entries) {
      const hit = res.find((x) => x.key === e.key);
      if (hit) {
        if (hit.status === "created" || hit.status === "exists") keysSeen.add(e.key);
        continue;
      }
      const id = yield* workOf(
        {
          key: e.key,
          doi: e.field("doi"),
          eprint: e.field("eprint"),
          title: e.field("title") ?? "",
        },
        res
      );
      if (id) keysSeen.add(e.key);
    }
  }
  const missing = [...cited].filter((k) => !keysSeen.has(k));
  note(c, "稿件 Overleaf zip", oCounts, `，引用了但库里没有：${missing.join("、") || "无"}`);
  if (msLine) msLine.status = "已带入";
  if (missing.length) c.pending.push(`稿件 Overleaf：引用了但库里没有 ${missing.join("、")}`);
  yield* save(c);

  // 5. arXiv full text, asked once
  const all = yield* tool("library", { action: "read", limit: 200 });
  const arxivOf = (r: Json): string | undefined =>
    (r.arxiv_id as string | undefined) ?? (r.id.startsWith("arxiv:") ? r.id.slice(6) : undefined);
  const noPdf = (all.refs as Json[]).filter((r) => !r.pdf && arxivOf(r));
  const arxivReply = yield* say(
    `用户确认后补的一批：\n${table(counts2)}\n\n服务器 papers：\n${table(sCounts)}\n\nOverleaf zip：\n${table(oCounts)}\n\n稿件里引用了但 .bib 里没有的：${missing.join("、") || "无"}。\n\n所有来源处理完了。最后问一次：哪些要取 arXiv 正文？我建议取有 arXiv id 又没有本地 PDF 的：${noPdf.map((r) => `${arxivOf(r)}《${r.title}》`).join("；")}。`
  );
  const wanted = noPdf.filter(
    (r) => arxivReply.includes(arxivOf(r) as string) || /都取|全部/.test(arxivReply)
  );
  let fetched = 0;
  for (const r of wanted) {
    let a = yield* tool("library", { action: "acquire_arxiv_pdf", refId: r.id });
    for (let tries = 0; a.status === "pending" && tries < 20; tries++) {
      yield* tool("library", { action: "read_jobs", refId: r.id });
      a = yield* tool("library", { action: "acquire_arxiv_pdf", refId: r.id });
    }
    if (!a.ok) throw new Error(`acquire ${r.id}: ${JSON.stringify(a)}`);
    fetched++;
  }
  c.imported.push(`${TODAY} arXiv 正文：取 ${fetched}`);
  yield* save(c);

  // 6. plans: read the notes, draft, ask for the missing deadline
  const planLine = find(c, "计划");
  const notes = yield* call("read", { path: pathsIn(planLine?.detail ?? "")[0] as string });
  const planName = /^Thesis: submit by (\d{4}-\d{2}-\d{2})/m.exec(notes);
  const tasks = notes
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => ({
      title: l
        .slice(2)
        .replace(/ by \d{4}-\d{2}-\d{2}.*$/, "")
        .replace(/ \(no date yet\).*$/, ""),
      due: /by (\d{4}-\d{2}-\d{2})/.exec(l)?.[1],
    }));
  const dateReply = yield* say(
    `计划草案：Plan「Thesis」（${planName?.[1]}）；\n${tasks.map((t) => `- ${t.title}${t.due ? `（${t.due}）` : "（没有期限）"}`).join("\n")}\n每个 Task 都要有期限，「${tasks.find((t) => !t.due)?.title}」的期限是？确认后我写入。`
  );
  const given = /(\d{4}-\d{2}-\d{2})/.exec(dateReply)?.[1];
  for (const t of tasks) t.due ??= given;
  let plan = yield* tool("plan", { action: "read" });
  let rev = plan.rev as number;
  const made = yield* tool("plan", {
    action: "create_plan",
    expectedRev: rev,
    name: "Thesis",
    due: planName?.[1],
  });
  rev = made.rev;
  const planId = made.object.id as string;
  for (const t of tasks) {
    const mk = yield* tool("plan", {
      action: "create_task",
      expectedRev: rev,
      planId,
      title: t.title,
      due: t.due,
    });
    rev = mk.rev;
    if (/dust settling/i.test(t.title)) {
      // the Task belongs to Smith 2020: link its main Doc (first of doc_ids)
      const work = yield* tool("library", { action: "read", refId: "doi:10.5555/smith.a1" });
      const docId = work.ref?.doc_ids?.[0];
      if (!docId) throw new Error("Smith 2020 has no Doc to link");
      const link = yield* tool("plan", {
        action: "add_task_link",
        expectedRev: rev,
        planId,
        taskId: mk.object.id,
        docId,
      });
      rev = link.rev;
    }
  }
  plan = yield* tool("plan", { action: "read" });
  c.imported.push(`${TODAY} 计划：Plan 1，Task ${tasks.length}`);
  if (planLine) planLine.status = "已带入";
  yield* save(c);

  // 7. wrap up
  const done = yield* say(
    "计划已写入。留在原处的材料（代码、服务器结果、稿件的 Overleaf 链接）已登记在清单里。要宣布迁入完成吗？"
  );
  if (/完成/.test(done)) {
    c.state = "已完成（用户宣布）";
    yield* save(c);
  }
  yield* say("迁入清单已更新。");
}

// ======================================================================================================== //
// An external agent in preparation mode: a shell and files, no business tools
// ======================================================================================================== //

export function* preparationAgent(project: string): Gen<void> {
  const first = yield* start();
  yield* loadSkill(first.system);
  const existing = yield* readChecklist();
  if (existing !== null) throw new Error("a fresh Project must not have a checklist");
  const survey = yield* say(
    "准备模式：不写入文库。先说说你有哪些材料（ADS、Zotero、.bib、PDF 文件夹、服务器、稿件、计划、其他）？"
  );
  const answers = new Map<string, string>();
  for (const line of survey.split("\n")) {
    const m = /^([^:：]+)[:：]\s*(.*)$/.exec(line);
    if (m) answers.set((m[1] as string).trim(), (m[2] as string).trim());
  }
  const c: Checklist = {
    state: "进行中",
    agent: "外部 agent",
    sources: [],
    imported: [],
    pending: [],
    left: [],
  };
  for (const kind of [
    "ADS libraries",
    "Zotero",
    ".bib",
    "PDF 文件夹",
    "服务器",
    "稿件",
    "计划",
    "其他",
  ]) {
    const detail = answers.get(kind) ?? "无";
    c.sources.push({
      kind,
      detail,
      status: kind === "其他" ? "只登记" : detail === "无" ? "跳过" : "未开始",
    });
  }
  for (const kind of ["服务器", "稿件", "其他"]) {
    const d = answers.get(kind);
    if (d) c.left.push(`${kind}：${d}`);
  }
  // read-only collection: the PDF folder's PDF -> id table, the Zotero export's file list, the zip's contents
  const folder = pathsIn(answers.get("PDF 文件夹") ?? "")[0] as string;
  const table1: string[] = ["PDF → DOI / arXiv id"];
  const prepPages = yield* firstPages(folder);
  for (const file of (yield* call("bash", { command: `ls '${folder}'` }))
    .split("\n")
    .filter((f) => f.endsWith(".pdf"))) {
    const page = prepPages.get(join(folder, file)) ?? "";
    const id =
      /^(\d{4}\.\d{4,5})/.exec(file)?.[1] ?? /10\.\d{4,9}\/[^\s,;)]+/.exec(page)?.[0] ?? "未识别";
    table1.push(`  ${file} → ${id}`);
  }
  const pdfLine = c.sources.find((s) => s.kind === "PDF 文件夹");
  if (pdfLine) pdfLine.sub = table1;
  const zip = pathsIn(answers.get("稿件") ?? "").find((p) => p.endsWith(".zip"));
  if (zip) yield* call("bash", { command: `unzip -l '${zip}'` });
  // fetch the server material to intake-inbox/ (after the command card)
  const serverCopy = /本机路径模拟\s*(\S+)/.exec(answers.get("服务器") ?? "")?.[1];
  if (serverCopy) {
    const inbox = join(project, "intake-inbox", "lab-server");
    yield* call("bash", { command: `mkdir -p '${inbox}'` });
    yield* call("bash", { command: `rsync -a '${serverCopy}/' '${inbox}/'` });
    const line = c.sources.find((s) => s.kind === "服务器");
    if (line) line.sub = ["副本：intake-inbox/lab-server/"];
  }
  const todo = pathsIn(answers.get("计划") ?? "")[0];
  if (todo) {
    const notes = yield* call("read", { path: todo });
    const line = c.sources.find((s) => s.kind === "计划");
    if (line)
      line.sub = [
        "计划草案：",
        ...notes
          .split("\n")
          .filter(Boolean)
          .map((l) => `  ${l}`),
      ];
  }
  yield* save(c);
  yield* say("准备好了：清单已写好，原文件夹没动。请打开工作台，让 Copilot 继续迁入。");
}

// ======================================================================================================== //
// The Copilot continues what an external agent prepared
// ======================================================================================================== //

/** Reads the prepared checklist and brings in the PDFs of its table (and the copies in intake-inbox/). */
export function* intakeFromPrepared(project: string): Gen<void> {
  const first = yield* start();
  yield* loadSkill(first.system);
  const text = yield* readChecklist();
  if (text === null) throw new Error("no checklist to continue from");
  const c = parse(text);
  const pdfLine = find(c, "PDF 文件夹");
  const folder = pathsIn(pdfLine?.detail ?? "")[0] as string;
  const rows = (pdfLine?.sub ?? [])
    .map((l) => /^\s*(\S+\.pdf) → (\S+)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({
      file: (m as RegExpExecArray)[1] as string,
      id: (m as RegExpExecArray)[2] as string,
    }));
  if (rows.length === 0) throw new Error("the prepared checklist has no PDF table");
  const counts = zero();
  const preparedPages = yield* firstPages(folder);
  for (const { file, id } of rows) {
    if (id === "未识别") {
      counts.pending++;
      continue;
    }
    const path = join(folder, file);
    // the table was prepared by someone else: the title still has to match the PDF's own
    const page = preparedPages.get(path) ?? "";
    const title = page.split("\n")[0]?.trim();
    const imp = yield* tool("library", {
      action: "import_works",
      mode: "identifier",
      text: /^\d{4}\.\d{4,5}$/.test(id) ? `arXiv:${id}` : id,
      batch: true,
    });
    const ref = imp.results?.[0]?.ref;
    if (!ref || ref.title !== title) {
      counts.pending++;
      if (ref && imp.results[0].status === "created") {
        counts.created++;
        c.pending.push(
          `PDF ${file}：准备的 id ${id} 对应《${ref.title}》，与 PDF 不符；可能是参考文献里的 DOI，不需要就在文献库页面删除`
        );
      } else c.pending.push(`PDF ${file}：准备的 id ${id} 对应的标题与 PDF 不符`);
      continue;
    }
    counts[imp.results[0].status === "created" ? "created" : "merged"]++;
    const a = yield* tool("library", { action: "attach_local_pdf", refId: ref.id, path });
    if (a.reason === "page_limit" || a.reason === "too_large") {
      counts.pending++;
      c.pending.push(`PDF ${file}：超出上传上限（${a.reason}），Work 已建，PDF 未挂`);
    } else if (!a.ok) throw new Error(`attach ${file}: ${JSON.stringify(a)}`);
  }
  const serverCopy = find(c, "服务器")?.sub?.some((l) => l.includes("intake-inbox/lab-server/"));
  const copy = serverCopy ? join(project, "intake-inbox", "lab-server") : null;
  if (copy) {
    const copyPages = yield* firstPages(copy);
    for (const file of (yield* call("bash", { command: `ls '${copy}'` }))
      .split("\n")
      .filter((f) => f.endsWith(".pdf"))) {
      const path = join(copy, file);
      const page = copyPages.get(path) ?? "";
      const doi = /10\.\d{4,9}\/[^\s,;)]+/.exec(page)?.[0];
      const imp = yield* tool("library", {
        action: "import_works",
        mode: "identifier",
        text: doi ?? "",
        batch: true,
      });
      const ref = imp.results?.[0]?.ref;
      if (!ref || ref.title !== page.split("\n")[0]?.trim())
        throw new Error(`copy ${file}: ${JSON.stringify(imp)}`);
      counts[imp.results[0].status === "created" ? "created" : "merged"]++;
      const a = yield* tool("library", { action: "attach_local_pdf", refId: ref.id, path });
      if (!a.ok) throw new Error(`attach ${file}: ${JSON.stringify(a)}`);
    }
  }
  if (pdfLine) pdfLine.status = "部分";
  note(c, "准备好的 PDF 表", counts);
  yield* save(c);
  yield* say(`按准备好的清单带入了 PDF：\n${table(counts)}`);
}

// ======================================================================================================== //
// A .bib longer than one `read` window
// ======================================================================================================== //

/** The skill's "Importing a .bib": one `read` window per batch, cut at an entry boundary, @string on top of each. */
export function* importLongBib(path: string): Gen<{ batches: number; keys: string[] }> {
  let offset = 1;
  const keys: string[] = [];
  let batches = 0;
  let preamble: string[] = [];
  for (;;) {
    const raw = yield* call("read", { path, offset });
    const notice = /\[Showing lines (\d+)-(\d+) of (\d+)\.[^\]]*\]\s*$/.exec(raw);
    const body = raw.replace(/\n*\[Showing lines[^\]]*\]\s*$/, "");
    const more = notice !== null && Number(notice[2]) < Number(notice[3]);
    const lines = body.split("\n");
    // the last line that begins an entry inside a cut window starts the half entry that waits for the next batch
    let usable = lines;
    if (more) {
      const lastAt =
        lines
          .map((l, i) => (l.startsWith("@") ? i : -1))
          .filter((i) => i >= 0)
          .at(-1) ?? 0;
      usable = lines.slice(0, lastAt);
    }
    const parts = splitBib(usable.join("\n"));
    if (offset === 1) preamble = parts.preamble;
    const r = yield* tool("library", {
      action: "import_works",
      mode: "bib",
      text: [...(offset === 1 ? [] : preamble), usable.join("\n")].join("\n\n"),
    });
    if (r.status === "rejected" || !r.ok)
      throw new Error(`long bib batch: ${JSON.stringify(r).slice(0, 300)}`);
    for (const x of r.results as Json[])
      if (x.status === "created" || x.status === "exists") keys.push(x.key);
    batches++;
    if (!more) break;
    offset += usable.length;
  }
  return { batches, keys };
}
