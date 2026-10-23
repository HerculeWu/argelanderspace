import type { CopilotConfirmation } from "@argelanderspace/contracts";
import { editFile, runCommand, writeFile } from "./file-tools";
import { deleteDoc } from "./delete-doc";
import { deleteManuscript } from "./delete-manuscript";
import { deletePlan } from "./delete-plan";
import type { ConfirmationCardKind, ConfirmationCardKinds } from "./kind";
import { deleteMail, moveMail, sendMail } from "./mail";
import { refreshArxivSource } from "./refresh-arxiv-source";
import { replaceArgumentGraph } from "./replace-argument-graph";
import { replaceTextReading } from "./replace-text-reading";
import { shelfAdd, shelfDelete, shelfTake } from "./shelf";

export type { ConfirmationCardKind, ConfirmationGuards, ConfirmationProblemScope } from "./kind";

/** Every kind of human confirmation card, keyed by its action. */
export const CONFIRMATION_KINDS: ConfirmationCardKinds = {
  send_mail: sendMail,
  delete_mail: deleteMail,
  move_mail: moveMail,
  replace_text_reading: replaceTextReading,
  delete_plan: deletePlan,
  delete_manuscript: deleteManuscript,
  delete_doc: deleteDoc,
  refresh_arxiv_source: refreshArxivSource,
  replace_argument_graph: replaceArgumentGraph,
  shelf_add: shelfAdd,
  shelf_take: shelfTake,
  shelf_delete: shelfDelete,
  run_command: runCommand,
  edit_file: editFile,
  write_file: writeFile,
};

// Looked up in a Map: only the registry's own actions are found (never `constructor` and the like).
const BY_ACTION: ReadonlyMap<string, ConfirmationCardKind> = new Map(Object.entries(CONFIRMATION_KINDS));

/** The card kind of a confirmation (none only for an action this build does not know). */
export function kindOf(card: CopilotConfirmation): ConfirmationCardKind | undefined {
  return BY_ACTION.get(card.action);
}
