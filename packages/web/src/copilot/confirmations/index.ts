import type { CopilotConfirmation } from "@argelanderspace/contracts";
import { editFile, runCommand, writeFile } from "./file-tools";
import { deleteDoc } from "./delete-doc";
import { deleteManuscript } from "./delete-manuscript";
import { deletePlan } from "./delete-plan";
import type { ConfirmationCardKind } from "./kind";
import { deleteMail, moveMail, sendMail } from "./mail";
import { refreshArxivSource } from "./refresh-arxiv-source";
import { replaceArgumentGraph } from "./replace-argument-graph";
import { replaceTextReading } from "./replace-text-reading";

export type { ConfirmationCardKind, ConfirmationGuards, ConfirmationProblemScope } from "./kind";

/** Every kind of human confirmation card, in lookup order. */
export const CONFIRMATION_KINDS = [sendMail, deleteMail, moveMail, replaceTextReading, deletePlan, deleteManuscript, deleteDoc, refreshArxivSource, replaceArgumentGraph, runCommand, editFile, writeFile] as const;

// Compile-time check: every confirmation the contracts define has a card kind.
type KindCard<K> = K extends ConfirmationCardKind<infer C> ? C : never;
const covered: [Exclude<CopilotConfirmation, KindCard<(typeof CONFIRMATION_KINDS)[number]>>] extends [never] ? true : false = true;
void covered;

/** The card kind of a confirmation (none only for an action this build does not know). */
export function kindOf(card: CopilotConfirmation): ConfirmationCardKind | undefined {
  return CONFIRMATION_KINDS.find((kind) => kind.match(card));
}
