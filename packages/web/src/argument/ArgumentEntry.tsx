/**
 * The entries into the argument graph view (ticket 04): the work detail's button (next to "Explore related papers"; it
 * says whether the work has a graph and how many arguments), and the Reader's top-bar button (which finds the work the
 * open Doc belongs to).
 */
import { useEffect, useState } from "react";
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
  );
}

/** The work a Doc belongs to, from the library; null when the library cannot be read live or lists none. */
async function workOfDoc(docId: string): Promise<string | null> {
  const { data, live } = await fetchLibrary();
  if (!live) return null;
  return data.refs.find((r) => r.doc_ids?.includes(docId) || r.doc_id === docId)?.id ?? null;
}

/**
 * The Reader's top-bar entry. The work is looked up when the button is pressed (the Reader itself reads nothing of the
 * library); a Doc that no listed work owns, or a library that cannot be read, says so next to the button.
 */
export function ReaderArgumentEntry({ docId, onOpen }: { docId: string; onOpen?: (workId: string) => void }) {
  const { t } = useTranslation();
  const [state, setState] = useState<"idle" | "busy" | "missing">("idle");
  useEffect(() => setState("idle"), [docId]);
  const press = async () => {
    setState("busy");
    const workId = await workOfDoc(docId);
    if (workId === null) return setState("missing");
    setState("idle");
    onOpen?.(workId);
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
    </>
  );
}
