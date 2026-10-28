import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SAMPLE_ANNOTATION_IDS,
  SAMPLE_ARGUMENT_IDS,
  SAMPLE_CELL_IDS,
  SAMPLE_CONVERSATION,
  SAMPLE_COPILOT_CELL_ID,
  SAMPLE_COPILOT_TASK_ID,
  SAMPLE_DOC_ID,
  SAMPLE_INTAKE_CONVERSATION,
  SAMPLE_JERABKOVA_ARXIV,
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
    const works: { id: string; doc_ids?: string[]; arxiv_id?: string }[] = json(join(LIT, "library", "library.json")).works;
    expect(works.map((w) => w.id).sort()).toEqual(Object.values(SAMPLE_WORK_IDS).sort());
    const jerabkova = works.find((w) => w.id === SAMPLE_WORK_IDS.jerabkova2021);
    expect(jerabkova?.doc_ids?.[0]).toBe(SAMPLE_DOC_ID);
    expect(jerabkova?.arxiv_id).toBe(SAMPLE_JERABKOVA_ARXIV);
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

  it("names the preset Copilot conversation, its three user messages, and the Task and cell it made", () => {
    const record = json(join(LIT, "copilot", "conversations", `${SAMPLE_CONVERSATION.id}.json`));
    expect(record.id).toBe(SAMPLE_CONVERSATION.id);
    const session = join(LIT, "copilot", "sessions", `${record.sessionId}.jsonl`);
    expect(existsSync(session)).toBe(true);
    // The panel's user messages carry the request's messageId (the JSON a user entry of the Pi session holds).
    const asked: string[] = [];
    for (const line of readFileSync(session, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.type !== "message" || entry.message?.role !== "user") continue;
      for (const part of entry.message.content ?? []) {
        if (part.type !== "text") continue;
        try {
          const request = JSON.parse(part.text);
          if (typeof request.messageId === "string") asked.push(request.messageId);
        } catch {
          // a plain-text user part is not a request
        }
      }
    }
    expect(asked).toEqual([...SAMPLE_CONVERSATION.questions]);
    // The Task and the cell the conversation made are in the sample's Plan and manuscript, and among the preset ids.
    const plan = json(join(SAMPLE, "status", "plans.json")).plans.find((p: { id: string }) => p.id === SAMPLE_PLAN_ID);
    expect(plan.tasks.map((t: { id: string }) => t.id)).toContain(SAMPLE_COPILOT_TASK_ID);
    expect(SAMPLE_TASK_IDS).toContain(SAMPLE_COPILOT_TASK_ID);
    const manuscript = json(join(LIT, "manuscripts", SAMPLE_MANUSCRIPT_ID, "manuscript.json"));
    expect(manuscript.cells.map((c: { id: string }) => c.id)).toContain(SAMPLE_COPILOT_CELL_ID);
    expect(SAMPLE_CELL_IDS).toContain(SAMPLE_COPILOT_CELL_ID);
  });

  it("names the two replies that carry the conversation's operations: a Plan task after the second question, a cell after the third", () => {
    const record = json(join(LIT, "copilot", "conversations", `${SAMPLE_CONVERSATION.id}.json`));
    const entries = readFileSync(join(LIT, "copilot", "sessions", `${record.sessionId}.jsonl`), "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    // The panel's assistant messages carry the session entry's id; an operation is a tool call of that message.
    const messages = entries.filter((e) => e.type === "message");
    const questionAt = (messageId: string) =>
      messages.findIndex((e) => e.message?.role === "user" && (e.message.content ?? []).some((part: { type: string; text?: string }) => part.type === "text" && part.text?.includes(messageId)));
    const toolCalls = (e: { message?: { content?: { type: string; name?: string; arguments?: { action?: string } }[] } }) =>
      (e.message?.content ?? []).filter((part) => part.type === "toolCall").map((part) => `${part.name}:${part.arguments?.action}`);
    const [plan, writer] = SAMPLE_CONVERSATION.operationReplies;
    const at = (id: string) => messages.findIndex((e) => e.id === id);
    expect(messages[at(plan)]?.message.role).toBe("assistant");
    expect(toolCalls(messages[at(plan)])).toEqual(["plan:create_task"]);
    expect(at(plan)).toBeGreaterThan(questionAt(SAMPLE_CONVERSATION.questions[1]));
    expect(at(plan)).toBeLessThan(questionAt(SAMPLE_CONVERSATION.questions[2]));
    expect(messages[at(writer)]?.message.role).toBe("assistant");
    expect(toolCalls(messages[at(writer)])).toEqual(["writer:insert_cell"]);
    expect(at(writer)).toBeGreaterThan(questionAt(SAMPLE_CONVERSATION.questions[2]));
    // No other reply carries a tool call: the chapter's operation anchors name every operation card there is.
    const withTools = messages.filter((e) => e.message?.role === "assistant" && toolCalls(e).length > 0).map((e) => e.id);
    expect(withTools).toEqual([plan, writer]);
  });

  // Chapter 9's preset move-in conversation (project-intake ticket 10 recorded it, ticket 15 re-recorded it): `null` until then; once set, it is
  // in the sample as a saved conversation whose session holds the two named replies as assistant messages. The recording runs with file permission on "ask",
  // so decided file-write confirmation cards may appear around them (the server's sample guard judges those).
  it("names the preset move-in conversation and its two replies, when the sample holds one", () => {
    if (SAMPLE_INTAKE_CONVERSATION === null) return;
    const record = json(join(LIT, "copilot", "conversations", `${SAMPLE_INTAKE_CONVERSATION.id}.json`));
    expect(record.id).toBe(SAMPLE_INTAKE_CONVERSATION.id);
    const session = join(LIT, "copilot", "sessions", `${record.sessionId}.jsonl`);
    const entries = readFileSync(session, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
    for (const key of Object.values(SAMPLE_INTAKE_CONVERSATION.replies)) {
      const entry = entries.find((e) => e.type === "message" && e.id === key);
      expect(entry?.message.role, key).toBe("assistant");
    }
    // By content, not only by role: the two ids are not interchangeable.
    const textOf = (e: { message?: { content?: { type: string; text?: string }[] } } | undefined) =>
      (e?.message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
    const messages = entries.filter((e) => e.type === "message");
    // the interview is the reply that ends the first turn: the last assistant text before the user's second message
    // (an assistant line that only announces a tool call may come before it)
    const users = messages.flatMap((e, i) => (e.message?.role === "user" ? [i] : []));
    const firstTurn = messages
      .slice(users[0] + 1, users[1])
      .filter((e) => e.message?.role === "assistant" && textOf(e).trim() !== "");
    const interview = firstTurn[firstTurn.length - 1];
    expect(SAMPLE_INTAKE_CONVERSATION.replies.interview).toBe(interview?.id);
    expect(textOf(interview)).toContain("项目文件夹");
    const summaryId = SAMPLE_INTAKE_CONVERSATION.replies.summary;
    const summary = messages.find((e) => e.id === summaryId);
    expect(summary?.message.role).toBe("assistant");
    expect(textOf(summary)).toMatch(/\|\s*新建\s*\|\s*5\s*\|/);
    expect(textOf(summary)).not.toContain("项目文件夹");
    // It is not the conversation the panel shows first: chapter 8 relies on its own being the most recently updated one.
    const chapter8 = json(join(LIT, "copilot", "conversations", `${SAMPLE_CONVERSATION.id}.json`));
    expect(Date.parse(chapter8.updatedAt)).toBeGreaterThan(Date.parse(record.updatedAt));
  });
});
