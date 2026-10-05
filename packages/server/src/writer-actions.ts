import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type ManuscriptSummary,
  sameJson,
  type WriterDeleteImpact,
  type WriterManuscript,
  type WriterTemplate,
  type WriterWriteOperation,
  WriterWriteOperationSchema,
} from "@argelanderspace/contracts";
import {
  createManuscript,
  deleteManuscript,
  listManuscripts,
  loadManuscript,
  loadTemplates,
  manuscriptDir,
  manuscriptJsonPath,
  saveManuscript,
} from "@argelanderspace/core";
import type { AsyncLock } from "./lock.js";

/**
 * The Writer's business seam: the HTTP routes (list page, editor autosave, New dialog, delete dialog) and the
 * Copilot `writer` tool both come here, so the lock, the revision check, the atomic save, the notification and the
 * cancel-compile-before-delete rule exist once. A narrow write changes only the named fields of the CURRENT stored
 * manuscript inside the lock (looseObject keeps every key this application does not know), after checking the rev the
 * caller read; the page's whole-document autosave keeps its own rev-checked replace.
 */
export interface WriterOpDeps {
  dataDir: string;
  /** The Writer's own lock (never shared with Plan, Library or annotations). */
  writerLock: AsyncLock;
  changed: (cause: "put" | "create" | "delete", id: string) => void;
  /** Stop a running compile of that manuscript and wait for it, so nothing recreates a deleted directory. */
  cancelCompile: (id: string) => Promise<void>;
}

export type WriterOpStatus = "conflict" | "not_found" | "invalid" | "error";
export type WriterOpOutcome =
  | {
      ok: true;
      status: "ok" | "noop";
      id: string;
      rev: number;
      label: string;
      /** update_manuscript with a template: cells the new template does not list (kept, flagged like the toast). */
      unsupportedCells?: number;
      manuscript?: WriterManuscript;
    }
  | { ok: false; status: WriterOpStatus; currentRev?: number; detail: string };

const fail = (status: WriterOpStatus, detail: string, currentRev?: number): WriterOpOutcome => ({
  ok: false,
  status,
  detail,
  ...(currentRev === undefined ? {} : { currentRev }),
});

export type WriterReadOutcome =
  | {
      kind: "list";
      manuscripts: ManuscriptSummary[];
      warnings: string[];
      templates: WriterTemplate[];
      templateWarnings: string[];
    }
  | {
      kind: "manuscript";
      manuscript: WriterManuscript;
      template: WriterTemplate | null;
      unsupportedCellIds: string[];
    }
  | { kind: "not_found" }
  | { kind: "error"; detail: string };

/** Background read: the list, or one whole saved manuscript. Never opens or moves anything. */
export function readWriter(deps: WriterOpDeps, id?: string): WriterReadOutcome {
  const { templates, warnings: templateWarnings } = loadTemplates(deps.dataDir);
  if (id === undefined) {
    const { manuscripts, warnings } = listManuscripts(deps.dataDir);
    return { kind: "list", manuscripts, warnings, templates, templateWarnings };
  }
  try {
    const manuscript = loadManuscript(deps.dataDir, id);
    if (!manuscript) return { kind: "not_found" };
    const template = templates.find((item) => item.id === manuscript.template) ?? null;
    return {
      kind: "manuscript",
      manuscript,
      template,
      unsupportedCellIds: manuscript.cells
        .filter((cell) => !template?.types.includes(cell.type))
        .map((cell) => cell.id),
    };
  } catch (error) {
    return { kind: "error", detail: (error as Error).message };
  }
}

/** The New dialog's create: a known template, an optional name. */
export async function createManuscriptOp(
  deps: WriterOpDeps,
  input: { template: string; title?: string }
): Promise<WriterOpOutcome> {
  const created = await deps.writerLock.run(() => {
    const { templates } = loadTemplates(deps.dataDir);
    if (!templates.some((template) => template.id === input.template)) return null;
    return createManuscript(deps.dataDir, input);
  });
  if (created === null) return fail("invalid", `unknown template '${input.template}'`);
  deps.changed("create", created.id);
  return {
    ok: true,
    status: "ok",
    id: created.id,
    rev: created.rev,
    label: created.title,
    manuscript: created,
  };
}

/** The editor autosave's whole-document replace: the stored rev must be the one the page holds. */
export async function replaceManuscript(
  deps: WriterOpDeps,
  id: string,
  doc: WriterManuscript
): Promise<{ missing: true } | { conflict: WriterManuscript } | { saved: WriterManuscript }> {
  const outcome = await deps.writerLock.run(
    (): { missing: true } | { conflict: WriterManuscript } | { saved: WriterManuscript } => {
      const current = loadManuscript(deps.dataDir, id);
      if (current === null) return { missing: true };
      if (doc.rev !== current.rev) return { conflict: current };
      return { saved: saveManuscript(deps.dataDir, doc, { bumpRev: true }) };
    }
  );
  if ("saved" in outcome) deps.changed("put", id);
  return outcome;
}

/** The Info modal, the Preamble modal and the template select, as one narrow write against the rev the caller read. */
export async function patchManuscript(
  deps: WriterOpDeps,
  input: WriterWriteOperation & { action: "update_manuscript" }
): Promise<WriterOpOutcome> {
  const op = WriterWriteOperationSchema.parse(input) as typeof input;
  const outcome = await deps.writerLock.run((): WriterOpOutcome => {
    let current: WriterManuscript | null;
    try {
      current = loadManuscript(deps.dataDir, op.manuscriptId);
    } catch (error) {
      // A damaged file is never reset or rewritten; it is reported and left as it is.
      return fail("error", (error as Error).message);
    }
    if (!current) return fail("not_found", "no such manuscript");
    if (current.rev !== op.expectedRev)
      return fail(
        "conflict",
        "the manuscript changed since your reading; read it again",
        current.rev
      );
    let templateForCells: WriterTemplate | undefined;
    const { templates } = loadTemplates(deps.dataDir);
    if (op.template !== undefined) {
      templateForCells = templates.find((template) => template.id === op.template);
      if (!templateForCells)
        return fail("invalid", `unknown template '${op.template}'`, current.rev);
    }
    if (op.infoValues !== undefined) {
      // Only the fields the bound template (the new one, when it changes too) declares: the Info modal offers no others.
      const bound =
        templateForCells ?? templates.find((template) => template.id === current.template);
      const allowed = new Set((bound?.infoFields ?? []).map((field) => field.key));
      const unknown = Object.keys(op.infoValues).filter((key) => !allowed.has(key));
      if (unknown.length)
        return fail(
          "invalid",
          `infoValues key(s) ${unknown.map((key) => `'${key}'`).join(", ")} are not extension fields of template '${bound?.id ?? current.template}' (it declares: ${[...allowed].join(", ") || "none"})`,
          current.rev
        );
    }
    const next: WriterManuscript = { ...current };
    if (op.title !== undefined) next.title = op.title;
    // Keys the file already has on an author (an email, unknown keys) survive only for an author that is provably the
    // same person: the list keeps its length and the author at that index keeps the name (an edit in place, like the
    // Info modal's `{ ...author, ...edit }`). A removed, added or reordered author gets only what the call says; keys
    // are never moved onto another person.
    if (op.authors !== undefined) {
      const sameLength = op.authors.length === current.authors.length;
      next.authors = op.authors.map((author, index) => {
        const existing = current.authors[index];
        const identified =
          sameLength && existing && (author.name === undefined || author.name === existing.name);
        return { name: "", aff: "", ...(identified ? existing : {}), ...author };
      });
    }
    if (op.affiliations !== undefined) next.affiliations = op.affiliations;
    if (op.userPreamble !== undefined) next.userPreamble = op.userPreamble;
    if (op.infoValues !== undefined) next.infoValues = { ...current.infoValues, ...op.infoValues };
    if (op.template !== undefined) next.template = op.template;
    const unsupportedCells = templateForCells
      ? current.cells.filter((cell) => !templateForCells?.types.includes(cell.type)).length
      : undefined;
    if (sameJson(next, current))
      return { ok: true, status: "noop", id: current.id, rev: current.rev, label: current.title };
    const saved = saveManuscript(deps.dataDir, next, { bumpRev: true });
    return {
      ok: true,
      status: "ok",
      id: saved.id,
      rev: saved.rev,
      label: saved.title,
      ...(unsupportedCells !== undefined ? { unsupportedCells } : {}),
    };
  });
  if (outcome.ok && outcome.status === "ok") deps.changed("put", outcome.id);
  return outcome;
}

function assetListing(dir: string): string {
  try {
    if (!existsSync(dir)) return "";
    return readdirSync(dir)
      .sort()
      .map((name) => `${name}:${statSync(join(dir, name)).size}`)
      .join("\n");
  } catch {
    return "?";
  }
}

export interface ManuscriptDeleteTarget {
  id: string;
  title: string;
  rev: number;
  /** Hash of the stored manuscript file's bytes: a hand edit that leaves the rev alone also expires a card. */
  digest: string;
  impact: WriterDeleteImpact;
}

/** What the delete dialog would show about the manuscript, and what binds a confirmation to it. */
export function describeManuscriptDelete(
  deps: WriterOpDeps,
  id: string
): ManuscriptDeleteTarget | { error: string } | null {
  let current: WriterManuscript | null;
  try {
    current = loadManuscript(deps.dataDir, id);
  } catch (error) {
    return { error: (error as Error).message };
  }
  if (!current) return null;
  const assets = join(manuscriptDir(deps.dataDir, id), "assets");
  let assetCount = 0;
  try {
    if (existsSync(assets)) assetCount = readdirSync(assets).length;
  } catch {
    assetCount = 0;
  }
  return {
    id: current.id,
    title: current.title,
    rev: current.rev,
    // The file's bytes and the figure files (names, sizes) it would take with it: a new figure ends a card too.
    digest: createHash("sha256")
      .update(readFileSync(manuscriptJsonPath(deps.dataDir, id)))
      .update(assetListing(assets))
      .digest("hex"),
    impact: { cells: current.cells.length, comments: current.comments.length, assets: assetCount },
  };
}

/**
 * The one physical delete: the list's delete dialog and, after the user's confirmation, the Copilot tool. The page's
 * own route passes no expectation; the confirmation passes the rev and digest its card showed.
 */
export async function deleteManuscriptOp(
  deps: WriterOpDeps,
  id: string,
  expected: { rev?: number; digest?: string } = {}
): Promise<WriterOpOutcome> {
  const outcome = await deps.writerLock.run(async (): Promise<WriterOpOutcome> => {
    if (expected.rev !== undefined || expected.digest !== undefined) {
      const target = describeManuscriptDelete(deps, id);
      if (target === null) return fail("not_found", "no such manuscript");
      if ("error" in target) return fail("error", target.error);
      if (
        (expected.rev !== undefined && target.rev !== expected.rev) ||
        (expected.digest !== undefined && target.digest !== expected.digest)
      )
        return fail("conflict", "the manuscript changed after the request", target.rev);
    }
    await deps.cancelCompile(id);
    if (!deleteManuscript(deps.dataDir, id)) return fail("not_found", "no such manuscript");
    return { ok: true, status: "ok", id, rev: expected.rev ?? 0, label: id };
  });
  if (outcome.ok) deps.changed("delete", id);
  return outcome;
}
