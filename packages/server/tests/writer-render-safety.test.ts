/**
 * Spec 14.1 for Render (copilot ticket 23): a REAL latexmk/pdflatex compile of a manuscript. TeX Live's default lets a
 * document \input any readable absolute path; the Writer compile now runs with paranoid file access, so text that got
 * past (or around) the agent-text screening still cannot read outside the compile workspace. Gated on the engine like
 * the other real-compile tests (a skip is not a pass).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WriterManuscript, WriterNumberingResponse } from "@argelanderspace/contracts";
import { libraryPaths } from "@argelanderspace/core";
import { haveLatexmk } from "@argelanderspace/infra";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { JobRunner } from "../src/jobs.js";
import { stubPipelines, stubSources } from "./helpers.js";

const HAVE = haveLatexmk();
if (!HAVE) console.warn("latexmk not on PATH — writer render-safety real-compile test skipped");

describe.skipIf(!HAVE)("a real Writer compile reads only its own workspace", () => {
  const compile = async (source: string): Promise<WriterNumberingResponse> => {
    const dataDir = mkdtempSync(join(tmpdir(), "writer-render-safety-"));
    const secret = join(dataDir, "outside-secret.txt");
    writeFileSync(secret, "TOP-SECRET-OUTSIDE-FILE-CONTENT\n");
    const app = createApp({
      paths: libraryPaths(dataDir),
      statusDir: statusDirFor(dataDir),
      makeSources: () => stubSources(),
      pipelines: stubPipelines(),
      runner: new JobRunner({ dir: join(dataDir, "jobs") }),
      broadcast: () => {},
    });
    const created = (await (
      await app.request("/api/writer/manuscripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template: "report", title: "Safety" }),
      })
    ).json()) as WriterManuscript;
    created.cells = [
      { id: "c_00000001", type: "latex", data: { source: source.replace("@SECRET@", secret) } },
    ] as never;
    expect(
      (
        await app.request(`/api/writer/manuscripts/${created.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(created),
        })
      ).status
    ).toBe(200);
    const res = await app.request(`/api/writer/manuscripts/${created.id}/numbering/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    mkdirSync(dataDir, { recursive: true });
    return (await res.json()) as WriterNumberingResponse;
  };

  test("an ordinary manuscript compiles to a preview", async () => {
    const out = await compile("\\section{Fine}\nPlain text with $x^2$.");
    expect(out.lastError).toBeNull();
    expect(out.status).toBe("ok");
  }, 120_000);

  test("\\input of an absolute path outside the workspace is refused and its content never reaches the preview", async () => {
    const out = await compile("\\section{Peek}\n\\input{@SECRET@}");
    expect(JSON.stringify(out)).not.toContain("TOP-SECRET-OUTSIDE-FILE-CONTENT");
    // The engine's log wraps lines: compare without whitespace.
    expect((out.lastError ?? "").replace(/\s+/g, "")).toMatch(/notfound|Notreading/i);
    expect(out.status).not.toBe("ok");
  }, 120_000);
});
