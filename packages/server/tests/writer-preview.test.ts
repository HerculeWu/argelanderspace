/** Real shared-pipeline regression probes; every manuscript/library is synthetic. */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import {
  BUILTIN_WRITER_TEMPLATES,
  type WriterManuscript,
  type WriterNumberingResponse,
} from "@argelanderspace/contracts";
import { libraryPaths, manuscriptDir, templatesDir } from "@argelanderspace/core";
import { haveLatexmk, haveTexEngine } from "@argelanderspace/infra";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { JobRunner } from "../src/jobs.js";
import {
  __setNumberingComputeForTests,
  cancelNumberingCompile,
  runWriterNumberingNow,
} from "../src/writer-numbering.js";
import { collectBroadcasts, makeDataDir, stubPipelines, stubSources } from "./helpers.js";

const HAVE_TEX = haveLatexmk() && haveTexEngine("pdflatex");
const HAVE_TEXT = (() => {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const BIB = `@article{smith2020,author={Smith, John and Doe, Jane and Lee, Sam and Kim, Pat},title={Synthetic A},journal={Test},year={2020}}
@article{jones2021,author={Jones, Amy},title={Synthetic B},journal={Test},year={2021}}`;
const SOURCE = String.raw`\chapter{Intro}\label{ch:intro}
\section{Setup}\label{sec:setup}
Paren \citep{smith2020}; textual \citet{jones2021}; notes \citep[see][sec.~2]{smith2020,jones2021}; starred \citep*{smith2020}; single note \citep[sec.~2]{smith2020}.
\begin{align}a&=b\label{eq:a}\\c&=d\label{eq:b}\end{align}
Rows \eqref{eq:a} and \eqref{eq:b}.`;
let dataDir: string;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  dataDir = makeDataDir();
  app = createApp({
    paths: libraryPaths(dataDir),
    statusDir: statusDirFor(dataDir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(dataDir, "jobs") }),
    broadcast: collectBroadcasts().broadcast,
  });
  const path = libraryPaths(dataDir).libraryBib;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, BIB);
});
const request = (path: string, method = "GET", value?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
  });
async function create(template = "report"): Promise<WriterManuscript> {
  return (await (
    await request("/api/writer/manuscripts", "POST", { template, title: "Synthetic preview" })
  ).json()) as WriterManuscript;
}
async function save(doc: WriterManuscript) {
  const res = await request(`/api/writer/manuscripts/${doc.id}`, "PUT", doc);
  expect(res.status).toBe(200);
  return (await res.json()) as WriterManuscript;
}
async function refresh(id: string): Promise<WriterNumberingResponse> {
  const res = await request(`/api/writer/manuscripts/${id}/numbering/refresh`, "POST");
  expect(res.status).toBe(200);
  return (await res.json()) as WriterNumberingResponse;
}
function firstCell(doc: WriterManuscript) {
  const cell = doc.cells[0];
  if (!cell) throw new Error("missing synthetic fixture cell");
  return cell;
}
const paragraphs = (n: WriterNumberingResponse) =>
  Object.values(n.preview?.cells ?? {}).flatMap((c) =>
    c.items.flatMap((i) =>
      i.kind === "block" && i.block.type === "paragraph" ? i.block.segments : []
    )
  );
const cites = (n: WriterNumberingResponse) =>
  paragraphs(n)
    .filter((s) => s.type === "cite")
    .map((s) => s.raw);

// A valid in-memory RGB PNG; no external image or real library access.
function png() {
  const chunk = (type: string, body: Buffer) => {
    const name = Buffer.from(type),
      size = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    size.writeUInt32BE(body.length);
    crc.writeUInt32BE(crc32(Buffer.concat([name, body])));
    return Buffer.concat([size, name, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe.skipIf(!HAVE_TEX)("shared latexmk / IR rendering", () => {
  test.each([false, true])(
    "natbib command semantics, compiled labels and row numbers (numbers=%s)",
    async (numeric) => {
      let doc = await create();
      doc.userPreamble = numeric ? "\\setcitestyle{numbers,square,comma}" : "";
      doc.cells = [{ id: "c_00000001", type: "latex", data: { source: SOURCE } }];
      doc = await save(doc);
      const n = await refresh(doc.id);
      expect(n.lastError).toBeNull();
      expect(n.status).toBe("ok");
      expect(cites(n)).toEqual(
        numeric
          ? ["[2]", "Jones [1]", "[see 2, 1, sec. 2]", "[2]", "[2, sec. 2]"]
          : [
              "[Smith et al., 2020]",
              "Jones [2021]",
              "[see Smith et al., 2020, Jones, 2021, sec. 2]",
              "[Smith, Doe, Lee, and Kim, 2020]",
              "[Smith et al., 2020, sec. 2]",
            ]
      );
      expect(
        paragraphs(n)
          .filter((s) => s.type === "xref")
          .map((s) => s.raw)
      ).toEqual(["(1.1)", "(1.2)"]);
      const math = n.preview?.cells.c_00000001?.items.find(
        (i) => i.kind === "block" && i.block.type === "equation"
      );
      expect(math?.kind === "block" && math.rows?.map((r) => r.number)).toEqual(["1.1", "1.2"]);
      expect(n.preview?.labelCells["eq:a"]).toBe("c_00000001");
      const root = manuscriptDir(dataDir, doc.id);
      const db = join(root, "build/latexmk/pdflatex-instrumented/main.fdb_latexmk");
      expect(existsSync(db)).toBe(true);
      const mtime = statSync(db).mtimeMs;
      const reused = await refresh(doc.id);
      expect(reused.status).toBe("ok");
      expect(reused.facts).toEqual(n.facts);
      expect(statSync(db).mtimeMs).toBe(mtime); // latexmk really checked, without rerunning TeX
      expect(existsSync(join(dataDir, "annotations"))).toBe(false);
    },
    60000
  );

  test("bibliography content, template deps and same-tex cell identity invalidate the cache", async () => {
    let doc = await create();
    doc.cells = [{ id: "c_00000001", type: "latex", data: { source: SOURCE } }];
    doc = await save(doc);
    const first = await refresh(doc.id);
    expect(first.status).toBe("ok");
    writeFileSync(libraryPaths(dataDir).libraryBib, BIB.replace("year={2020}", "year={2022}"));
    expect(
      await (await request(`/api/writer/manuscripts/${doc.id}/numbering`)).json()
    ).toMatchObject({ status: "stale" });
    expect(cites(await refresh(doc.id))[0]).toBe("[Smith et al., 2022]");
    const tpl = structuredClone(BUILTIN_WRITER_TEMPLATES.find((t) => t.id === "report"));
    if (!tpl) throw new Error("missing report template");
    tpl.deps = ["extra.sty"];
    tpl.preamble += "\n\\usepackage{extra}";
    mkdirSync(join(templatesDir(dataDir), "report.deps"), { recursive: true });
    writeFileSync(join(templatesDir(dataDir), "report.json"), JSON.stringify(tpl));
    const dep = join(templatesDir(dataDir), "report.deps", "extra.sty");
    writeFileSync(
      dep,
      "\\ProvidesPackage{extra}\n\\AtBeginDocument{\\renewcommand{\\theequation}{Z\\arabic{equation}}}"
    );
    expect((await refresh(doc.id)).facts?.labels["eq:a"]).toBe("Z1");
    writeFileSync(
      dep,
      "\\ProvidesPackage{extra}\n\\AtBeginDocument{\\renewcommand{\\theequation}{Q\\arabic{equation}}}"
    );
    expect((await refresh(doc.id)).facts?.labels["eq:a"]).toBe("Q1");
    firstCell(doc).id = "c_00000002";
    doc = await save(doc);
    const rebound = await refresh(doc.id);
    expect(rebound.preview?.cells.c_00000001).toBeUndefined();
    expect(rebound.preview?.labelCells["eq:a"]).toBe("c_00000002");
  }, 60000);

  test("a failed compile preserves the previous projection and recovers without rewriting the manuscript", async () => {
    let doc = await create();
    doc.cells = [{ id: "c_00000001", type: "latex", data: { source: SOURCE } }];
    doc = await save(doc);
    const good = await refresh(doc.id);
    expect(good.status).toBe("ok");
    firstCell(doc).data.source = "\\undefinedWriterCommand";
    doc = await save(doc);
    const failed = await refresh(doc.id);
    expect(failed.status).toBe("stale");
    expect(failed.lastError).toContain("Undefined control sequence");
    expect(failed.preview).toEqual(good.preview);
    expect(
      JSON.parse(readFileSync(join(manuscriptDir(dataDir, doc.id), "manuscript.json"), "utf8"))
        .cells[0].data.source
    ).toBe("\\undefinedWriterCommand");
    firstCell(doc).data.source = SOURCE;
    doc = await save(doc);
    expect((await refresh(doc.id)).status).toBe("ok");
  }, 60000);

  test("letter template supports its declared figure/table/code types and materialized assets", async () => {
    let doc = await create("letter");
    const assetDir = join(manuscriptDir(dataDir, doc.id), "assets");
    mkdirSync(assetDir, { recursive: true });
    writeFileSync(join(assetDir, "plot.png"), png());
    doc.cells = [
      { id: "c_00000001", type: "latex", data: { source: "Text \\citep{smith2020}." } },
      {
        id: "c_00000002",
        type: "figure",
        data: {
          caption: "Plot \\citet{smith2020}.",
          label: "fig:plot",
          image: "plot.png",
          width: 80,
          placement: "center",
        },
      },
      {
        id: "c_00000003",
        type: "table",
        data: {
          caption: "Data",
          label: "tab:data",
          head: "A,B",
          csv: "1,2",
          width: 90,
          placement: "center",
        },
      },
      {
        id: "c_00000004",
        type: "code",
        data: {
          caption: "Code",
          label: "lst:code",
          code: "x = 1",
          language: "Python",
          lineNumbers: true,
        },
      },
    ];
    doc = await save(doc);
    const n = await refresh(doc.id);
    expect(n.lastError).toBeNull();
    expect(n.status).toBe("ok");
    const figure = n.preview?.cells.c_00000002?.items.find(
      (i) => i.kind === "block" && i.block.type === "figure"
    );
    expect(figure?.kind === "block" && figure.block.type === "figure" && figure.block.number).toBe(
      "1"
    );
    const name =
      figure?.kind === "block" && figure.block.type === "figure" ? figure.block.imgPath : "";
    expect(name).toBeTruthy();
    const image = await request(`/api/writer/manuscripts/${doc.id}/preview-assets/${name}`);
    expect(image.status).toBe(200);
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png());
    const listing = n.preview?.cells.c_00000004?.items.find(
      (i) => i.kind === "block" && i.block.type === "code"
    );
    expect(
      listing?.kind === "block" && listing.block.type === "code" && listing.block.captionSegments
    ).toEqual([{ type: "text", text: "Code" }]);
    expect(n.facts?.labels["lst:code"]).toBe("1");
  }, 60000);
});

test.skipIf(!HAVE_TEX || !HAVE_TEXT)(
  "citation forms agree with the compiled PDF, including grouped years and user punctuation",
  async () => {
    const forms = [
      String.raw`\citep{smith2020,smith2020b,smith2021}`,
      String.raw`\citet{smith2020,jones2021}`,
      String.raw`\citealt[see][sec.~2]{smith2020}`,
      String.raw`\citealp[see][post]{smith2020,jones2021}`,
      String.raw`\citeauthor*{smith2020}`,
      String.raw`\citeyearpar[see][post]{smith2020,smith2021}`,
      String.raw`\citet[see][post]{smith2020,smith2021}`,
      String.raw`\cite{smith2020}`,
      String.raw`\cite[post]{smith2020}`,
      String.raw`\citenum{smith2020}`,
      String.raw`\citeyear{smith2020,smith2021}`,
      String.raw`\citep{jones2021,smith2020,smith2020b,smith2021}`,
      String.raw`\citep{smith2020,smith2020}`,
    ];
    const smith = BIB.split("\n")[0] ?? "";
    writeFileSync(
      libraryPaths(dataDir).libraryBib,
      [
        BIB,
        smith.replace("smith2020", "smith2020b").replace("Synthetic A", "Synthetic C"),
        smith.replace("smith2020", "smith2021").replace("2020", "2021"),
      ].join("\n")
    );
    let doc = await create();
    doc.cells = [
      {
        id: "c_00000001",
        type: "latex",
        data: {
          source:
            forms.map((f, i) => `T${i}START ${f} T${i}END`).join("\n\n") +
            "\n\nSPACEBEGIN A.\n% comment-only line\nB. SPACEEND",
        },
      },
    ];
    for (const style of [
      "",
      "\\setcitestyle{numbers}",
      "\\setcitestyle{numbers,square,comma}",
      "\\setcitestyle{numbers,square,comma,notesep={;}}",
      "sort&compress",
    ]) {
      const tpl = structuredClone(BUILTIN_WRITER_TEMPLATES.find((t) => t.id === "report"));
      if (!tpl) throw new Error("missing report template");
      if (style === "sort&compress")
        tpl.preamble = tpl.preamble.replace(
          "\\usepackage{natbib}",
          "\\usepackage[numbers,sort&compress]{natbib}"
        );
      mkdirSync(templatesDir(dataDir), { recursive: true });
      writeFileSync(join(templatesDir(dataDir), "report.json"), JSON.stringify(tpl));
      doc.userPreamble = style === "sort&compress" ? "" : style;
      doc = await save(doc);
      const n = await refresh(doc.id);
      expect(n.lastError).toBeNull();
      const text = execFileSync(
        "pdftotext",
        [join(manuscriptDir(dataDir, doc.id), "build/latexmk/pdflatex-instrumented/main.pdf"), "-"],
        { encoding: "utf8" }
      ).replace(/\s+/g, " ");
      const raws = cites(n);
      const plain = paragraphs(n)
        .map((s) => (s.type === "text" ? s.text : ""))
        .join("");
      expect(/SPACEBEGIN(.*?)SPACEEND/.exec(plain)?.[1]?.trim()).toBe("A. B.");
      for (const [i, form] of forms.entries()) {
        const expected = new RegExp(`T${i}START (.*?) T${i}END`).exec(text)?.[1];
        expect(raws[i], `${style}: ${form}`).toBe(expected);
      }
    }
  },
  60000
);

// External class files remain outside the repository and npm package. Set this
// only for a synthetic A&A smoke run with locally supplied dependencies.
test.skipIf(!HAVE_TEX || !HAVE_TEXT || !process.env.WRITER_AA_DEPS)(
  "A&A class: abstract before title, native citation style and row references",
  async () => {
    const from = process.env.WRITER_AA_DEPS;
    if (!from) throw new Error("A&A dependency directory missing");
    const deps = join(templatesDir(dataDir), "aa.deps");
    mkdirSync(deps, { recursive: true });
    for (const file of ["aa.cls", "aa.bst"]) copyFileSync(join(from, file), join(deps, file));
    let doc = await create("aa");
    doc.authors = [{ name: "Test Author", aff: "1" }];
    doc.affiliations = ["Test Institute"];
    doc.cells = [
      {
        id: "c_00000001",
        type: "abstract-aa",
        data: {
          Context: "",
          Aims: "AIMSANCHOR",
          Methods: "Method.",
          Results: "Result.",
          Conclusions: "Conclusion.",
        },
      },
      {
        id: "c_00000002",
        type: "latex",
        data: { source: SOURCE.replace("\\chapter{Intro}\\label{ch:intro}\n", "") },
      },
    ];
    doc = await save(doc);
    const n = await refresh(doc.id);
    expect(n.lastError).toBeNull();
    expect(n.status).toBe("ok");
    expect(cites(n)[0]).toBe("(Smith et al. 2020)");
    const pdf = execFileSync(
      "pdftotext",
      [join(manuscriptDir(dataDir, doc.id), "build/latexmk/pdflatex-instrumented/main.pdf"), "-"],
      { encoding: "utf8" }
    );
    expect(pdf).toContain("AIMSANCHOR");
    expect(JSON.stringify(n.preview?.cells.c_00000001)).toContain("Aims. AIMSANCHOR");
    expect(n.facts?.labels["eq:a"]).toBe("1");
    expect(n.facts?.labels["eq:b"]).toBe("2");
  },
  60000
);

test("concurrent manual renders share one flight and one latest follow-up", async () => {
  const doc = await create();
  let calls = 0,
    active = 0,
    max = 0,
    release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const restore = __setNumberingComputeForTests(async () => {
    calls++;
    active++;
    max = Math.max(max, active);
    if (calls === 1) await gate;
    active--;
    return {
      version: 1,
      at: new Date().toISOString(),
      texHash: "x",
      facts: null,
      lastError: "test",
    };
  });
  try {
    const opts = { broadcast: () => {} };
    const a = runWriterNumberingNow(dataDir, doc.id, opts);
    await Promise.resolve();
    const b = runWriterNumberingNow(dataDir, doc.id, opts);
    void runWriterNumberingNow(dataDir, doc.id, opts);
    release();
    await Promise.all([a, b]);
    expect(max).toBe(1);
    expect(calls).toBe(2);
  } finally {
    restore();
    await cancelNumberingCompile(doc.id, dataDir);
  }
});

test("DELETE drains an in-flight writer before removing derived files (no resurrection)", async () => {
  const doc = await create();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const ready = new Promise<void>((r) => {
    started = r;
  });
  const restore = __setNumberingComputeForTests(async () => {
    started();
    await gate;
    const root = join(manuscriptDir(dataDir, doc.id), "build");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "probe"), "derived");
    return {
      version: 1,
      at: new Date().toISOString(),
      texHash: "x",
      facts: null,
      lastError: "test",
    };
  });
  try {
    const running = request(`/api/writer/manuscripts/${doc.id}/numbering/refresh`, "POST");
    await ready;
    const deleting = request(`/api/writer/manuscripts/${doc.id}`, "DELETE");
    await Promise.resolve();
    release();
    const [, deleted] = await Promise.all([running, deleting]);
    expect(deleted.status).toBe(200);
    expect(existsSync(manuscriptDir(dataDir, doc.id))).toBe(false);
  } finally {
    restore();
  }
});
