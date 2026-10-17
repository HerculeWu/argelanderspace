import type { CopilotConfirmation } from "@argelanderspace/contracts";
import { useTranslation } from "react-i18next";
import { ChangeBlock, VisibleText } from "../FileToolCard";
import type { ConfirmationCardKind } from "./kind";

type CommandCard = Extract<CopilotConfirmation, { action: "run_command" }>;
type EditCard = Extract<CopilotConfirmation, { action: "edit_file" }>;
type WriteCard = Extract<CopilotConfirmation, { action: "write_file" }>;

/**
 * The cards of Copilot's command and file tools (copilot ticket 57, approved prototype): where it runs, the WHOLE
 * command (scrollable) or the path with the change it would make, and what an approval covers. Three decisions: deny,
 * allow this class for the conversation, allow once. The text is the model's, shown as plain text.
 */
function CommandBody({ card }: { card: CommandCard }) {
  const { t } = useTranslation();
  const lines = card.command.split("\n").length;
  return (
    <>
      <h3 data-ui="copilot-confirmation-title">{t(card.shell === "powershell" ? "copilot.tools.runPs" : "copilot.tools.runCmd")}</h3>
      <dl className="copilot-mail-fields" data-ui="copilot-confirmation-tool">
        <dt>{t("copilot.tools.cwd")}</dt><dd data-ui="copilot-confirmation-cwd"><code>{card.cwd}</code></dd>
        <dt>{t("copilot.tools.command")}</dt>
        <dd>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable output must be reachable by keyboard */}
          <pre className="copilot-mail-body copilot-tool-cmd" data-ui="copilot-confirmation-command" tabIndex={0}><VisibleText text={card.command} /></pre>
          {lines > 6 && <span className="copilot-tool-lines">{t("copilot.tools.lines", { n: lines })}</span>}
        </dd>
      </dl>
      <p className="copilot-mail-note" data-ui="copilot-confirmation-scope">{t("copilot.tools.scopeCommand")}</p>
    </>
  );
}

function FileBody({ card }: { card: EditCard | WriteCard }) {
  const { t } = useTranslation();
  const edit = card.action === "edit_file";
  return (
    <>
      <h3 data-ui="copilot-confirmation-title">{t(edit ? "copilot.tools.editFile" : card.change.overwrite ? "copilot.tools.overwriteFile" : "copilot.tools.writeFile")}</h3>
      <dl className="copilot-mail-fields" data-ui="copilot-confirmation-tool">
        <dt>{t("copilot.tools.cwd")}</dt><dd data-ui="copilot-confirmation-cwd"><code>{card.cwd}</code></dd>
        <dt>{t("copilot.tools.path")}</dt><dd data-ui="copilot-confirmation-path"><code><VisibleText text={card.path} /></code></dd>
        {card.resolved !== card.path && <><dt>{t("copilot.tools.resolved")}</dt><dd data-ui="copilot-confirmation-resolved"><code><VisibleText text={card.resolved} /></code></dd></>}
        <dt>{t("copilot.tools.change")}</dt><dd><ChangeBlock tool={edit ? "edit" : "write"} change={card.change} /></dd>
      </dl>
      <p className="copilot-mail-note" data-ui="copilot-confirmation-scope">{t(edit ? "copilot.tools.scopeWrite" : card.change.overwrite ? "copilot.tools.scopeOverwrite" : "copilot.tools.scopeWrite")}</p>
    </>
  );
}

export const runCommand: ConfirmationCardKind<CommandCard> = {
  match: (card): card is CommandCard => card.action === "run_command",
  Body: CommandBody,
  confirmLabel: (t) => t("copilot.tools.allowOnce"),
  session: { label: (t) => t("copilot.tools.allowSessionCmd") },
  problemScope: "file",
};
export const editFile: ConfirmationCardKind<EditCard> = {
  match: (card): card is EditCard => card.action === "edit_file",
  Body: FileBody,
  confirmLabel: (t) => t("copilot.tools.allowOnce"),
  session: { label: (t) => t("copilot.tools.allowSessionWrite") },
  problemScope: "file",
};
export const writeFile: ConfirmationCardKind<WriteCard> = {
  match: (card): card is WriteCard => card.action === "write_file",
  Body: FileBody,
  confirmLabel: (t) => t("copilot.tools.allowOnce"),
  session: { label: (t) => t("copilot.tools.allowSessionWrite") },
  problemScope: "file",
};
