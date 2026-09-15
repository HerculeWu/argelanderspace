/**
 * Writer numbering channel (Stage 10 M3, D14): the deps-missing fast path,
 * the 400/404 route errors, the debounce scheduler (injected compute), and a
 * REAL single-pass pdflatex compile over an assembled manuscript (gated on
 * the engine being available, mirroring the infra HAVE_LATEXMK idiom).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WriterManuscript } from "@argelanderspace/contracts";
import { libraryPaths, templatesDir } from "@argelanderspace/core";
import { haveTexEngine } from "@argelanderspace/infra";
import type { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { JobRunner } from "../src/jobs.js";
import {
  __setNumberingComputeForTests,
  scheduleNumberingCompile,
} from "../src/writer-numbering.js";
import { collectBroadcasts, makeDataDir, stubPipelines, stubSources } from "./helpers.js";

const PD = haveTexEngine("pdflatex");
if (!PD) console.warn("pdflatex not on PATH — writer numbering real-compile test skipped");

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
const post = async (path: string, body?: unknown): Promise<Response> =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function createMs(template: string, title?: string): Promise<WriterManuscript> {
  const res = await post("/api/writer/manuscripts", { template, ...(title ? { title } : {}) });
  expect(res.status).toBe(201);
  return (await res.json()) as WriterManuscript;
}

describe("numbering routes", () => {
  test("unknown manuscript → 404 on both routes; bad id → 400", async () => {
    expect((await get("/api/writer/manuscripts/m_00000000/numbering")).status).toBe(404);
    expect((await get("/api/writer/manuscripts/nope/numbering")).status).toBe(400);
    expect((await post("/api/writer/manuscripts/m_00000000/numbering/refresh")).status).toBe(404);
    expect((await post("/api/writer/manuscripts/nope/numbering/refresh")).status).toBe(400);
  });

  test("fresh manuscript: status never (no compile file yet)", async () => {
    const doc = await createMs("report");
    const res = await get(`/api/writer/manuscripts/${doc.id}/numbering`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "never", facts: null, lastError: null });
  });

  test("deps-missing fast path: aa template without templates/aa.deps/aa.cls → stale, no compile", async () => {
    const doc = await createMs("aa");
    const res = await post(`/api/writer/manuscripts/${doc.id}/numbering/refresh`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; lastError: string | null };
    expect(body.status).toBe("stale");
    expect(body.lastError).toContain("aa.cls");
    expect(body.lastError).toContain(templatesDir(dataDir));
    // no compile was attempted: no build/numbering.json → wait, the failure
    // file IS persisted; assert there is no events artifact instead.
    expect(() =>
      readFileSync(join(dataDir, "manuscripts", doc.id, "build", "main.argelander.jsonl"), "utf8")
    ).toThrow();
  });

  test("bound template no longer loadable → stale with lastError", async () => {
    const doc = await createMs("report");
    const raw = JSON.parse(
      readFileSync(join(dataDir, "manuscripts", doc.id, "manuscript.json"), "utf8")
    ) as Record<string, unknown>;
    raw.template = "ghost-template";
    writeFileSync(join(dataDir, "manuscripts", doc.id, "manuscript.json"), JSON.stringify(raw));
    const res = await get(`/api/writer/manuscripts/${doc.id}/numbering`);
    const body = (await res.json()) as { status: string; lastError: string | null };
    expect(body.status).toBe("stale");
    expect(body.lastError).toContain("ghost-template");
  });

  test("numbering cache file is a derived cache: corrupt file → status never", async () => {
    const doc = await createMs("report");
    mkdirSync(join(dataDir, "manuscripts", doc.id, "build"), { recursive: true });
    writeFileSync(join(dataDir, "manuscripts", doc.id, "build", "numbering.json"), "{ corrupt");
    const res = await get(`/api/writer/manuscripts/${doc.id}/numbering`);
    expect(((await res.json()) as { status: string }).status).toBe("never");
  });
});

describe("numbering scheduler", () => {
  test("two schedules inside the debounce window coalesce into one compile", async () => {
    const doc = await createMs("report");
    const compute = vi.fn(async () => ({
      version: 1 as const,
      at: new Date().toISOString(),
      texHash: "x",
      facts: null,
      lastError: "injected failure",
    }));
    const restore = __setNumberingComputeForTests(compute);
    try {
      const broadcasts: unknown[] = [];
      scheduleNumberingCompile(dataDir, doc.id, { broadcast: (m) => broadcasts.push(m) });
      scheduleNumberingCompile(dataDir, doc.id, { broadcast: (m) => broadcasts.push(m) });
      await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1), { timeout: 5000 });
      expect(broadcasts).toEqual([]); // injected failure: no broadcast
    } finally {
      restore();
    }
  });

  test("a schedule during an in-flight compile runs exactly one follow-up", async () => {
    const doc = await createMs("report");
    let calls = 0;
    const compute = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        // a second schedule lands while the first compile is in flight
        scheduleNumberingCompile(dataDir, doc.id, { broadcast: () => {} });
        // simulate the debounce already elapsed: directly await the slow path
        await new Promise((r) => setTimeout(r, 30));
      }
      return {
        version: 1 as const,
        at: new Date().toISOString(),
        texHash: "x",
        facts: { sections: [], equations: [], labels: {} },
        lastError: null,
      };
    });
    const restore = __setNumberingComputeForTests(compute);
    try {
      scheduleNumberingCompile(dataDir, doc.id, { broadcast: () => {} });
      await vi.waitFor(() => expect(calls).toBe(1), { timeout: 5000 });
      await vi.waitFor(() => expect(calls).toBe(2), { timeout: 5000 });
      await new Promise((r) => setTimeout(r, 100));
      expect(calls).toBe(2); // no third compile
    } finally {
      restore();
    }
  });
});

describe("real compile (gated on pdflatex)", () => {
  test.skipIf(!PD)(
    "single-pass compile yields true numbers; editing flips status to stale",
    async () => {
      const doc = await createMs("report", "Numbering Probe");
      doc.cells = [
        {
          id: "c_00000001",
          type: "latex",
          data: {
            source:
              "\\chapter{First}\n\\label{ch:one}\n\n\\section{Intro}\n\\label{sec:intro}\n\nText.\n\n\\begin{equation}\n  v_c^2 = GM(r)/r\n  \\label{eq:vc}\n\\end{equation}",
          },
        },
      ];
      const putRes = await app.request(`/api/writer/manuscripts/${doc.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(doc),
      });
      expect(putRes.status).toBe(200);

      const res = await post(`/api/writer/manuscripts/${doc.id}/numbering/refresh`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        facts: {
          sections: { number: string; title: string; cell: string | null; label: string | null }[];
          equations: { number: string; env: string; cell: string | null; label: string | null }[];
          labels: Record<string, string>;
        } | null;
        lastError: string | null;
      };
      expect(body.status).toBe("ok");
      expect(body.lastError).toBeNull();
      expect(body.facts?.sections).toEqual([
        { number: "1.1", title: "Intro", cell: "c_00000001", label: "sec:intro" },
      ]);
      expect(body.facts?.equations).toEqual([
        { number: "1.1", env: "equation", cell: "c_00000001", label: "eq:vc" },
      ]);
      expect(body.facts?.labels["sec:intro"]).toBe("1.1");
      expect(body.facts?.labels["eq:vc"]).toBe("1.1");
      // success broadcast
      expect(
        messages.some(
          (m) => m.type === "writer.changed" && m.cause === "numbering" && m.id === doc.id
        )
      ).toBe(true);
      // persisted file
      const file = JSON.parse(
        readFileSync(join(dataDir, "manuscripts", doc.id, "build", "numbering.json"), "utf8")
      );
      expect(file.facts.sections[0].number).toBe("1.1");
      expect(file.lastError).toBeNull();

      // edit the manuscript → hash moves → stale
      const doc2 = (await (
        await get(`/api/writer/manuscripts/${doc.id}`)
      ).json()) as WriterManuscript;
      if (doc2.cells[0])
        (doc2.cells[0].data as Record<string, unknown>).source = "\\chapter{First}\n\nChanged.";
      const put2 = await app.request(`/api/writer/manuscripts/${doc.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(doc2),
      });
      expect(put2.status).toBe(200);
      const stale = await get(`/api/writer/manuscripts/${doc.id}/numbering`);
      expect(((await stale.json()) as { status: string }).status).toBe("stale");
    },
    60_000
  );
});
