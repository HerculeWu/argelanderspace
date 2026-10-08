import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { IconButton, Tooltip } from "../ui";
import { searchReason } from "./manage-error";
import "./mail-manage.css";

/**
 * The list's search box. Enter asks the IMAP server (nothing is searched locally);
 * the line below says what is happening: searching, how many the server found,
 * or why it failed. The text is plain words plus optional from:/subject:/body:/
 * since:/before: terms (see search-query.ts).
 */
export function MailSearch({
  resetKey,
  scopeLabel,
  state,
  onSearch,
  onClear,
}: {
  /** Changes when the folder changes: the box empties with the search. */
  resetKey: string;
  scopeLabel: string;
  state: {
    active: boolean;
    text: string;
    invalid: "date" | null;
    searching: boolean;
    matches: number;
    shown: number;
    errorCode: string | null;
  };
  onSearch: (text: string) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const composing = useRef(false);
  useEffect(() => setText(""), [resetKey]);

  return (
    <>
      <form
        className="lib-search mail-search"
        data-ui="mail-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (composing.current) return; // Enter that only confirms an IME candidate is not a search
          onSearch(text);
        }}
      >
        <Icon name="search" cls="ico-sm" />
        {/* The syntax hint is a shared Tooltip around the INPUT, so aria-describedby sits on the control that has focus. */}
        <Tooltip content={t("mail.search.hint")}>
          <input
            value={text}
            placeholder={t("mail.search.placeholder")}
            aria-label={t("mail.search.label", { scope: scopeLabel })}
            onChange={(e) => setText(e.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.nativeEvent.isComposing || composing.current)) e.preventDefault();
            }}
          />
        </Tooltip>
        {(text || state.active) && (
          <IconButton
            unstyled
            className="mail-search-clear"
            data-ui="mail-search-clear"
            icon={<Icon name="x" cls="ico-sm" />}
            label={t("mail.search.clear")}
            onClick={() => {
              setText("");
              onClear();
            }}
          />
        )}
      </form>
      {state.active && (
        <div className="mail-search-state" role="status" data-ui="mail-search-state">
          {state.invalid ? (
            <span className="danger">{t("mail.search.invalidDate")}</span>
          ) : state.errorCode ? (
            <span className="danger">{t("mail.search.failed", { reason: searchReason(t, state.errorCode) })}</span>
          ) : state.searching ? (
            t("mail.search.searching")
          ) : (
            t("mail.search.results", { n: state.matches })
          )}
        </div>
      )}
    </>
  );
}
