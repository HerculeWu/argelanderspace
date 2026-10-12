/**
 * What a Work merge did with the absorbed Work's argument graph (ticket 06), in one wording wherever it is shown:
 * the import dialog, the discovery view's Add, and the Files tab after a background task. File locations arrive
 * relative to the data directory and wrap instead of overflowing.
 */

import { useTranslation } from "react-i18next";
import type { ArgumentGraphMergeNote } from "@argelanderspace/contracts";
import { Icon } from "../lib/icons";

export function MergeNoteRow({ n, index, uiId }: { n: ArgumentGraphMergeNote; index: number; uiId: string }) {
  const { t } = useTranslation();
  const failed = n.outcome === "transfer_failed";
  const vars = { absorbed: n.absorbed_id, survivor: n.survivor_id };
  const sentence =
    n.outcome === "moved"
      ? n.absorbed_file_left === true
        ? t("library.graphMerge.moved_left", vars)
        : t("library.graphMerge.moved", vars)
      : n.outcome === "kept_survivor"
        ? n.survivor_unreadable === true
          ? t("library.graphMerge.kept_survivor_unreadable", vars)
          : t("library.graphMerge.kept_survivor", vars)
        : t("library.graphMerge.transfer_failed", vars);
  const cause =
    n.error === "absorbed_unreadable"
      ? t("library.graphMerge.error.absorbed_unreadable")
      : n.error === "survivor_name_unusable"
        ? t("library.graphMerge.error.survivor_name_unusable")
        : n.error === "write_failed"
          ? t("library.graphMerge.error.write_failed")
          : null;
  const showsFile = n.outcome !== "moved" || n.absorbed_file_left === true;
  return (
    <div className={`import-result merge-note ${failed ? "error" : "exists"}`} data-ui={uiId} data-ui-key={index}>
      <Icon name={failed ? "x-circle" : "info"} cls="ico-sm" />
      <span className="import-result-body">
        <span className="import-result-title">{sentence}</span>
        {failed && cause && <span className="import-result-err">{cause}</span>}
        {showsFile && <span className="import-result-key mono merge-note-file">{n.absorbed_file}</span>}
      </span>
    </div>
  );
}

export function MergeNoteList({ notes, uiId }: { notes: readonly ArgumentGraphMergeNote[]; uiId: string }) {
  return (
    <>
      {notes.map((n, i) => (
        <MergeNoteRow key={`${n.absorbed_id}>${n.survivor_id}>${i}`} n={n} index={i} uiId={uiId} />
      ))}
    </>
  );
}
