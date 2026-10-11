import type { Workbench } from "../copilot.js";
import { deleteDocKind } from "./delete-doc.js";
import { deleteManuscriptKind } from "./delete-manuscript.js";
import { deletePlanKind } from "./delete-plan.js";
import type { ConfirmationKinds } from "./kind.js";
import { deleteMailKind, moveMailKind } from "./mail-message.js";
import { refreshArxivSourceKind } from "./refresh-arxiv-source.js";
import { replaceTextReadingKind } from "./replace-text-reading.js";
import { sendMailKind } from "./send-mail.js";

export type {
  ConfirmationAction,
  ConfirmationCheck,
  ConfirmationKind,
  ConfirmationKinds,
  ConfirmationTrigger,
} from "./kind.js";

/** Every confirmation kind, its checks reading this workbench (none: every check says changed, as before). */
export function createConfirmationKinds(workbench: Workbench | undefined): ConfirmationKinds {
  return {
    send_mail: sendMailKind(workbench),
    delete_mail: deleteMailKind,
    move_mail: moveMailKind,
    replace_text_reading: replaceTextReadingKind(workbench),
    delete_plan: deletePlanKind(workbench),
    delete_manuscript: deleteManuscriptKind(workbench),
    delete_doc: deleteDocKind(workbench),
    refresh_arxiv_source: refreshArxivSourceKind(workbench),
  };
}
