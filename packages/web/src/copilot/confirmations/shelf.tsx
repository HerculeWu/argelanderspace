import type { CopilotConfirmation, ShelfDocKind, ShelfReplacedEntry } from "@argelanderspace/contracts";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { ConfirmationCardKind } from "./kind";

type ShelfAddConfirmation = Extract<CopilotConfirmation, { action: "shelf_add" }>;
type ShelfTakeConfirmation = Extract<CopilotConfirmation, { action: "shelf_take" }>;
type ShelfDeleteConfirmation = Extract<CopilotConfirmation, { action: "shelf_delete" }>;

const kindLabel = (t: TFunction, kind: ShelfDocKind) => t(`copilot.shelfCard.kind.${kind}`);
const day = (iso: string) => iso.slice(0, 10);

/** One Shelf entry a replacement removes, or the one a delete removes: what it holds, where it came from. */
function EntryFacts({ entry }: { entry: ShelfReplacedEntry }) {
  const { t } = useTranslation();
  return <>
    {t("copilot.shelfCard.entryLine", { title: entry.title || entry.entryId, date: day(entry.addedAt), project: entry.sourceProject })}
    {" · "}
    {t("copilot.shelfCard.entryHolds", { docs: entry.docs.length, annotations: entry.annotations })}
    {entry.argumentGraph && <>{" · "}{t("copilot.shelfCard.withGraph")}</>}
    {entry.note && <>{" · "}{t("copilot.shelfCard.withNote")}</>}
  </>;
}

/**
 * Adding a work to the Shelf, or replacing the Shelf's entries of the same paper (shelf ticket 07): the Docs that go in
 * with their annotation counts, the argument graph and note switches, the chosen annotations that do not go in, the old
 * annotation batches the add's access path will archive in this project (Doc by Doc), and, for a replacement, every
 * entry it removes. Exactly what the approval sends; only when nothing is archived does it say the project is unchanged.
 */
function ShelfAddBody({ card }: { card: ShelfAddConfirmation }) {
  const { t } = useTranslation();
  const notCarried = card.notCarried.reduce((n, d) => n + d.annotationIds.length, 0);
  const archives = card.wouldArchive.length > 0;
  return <>
    <h3 data-ui="copilot-confirmation-title">{t(card.impact ? "copilot.shelfCard.replaceTitle" : "copilot.shelfCard.addTitle")}</h3>
    <p data-ui="copilot-confirmation-work">{card.label || card.object.id}</p>
    <dl className="copilot-confirmation-fields" data-ui="copilot-confirmation-shelf">
      <dt>{t("copilot.shelfCard.docs")}</dt>
      <dd data-ui="copilot-confirmation-docs">{card.carried.docs.length === 0 ? t("copilot.shelfCard.noDocs") : <ul className="copilot-confirmation-works">{card.carried.docs.map((d) => <li key={d.docId} data-ui="copilot-confirmation-doc" data-ui-key={d.docId}>{t("copilot.shelfCard.docLine", { id: d.docId, kind: kindLabel(t, d.kind), count: d.annotations })}</li>)}</ul>}</dd>
      <dt>{t("copilot.shelfCard.graph")}</dt>
      <dd data-ui="copilot-confirmation-graph">{t(card.carried.argumentGraph ? "copilot.shelfCard.carried" : "copilot.shelfCard.notCarried")}</dd>
      <dt>{t("copilot.shelfCard.note")}</dt>
      <dd data-ui="copilot-confirmation-note">{t(card.carried.note ? "copilot.shelfCard.carried" : "copilot.shelfCard.notCarried")}</dd>
    </dl>
    {notCarried > 0 && <p data-ui="copilot-confirmation-not-carried">{t("copilot.shelfCard.notCurrent", { count: notCarried })}</p>}
    {archives && <>
      <p className="copilot-confirmation-danger" data-ui="copilot-confirmation-archive">{t("copilot.shelfCard.archiveScope")}</p>
      <ul className="copilot-confirmation-works">{card.wouldArchive.map((d) => <li key={d.docId} data-ui="copilot-confirmation-archive-doc" data-ui-key={d.docId}>{t("copilot.shelfCard.archiveLine", { id: d.docId, count: d.count })}</li>)}</ul>
    </>}
    {card.impact && <>
      <p className="copilot-confirmation-danger" data-ui="copilot-confirmation-scope">{t("copilot.shelfCard.replaceScope", { count: card.impact.entries.length })}</p>
      <ul className="copilot-confirmation-works" data-ui="copilot-confirmation-replaced">{card.impact.entries.map((entry) => <li key={entry.entryId} data-ui="copilot-confirmation-replaced-entry" data-ui-key={entry.entryId}><EntryFacts entry={entry} /></li>)}</ul>
    </>}
    <p className="copilot-confirmation-note" data-ui="copilot-confirmation-project-note">{t(archives ? "copilot.shelfCard.addNoteArchive" : "copilot.shelfCard.addNote")}</p>
  </>;
}

const SKIP_REASONS = ["exists", "linked", "annotations_present", "seed_conflict"] as const;
/** A bibliography field written into the work, in the user's words (the stored key when this build has no name for it). */
const fieldName = (t: TFunction, key: string) => t(`copilot.shelfCard.field.${key}`, { defaultValue: key });

/**
 * Taking a Shelf entry into this project: the plan of exactly the request the approval sends — the target work (new with
 * its cite key, or merged into and the fields filled), the main Doc, the Docs taken (and whether a Doc's metadata gets the
 * work's identity) and skipped (and where the next build would put it), the argument graph and the note.
 */
function ShelfTakeBody({ card }: { card: ShelfTakeConfirmation }) {
  const { t } = useTranslation();
  const { plan } = card;
  const skipReason = (d: ShelfTakeConfirmation["plan"]["docs"]["skipped"][number]) => {
    const reason = t(`copilot.shelfCard.skip.${SKIP_REASONS.includes(d.reason) ? d.reason : "exists"}`);
    if (d.reason !== "seed_conflict" || d.wouldJoin === undefined) return reason;
    return `${reason} (${d.wouldJoin === null ? t("copilot.shelfCard.aNewWork") : d.wouldJoin})`;
  };
  return <>
    <h3 data-ui="copilot-confirmation-title">{t("copilot.shelfCard.takeTitle")}</h3>
    <p data-ui="copilot-confirmation-work">{card.label || card.object.id}</p>
    <dl className="copilot-confirmation-fields" data-ui="copilot-confirmation-shelf">
      <dt>{t("copilot.shelfCard.target")}</dt>
      <dd data-ui="copilot-confirmation-target">{t(plan.work.created ? "copilot.shelfCard.newWork" : "copilot.shelfCard.mergeWork", { id: plan.work.id })}</dd>
      {plan.work.created && plan.work.citeKey && <><dt>{t("copilot.shelfCard.citeKey")}</dt><dd data-ui="copilot-confirmation-cite-key">{plan.work.citeKey}</dd></>}
      {!plan.work.created && <><dt>{t("copilot.shelfCard.filled")}</dt><dd data-ui="copilot-confirmation-filled">{plan.work.filled.length ? plan.work.filled.map((key) => fieldName(t, key)).join(", ") : t("copilot.shelfCard.nothingFilled")}</dd></>}
      <dt>{t("copilot.shelfCard.mainDoc")}</dt>
      <dd data-ui="copilot-confirmation-main-doc">{plan.mainDoc.changed && plan.mainDoc.after ? t("copilot.shelfCard.mainDocSet", { id: plan.mainDoc.after }) : t("copilot.shelfCard.mainDocKept")}</dd>
      <dt>{t("copilot.shelfCard.taken")}</dt>
      <dd data-ui="copilot-confirmation-docs">{plan.docs.taken.length === 0 ? t("copilot.shelfCard.noDocsTaken") : <ul className="copilot-confirmation-works">{plan.docs.taken.map((d) => <li key={d.docId} data-ui="copilot-confirmation-doc" data-ui-key={d.docId}>{t("copilot.shelfCard.docLine", { id: d.docId, kind: kindLabel(t, d.kind), count: d.annotations })}{d.stamped && <>{" · "}{t("copilot.shelfCard.stamped")}</>}</li>)}</ul>}</dd>
      {plan.docs.skipped.length > 0 && <><dt>{t("copilot.shelfCard.skipped")}</dt><dd data-ui="copilot-confirmation-skipped"><ul className="copilot-confirmation-works">{plan.docs.skipped.map((d) => <li key={d.docId} data-ui="copilot-confirmation-skipped-doc" data-ui-key={d.docId}>{t("copilot.shelfCard.skipLine", { id: d.docId, kind: kindLabel(t, d.kind), reason: skipReason(d) })}</li>)}</ul></dd></>}
      <dt>{t("copilot.shelfCard.graph")}</dt>
      <dd data-ui="copilot-confirmation-graph">{t(`copilot.shelfCard.graphTake.${plan.argumentGraph}`)}</dd>
      <dt>{t("copilot.shelfCard.note")}</dt>
      <dd data-ui="copilot-confirmation-note">{t(`copilot.shelfCard.noteTake.${plan.note}`)}</dd>
    </dl>
    <div className="copilot-confirmation-meta">{t("copilot.shelfCard.metaEntry", { id: card.object.id, rev: card.baseRev })}</div>
  </>;
}

/** Deleting one Shelf entry: only the Shelf's copy, at the rev shown; no project is touched and there is no recycle bin. */
function ShelfDeleteBody({ card }: { card: ShelfDeleteConfirmation }) {
  const { t } = useTranslation();
  return <>
    <h3 data-ui="copilot-confirmation-title">{t("copilot.shelfCard.deleteTitle")}</h3>
    <p data-ui="copilot-confirmation-work">{card.label || card.object.id}</p>
    <p data-ui="copilot-confirmation-risk">{t("copilot.shelfCard.deleteScope")}</p>
    {card.entry
      ? <p data-ui="copilot-confirmation-entry"><EntryFacts entry={card.entry} /></p>
      : <p data-ui="copilot-confirmation-entry">{t(card.status === "incompatible" ? "copilot.shelfCard.incompatible" : "copilot.shelfCard.damaged")}</p>}
    <div className="copilot-confirmation-meta">{t("copilot.shelfCard.metaEntry", { id: card.object.id, rev: card.baseRev })}</div>
  </>;
}

export const shelfAdd: ConfirmationCardKind<ShelfAddConfirmation> = {
  Body: ShelfAddBody,
  confirmLabel: (t, card) => t(card.impact ? "copilot.shelfCard.confirmReplace" : "copilot.shelfCard.confirmAdd"),
  // A replacement removes the entries it lists for good; a new entry removes nothing.
  toneOf: (card) => (card.impact ? "danger" : undefined),
  problemScope: "shelf",
};
export const shelfTake: ConfirmationCardKind<ShelfTakeConfirmation> = {
  Body: ShelfTakeBody,
  confirmLabel: (t) => t("copilot.shelfCard.confirmTake"),
  problemScope: "shelf",
};
export const shelfDelete: ConfirmationCardKind<ShelfDeleteConfirmation> = {
  Body: ShelfDeleteBody,
  confirmLabel: (t) => t("copilot.shelfCard.confirmDelete"),
  tone: "danger",
  problemScope: "shelf",
};
