import type { Workbench } from "../copilot.js";
import type { ConfirmationKind } from "./kind.js";

/** Replacing the annotated reading text of a text Doc (ticket 29): the source panel's replacement dialog. */
export function replaceTextReadingKind(workbench: Workbench | undefined) {
  return {
    action: "replace_text_reading",
    object: (entry) => ({ kind: "doc", id: entry.docId }),
    record: (card) => ({ action: card.action, docId: card.object.id }),
    askedLine: (entry) => `${entry.action} ${entry.docId}`,
    /**
     * `valid` (the Doc's source revision, annotated reading text, annotation count and revision and both content
     * fingerprints are exactly what the card showed, by the generation's own code probed without writing), `changed` (a
     * bound value really differs) or an error (a system error: annotations, reading text, fingerprint or an asset cannot
     * be read; reported as that, never as a change).
     */
    check: async (card) => {
      const text = workbench?.text;
      if (!text) return "changed";
      const now = await text.probeReplacement(card.object.id, card.impact.sourceRev);
      if (now.kind === "error") return { error: `${now.code}: ${now.detail}` };
      if (now.kind !== "impact" || !now.impact) return "changed";
      const a = now.impact;
      const b = card.impact;
      return a.docId === b.docId &&
        a.sourceRev === b.sourceRev &&
        a.publishedSourceRev === b.publishedSourceRev &&
        a.annotations === b.annotations &&
        a.annotationsRev === b.annotationsRev &&
        a.oldFingerprint === b.oldFingerprint &&
        a.newFingerprint === b.newFingerprint
        ? "valid"
        : "changed";
    },
    revalidateOn: "doc",
    boundToNavView: false,
  } satisfies ConfirmationKind<"replace_text_reading", { docId: string }>;
}
