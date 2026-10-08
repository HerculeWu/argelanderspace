import { useTranslation } from "react-i18next";
import { ActionButton } from "../ui";
import { useMailLive } from "./mailLive";
import "./mail-live.css";

/**
 * The Shell's Mail entry with its unread badge (ticket 08). The number is INBOX unread summed over
 * the accounts that can log in (a failed login does not count); it is a number, not a dot, and
 * reads "99+" above 99. The accessible name carries the count because the badge itself is decorative.
 * No system or browser notification exists by decision (spec Q17).
 */
export function MailNavItem({
  label,
  className,
  active,
  onClick,
}: {
  label: string;
  className: string;
  active: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const { total } = useMailLive();
  const name = total > 0 ? t("mail.live.navWithUnread", { name: label, n: total }) : label;
  return (
    <span className="mail-nav-wrap">
      <ActionButton
        unstyled
        iconSize="navigation"
        mode="icon"
        iconName="mail"
        label={name}
        tooltip={name}
        data-ui="navigate-view"
        data-ui-key="mail"
        className={className}
        aria-current={active ? "page" : undefined}
        onClick={onClick}
      />
      {total > 0 && (
        <span className="mail-nav-badge" data-ui="mail-unread-badge" data-count={total} aria-hidden="true">
          {total > 99 ? "99+" : total}
        </span>
      )}
    </span>
  );
}
