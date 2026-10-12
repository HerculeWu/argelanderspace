/**
 * Words for what an edit can be refused with (ticket 05): the pure operations' rejections and issues (contracts
 * `argument-edit.ts`) and the server's 400, said so a person can act on them. Nothing here decides anything.
 */
import type { ArgumentEditIssue, ArgumentEditRejection } from "@argelanderspace/contracts";
import type { TFunction } from "i18next";
import { ROLE_NAME } from "./ArgumentPanel";

export function issueText(t: TFunction, issue: ArgumentEditIssue): string {
  switch (issue.code) {
    case "title_blank":
      return t("argument.edit.issue.title_blank");
    case "title_too_long":
      return t("argument.edit.issue.title_too_long", { limit: issue.limit });
    case "field_too_long":
      return t("argument.edit.issue.field_too_long", { field: issue.field === "sources" ? t("argument.view.panel.sources") : issue.field[0]!.toUpperCase() + issue.field.slice(1), limit: issue.limit });
    case "source_text_blank":
      return t("argument.edit.issue.source_text_blank", { n: issue.index + 1 });
    case "too_many_sources":
      return t("argument.edit.issue.too_many_sources", { limit: issue.limit });
    case "too_many_arguments":
      return t("argument.edit.issue.too_many_arguments", { limit: issue.limit });
    case "too_many_edges":
      return t("argument.edit.issue.too_many_edges", { limit: issue.limit });
    case "duplicate_id":
      return t("argument.edit.issue.duplicate_id", { id: issue.argumentId });
    case "other":
      return t("argument.edit.issue.other", { message: issue.message });
  }
}

/** One sentence per reason a refused operation gives. */
export function rejectionMessages(t: TFunction, rejection: ArgumentEditRejection): string[] {
  switch (rejection.code) {
    case "not_found":
      return [t("argument.edit.notFoundArg")];
    case "self_loop":
      return [t("argument.edit.selfLoop")];
    case "duplicate_edge":
      return [t("argument.edit.duplicateEdge", { role: ROLE_NAME[rejection.role] })];
    case "edge_not_found":
      return [t("argument.edit.edgeGone")];
    case "invalid":
      return rejection.issues.map((i) => issueText(t, i));
  }
}

/** The server's 400 detail (English, up to 20 reasons) behind a plain lead-in; shown as is, it is not translated. */
export const serverInvalidText = (t: TFunction, detail: string): string[] => [t("argument.edit.invalidIntro"), ...(detail ? [t("argument.edit.issue.serverDetail", { detail })] : [])];
