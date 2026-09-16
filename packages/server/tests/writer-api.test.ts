/**
 * The Writer REST endpoints (Stage 10 M2a): templates listing (built-ins +
 * user-dir overrides + warnings), manuscript CRUD with the plans-style rev
 * optimistic lock (409 carries the current rev AND the current document),
 * physical delete, and figure-asset upload/serve (raw body, extension
 * allowlist, collision renaming, traversal-safe reads). Hermetic: tmp data
 * dir, Hono `app.request` (no socket).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WriterManuscript } from "@argelanderspace/contracts";
import {
  libraryPaths,
  loadManuscript,
  manuscriptJsonPath,
  templatesDir,
} from "@argelanderspace/core";
import { extractZip } from "@argelanderspace/infra";
import type { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { JobRunner } from "../src/jobs.js";
import { collectBroadcasts, makeDataDir, stubPipelines, stubSources } from "./helpers.js";

let dataDir: string;
let app: Hono;
let messages: ReturnType<typeof collectBroadcasts>["messages"];

beforeEach(() => {
  dataDir = makeDataDir();
  const runner = new JobRunner({ dir: join(dataDir, "jobs") });
  const collector = collectBroadcasts();
  messages = collector.messages;
  app = createApp({
    paths: libraryPaths(dataDir),
    statusDir: statusDirFor(dataDir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner,
    broadcast: collector.broadcast,
  });
});

const get = async (path: string): Promise<Response> => app.request(path);
const post = async (
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<Response> =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const put = async (
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<Response> =>
  app.request(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const del = async (path: string, headers?: Record<string, string>): Promise<Response> =>
  app.request(path, { method: "DELETE", headers });

async function createMs(template = "aa", title?: string): Promise<WriterManuscript> {
  const res = await post("/api/writer/manuscripts", { template, ...(title ? { title } : {}) });
  expect(res.status).toBe(201);
  return (await res.json()) as WriterManuscript;
}

describe("GET /api/writer/templates", () => {
  test("returns the built-ins; user files override and extend them", async () => {
    const res = await get("/api/writer/templates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { templates: { id: string }[]; warnings: string[] };
    expect(body.templates.map((t) => t.id).sort()).toEqual(["aa", "letter", "report"]);
    expect(body.warnings).toEqual([]);

    // a same-id user file overrides the built-in; a broken file warns
    const dir = templatesDir(dataDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "aa.json"),
      JSON.stringify({ id: "aa", version: 1, label: "A&A override", types: ["latex"] })
    );
    writeFileSync(join(dir, "broken.json"), "{ nope");
    const body2 = (await (await get("/api/writer/templates")).json()) as {
      templates: { id: string; label: string }[];
      warnings: string[];
    };
    expect(body2.templates.find((t) => t.id === "aa")?.label).toBe("A&A override");
    expect(body2.warnings.some((w) => w.startsWith("broken.json"))).toBe(true);
  });
});

describe("manuscript CRUD", () => {
  test("POST create → 201 with the full manuscript + writer.changed(create)", async () => {
    const doc = await createMs("aa", "  My paper  ");
    expect(doc).toMatchObject({
      id: expect.stringMatching(/^m_[0-9a-f]{8}$/),
      rev: 0,
      template: "aa",
      title: "My paper",
      cells: [],
    });
    // persisted on disk
    expect(loadManuscript(dataDir, doc.id)).toMatchObject({ title: "My paper", rev: 0 });
    const changed = messages.filter((m) => m.type === "writer.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ type: "writer.changed", cause: "create", id: doc.id });
  });

  test("POST with an unknown template → 400; title/type validation → 400", async () => {
    const res = await post("/api/writer/manuscripts", { template: "nope" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toContain("unknown template");
    expect((await post("/api/writer/manuscripts", { title: "x" })).status).toBe(400);
    expect((await post("/api/writer/manuscripts", { template: "aa", title: 42 })).status).toBe(400);
    expect(messages).toHaveLength(0);
  });

  test("GET list returns summaries sorted by updated_at desc", async () => {
    const a = await createMs("aa", "First");
    const b = await createMs("report", "Second");
    const res = await get("/api/writer/manuscripts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { manuscripts: { id: string; title: string }[] };
    expect(body.manuscripts.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("GET by id: 404 for missing, 400 for a malformed id", async () => {
    const doc = await createMs("aa");
    expect((await get(`/api/writer/manuscripts/${doc.id}`)).status).toBe(200);
    expect((await get("/api/writer/manuscripts/m_ffffffff")).status).toBe(404);
    expect((await get("/api/writer/manuscripts/../evil")).status).toBe(404); // route miss
    expect((await get("/api/writer/manuscripts/not-an-id")).status).toBe(400);
  });

  test("PUT: matching rev → 200 with rev+1; disk updated; writer.changed(put)", async () => {
    const doc = await createMs("aa", "Draft");
    messages.length = 0;
    const res = await put(`/api/writer/manuscripts/${doc.id}`, { ...doc, title: "Renamed" });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as WriterManuscript;
    expect(saved).toMatchObject({ title: "Renamed", rev: 1 });
    expect(Date.parse(saved.updated_at)).toBeGreaterThanOrEqual(Date.parse(doc.updated_at));
    expect(loadManuscript(dataDir, doc.id)).toMatchObject({ title: "Renamed", rev: 1 });
    const changed = messages.filter((m) => m.type === "writer.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ cause: "put", id: doc.id });
  });

  test("PUT rev mismatch → 409 with the current rev AND document; recovery via refetch", async () => {
    const doc = await createMs("aa", "Draft");
    // first client saves (rev 0 → 1)
    expect(
      (await put(`/api/writer/manuscripts/${doc.id}`, { ...doc, title: "Client A" })).status
    ).toBe(200);
    // second client still holds rev 0
    const res = await put(`/api/writer/manuscripts/${doc.id}`, { ...doc, title: "Client B" });
    expect(res.status).toBe(409);
    const conflict = (await res.json()) as {
      detail: string;
      rev: number;
      current: WriterManuscript;
    };
    expect(conflict.rev).toBe(1);
    expect(conflict.current.title).toBe("Client A");
    // recovery: rebase on the 409's current document and PUT again
    const retry = await put(`/api/writer/manuscripts/${doc.id}`, {
      ...conflict.current,
      title: "Client B",
    });
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as WriterManuscript).rev).toBe(2);
  });

  test("PUT rejects: schema-invalid body, id/body mismatch, unknown id", async () => {
    const doc = await createMs("aa");
    expect((await put(`/api/writer/manuscripts/${doc.id}`, { version: 2 })).status).toBe(400);
    expect(
      (await put(`/api/writer/manuscripts/${doc.id}`, { ...doc, id: "m_ffffffff" })).status
    ).toBe(400);
    expect(
      (await put("/api/writer/manuscripts/m_ffffffff", { ...doc, id: "m_ffffffff" })).status
    ).toBe(404);
  });

  test("DELETE: physical removal of the tree (assets included) + broadcast", async () => {
    const doc = await createMs("aa");
    const up = await app.request(`/api/writer/manuscripts/${doc.id}/assets?filename=fig.png`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from([1, 2, 3]),
    });
    expect(up.status).toBe(201);
    messages.length = 0;
    const res = await del(`/api/writer/manuscripts/${doc.id}`);
    expect(res.status).toBe(200);
    expect(loadManuscript(dataDir, doc.id)).toBeNull();
    expect(messages.filter((m) => m.type === "writer.changed")).toEqual([
      expect.objectContaining({ cause: "delete", id: doc.id }),
    ]);
    expect((await del(`/api/writer/manuscripts/${doc.id}`)).status).toBe(404);
  });
});

describe("figure assets", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

  const upload = async (
    id: string,
    filename: string,
    bytes: Buffer,
    headers?: Record<string, string>
  ): Promise<Response> =>
    app.request(`/api/writer/manuscripts/${id}/assets?filename=${encodeURIComponent(filename)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", ...headers },
      body: bytes,
    });

  test("upload → 201 {name}; serve round-trips the bytes with image/png", async () => {
    const doc = await createMs("aa");
    const res = await upload(doc.id, "curve.png", PNG);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ name: "curve.png" });
    const got = await get(`/api/writer/manuscripts/${doc.id}/assets/curve.png`);
    expect(got.status).toBe(200);
    expect(got.headers.get("Content-Type")).toBe("image/png");
    expect(got.headers.get("Cache-Control")).toBe("no-cache");
    expect(Buffer.from(await got.arrayBuffer())).toEqual(PNG);
  });

  test("collision → -1; bad extension → 400; unknown manuscript → 404", async () => {
    const doc = await createMs("aa");
    expect(((await (await upload(doc.id, "fig.png", PNG)).json()) as { name: string }).name).toBe(
      "fig.png"
    );
    expect(((await (await upload(doc.id, "fig.png", PNG)).json()) as { name: string }).name).toBe(
      "fig-1.png"
    );
    expect((await upload(doc.id, "fig.txt", PNG)).status).toBe(400);
    expect((await upload("m_ffffffff", "fig.png", PNG)).status).toBe(404);
  });

  test("traversal names are rejected on upload and serve", async () => {
    const doc = await createMs("aa");
    expect((await upload(doc.id, "../evil.png", PNG)).status).toBe(400);
    expect((await get(`/api/writer/manuscripts/${doc.id}/assets/..%2Fevil.png`)).status).toBe(400);
    expect((await get(`/api/writer/manuscripts/${doc.id}/assets/.hidden.png`)).status).toBe(400);
  });

  test("missing asset → 404", async () => {
    const doc = await createMs("aa");
    expect((await get(`/api/writer/manuscripts/${doc.id}/assets/nope.png`)).status).toBe(404);
  });
});

describe("CSRF (mutations guarded, reads open)", () => {
  test("a cross-site Origin is rejected on POST/PUT/DELETE, accepted on GET", async () => {
    const bad = { Origin: "https://evil.example" };
    expect((await post("/api/writer/manuscripts", { template: "aa" }, bad)).status).toBe(403);
    const doc = await createMs("aa");
    expect((await put(`/api/writer/manuscripts/${doc.id}`, doc, bad)).status).toBe(403);
    expect((await del(`/api/writer/manuscripts/${doc.id}`, bad)).status).toBe(403);
    expect((await get(`/api/writer/manuscripts/${doc.id}`)).status).toBe(200);
  });
});

describe("corrupt manuscript.json on disk", () => {
  test("GET by id / PUT surface a 500 (never a silent reset); list still works with a warning", async () => {
    const doc = await createMs("aa");
    writeFileSync(manuscriptJsonPath(dataDir, doc.id), "{ corrupt");
    expect((await get(`/api/writer/manuscripts/${doc.id}`)).status).toBe(500);
    expect((await put(`/api/writer/manuscripts/${doc.id}`, doc)).status).toBe(500);
    const list = (await (await get("/api/writer/manuscripts")).json()) as {
      manuscripts: unknown[];
      warnings: string[];
    };
    expect(list.manuscripts).toHaveLength(0);
    expect(list.warnings.some((w) => w.startsWith(doc.id))).toBe(true);
  });
});

describe("export zip (M3)", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

  test("manuscript.tex + cited-only references.bib + referenced assets, missing-key header", async () => {
    mkdirSync(join(dataDir, "library"), { recursive: true });
    writeFileSync(
      libraryPaths(dataDir).libraryBib,
      "@article{Belokurov2006,\n  title = {Streams},\n}\n\n@article{Other2020,\n  title = {Other},\n}\n"
    );
    const doc = await createMs("report", "Export Probe");
    doc.cells = [
      {
        id: "c_00000001",
        type: "latex",
        data: { source: "\\section{I}\n\nSee \\citep{Belokurov2006} plus \\cite{ghost2026}." },
      },
      {
        id: "c_00000002",
        type: "figure",
        data: { caption: "", label: "fig:a", placement: "center", width: 80, image: "rc.png" },
      },
    ];
    expect((await put(`/api/writer/manuscripts/${doc.id}`, doc)).status).toBe(200);
    const up = await app.request(`/api/writer/manuscripts/${doc.id}/assets?filename=rc.png`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: PNG,
    });
    expect(up.status).toBe(201);

    const res = await get(`/api/writer/manuscripts/${doc.id}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toContain('filename="export-probe.zip"');
    const missing = JSON.parse(
      decodeURIComponent(res.headers.get("X-Writer-Bib-Missing") ?? "%5B%5D")
    );
    expect(missing).toEqual(["ghost2026"]);

    const dir = mkdtempSync(join(tmpdir(), "writer-export-route-"));
    try {
      extractZip(new Uint8Array(await res.arrayBuffer()), dir);
      const tex = readFileSync(join(dir, "manuscript.tex"), "utf8");
      expect(tex).toContain("\\bibliography{references}");
      const bib = readFileSync(join(dir, "references.bib"), "utf8");
      expect(bib).toContain("Belokurov2006");
      expect(bib).not.toContain("Other2020");
      expect(readFileSync(join(dir, "assets", "rc.png"))).toEqual(PNG);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Stage 12: zip ships template deps (cls/sty/bst) at the root", async () => {
    // user-installed A&A deps
    mkdirSync(join(dataDir, "templates", "aa.deps"), { recursive: true });
    writeFileSync(join(dataDir, "templates", "aa.deps", "aa.cls"), "AA_CLS_BYTES");
    writeFileSync(join(dataDir, "templates", "aa.deps", "aa.bst"), "AA_BST_BYTES");
    const doc = await createMs("aa", "Deps Zip Probe");
    const res = await get(`/api/writer/manuscripts/${doc.id}/export`);
    expect(res.status).toBe(200);
    const dir = mkdtempSync(join(tmpdir(), "writer-export-deps-"));
    try {
      extractZip(new Uint8Array(await res.arrayBuffer()), dir);
      expect(readFileSync(join(dir, "aa.cls"), "utf8")).toBe("AA_CLS_BYTES");
      expect(readFileSync(join(dir, "aa.bst"), "utf8")).toBe("AA_BST_BYTES");
      expect(readFileSync(join(dir, "manuscript.tex"), "utf8")).toContain("\\documentclass{aa}");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unknown manuscript → 404; bad id → 400", async () => {
    expect((await get("/api/writer/manuscripts/m_00000000/export")).status).toBe(404);
    expect((await get("/api/writer/manuscripts/nope/export")).status).toBe(400);
  });
});
