# Web product and interface design

ArgelanderSpace Web is a dense, independently operable research workbench. Preserve the Library, graph, Reader, Plan, and Writer context instead of turning a task into an isolated card page. Let scientific content and the user's current task lead; use spacing, typography, and disclosure before adding decoration or shrinking readable text.

## Existing system

- Extend `argelander.css` semantic tokens and `argelander/theme.ts`; dark/light, accent, and compact/regular/comfy density are one system.
- Put user-facing copy in the existing `zh-CN.json` and `en.json` catalogs. Keep user data and server details verbatim.
- Common spacing is 4/8/12/16/24 px. Controls use 30/32/36 px across compact/regular/comfy density, 16 px icons, 5 px control radii, 7 px groups, and 11 px dialogs. These are reasoned defaults, not a ban on other values.
- Use one filled primary action per local task area by default. Danger communicates irreversible risk; it is not a second primary hierarchy.
- A visible `:focus-visible` outline, an accessible name, and non-color state copy are baseline behavior.

## Shared UI interface

Import reusable controls from `src/ui/index.ts`. This is the public entry; feature code does not import another feature's generic shell.

### `Dialog`

`Dialog` owns the accessible title/description relationship, modal role, document-level focus containment and return, Escape/backdrop close, and close protection while `busy`. Confirmation dialogs pass a safe `initialFocusRef`. When submission disables every control, focus stays on the dialog itself and returns to the safe action when the request settles. The regular width is 480 px with a 32 px viewport margin, internal body scrolling, and a footer that remains reachable. Plan passes 440 px to preserve its established compact form intent.

A destructive operation must name the object and state its scope and irreversibility before the action. While submitting, disable repeated submission and every dismissal path; after a rejected request, keep the dialog open so the user can retry or cancel.

### Actions and explanations

- `Button` owns variant and busy/disabled semantics. Use `danger` only for destructive actions.
- `IconButton` always receives a text `label`; it combines the accessible name with the shared custom `Tooltip`. Do not rely on native `title` alone for icon-only actions.
- `InlineMessage` combines icon, text, and semantic tone. Use warning for a risk or recoverable busy state, danger for a failed operation, and preserve useful server detail beneath a localized heading.
- `Badge` supplies compact, non-interactive status labels. Its `neutral` and `accent` tones are supplemental: the visible text must carry the state without relying on color.

## Reading-first reference detail

A reference detail leads with the Work identity: type, complete title, authors, venue, year, and citation information. Acquisition planning is not document provenance, so planner source labels do not appear beneath the title. Full-text availability is stated separately, with one primary action: open the selected main Doc when it exists, or enter the existing full-text acquisition area when it does not. Main means the user's selected default, not a system claim about the newest or published version.

The detail pane is 392 px on a regular desktop and 360 px at viewports up to 1100 px. It scrolls independently and uses 16/20/24 px inner padding for compact/regular/comfy density. A 20 px serif title and readable body type may wrap; long titles, DOI/arXiv identifiers, and Doc ids must wrap rather than create page-level horizontal overflow. These widths preserve useful room for bilingual actions while keeping the Library list and graph in context.

`Tabs` owns the tablist/tab/panel relationships, roving focus, and automatic Left/Right/Home/End activation. Reference content uses five tabs—Info, Abstract, BibTeX, Notes, Full text—and defaults to Info. Abstracts continue through the provider-HTML sanitizer and math renderer; BibTeX generation is unchanged. Notes remain a truthful view of the current read-only surface and say that editing is not available *here yet*, rather than defining notes as permanently read-only.

Icon-only copy and close actions use `IconButton`, so their accessible name and tooltip match. Cite-key and BibTeX copy actions report both success and denied clipboard access; a failed browser permission must never produce a copied confirmation.

## Document provenance and acquisition state

The Full text tab lists concrete Docs, not abstract “files”. Each row visibly states its Doc id, selected-main/additional position, and provenance. Provenance comes only from the Doc IR's explicit `source.acquired_via`: `arxiv_eprint` is arXiv, `user_latex_zip` is an uploaded source archive, and missing, unsupported, malformed, or unavailable metadata stays unknown. Origin paths and annotation data are neither a provenance source nor display copy.

Upload and arXiv acquisition use persistent `InlineMessage` task states before the document list. Queued/running jobs remain recoverable from WebSocket hello replay. A failure/interruption does not remove an existing Doc link, but neither the link nor the failed job proves the IR is healthy; the Reader remains authoritative after opening. Retry or replacement guidance stays available. Job and request updates are scoped to a Work session generation and job identity so late responses cannot attach after switching away and back.

## Full-text acquisition and safe update

The Full text tab has one acquisition entry point for arXiv source retrieval and real `.zip` LaTeX uploads. The dialog names the selected method and, before replacing an existing Doc, shows the exact target Doc id and queries that Doc's current annotation count. A new target does not imply risk to another existing Doc and therefore needs no replacement confirmation.

Known nonzero and unknown annotation counts require explicit confirmation; loading, busy, missing, and otherwise unavailable states block submission. A known zero count still states that the body will be replaced. Retry starts a new risk check, and a fresh Work payload, target change, or known target job invalidates prior count and consent state. Dialog/method/submission generations prevent a late request from settling into a later flow. Submission uses a synchronous guard plus `Dialog` busy protection so duplicate submission, Escape, backdrop, and close cannot dismiss an in-flight request.

The file picker’s `accept` attribute is only guidance. Before HTTP submission, require a non-empty File whose name ends in `.zip` (case-insensitive), show a localized field error otherwise, and clear the native input value after every choice so selecting the same filename again still produces a deliberate change. The backend remains authoritative for ZIP structure and LaTeX validity.

The update action belongs to a concrete Doc only when that Doc id exactly equals the backend-derived arXiv or upload target. Provenance labels and arbitrary Doc-id prefixes are presentation data, not eligibility. arXiv PDF-only failures direct the user to upload a LaTeX source archive rather than retrying an impossible source path.

## Document deletion pattern

Document deletion is global physical deletion, not unlinking from the current Work. Its dialog identifies the selected Doc, fetches the current annotation count only after entry, and separately states that body content, current annotations, and historical archives are deleted and the Doc is removed from every linked Work. Keep deletion confirmation disabled while the count loads; cancellation remains available. A failed count request is an explicit unknown state, never zero, and still permits explicit confirmation. Late count responses from a closed or changed Doc session are ignored.

HTTP success, busy 409, already-missing 404, and other errors retain their established server semantics. The UI supplies explanation and recovery without changing the API or moving annotation archival responsibility into the browser.

## Extending the foundation

Extract a primitive from a real consumer and give it interaction responsibility, not only a CSS wrapper. Reuse the public interface first; add a prop or primitive when the consumer demonstrates a distinct behavior. Writer and ImportDialog remain separate until a ticket explicitly migrates them.

Validate behavior at public props/keyboard/focus or feature HTTP/WS/callback seams. Happy DOM cannot prove layout: use the real application in a browser for representative theme, language, density, and desktop viewport combinations, recording actual pane/dialog dimensions and any unverified cases.
