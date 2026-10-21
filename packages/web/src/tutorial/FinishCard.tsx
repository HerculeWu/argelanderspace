import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useHostRequest } from "../host";
import { Icon } from "../lib/icons";
import { ActionButton, Button, InlineMessage } from "../ui";
import { FINISH_CHAPTER_ID, FINISH_STEP_ID } from "./chapters/finish";
import { tk } from "./text";
import "./tutorial-finish.css";

const KEY = `tutorial.steps.${FINISH_STEP_ID}`;

/** A sentence whose `command` parts are shown as code (the browser form's line names a terminal command). */
function WithCode({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part))}
    </>
  );
}

export interface FinishCardProps {
  /** The desktop app (its folder picker), or the browser form (the command to run). */
  desktop: boolean;
  /** Open the chapter rail, so any chapter can be picked again. */
  onReview: () => void;
  /** Close the tutorial: the card goes, the capsule stays, the project stays open. */
  onClose: () => void;
  onLeave: () => void;
}

/**
 * The finish page (appendix A, spec addendum 5): docked at the bottom right like a card without anchor, with the three
 * ways out — open your own project (the desktop app's folder picker, the same request as Settings' "Open another
 * folder…"; in the browser form, the command to run), review any chapter, close — and two notes on where settings and
 * diagnostics are. Nothing here switches the project by itself.
 */
export function FinishCard({ desktop, onReview, onClose, onLeave }: FinishCardProps) {
  const { t } = useTranslation();
  const pickFolder = useHostRequest("pick_folder");
  const [asking, setAsking] = useState(false);
  const [refused, setRefused] = useState(false);
  const openOwn = () => {
    if (!pickFolder) return;
    setAsking(true);
    setRefused(false);
    void pickFolder().then(
      (ok) => {
        setAsking(false);
        setRefused(!ok);
      },
      () => {
        setAsking(false);
        setRefused(true);
      },
    );
  };
  const titleId = "tut-title-finish";
  return (
    <div
      className="tut-card docked tut-finish"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-ui="tutorial-step-card"
      data-ui-key={FINISH_STEP_ID}
      data-state="none"
    >
      <div className="tut-card-head">
        <div className="tut-crumb">
          <Icon name="flag" cls="ico-sm" />
          <span>{tk(t, `tutorial.chapters.${FINISH_CHAPTER_ID}.title`)}</span>
        </div>
        <ActionButton
          unstyled
          mode="icon"
          iconName="x"
          className="btn icon ghost"
          data-ui="exit-tutorial"
          data-ui-key="card"
          label={t("tutorial.ui.leave")}
          tooltip={t("tutorial.ui.leave")}
          onClick={onLeave}
        />
      </div>
      <div className="tut-card-body" data-ui="tutorial-finish">
        <h2 className="tut-title" id={titleId}>{tk(t, `${KEY}.title`)}</h2>
        <p className="tut-text">{tk(t, `${KEY}.body`)}</p>
        <div className="tut-finish-ways">
          {desktop && pickFolder ? (
            <Button appearance="primary" data-ui="tutorial-finish-open-own" busy={asking} disabled={asking} onClick={openOwn}>
              <Icon name="folder-open" cls="ico-sm" />
              {tk(t, `${KEY}.openOwn`)}
            </Button>
          ) : (
            <p className="tut-text" data-ui="tutorial-finish-open-own-browser">
              <WithCode text={tk(t, `${KEY}.openOwnBrowser`)} />
            </p>
          )}
          {refused && (
            <InlineMessage tone="danger" uiId="tutorial-finish-open-own-failed">{t("settings.host.requestFailed")}</InlineMessage>
          )}
          <Button data-ui="tutorial-finish-review" onClick={onReview}>
            <Icon name="list" cls="ico-sm" />
            {tk(t, `${KEY}.review`)}
          </Button>
          <Button data-ui="tutorial-finish-close" onClick={onClose}>
            <Icon name="x" cls="ico-sm" />
            {tk(t, `${KEY}.close`)}
          </Button>
        </div>
        <p className="tut-finish-note" data-ui="tutorial-finish-settings-note">{tk(t, `${KEY}.settingsNote`)}</p>
        <p className="tut-finish-note" data-ui="tutorial-finish-trouble-note">{tk(t, `${KEY}.troubleNote`)}</p>
      </div>
    </div>
  );
}
