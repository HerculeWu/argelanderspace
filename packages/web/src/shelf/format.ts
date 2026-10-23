import type { ShelfItemProblem } from "@argelanderspace/contracts";
import type { TFunction } from "i18next";
import { refusalParts, type ShelfFailure } from "../api/shelf";

export type Translate = TFunction;

/** Bytes as the Shelf shows them (KB / MB / GB, one decimal under 10). */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${shown} ${units[unit]}`;
}

const PROBLEMS: readonly ShelfItemProblem[] = [
  "missing",
  "incomplete",
  "not_a_regular_file",
  "unreadable",
  "invalid",
  "asset_mismatch",
  "asset_outside_carried",
  "content_changed",
  "ownership",
  "annotations_invalid",
  "annotations_archive_failed",
  "annotations_new_current_failed",
];

const DAMAGES = ["not_a_directory", "manifest_missing", "manifest_not_a_file", "manifest_unreadable", "manifest_invalid", "manifest_mismatch", "file_missing", "file_changed", "file_unexpected", "damaged"] as const;
const PARTS = ["doc", "annotations", "argument_graph"] as const;
const PART_PROBLEMS = ["annotations_file", "not_json", "pdf_annotations", "no_reading_text", "stale", "bad_text_doc_id", "ir_doc_id", "pdf_metadata", "pdf_original", "text_source", "future_version", "schema"] as const;
const known = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/** A damaged entry's reason (infra `ShelfDamage`) in words; an unknown category is shown as it came. */
export function damageText(problem: unknown, t: Translate): string {
  return known(DAMAGES, problem) ? t(`shelf.damage.${problem}`) : String(problem);
}

/**
 * The lines a refused Shelf request shows: what failed (by code, naming the Doc or part), what that left behind, and
 * the server's own detail beneath. `op` picks the wording of what was (not) changed.
 */
export function shelfFailureLines(f: ShelfFailure, t: Translate, op: "add" | "take" | "delete" | "read"): string[] {
  const lines: string[] = [];
  const { item, problem, archived } = refusalParts(f);
  const docId = typeof f.body.docId === "string" ? f.body.docId : null;
  switch (f.code) {
    case "unreachable":
      lines.push(t("shelf.fail.unreachable"));
      break;
    case "item_unreadable": {
      const what =
        item?.kind === "doc"
          ? t("shelf.fail.itemDoc", { doc: item.docId })
          : item?.kind === "annotations"
            ? t("shelf.fail.itemAnnotations", { doc: item.docId })
            : item?.kind === "argument_graph"
              ? t("shelf.fail.itemGraph")
              : t("shelf.fail.itemLibrary");
      const path = item && "path" in item && item.path ? t("shelf.fail.itemPath", { path: item.path }) : "";
      const why = problem && PROBLEMS.includes(problem) ? t(`shelf.problem.${problem}`) : t("shelf.problem.unknown");
      lines.push(t("shelf.fail.item", { what, path, why }));
      break;
    }
    case "doc_busy":
    case "busy":
      lines.push(t("shelf.fail.busy", { doc: docId ?? "" }));
      break;
    case "doc_not_in_work":
      lines.push(t("shelf.fail.docNotInWork", { doc: docId ?? "" }));
      break;
    case "work_not_found":
      lines.push(t("shelf.fail.workNotFound"));
      break;
    case "shelf_busy":
      lines.push(t("shelf.fail.shelfBusy"));
      break;
    case "shelf_unreadable":
      lines.push(t("shelf.fail.shelfUnreadable"));
      break;
    case "shelf_write_failed":
      lines.push(t("shelf.fail.writeFailed"));
      break;
    case "lock_lost":
      lines.push(t("shelf.fail.lockLost"));
      break;
    case "not_found":
      lines.push(t("shelf.fail.notFound"));
      break;
    case "rev_mismatch":
    case "changed":
      lines.push(t("shelf.fail.changed"));
      break;
    case "incompatible":
      lines.push(t("shelf.fail.incompatible"));
      break;
    case "damaged":
      lines.push(t("shelf.fail.damaged", { problem: damageText(f.body.problem, t) }));
      break;
    case "entry_invalid": {
      const part = known(PARTS, f.body.part) ? t(`shelf.part.${f.body.part}`) : String(f.body.part ?? "");
      const why = known(PART_PROBLEMS, f.body.problem) ? t(`shelf.partProblem.${f.body.problem}`) : String(f.body.problem ?? "");
      lines.push(t(docId ? "shelf.fail.entryInvalid" : "shelf.fail.entryInvalidNoDoc", { doc: docId ?? "", part, why }));
      break;
    }
    case "id_taken":
      lines.push(t("shelf.fail.idTaken", { work: typeof f.body.workId === "string" ? f.body.workId : "" }));
      break;
    case "multiple_works":
      lines.push(t("shelf.fail.multipleWorks", { works: Array.isArray(f.body.workIds) ? f.body.workIds.join(", ") : "" }));
      break;
    case "library_unreadable":
      lines.push(t("shelf.fail.libraryUnreadable"));
      break;
    case "argument_graph_unreadable":
      lines.push(t("shelf.fail.graphUnreadable"));
      break;
    case "write_failed":
      // `cleanedUp` says whether what this take added was removed again; without it the take failed before writing
      // anything (or the server did not say), so no undo is claimed.
      lines.push(t(f.body.cleanedUp === false ? "shelf.fail.takeWriteFailedLeft" : f.body.cleanedUp === true ? "shelf.fail.takeWriteFailed" : "shelf.fail.takeWriteFailedPlain"));
      break;
    default:
      lines.push(t("shelf.fail.other"));
  }
  if (op === "add" && f.code !== "unreachable") {
    lines.push(t(f.code === "lock_lost" ? "shelf.fail.addLockLostNote" : "shelf.fail.addNothingWritten"));
    lines.push(
      archived.length > 0
        ? t("shelf.fail.archived", { docs: archived.map((a) => (a.count === null ? a.docId : `${a.docId} (${a.count})`)).join(", ") })
        : t("shelf.fail.projectUnchanged")
    );
  }
  if (op === "take" && f.code !== "unreachable" && f.code !== "write_failed") lines.push(t("shelf.fail.takeNothingWritten"));
  if (f.detail && f.code !== "unreachable") lines.push(f.detail);
  return lines;
}
