/**
 * The entries into the argument graph view (ticket 04): the work detail's button (next to "Explore related papers"; it
 * says whether the work has a graph and how many arguments), and the Reader's top-bar button (which finds the work the
 * open Doc belongs to).
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchLibrary } from "../api/library";
import { Icon } from "../lib/icons";
import { ActionButton } from "../ui";
import { useArgumentGraph } from "./useArgumentGraph";

export function WorkArgumentEntry({ workId, live, onOpen }: { workId: string; live: boolean; onOpen: (workId: string) => void }) {
  const { t } = useTranslation();
  const { state } = useArgumentGraph(workId, live);
  const count = state.phase === "ready" ? state.graph.arguments.length : null;
  const label = !live ? t("argument.view.entry") : count === null ? t("argument.view.entry") : count > 0 ? t("argument.view.entryCount", { count }) : t("argument.view.entryNone");
  return (
    <>
      <ActionButton
        unstyled
        mode="text"
        className="btn large"
        data-ui="open-argument-graph"
        data-count={count ?? undefined}
        label={label}
        tooltip={!live ? t("argument.view.entryDemoOff") : t("argument.view.open")}
        disabled={!live}
        onClick={() => onOpen(workId)}
      >
        <Icon name="workflow" cls="ico-sm" />
        {label}
      </ActionButton>
      {!live && (
        <div className="detail-footer-note" data-ui="open-argument-graph-note">
          {t("argument.view.entryDemoOff")}
        </div>
      )}
    </>
  );
}

/** The work a Doc belongs to, from the library: `unreadable` when the library cannot be read live, `none` when no listed work owns the Doc. */
async function workOfDoc(docId: string): Promise<{ workId: string } | "unreadable" | "none"> {
  try {
    const { data, live } = await fetchLibrary();
    if (!live) return "unreadable";
    const workId = data.refs.find((r) => r.doc_ids?.includes(docId) || r.doc_id === docId)?.id;
    return workId === undefined ? "none" : { workId };
  } catch {
    return "unreadable";
  }
}

/**
 * The Reader's top-bar entry. The work is looked up when the button is pressed (the Reader itself reads nothing of the
 * library); a Doc that no listed work owns, or a library that cannot be read, says so next to the button.
 */
export function ReaderArgumentEntry({ docId, onOpen }: { docId: string; onOpen?: (workId: string) => void }) {
  const { t } = useTranslation();
  const [state, setState] = useState<"idle" | "busy" | "missing" | "unreadable">("idle");
  // An answer that arrives after the Reader moved to another Doc (or the entry went away) belongs to nobody: it must not take the user anywhere.
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setState("idle");
    return () => {
      generation.current++;
    };
  }, [docId]);
  const press = async () => {
    const mine = ++generation.current;
    setState("busy");
    const found = await workOfDoc(docId);
    if (mine !== generation.current) return;
    if (found === "none" || found === "unreadable") return setState(found === "none" ? "missing" : "unreadable");
    setState("idle");
    onOpen?.(found.workId);
  };
  return (
    <>
      <ActionButton
        unstyled
        mode="text"
        className="btn ag-reader-entry"
        data-ui="open-argument-graph-from-reader"
        data-ui-key={docId}
        label={t("argument.view.entry")}
        tooltip={t("argument.view.open")}
        disabled={!onOpen}
        busy={state === "busy"}
        onClick={() => void press()}
      >
        <Icon name="workflow" cls="ico-sm" />
        {t("argument.view.entry")}
      </ActionButton>
      {state === "missing" && (
        <span className="ag-reader-entry-note" role="status" data-ui="argument-reader-entry-missing">
          {t("argument.view.readerNoWork")}
        </span>
      )}
      {state === "unreadable" && (
        <span className="ag-reader-entry-note" role="status" data-ui="argument-reader-entry-unreadable">
          {t("argument.view.readerLibraryUnreadable")}
        </span>
      )}
    </>
  );
}
