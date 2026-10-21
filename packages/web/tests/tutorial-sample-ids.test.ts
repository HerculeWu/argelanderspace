import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SAMPLE_ANNOTATION_IDS,
  SAMPLE_ARGUMENT_IDS,
  SAMPLE_CELL_IDS,
  SAMPLE_DOC_ID,
  SAMPLE_LAST_CELL_ID,
  SAMPLE_MANUSCRIPT_ID,
  SAMPLE_PLAN_ID,
  SAMPLE_TASK_IDS,
  SAMPLE_TEXT_ANNOTATION_BLOCK,
  SAMPLE_WORK_IDS,
} from "../src/tutorial/sample-ids";

// in-app-tutorial ticket 17: every stable id the tutorial uses is really in tutorial-sample/ (repository root), each
// as the kind of object the tutorial takes it for. (node:url's URL, not happy-dom's, so fileURLToPath accepts it.)
const SAMPLE = fileURLToPath(new NodeURL("../../../tutorial-sample", import.meta.url));
const LIT = join(SAMPLE, "literatures");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("the tutorial sample ids", () => {
  it("names the five Works of the sample library, and the Doc is Jerabkova's main Doc", () => {
    const works: { id: string; doc_ids?: string[] }[] = json(join(LIT, "library", "library.json")).works;
    expect(works.map((w) => w.id).sort()).toEqual(Object.values(SAMPLE_WORK_IDS).sort());
    const jerabkova = works.find((w) => w.id === SAMPLE_WORK_IDS.jerabkova2021);
    expect(jerabkova?.doc_ids?.[0]).toBe(SAMPLE_DOC_ID);
    expect(existsSync(join(LIT, "output", SAMPLE_DOC_ID, `${SAMPLE_DOC_ID}.json`))).toBe(true);
  });

  it("names the three preset annotations of that Doc, one per target type", () => {
    const file = json(join(LIT, "annotations", SAMPLE_DOC_ID, "current.json"));
    const byId = new Map<string, string>(
      file.annotations.map((a: { id: string; target: { type: string } }) => [a.id, a.target.type])
    );
    expect(byId.size).toBe(3);
    expect(byId.get(SAMPLE_ANNOTATION_IDS.document)).toBe("document");
    expect(byId.get(SAMPLE_ANNOTATION_IDS.figure)).toBe("structure");
    expect(byId.get(SAMPLE_ANNOTATION_IDS.text)).toBe("text");
    // The block the text annotation sits in: its gutter (`latex-annotation-gutter[<block>]`) is a rung of step 3.4.
    const text = file.annotations.find((x: { id: string }) => x.id === SAMPLE_ANNOTATION_IDS.text);
    expect(text.target.block).toBe(SAMPLE_TEXT_ANNOTATION_BLOCK);
  });

  it("names the preset Plan and its Tasks", () => {
    const plans: { id: string; tasks: { id: string }[] }[] = json(
      join(SAMPLE, "status", "plans.json")
    ).plans;
    const plan = plans.find((p) => p.id === SAMPLE_PLAN_ID);
    expect(plan).toBeDefined();
    for (const task of SAMPLE_TASK_IDS) expect(plan?.tasks.map((t) => t.id)).toContain(task);
  });

  it("names the review manuscript and its cells in order", () => {
    const manuscript = json(join(LIT, "manuscripts", SAMPLE_MANUSCRIPT_ID, "manuscript.json"));
    expect(manuscript.id).toBe(SAMPLE_MANUSCRIPT_ID);
    const cells: string[] = manuscript.cells.map((c: { id: string }) => c.id);
    expect(cells).toEqual([...SAMPLE_CELL_IDS]);
    expect(cells[cells.length - 1]).toBe(SAMPLE_LAST_CELL_ID);
  });

  it("names Jerabkova's End argument and the unlinked Native argument", () => {
    const dir = join(LIT, "argument-graphs");
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const graph = json(join(dir, files[0] as string));
    expect(graph.work_id).toBe(SAMPLE_WORK_IDS.jerabkova2021);
    const kind = (id: string) =>
      graph.arguments.find((a: { id: string }) => a.id === id)?.kind as string | undefined;
    expect(kind(SAMPLE_ARGUMENT_IDS.end)).toBe("end");
    expect(kind(SAMPLE_ARGUMENT_IDS.orphanNative)).toBe("native");
    const touched = graph.edges.some(
      (e: { from: string; to: string }) =>
        e.from === SAMPLE_ARGUMENT_IDS.orphanNative || e.to === SAMPLE_ARGUMENT_IDS.orphanNative
    );
    expect(touched).toBe(false);
  });
});
