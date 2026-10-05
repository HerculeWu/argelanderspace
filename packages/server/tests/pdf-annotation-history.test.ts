import type { PdfAnnotation, PdfAnnotationsFile } from "@argelanderspace/contracts";
import { expect, test } from "vitest";
import { PDF_HISTORY_KEYS, PdfAnnotationHistory } from "../src/pdf-annotation-actions.js";

const at = "2026-10-05T10:00:00.000Z";
const note = (id: string, body = id): PdfAnnotation => ({
  id,
  kind: "document_comment",
  body,
  created_at: at,
  updated_at: at,
});
const file = (rev: number, annotations: PdfAnnotation[]): PdfAnnotationsFile => ({
  version: 1,
  doc_id: "d",
  content_sha256: "a".repeat(64),
  rev,
  annotations,
});
const write = (before: PdfAnnotation[], next: PdfAnnotation[]) => ({
  kind: "write" as const,
  before,
  next,
  label: "l",
});

test("the history of one conversation is not reachable from another, and the map stays bounded", () => {
  const history = new PdfAnnotationHistory();
  const a = PdfAnnotationHistory.key("conversation-a", "doc");
  const b = PdfAnnotationHistory.key("conversation-b", "doc");
  history.recordChange(a, write([], [note("x")]), 1);
  expect(history.plan(b, "undo", file(1, [note("x")]))).toEqual({
    kind: "none",
    reason: "nothing",
  });
  expect(history.plan(a, "undo", file(1, [note("x")])).kind).toBe("write");
  for (let i = 0; i < PDF_HISTORY_KEYS + 10; i++)
    history.recordChange(PdfAnnotationHistory.key(`c${i}`, "doc"), write([], [note("x")]), 1);
  expect(history.size).toBe(PDF_HISTORY_KEYS);
  // the least recently used went first
  expect(history.depth(a).canUndo).toBe(false);
  expect(history.depth(PdfAnnotationHistory.key(`c${PDF_HISTORY_KEYS + 9}`, "doc")).canUndo).toBe(
    true
  );
});

test("undo, undo, redo, redo crosses an undone update without the history ending", () => {
  const history = new PdfAnnotationHistory();
  const key = PdfAnnotationHistory.key("c", "doc");
  const x1 = note("x", "v1");
  const x2 = { ...x1, body: "v2", updated_at: "2026-10-05T10:00:01.000Z" };
  history.recordChange(key, write([], [x1]), 1);
  history.recordChange(key, write([x1], [x2]), 2);
  let rev = 2;
  let stored: PdfAnnotation[] = [x2];
  const move = (direction: "undo" | "redo") => {
    const step = history.plan(key, direction, file(rev, stored), new Date(Date.now() + rev * 1000));
    expect(step.kind, `${direction} at ${rev}`).toBe("write");
    if (step.kind !== "write") throw new Error("unreachable");
    rev += 1;
    stored = step.next;
    history.recordMove(key, direction, rev, stored);
  };
  move("undo");
  expect(stored.map((a) => a.body)).toEqual(["v1"]);
  move("undo");
  expect(stored).toEqual([]);
  move("redo");
  expect(stored.map((a) => a.body)).toEqual(["v1"]);
  move("redo");
  expect(stored.map((a) => a.body)).toEqual(["v2"]);
  expect(history.plan(key, "redo", file(rev, stored)).kind).toBe("none");
});
