import type { ShelfEntrySummary } from "@argelanderspace/contracts";
import { useTranslation } from "react-i18next";
import { fetchShelfEntry, lookupShelf } from "../api/shelf";
import type { LibraryRef } from "../library/types";
import { InlineMessage } from "../ui";
import { formatTime } from "./AddToShelf";
import "./shelf.css";

/*
 * The "already on the Shelf" hint (shelf ticket 06; spec Q5(b), Q11, Q22; review Q6): when a paper is added by DOI,
 * arXiv id or from an exploration candidate, the Shelf is asked — after the add is submitted, never while typing —
 * whether it holds the same paper. Only DOI, arXiv id and OpenAlex id count (the server's `GET /api/shelf/lookup`,
 * read-only); a title never does. A failed lookup is "not known", and the add goes ahead as usual.
 */

export interface ShelfIds {
  doi?: string | null;
  arxiv?: string | null;
  openalex?: string | null;
}

/** One Shelf entry that is the same paper; `summary` is null when its summary could not be read. */
export interface ShelfHit {
  entryId: string;
  rev: number;
  title: string;
  summary: ShelfEntrySummary | null;
}

/** Where "Take from Shelf…" opens the Shelf dialog: one hit goes straight to its take step; several, to the first one's summary. */
export const shelfTakeTarget = (hits: readonly ShelfHit[]) => ({ entryId: hits[0]!.entryId, take: hits.length === 1 });

// The server's identifier mode (server library-actions `detectIdentifier`): an arXiv id must be explicit (the
// `arXiv:` prefix or an arxiv.org URL); a bare one is refused there, so it is not looked up here either.
const NEW_ID = String.raw`\d{4}\.\d{4,5}(?:v\d+)?`;
const OLD_ID = String.raw`[a-z][a-z\-\.]+/\d{7}(?:v\d+)?`;
const ARXIV_PREFIX_RE = new RegExp(`^arxiv:\\s*(${NEW_ID}|${OLD_ID})$`, "i");
const ARXIV_URL_RE = new RegExp(String.raw`arxiv\.org/(?:abs|pdf|e-print|format)/(${NEW_ID}|${OLD_ID})`, "i");
const ARXIV_DOI_RE = /^10\.48550\/arxiv\.(.+)$/i;

const normDoi = (s: string | null | undefined) =>
  (s ?? "").trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "").replace(/^doi:/, "");
const normArxiv = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/^arxiv:/, "").replace(/v\d+$/, "");

/** The identity an identifier-dialog input names, as the server will read it; null when it names none. */
export function identifierIds(value: string): ShelfIds | null {
  const v = value.trim();
  const explicit = ARXIV_PREFIX_RE.exec(v)?.[1] ?? ARXIV_URL_RE.exec(v)?.[1]?.replace(/\.pdf$/i, "");
  if (explicit) return { arxiv: explicit };
  const doi = normDoi(v);
  const fromDoi = ARXIV_DOI_RE.exec(doi)?.[1];
  if (fromDoi) return { arxiv: fromDoi };
  return /^10\.\d{4,9}\/\S+$/.test(doi) ? { doi } : null;
}

/** The project already has this paper (same DOI or arXiv id): adding it only opens that Work, so no hint. */
export function projectHas(ids: ShelfIds, works: readonly LibraryRef[]): boolean {
  const a = identity(ids.doi, ids.arxiv);
  return works.some((w) => {
    const b = identity(w.doi, w.arxiv_id);
    return (a.doi !== "" && a.doi === b.doi) || (a.arxiv !== "" && a.arxiv === b.arxiv);
  });
}

/** DOI and arXiv id as the Shelf compares them (infra `shelfIdentityOf`): an arXiv DataCite DOI is the arXiv id. */
function identity(doi: string | null | undefined, arxiv: string | null | undefined): { doi: string; arxiv: string } {
  const d = normDoi(doi);
  const fromDoi = ARXIV_DOI_RE.exec(d)?.[1];
  return { doi: fromDoi ? "" : d, arxiv: normArxiv(arxiv) || normArxiv(fromDoi) };
}

/**
 * The Shelf entries that are this paper: [] when there are none or `ids` names nothing; null when the Shelf could
 * not be asked (the caller adds as usual). An abort is rethrown. Every request here only reads.
 */
export async function findOnShelf(ids: ShelfIds, signal?: AbortSignal): Promise<ShelfHit[] | null> {
  const asked = lookupShelf(ids, signal);
  if (asked === null) return [];
  const answer = await asked;
  if (!answer.ok) return null;
  return Promise.all(
    answer.value.entries.map(async (e): Promise<ShelfHit> => {
      const entry = await fetchShelfEntry(e.entryId, signal);
      const summary = entry.ok && entry.value.status === "ok" && entry.value.rev === e.rev ? entry.value : null;
      return { entryId: e.entryId, rev: e.rev, title: e.title, summary };
    })
  );
}

/** The hint itself (prototype `already-on-shelf-hint`): what the entry carries, when and where it was added from. */
export function ShelfHint({ hits }: { hits: readonly ShelfHit[] }) {
  const { t } = useTranslation();
  const added = (s: ShelfEntrySummary) => t("shelf.addedFrom", { at: formatTime(s.addedAt), from: s.source.project });
  if (hits.length > 1)
    return (
      <InlineMessage uiId="already-on-shelf-hint" title={t("shelf.hint.titleMany", { count: hits.length })}>
        <p className="shelf-hint-p">{t("shelf.hint.bodyMany")}</p>
        <ul className="shelf-hint-list">
          {hits.map((h) => (
            <li key={h.entryId} data-ui="already-on-shelf-entry" data-ui-key={h.entryId}>
              <span>{h.title}</span>
              {h.summary && <span className="shelf-dim mono">{added(h.summary)}</span>}
            </li>
          ))}
        </ul>
      </InlineMessage>
    );
  const s = hits[0]?.summary ?? null;
  const counts = s && { docs: t("shelf.docCount", { count: s.docs.length }), annotations: t("shelf.annCount", { count: s.annotations }) };
  return (
    <InlineMessage uiId="already-on-shelf-hint" title={t("shelf.hint.title")}>
      <p className="shelf-hint-p">{counts ? t(s.argumentGraph ? "shelf.hint.bodyGraph" : "shelf.hint.body", counts) : t("shelf.hint.bodyPlain")}</p>
      {s && <p className="shelf-hint-p shelf-dim mono">{added(s)}</p>}
    </InlineMessage>
  );
}
