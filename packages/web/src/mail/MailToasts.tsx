import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { Button, IconButton } from "../ui";
import "./mail-manage.css";

export interface MailToast {
  id: number;
  tone: "info" | "danger";
  text: string;
  action?: { label: string; run: () => void } | undefined;
}

/** Short-lived notices at the bottom of the Mail page: a finished change with Undo, or a change that failed. */
export function MailToasts({ toasts, onDismiss }: { toasts: MailToast[]; onDismiss: (id: number) => void }) {
  const { t } = useTranslation();
  if (toasts.length === 0) return null;
  return (
    <div className="mail-toasts" data-ui="mail-toasts">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`mail-toast ${toast.tone}`}
          data-ui="mail-toast"
          data-ui-key={toast.tone}
          role={toast.tone === "danger" ? "alert" : "status"}
        >
          {toast.tone === "danger" && <Icon name="triangle-alert" cls="ico-sm" />}
          <span>{toast.text}</span>
          {toast.action && (
            <Button
              data-ui="mail-toast-action"
              onClick={() => {
                toast.action?.run();
                onDismiss(toast.id);
              }}
            >
              {toast.action.label}
            </Button>
          )}
          <IconButton
            unstyled
            className="btn icon ghost"
            data-ui="mail-toast-dismiss"
            icon={<Icon name="x" cls="ico-sm" />}
            label={t("mail.close")}
            onClick={() => onDismiss(toast.id)}
          />
        </div>
      ))}
    </div>
  );
}
