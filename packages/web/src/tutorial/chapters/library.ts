import { type CopilotViewAction, jobTarget } from "@argelanderspace/contracts";
import { fetchLibrary } from "../../api/library";
import { fetchShelf, onShelfChanged } from "../../api/shelf";
import { onJobEvent, onLibraryChanged } from "../../api/ws";
import { samePath } from "../progress";
import { SAMPLE_JERABKOVA_ARXIV, SAMPLE_WORK_IDS } from "../sample-ids";
import type { ChapterDefinition, L2Source, Requirement, WorkbenchSnapshot } from "../types";

/**
 * The paper chapter 2 adds (spec section 1): Evans & Oh 2022, arXiv 2202.06973, not in the sample library. The BibTeX
 * the card offers to copy is language-neutral data, not an i18n key (spec section 5); its DOI and authors were checked
 * against the arXiv API (copy file, chapter 2), and its cite key is not one of the sample's (tests).
 */
export const EVANS_OH_2022_BIBTEX = `@article{evans2022hyades,
  author        = {Evans, N. Wyn and Oh, Semyeong},
  title         = {Mass Segregation in the Hyades Cluster},
  journal       = {Monthly Notices of the Royal Astronomical Society},
  volume        = {512},
  pages         = {3846},
  year          = {2022},
  doi           = {10.1093/mnras/stac707},
  eprint        = {2202.06973},
  archivePrefix = {arXiv},
  primaryClass  = {astro-ph.GA}
}`;
export const EVANS_OH_2022_ARXIV = "2202.06973";
/**
 * The id the product gives the Work that BibTeX creates (core `canonicalId`: an entry with a DOI is `doi:<lower-case
 * DOI>`). Only the take-me-there needs it; the gates find the Work by its arXiv id.
 */
export const EVANS_OH_2022_WORK_ID = "doi:10.1093/mnras/stac707";
/**
 * The Doc an upload of the chapter's archive gives that Work: an uploaded archive's Doc id is derived from the Work id
 * (core `uploadDocId`: `upload-<slug>-<first 6 hex of its SHA-1>`), not `arxiv-2202.06973` as appendix A wrote (measured
 * in the real app: checks/20).
 */
export const EVANS_OH_2022_UPLOAD_DOC_ID = "upload-doi-10-1093-mnras-stac707-56b6a2";
/** How the "first go back to …" line names it (`tutorial.ui.where.workDetail`): a proper name, the same in every language. */
const EVANS_OH_2022_NAME = "Evans & Oh 2022";

/** What the gates read of a Work: the library payload's ref, as much as they need. */
interface WorkRef {
  readonly id: string;
  readonly arxiv_id?: string;
  readonly doc_id?: string;
  readonly doc_ids?: readonly string[];
}
/** The library read back (GET /api/library). `live` false: the client's built-in example, never the project's library. */
export interface LibraryReadback {
  readonly live: boolean;
  readonly refs: readonly WorkRef[];
}
/** The library read back, with the Works whose upload job finished while step 2.5 was shown (`jobTarget().workId`). */
export interface UploadReadback extends LibraryReadback {
  readonly uploadedWorkIds: readonly string[];
}

const readLibrary = async (): Promise<LibraryReadback> => {
  const load = await fetchLibrary();
  return { live: load.live, refs: load.data.refs };
};

/** L2 of step 2.3: `library.changed` → GET /api/library. */
const LIBRARY_SOURCE: L2Source<LibraryReadback> = {
  id: "library",
  subscribe: (changed) => onLibraryChanged(changed),
  read: () => readLibrary(),
};

/**
 * L2 of step 2.5: a finished upload job (`job.done`, kind upload) and `library.changed` → GET /api/library. The Works
 * those jobs were for are remembered for one showing of the step: subscribing starts a new record (one step is shown
 * at a time, and the source is subscribed before its first read).
 */
function uploadSource(): L2Source<UploadReadback> {
  let uploaded: string[] = [];
  return {
    id: "upload",
    subscribe: (changed) => {
      uploaded = [];
      const offJob = onJobEvent((job) => {
        if (job.kind !== "upload" || job.status !== "done") return;
        const workId = jobTarget(job).workId;
        if (workId && !uploaded.includes(workId)) uploaded = [...uploaded, workId];
        changed();
      });
      const offLibrary = onLibraryChanged(changed);
      return () => {
        offJob();
        offLibrary();
      };
    },
    read: async () => ({ ...(await readLibrary()), uploadedWorkIds: uploaded }),
  };
}


/** What step 2.7 reads of a Shelf entry: its id and rev (a replacement keeps the id at a higher rev), its arXiv identity, where it was added from. */
export interface ShelfReadEntry {
  readonly entryId: string;
  readonly rev: number;
  readonly arxiv: string | null;
  readonly project: string;
}
export interface ShelfReadback {
  readonly entries: readonly ShelfReadEntry[];
}

/**
 * L2 of step 2.7: `shelf.changed` with cause add or replace (a delete changes nothing the step waits for) → GET
 * /api/shelf. Rows that are not readable entries (damaged, incompatible, unreadable) have no identity and are left out.
 * A refused or unreachable read throws: the step then has no data and no baseline, so its gate never passes (the user
 * skips it), never passes on a Shelf that could not be read.
 */
const SHELF_SOURCE: L2Source<ShelfReadback> = {
  id: "shelf",
  subscribe: (changed) =>
    onShelfChanged((msg) => {
      if (msg.cause === "add" || msg.cause === "replace") changed();
    }),
  read: async (signal) => {
    const answer = await fetchShelf(signal);
    if (!answer.ok) throw new Error(answer.code);
    const entries: ShelfReadEntry[] = [];
    for (const row of answer.value.entries)
      if (row.status === "ok") entries.push({ entryId: row.entryId, rev: row.rev, arxiv: row.identity.arxiv, project: row.source.project });
    return { entries };
  },
};

/**
 * Step 2.7's gate: the Shelf now holds an entry of Jerabkova 2021 (arXiv identity) that was added from this tutorial
 * Project and is not one the Shelf held when the step started. "Not held at the start" is the entry id and rev pair: an
 * add is a new id, a replacement the same id at a higher rev, while whatever the user already had — from any project —
 * is in the baseline and cannot pass the step on its own.
 */
export function shelfAddPassed(now: ShelfReadback, baseline: ShelfReadback, projectRoot: string | null | undefined): boolean {
  if (!projectRoot) return false;
  const held = new Set(baseline.entries.map((e) => `${e.entryId}@${e.rev}`));
  return now.entries.some((e) => e.arxiv === SAMPLE_JERABKOVA_ARXIV && samePath(e.project, projectRoot) && !held.has(`${e.entryId}@${e.rev}`));
}

const isEvansOh = (ref: WorkRef | undefined | null) => !!ref && (ref.arxiv_id === EVANS_OH_2022_ARXIV || ref.id === EVANS_OH_2022_WORK_ID);
const hasDoc = (ref: WorkRef | undefined) => !!ref && ((ref.doc_ids?.length ?? 0) > 0 || !!ref.doc_id);
const readback = <T extends LibraryReadback>(s: WorkbenchSnapshot, id: string): T | null => {
  const value = s.data[id] as T | undefined;
  return value?.live ? value : null;
};

/** The Work open in the library's detail panel (L1). */
const selectedRef = (s: WorkbenchSnapshot): WorkRef | null => (s.page.view === "library" ? (s.page.library?.detail?.ref ?? null) : null);
const selectedId = (s: WorkbenchSnapshot): string | null => (s.page.view === "library" ? (s.page.library?.selectedRefId ?? null) : null);

const TO_LIBRARY: CopilotViewAction = { action: "switch_view", view: "library" };
const SELECT_EVANS_OH: CopilotViewAction = { action: "select_work", refId: EVANS_OH_2022_WORK_ID };

const ON_LIBRARY: Requirement = { test: (s) => s.page.view === "library", where: "library", takeMeThere: TO_LIBRARY };
const SELECT_JERABKOVA: CopilotViewAction = { action: "select_work", refId: SAMPLE_WORK_IDS.jerabkova2021 };
const JERABKOVA_SELECTED: Requirement = {
  test: (s) => selectedId(s) === SAMPLE_WORK_IDS.jerabkova2021,
  where: "workDetail",
  whereValues: { work: "Jerabkova 2021" },
  takeMeThere: SELECT_JERABKOVA,
};
const EVANS_OH_SELECTED: Requirement = {
  test: (s) => isEvansOh(selectedRef(s)),
  where: "workDetail",
  whereValues: { work: EVANS_OH_2022_NAME },
  takeMeThere: SELECT_EVANS_OH,
};

/** The anchors of chapter 2, constants checked by the static anchor test. */
const LIBRARY_VIEW = { ui: "library-view" } as const;
const WORK_LIST = { ui: "work-list" } as const;
const WORK_ITEM_ROSER = { ui: "work-item", key: SAMPLE_WORK_IDS.roser2019 } as const;
const WORK_DETAIL_ROSER = { ui: "work-detail", key: SAMPLE_WORK_IDS.roser2019 } as const;
const WORK_FULLTEXT = { ui: "work-fulltext" } as const;
/** Röser's "Full text" tab, in its own detail panel. */
const ROSER_FULLTEXT_TAB = { ui: "tab", key: "files", within: WORK_DETAIL_ROSER } as const;
const OPEN_IMPORT_MENU = { ui: "open-import-menu" } as const;
const IMPORT_OPTION_BIB = { ui: "import-option", key: "bib" } as const;
const IMPORT_DIALOG_BIB = { ui: "import-dialog", key: "bib" } as const;
const SUBMIT_IMPORT = { ui: "submit-import" } as const;
/**
 * The detail panel's "Full text" tab: the Full text panel and its controls exist only while that tab is chosen, so it is
 * the lowest rung of the steps in it (as the settings groups are in chapter 0).
 */
const FULLTEXT_TAB = { ui: "tab", key: "files", within: { ui: "work-detail" } } as const;
/** "Get full text…" in the Full text panel: it opens the acquisition dialog (a product modal: the card yields to it). */
const GATHER_DOC = { ui: "gather-doc" } as const;
const ACQUISITION_METHODS = { ui: "fulltext-acquisition-methods" } as const;
const UPLOAD_LATEX_SOURCE = { ui: "upload-latex-source" } as const;
const ACQUISITION_STATUS = { ui: "acquisition-status" } as const;
/** The selected Work's Documents list (Jerabkova's, the no-TeX alternative), then the uploaded Doc's row in it. */
const WORK_DOCUMENTS = { ui: "work-documents" } as const;
const EVANS_OH_DOC = { ui: "doc-item", key: EVANS_OH_2022_UPLOAD_DOC_ID } as const;
const COPY_CITE_KEY = { ui: "copy-cite-key" } as const;
/** The Work detail header's "Add to Shelf", the add dialog it opens (a product modal: the card yields), and its submit. */
const ADD_WORK_TO_SHELF = { ui: "add-work-to-shelf" } as const;
const ADD_TO_SHELF_DIALOG = { ui: "add-to-shelf-dialog" } as const;
const SUBMIT_ADD_TO_SHELF = { ui: "submit-add-to-shelf" } as const;
/** 2.8: the import menu's "From Shelf" option and the Shelf dialog it opens (a product modal: the card yields). 2.9: that dialog's Delete button. */
const IMPORT_OPTION_SHELF = { ui: "import-option", key: "shelf" } as const;
const SHELF_DIALOG = { ui: "shelf-dialog" } as const;
const DELETE_SHELF_ENTRY = { ui: "delete-shelf-entry" } as const;
const SHELF_DIALOG_OPEN: Requirement = { test: (s) => s.dom.present(SHELF_DIALOG), where: "shelfDialog" };

/** Chapter 2, "library" (appendix A): the sample library, a BibTeX entry, an uploaded source archive, the cite key, the Shelf (add, browse, take and delete). */
export const LIBRARY: ChapterDefinition = {
  id: "library",
  n: 2,
  steps: [
    {
      id: "library.list",
      kind: "look",
      anchors: [LIBRARY_VIEW, WORK_LIST],
      requires: ON_LIBRARY,
    },
    {
      id: "library.work-vs-doc",
      kind: "do",
      anchors: [WORK_ITEM_ROSER, WORK_DETAIL_ROSER, ROSER_FULLTEXT_TAB, WORK_FULLTEXT],
      // Röser selected with its details on the Full text tab (parent ruling 2026-10-21, local revision of appendix A
      // 2.2): the library selects its first graph node, Röser, by itself, so "Röser selected" alone held at once.
      gate: (s) => selectedId(s) === SAMPLE_WORK_IDS.roser2019 && s.page.library?.detail?.tab === "files",
      requires: ON_LIBRARY,
    },
    {
      id: "library.add-bibtex",
      kind: "do",
      anchors: [OPEN_IMPORT_MENU, IMPORT_OPTION_BIB, IMPORT_DIALOG_BIB, SUBMIT_IMPORT],
      sources: [LIBRARY_SOURCE],
      gate: (s) => readback<LibraryReadback>(s, LIBRARY_SOURCE.id)?.refs.some(isEvansOh) ?? false,
      requires: ON_LIBRARY,
      preparedText: EVANS_OH_2022_BIBTEX,
    },
    {
      id: "library.acquisition",
      kind: "look",
      anchors: [FULLTEXT_TAB, WORK_FULLTEXT, GATHER_DOC, ACQUISITION_METHODS],
      requires: EVANS_OH_SELECTED,
    },
    (() => {
      const source = uploadSource();
      return {
        id: "library.upload-source",
        kind: "do" as const,
        anchors: [FULLTEXT_TAB, GATHER_DOC, UPLOAD_LATEX_SOURCE, ACQUISITION_STATUS, WORK_DOCUMENTS, EVANS_OH_DOC],
        sources: [source],
        // The upload job of that Work finished and the Work read back has a Doc; or it already had one when the step
        // started (uploaded before: resumed, or come back to after a skip).
        gate: (s, run) => {
          const now = readback<UploadReadback>(s, source.id);
          const evans = now?.refs.find(isEvansOh);
          if (!now || !evans || !hasDoc(evans)) return false;
          if (now.uploadedWorkIds.includes(evans.id)) return true;
          return hasDoc(readback<UploadReadback>(run.baseline, source.id)?.refs.find(isEvansOh));
        },
        // Without TeX the card points at Jerabkova 2021's ingested Doc instead (its `alt` copy): that Work is accepted
        // too, and the Documents rung then shows its list.
        requires: { ...EVANS_OH_SELECTED, test: (s) => isEvansOh(selectedRef(s)) || selectedId(s) === SAMPLE_WORK_IDS.jerabkova2021 },
        needsTex: true,
      };
    })(),
    {
      id: "library.cite-key",
      kind: "look",
      anchors: [COPY_CITE_KEY],
      requires: { ...EVANS_OH_SELECTED, test: (s) => selectedId(s) !== null },
    },
    {
      id: "library.shelf-add",
      kind: "do",
      anchors: [ADD_WORK_TO_SHELF, ADD_TO_SHELF_DIALOG, SUBMIT_ADD_TO_SHELF],
      sources: [SHELF_SOURCE],
      // An entry of Jerabkova 2021 added from this Project since the step started (add or replace); see shelfAddPassed.
      gate: (s, run) => {
        const now = s.data[SHELF_SOURCE.id] as ShelfReadback | undefined;
        const start = run.baseline.data[SHELF_SOURCE.id] as ShelfReadback | undefined;
        return !!now && !!start && shelfAddPassed(now, start, s.projectRoot);
      },
      requires: JERABKOVA_SELECTED,
    },
    {
      id: "library.shelf-browse",
      kind: "do",
      anchors: [OPEN_IMPORT_MENU, IMPORT_OPTION_SHELF, SHELF_DIALOG],
      // L3: the Shelf dialog is on the page (the card yields to it, so the gate passes as the dialog opens).
      gate: (s) => s.dom.present(SHELF_DIALOG),
      requires: ON_LIBRARY,
    },
    {
      id: "library.shelf-take",
      kind: "look",
      anchors: [SHELF_DIALOG, DELETE_SHELF_ENTRY],
      // Looked at in the dialog; no registered view action opens it, so "first go back to …" has no take-me-there.
      requires: SHELF_DIALOG_OPEN,
    },
    {
      id: "library.agent",
      kind: "agent",
      anchors: [],
    },
  ],
};
