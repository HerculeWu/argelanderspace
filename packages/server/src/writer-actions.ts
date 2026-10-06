import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  agentTexProblem,
  CELL_FIELD_NAMES,
  type CellType,
  collectLabels,
  convertCellData,
  defaultCellData,
  type ManuscriptSummary,
  randomLabel,
  SafeLabelSchema,
  sameJson,
  validateCellFields,
  type WriterCell,
  type WriterCellOperation,
  type WriterDeleteImpact,
  type WriterManuscript,
  type WriterNumberingResponse,
  type WriterTemplate,
  type WriterWriteOperation,
  WriterWriteOperationSchema,
  withEnsuredLabel,
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
  /** The Render button's compile (single-flight, broadcasts `writer.changed`); absent in a headless host. */
  render?: (id: string) => Promise<WriterNumberingResponse>;
  /** The cite keys of the saved library, the References tab's list; absent = no key can be verified. */
  citeKeys?: () => ReadonlySet<string>;
  /**
   * Whether Writer compiles run inside the OS sandbox (bubblewrap), the real boundary against TeX reading files the
   * engine's own settings cannot stop (pdfTeX \pdfobj file{}). Without it the Copilot never causes a compile: its
   * render is rejected here and the server refuses its view-driven refresh (the user's own Render is unaffected).
   */
  sandboxed: () => boolean;
}

export type WriterOpStatus = "conflict" | "not_found" | "invalid" | "error" | "rejected";
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
      /** What a cell operation made or touched (cell id, comment id, image name, the offset after an insert...). */
      detail?: Record<string, unknown>;
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
      /** Labels the cells define in their source, and the figure files the manuscript holds (read-only inventory). */
      labels: { label: string; cell: string }[];
      assets: string[];
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
      labels: collectLabels(manuscript.cells),
      assets: assetNames(join(manuscriptDir(deps.dataDir, id), "assets")),
    };
  } catch (error) {
    return { kind: "error", detail: (error as Error).message };
  }
}

/** The New dialog's create: a known template, an optional name. */
export async function createManuscriptOp(
  deps: WriterOpDeps,
  input: { template: string; title?: string },
  /** Set for the Copilot: its text is screened for what the TeX engine must not be handed (spec 14.1). */
  options: { screen?: boolean } = {}
): Promise<WriterOpOutcome> {
  if (options.screen) {
    const problem = agentTexProblem({ title: input.title });
    if (problem) return fail("invalid", problem);
  }
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
  // All of it but the template id ends up in the compiled document: screened before anything is read or written.
  const problem = agentTexProblem({
    title: op.title,
    userPreamble: op.userPreamble,
    affiliations: op.affiliations?.join("\n"),
    authors: op.authors?.flatMap((a) => [a.name, a.aff, a.email]).join("\n"),
    infoValues: op.infoValues ? Object.values(op.infoValues).join("\n") : undefined,
  });
  if (problem) return fail("invalid", problem);
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

function assetNames(dir: string): string[] {
  try {
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  } catch {
    return [];
  }
}

const hex8 = () => randomBytes(4).toString("hex");

/** The text fields of a cell an insert button may write into (what the editing form shows as text). */
const NON_TEXT_FIELDS = new Set([
  "placement",
  "label",
  "language",
  "width",
  "lineNumbers",
  "image",
]);
function textFields(type: CellType): string[] {
  return CELL_FIELD_NAMES[type].filter((field) => !NON_TEXT_FIELDS.has(field));
}

function freshId(prefix: string, taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = `${prefix}_${hex8()}`;
    if (!taken.has(id)) return id;
  }
  return `${prefix}_${hex8()}`;
}

/**
 * The editor's cell operations as narrow writes on the CURRENT stored manuscript inside the writer lock: the add and
 * type menus, the editing form, Delete, the comment box, the References/Crossrefs insert buttons and the figure's image
 * chooser. The caller's `expectedRev` is checked in the same critical section (a stale plan changes nothing); only the
 * named cell or comment is touched, every key of the file this application does not know is kept, and text an agent
 * writes is screened before it can reach the compiler (spec 14.1). The page keeps its own whole-document autosave.
 */
export async function cellOperation(
  deps: WriterOpDeps,
  op: WriterCellOperation
): Promise<WriterOpOutcome> {
  // Screening of what is written (cell fields and the cite/label text; the figure name is rebuilt below).
  if (op.action === "insert_cell" || op.action === "update_cell") {
    const fields = Object.fromEntries(
      Object.entries(op.fields ?? {}).map(([key, value]) => [
        `field ${key}`,
        typeof value === "string" ? value : undefined,
      ])
    );
    const problem = agentTexProblem(fields);
    if (problem) return fail("invalid", problem);
  }
  const outcome = await deps.writerLock.run((): WriterOpOutcome => {
    let current: WriterManuscript | null;
    try {
      current = loadManuscript(deps.dataDir, op.manuscriptId);
    } catch (error) {
      return fail("error", (error as Error).message);
    }
    if (!current) return fail("not_found", "no such manuscript");
    if (current.rev !== op.expectedRev)
      return fail(
        "conflict",
        "the manuscript changed since your reading; read it again",
        current.rev
      );
    const { templates } = loadTemplates(deps.dataDir);
    const template = templates.find((item) => item.id === current.template);
    const cells = [...current.cells];
    const indexOf = (cellId: string) => cells.findIndex((cell) => cell.id === cellId);
    const missingCell = (cellId: string) =>
      fail("not_found", `no cell ${cellId} in this manuscript`, current.rev);
    const finish = (
      next: WriterManuscript,
      detail: Record<string, unknown> = {}
    ): WriterOpOutcome => {
      if (sameJson(next, current))
        return {
          ok: true,
          status: "noop",
          id: current.id,
          rev: current.rev,
          label: current.title,
          detail,
        };
      const saved = saveManuscript(deps.dataDir, next, { bumpRev: true });
      return { ok: true, status: "ok", id: saved.id, rev: saved.rev, label: saved.title, detail };
    };

    if (op.action === "insert_cell") {
      if (!template)
        return fail("invalid", `template '${current.template}' is not available`, current.rev);
      if (!template.types.includes(op.cellType))
        return fail(
          "invalid",
          `template '${template.id}' does not list a ${op.cellType} cell (its add menu offers: ${template.types.join(", ")})`,
          current.rev
        );
      const valid = validateCellFields(op.cellType, op.fields ?? {});
      if (!valid.ok) return fail("invalid", valid.detail, current.rev);
      const index = op.index ?? cells.length;
      if (index > cells.length)
        return fail(
          "invalid",
          `index ${index} is past the end (the manuscript has ${cells.length} cells)`,
          current.rev
        );
      const id = freshId("c", new Set(cells.map((cell) => cell.id)));
      const cell = {
        id,
        type: op.cellType,
        data: { ...defaultCellData(op.cellType), ...valid.fields },
      } as WriterCell;
      cells.splice(index, 0, cell);
      return finish({ ...current, cells }, { cellId: id, index });
    }

    if (op.action === "add_comment") {
      if (indexOf(op.cellId) < 0) return missingCell(op.cellId);
      // The Comments tab trims the note and refuses an empty one.
      const body = op.body.trim();
      if (!body) return fail("invalid", "the note is empty", current.rev);
      const id = freshId("cm", new Set(current.comments.map((comment) => comment.id)));
      return finish(
        {
          ...current,
          comments: [
            ...current.comments,
            {
              id,
              cell: op.cellId,
              // The page's own value: the manuscript has no authorship concept.
              who: "You",
              body,
              created_at: new Date().toISOString(),
            },
          ],
        },
        { commentId: id }
      );
    }

    const at = indexOf(op.cellId);
    if (at < 0) return missingCell(op.cellId);
    const cell = cells[at] as WriterCell;

    if (op.action === "update_cell") {
      const valid = validateCellFields(cell.type, op.fields);
      if (!valid.ok) return fail("invalid", valid.detail, current.rev);
      cells[at] = { ...cell, data: { ...cell.data, ...valid.fields } } as WriterCell;
      return finish({ ...current, cells }, { cellId: cell.id });
    }

    if (op.action === "delete_cell") {
      cells.splice(at, 1);
      return finish({ ...current, cells }, { cellId: cell.id });
    }

    if (op.action === "convert_cell") {
      // The type menu offers the template's types and latex.
      const offered = [...new Set([...(template?.types ?? []), "latex" as const])];
      if (!offered.includes(op.cellType))
        return fail("invalid", `the type menu offers: ${offered.join(", ")}`, current.rev);
      if (cell.type === op.cellType) return finish(current, { cellId: cell.id });
      cells[at] = {
        ...cell,
        type: op.cellType,
        data: convertCellData(cell, op.cellType),
      } as WriterCell;
      return finish({ ...current, cells }, { cellId: cell.id, lossy: op.cellType !== "latex" });
    }

    if (op.action === "insert_reference") {
      const fields = textFields(cell.type);
      if (!fields.includes(op.field))
        return fail(
          "invalid",
          `a ${cell.type} cell has no text field '${op.field}' (it has: ${fields.join(", ") || "none"})`,
          current.rev
        );
      let text = op.text;
      let working = cells;
      if (op.kind === "cite") {
        if (!text) return fail("invalid", "kind cite needs the cite key in text", current.rev);
        const keys = deps.citeKeys?.();
        if (!keys?.has(text))
          return fail(
            "invalid",
            `'${text}' is not a cite key of the library (the References tab lists the saved works' keys)`,
            current.rev
          );
        // Between the braces of a cite command: no TeX syntax, no separator (one key per insert, like the tab).
        if (!/^[A-Za-z0-9][A-Za-z0-9:_.\-/+]*$/.test(text))
          return fail("invalid", `the key '${text}' cannot be inserted bare`, current.rev);
      } else {
        if (op.target) {
          const targetAt = indexOf(op.target.cellId);
          if (targetAt < 0) return missingCell(op.target.cellId);
          text ??= randomLabel();
          if (!SafeLabelSchema.safeParse(text).success)
            return fail("invalid", `'${text}' is not a usable label`, current.rev);
          working = [...cells];
          working[targetAt] = withEnsuredLabel(
            cells[targetAt] as WriterCell,
            text,
            op.target.envIndex,
            op.target.sectionIndex
          );
        } else if (!text) {
          return fail(
            "invalid",
            "kind label needs the label in text or a target to label",
            current.rev
          );
        }
        if (!collectLabels(working).some((item) => item.label === text))
          return fail(
            "invalid",
            `'${text}' is not a label of this manuscript${op.target ? " (the target already carries another label, or has nothing to attach one to)" : "; name a target to label, or use a label from read"}`,
            current.rev
          );
      }
      const inserted = text as string;
      // Like the page: completing a label earlier in the same field moves the caret by what it added.
      const before = String((cell.data as Record<string, unknown>)[op.field] ?? "");
      const edited = working[at] as WriterCell;
      const after = String((edited.data as Record<string, unknown>)[op.field] ?? "");
      let offset = op.offset;
      if (offset > before.length)
        return fail(
          "invalid",
          `offset ${offset} is past the end of the field (${before.length} UTF-16 units)`,
          current.rev
        );
      if (before !== after) {
        let firstDifference = 0;
        while (
          firstDifference < before.length &&
          before[firstDifference] === after[firstDifference]
        )
          firstDifference++;
        if (offset >= firstDifference) offset += after.length - before.length;
      }
      working[at] = {
        ...edited,
        data: {
          ...edited.data,
          [op.field]: after.slice(0, offset) + inserted + after.slice(offset),
        },
      } as WriterCell;
      return finish(
        { ...current, cells: working },
        { cellId: cell.id, inserted, offsetAfter: offset + inserted.length }
      );
    }

    return fail("invalid", "unsupported cell operation", current.rev);
  });
  if (outcome.ok && outcome.status === "ok") deps.changed("put", outcome.id);
  return outcome;
}

export type WriterRenderOutcome =
  | {
      ok: true;
      status: "ok";
      id: string;
      rev: number;
      /** The rev the preview was compiled from; null when the manuscript changed while the compile ran (unknown). */
      compiledRev: number | null;
      /** The compile finished against an older state than the one stored now (an edit arrived meanwhile). */
      stale: boolean;
      warnings: string[];
    }
  | { ok: false; status: "not_found" | "error" | "rejected"; detail: string };

/**
 * The topbar's Render: the same single-flight numbering/preview compile the page's button starts, on the saved
 * manuscript (a user's unsaved typing is not part of it). Nothing is written to the manuscript; a failed compile keeps
 * the last good preview and is reported as a failure, never as done.
 */
export async function renderManuscript(
  deps: WriterOpDeps,
  id: string
): Promise<WriterRenderOutcome> {
  if (!deps.render)
    return { ok: false, status: "error", detail: "rendering is not available in this host" };
  // A render triggered by the Copilot compiles whatever the manuscript holds (some of it possibly agent-written): only
  // with the OS sandbox. The user's own Render button is not affected.
  if (!deps.sandboxed())
    return {
      ok: false,
      status: "rejected",
      detail:
        "this machine has no working OS sandbox (bubblewrap) for the Writer's TeX compile, so the Copilot cannot start a render; the user can press Render themselves",
    };
  let manuscript: WriterManuscript | null;
  try {
    manuscript = loadManuscript(deps.dataDir, id);
  } catch (error) {
    return { ok: false, status: "error", detail: (error as Error).message };
  }
  if (!manuscript) return { ok: false, status: "not_found", detail: "no such manuscript" };
  try {
    const result = await deps.render(id);
    if (result.lastError)
      return {
        ok: false,
        status: "error",
        detail: `the compile failed (the last good preview is kept): ${result.lastError.slice(0, 2000)}`,
      };
    // The compile reads the stored manuscript when it starts; an edit landing meanwhile makes the preview older than
    // the stored rev, so the rev is read again and the compiled rev is only claimed when nothing moved.
    let currentRev = manuscript.rev;
    try {
      currentRev = loadManuscript(deps.dataDir, id)?.rev ?? manuscript.rev;
    } catch {
      /* keep the rev read before */
    }
    return {
      ok: true,
      status: "ok",
      id,
      rev: currentRev,
      compiledRev: currentRev === manuscript.rev ? currentRev : null,
      stale: result.status !== "ok" || currentRev !== manuscript.rev,
      warnings: (result.preview?.warnings ?? []).slice(0, 10).map((line) => line.slice(0, 300)),
    };
  } catch (error) {
    const message = (error as Error).message;
    return {
      ok: false,
      status: /not found/.test(message) ? "not_found" : "error",
      detail: `the compile did not finish: ${message.slice(0, 300)}`,
    };
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
