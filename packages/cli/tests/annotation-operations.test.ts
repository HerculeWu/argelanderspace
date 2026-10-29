/**
 * `argelanderspace reader ...` and `argelanderspace annotation ...` (release-0.2 ticket 07), the real `bin.js` as a child
 * process, on the two paths: no workbench running (the command runs the server's annotation access path in its own
 * process) and a real workbench in this process (the command hands the operation to it). The three states of the
 * content fingerprint, the system errors that touch nothing, the parameter errors, PDF workbench annotations, and that
 * the frozen read-only `annot` neither changes nor is changed by any of it.
 */
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { docContentFingerprint, libraryPaths, publishPdfDoc } from "@argelanderspace/core";
import { resolveGlobalDirsLeniently } from "@argelanderspace/infra";
import {
  createServer,
  newWorkbenchToken,
  type RunningServer,
  registerWorkbench,
} from "@argelanderspace/server";
import { afterEach, describe, expect, test } from "vitest";
import { probePdf } from "../../server/src/pdfium-probe.js";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(PKG, "dist", "bin.js");
const DOC = "read-doc";
const W1 = "doi:10.1000/w1";
const roots: string[] = [];
const closers: (() => unknown)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ir = (text: string) => ({
  version: 1,
  docId: DOC,
  title: "A Synthetic Reader Paper",
  sections: [
    {
      id: "sec-1",
      level: 1,
      number: "1",
      heading: "Introduction",
      blocks: [
        { id: "p-1", type: "paragraph", segments: [{ type: "text", text }] },
        { id: "p-2", type: "paragraph", segments: [{ type: "text", text: "Second paragraph." }] },
      ],
      children: [],
    },
  ],
  refsManifest: [],
  bib: [],
  citationsByBlock: {},
  source: { type: "latex", origin: "x", main_tex: "main.tex" },
  meta: { title: "A Synthetic Reader Paper" },
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "aspace-cli-ann-"));
  roots.push(root);
  const dataDir = join(root, "data");
  const paths = libraryPaths(dataDir);
  mkdirSync(paths.libraryDir, { recursive: true });
  writeFileSync(
    paths.libraryJson,
    JSON.stringify({
      version: 1,
      project: { name: "Synthetic", short: "S", field: "" },
      works: [
        {
          id: W1,
          title: "Work number 1",
          authors: ["Author1"],
          year: 2001,
          venue: "MNRAS",
          type: "article",
          doi: "10.1000/w1",
          cite_key: "author1",
          doc_ids: [DOC],
        },
      ],
    })
  );
  const docDir = join(dataDir, "output", DOC);
  mkdirSync(docDir, { recursive: true });
  const irFile = join(docDir, `${DOC}.json`);
  const annDir = join(dataDir, "annotations", DOC);
  const writeIr = (text: string) => writeFileSync(irFile, JSON.stringify(ir(text)));
  writeIr("A paragraph of the synthetic paper.");
  const fingerprint = () =>
    docContentFingerprint(JSON.parse(readFileSync(irFile, "utf8")), { docDir });
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "xdg") };
  // Asynchronous: the workbench of these tests lives in this very process and must keep answering.
  const run = (args: string[]) =>
    new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [BIN, ...args, "--data-dir", dataDir],
        { env, encoding: "utf8", timeout: 60_000 },
        (error, stdout, stderr) =>
          resolve({
            status: error === null ? 0 : ((error as { code?: number }).code ?? 1),
            stdout,
            stderr,
          })
      );
    });
  const json = async (args: string[]) => {
    const r = await run(args);
    return { ...r, body: r.stdout.trim() ? JSON.parse(r.stdout) : null };
  };
  const tree = () => {
    const out: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          out.push(`${relative(dataDir, full)}/`);
          walk(full);
        } else if (name !== "workbench.json")
          out.push(`${relative(dataDir, full)} ${readFileSync(full).toString("base64")}`);
      }
    };
    walk(dataDir);
    return out.filter((line) => !line.startsWith("jobs/"));
  };
  return { root, dataDir, paths, annDir, irFile, writeIr, fingerprint, run, json, tree };
}
type Fixture = ReturnType<typeof setup>;

async function startWorkbench(dataDir: string) {
  const token = newWorkbenchToken();
  const srv: RunningServer = createServer({
    globalDirs: resolveGlobalDirsLeniently({}).dirs,
    dataDir,
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    operationToken: token,
  });
  closers.push(() => srv.close().catch(() => {}));
  const port = await srv.ready();
  const registration = await registerWorkbench(dataDir, { port, token });
  closers.push(() => registration.revoke());
}

const D = ["--doc-id", DOC];
const create = (
  f: Fixture,
  extra: string[] = [],
  over: { fingerprint?: string; rev?: string } = {}
) => [
  "annotation",
  "create",
  ...D,
  "--fingerprint",
  over.fingerprint ?? f.fingerprint(),
  "--rev",
  over.rev ?? "0",
  "--target",
  '{"type":"document"}',
  "--body",
  "hello from the CLI",
  ...extra,
];
const OLD_NOTE = {
  id: "a_0000aaaa",
  target: { type: "document" },
  body: "  an old note  ",
  created_at: "2026-09-10T10:00:00.000Z",
  updated_at: "2026-09-10T10:00:00.000Z",
};
const writeCurrent = (
  f: Fixture,
  fingerprint: string,
  annotations: object[] = [OLD_NOTE],
  rev = 2
) => {
  mkdirSync(f.annDir, { recursive: true });
  writeFileSync(
    join(f.annDir, "current.json"),
    `${JSON.stringify({ version: 1, rev, content_fingerprint: fingerprint, annotations }, null, 2)}\n`
  );
};

for (const path of ["no workbench running", "workbench running"] as const) {
  describe(path, () => {
    const prepare = async () => {
      const f = setup();
      if (path === "workbench running") await startWorkbench(f.dataDir);
      return f;
    };

    test("read, create, update, delete: JSON on stdout, exit 0; `annot` lists what was written", {
      timeout: 120_000,
    }, async () => {
      const f = await prepare();
      const reading = await f.json(["reader", "read", ...D]);
      expect(reading.status).toBe(0);
      expect(reading.body).toMatchObject({ ok: true, status: "ok" });
      expect(reading.body.reading.epoch).toMatchObject({
        fingerprint: f.fingerprint(),
        annotationsRev: 0,
      });
      // a read leaves the Project exactly as it was
      expect(existsSync(f.annDir)).toBe(false);

      const created = await f.json(create(f));
      expect(created.status).toBe(0);
      expect(created.body).toMatchObject({ ok: true, status: "ok", epoch: { annotationsRev: 1 } });
      const id = created.body.annotation.id as string;

      // the frozen listing sees it (and is untouched by all this)
      const listed = await f.run(["annot", DOC]);
      expect(listed.status).toBe(0);
      expect(listed.stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(listed.stdout)).toMatchObject({ id, body: "hello from the CLI" });
      expect(Object.keys(JSON.parse(listed.stdout))).toEqual([
        "id",
        "doc_id",
        "target",
        "context",
        "body",
        "created_at",
        "updated_at",
        "link",
      ]);

      const updated = await f.json([
        "annotation",
        "update",
        ...D,
        "--fingerprint",
        f.fingerprint(),
        "--rev",
        "1",
        "--annotation-id",
        id,
        "--expected-updated-at",
        created.body.annotation.updated_at,
        "--body",
        "hello again",
      ]);
      expect(updated.status).toBe(0);
      expect(updated.body).toMatchObject({ ok: true, status: "ok", epoch: { annotationsRev: 2 } });

      const deleted = await f.json([
        "annotation",
        "delete",
        ...D,
        "--fingerprint",
        f.fingerprint(),
        "--rev",
        "2",
        "--annotation-id",
        id,
        "--expected-updated-at",
        updated.body.annotation.updated_at,
      ]);
      expect(deleted.status).toBe(0);
      expect(deleted.body).toMatchObject({ ok: true, status: "ok", deleted: id });
      expect((await f.run(["annot", DOC])).stdout).toBe("");
    });

    test("1. same fingerprint: a stale revision is a conflict that writes nothing (exit 1)", {
      timeout: 120_000,
    }, async () => {
      const f = await prepare();
      writeCurrent(f, f.fingerprint());
      const before = f.tree();
      const r = await f.json(create(f, [], { rev: "1" }));
      expect(r.status).toBe(1);
      expect(r.body).toMatchObject({ ok: false, status: "conflict", reason: "rev_mismatch" });
      expect(f.tree()).toEqual(before);
    });

    test("2. different fingerprint: reading changes nothing; the write is a conflict and the access path archives", {
      timeout: 120_000,
    }, async () => {
      const f = await prepare();
      f.writeIr("The content was replaced by something else.");
      writeCurrent(f, "f".repeat(64));
      const before = f.tree();
      const reading = await f.json(["reader", "read", ...D]);
      expect(reading.body).toMatchObject({ ok: true });
      expect(f.tree()).toEqual(before);
      // the frozen annot also hides the old ones and writes nothing
      const hidden = await f.run(["annot", DOC]);
      expect(hidden.stdout).toBe("");
      expect(hidden.stderr).toContain("archived and not shown");
      expect(f.tree()).toEqual(before);

      const r = await f.json(create(f, [], { fingerprint: "f".repeat(64), rev: "2" }));
      expect(r.status).toBe(1);
      expect(r.body).toMatchObject({
        ok: false,
        status: "conflict",
        reason: "document_changed",
        archivedOlder: 1,
      });
      const archive = readdirSync(join(f.annDir, "archive"));
      expect(archive).toHaveLength(1);
      expect(
        JSON.parse(readFileSync(join(f.annDir, "archive", archive[0] as string), "utf8"))
          .annotations
      ).toEqual([OLD_NOTE]);
      expect(JSON.parse(readFileSync(join(f.annDir, "current.json"), "utf8"))).toMatchObject({
        content_fingerprint: f.fingerprint(),
        annotations: [],
      });
    });

    test("3. cannot be computed: exit 1 with a system error, never a mismatch, and not a byte moves", {
      timeout: 180_000,
    }, async () => {
      for (const [what, damage] of [
        ["IR is not JSON", (f: Fixture) => writeFileSync(f.irFile, "{ not json")],
        [
          "current.json is damaged",
          (f: Fixture) => writeFileSync(join(f.annDir, "current.json"), "{ x"),
        ],
      ] as const) {
        const f = await prepare();
        const fp = f.fingerprint();
        writeCurrent(f, fp);
        damage(f);
        const before = f.tree();
        const written = await f.json(create(f, [], { fingerprint: fp, rev: "2" }));
        expect(written.status, what).toBe(1);
        expect(written.body, what).toMatchObject({ ok: false, status: "error" });
        const read = await f.json(["reader", "read", ...D]);
        expect(read.status, what).toBe(1);
        expect(read.body, what).toMatchObject({ ok: false, status: "error" });
        expect(f.tree(), what).toEqual(before);
        expect(existsSync(join(f.annDir, "archive")), what).toBe(false);
      }
    });

    test("an unknown Doc is not_found (exit 1) and nothing is created", {
      timeout: 120_000,
    }, async () => {
      const f = await prepare();
      const before = f.tree();
      const r = await f.json([
        "annotation",
        "create",
        "--doc-id",
        "no-such-doc",
        "--fingerprint",
        "x",
        "--rev",
        "0",
        "--target",
        '{"type":"document"}',
        "--body",
        "b",
      ]);
      expect(r.status).toBe(1);
      expect(r.body).toMatchObject({ ok: false, status: "not_found" });
      expect(f.tree()).toEqual(before);
    });

    test("parameter errors are exit 2, `unsupported`, and nothing runs", {
      timeout: 120_000,
    }, async () => {
      const f = await prepare();
      const before = f.tree();
      for (const args of [
        [
          "annotation",
          "create",
          ...D,
          "--rev",
          "0",
          "--target",
          '{"type":"document"}',
          "--body",
          "b",
        ],
        [
          "annotation",
          "create",
          ...D,
          "--fingerprint",
          "f",
          "--rev",
          "0",
          "--target",
          "{not json",
          "--body",
          "b",
        ],
        [
          "annotation",
          "create",
          ...D,
          "--fingerprint",
          "f",
          "--rev",
          "0",
          "--target",
          '{"type":"text"}',
          "--body",
          "b",
        ],
        [
          "annotation",
          "create",
          ...D,
          "--fingerprint",
          "f",
          "--rev",
          "0",
          "--target",
          '{"type":"document"}',
          "--body",
          "   ",
        ],
        [
          "annotation",
          "create-pdf",
          ...D,
          "--sha256",
          "a".repeat(64),
          "--rev",
          "0",
          "--kind",
          "page_comment",
          "--body",
          "b",
        ],
        ["reader", "read"],
      ]) {
        const r = await f.json(args);
        expect(r.status, args.join(" ")).toBe(2);
        expect(r.body).toMatchObject({ ok: false, status: "unsupported" });
      }
      expect(f.tree()).toEqual(before);
    });

    test("--json takes the whole parameter object, nested target included", {
      timeout: 120_000,
    }, async () => {
      const f = await prepare();
      const file = join(f.root, "params.json");
      writeFileSync(
        file,
        JSON.stringify({
          docId: DOC,
          fingerprint: f.fingerprint(),
          rev: 0,
          target: { type: "structure", id: "p-2" },
          body: "from a file",
        })
      );
      const r = await f.json(["annotation", "create", "--json", file]);
      expect(r.status).toBe(0);
      expect(r.body).toMatchObject({ ok: true, annotation: { target: { type: "structure" } } });
    });

    test("PDF workbench annotations: create-pdf, update-pdf, delete-pdf; the PDF is never changed", {
      timeout: 180_000,
    }, async () => {
      const f = await prepare();
      const { syntheticPdf } = await import("../../server/tests/pdf-fixture.js");
      const bytes = syntheticPdf({ pageCount: 2 });
      const metadata = publishPdfDoc(f.paths, {
        workId: W1,
        filename: "synthetic.pdf",
        bytes,
        pages: (await probePdf(bytes)).pages,
      });
      const pdf = metadata.doc_id;
      const originalPath = join(f.dataDir, "output", pdf, "original.pdf");
      const original = readFileSync(originalPath);
      const reading = await f.json(["reader", "read", "--doc-id", pdf]);
      expect(reading.body.reading.sha256).toBe(metadata.sha256);
      const rev = reading.body.reading.annotationsRev as number;
      const made = await f.json([
        "annotation",
        "create-pdf",
        "--doc-id",
        pdf,
        "--sha256",
        metadata.sha256,
        "--rev",
        String(rev),
        "--kind",
        "rectangle",
        "--page-index",
        "0",
        "--rectangle",
        '{"x":0.1,"y":0.1,"width":0.3,"height":0.2}',
        "--body",
        "a box",
      ]);
      expect(made.status).toBe(0);
      expect(made.body).toMatchObject({
        ok: true,
        status: "ok",
        epoch: { annotationsRev: rev + 1 },
      });
      const stale = await f.json([
        "annotation",
        "create-pdf",
        "--doc-id",
        pdf,
        "--sha256",
        metadata.sha256,
        "--rev",
        String(rev),
        "--kind",
        "document_comment",
        "--body",
        "stale",
      ]);
      expect(stale.status).toBe(1);
      expect(stale.body).toMatchObject({ ok: false, status: "conflict", reason: "rev_mismatch" });
      const updated = await f.json([
        "annotation",
        "update-pdf",
        "--doc-id",
        pdf,
        "--sha256",
        metadata.sha256,
        "--rev",
        String(rev + 1),
        "--annotation-id",
        made.body.annotation.id,
        "--expected-updated-at",
        made.body.annotation.updated_at,
        "--body",
        "a bigger box",
        "--rectangle",
        '{"x":0.1,"y":0.1,"width":0.5,"height":0.4}',
      ]);
      expect(updated.status).toBe(0);
      const deleted = await f.json([
        "annotation",
        "delete-pdf",
        "--doc-id",
        pdf,
        "--sha256",
        metadata.sha256,
        "--rev",
        String(updated.body.epoch.annotationsRev),
        "--annotation-id",
        made.body.annotation.id,
        "--expected-updated-at",
        updated.body.annotation.updated_at,
      ]);
      expect(deleted.status).toBe(0);
      expect(deleted.body).toMatchObject({ ok: true, deleted: made.body.annotation.id });
      expect(readFileSync(originalPath).equals(original)).toBe(true);
      const page = await f.json([
        "reader",
        "read-page-image",
        "--doc-id",
        pdf,
        "--page-index",
        "0",
        "--sha256",
        metadata.sha256,
        "--long-edge",
        "256",
      ]);
      expect(page.status).toBe(0);
      expect(Buffer.from(page.body.data, "base64").subarray(1, 4).toString("latin1")).toBe("PNG");
    });
  });
}

test("the groups are in --help and the frozen `annot` keeps its own place", {
  timeout: 60_000,
}, async () => {
  const f = setup();
  const help = (await f.run(["--help"])).stdout;
  for (const word of ["annotation", "reader", "text", "annot "]) expect(help).toContain(word);
  const group = (await f.run(["annotation", "--help"])).stdout;
  for (const name of ["create", "update", "delete", "create-pdf", "update-pdf", "delete-pdf"])
    expect(group).toContain(name);
  // `annot` has no write subcommand and no catalog option
  expect((await f.run(["annot", "--help"])).stdout).not.toContain("--body");
});
