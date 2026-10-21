/**
 * How a page knows the tutorial project was entered through the tutorial's own entry ("Start / Resume tutorial" on the
 * welcome page or the settings page) rather than another way (recent projects, the command line): the entry writes a
 * one-time mark in the tab's session storage just before it asks the host to switch, and the tutorial layer of the
 * next page takes it (reads and removes it) when it mounts. Session storage belongs to the tab and its origin, so the
 * mark reaches the next page when the desktop host serves it at the same address (the configured port); when the
 * port fell back to another one the mark is not there and the layer only shows its capsule, as for any other way in.
 * A mark older than {@link ENTRY_MARK_TTL_MS} is ignored (a switch that was cancelled and left it behind).
 */
export const ENTRY_MARK_KEY = "argelander.tutorial.entry";
export const ENTRY_MARK_TTL_MS = 10 * 60 * 1000;

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Called by an entry right before the switch. */
export function markTutorialEntry(now = Date.now()): void {
  try {
    storage()?.setItem(ENTRY_MARK_KEY, JSON.stringify({ v: 1, at: now }));
  } catch {
    // storage refused: the next page shows only the capsule
  }
}

/** Taken once by the tutorial layer: true when a fresh mark was there. The mark is removed either way. */
export function takeTutorialEntry(now = Date.now()): boolean {
  const s = storage();
  if (!s) return false;
  let raw: string | null = null;
  try {
    raw = s.getItem(ENTRY_MARK_KEY);
    s.removeItem(ENTRY_MARK_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;
  try {
    const mark = JSON.parse(raw) as { v?: unknown; at?: unknown };
    return mark.v === 1 && typeof mark.at === "number" && now - mark.at >= 0 && now - mark.at <= ENTRY_MARK_TTL_MS;
  } catch {
    return false;
  }
}

let taken: boolean | undefined;
/** {@link takeTutorialEntry} once per page load: a second mount (a remount, React's development double run) gets the same answer. */
export function takeTutorialEntryOnce(): boolean {
  if (taken === undefined) taken = takeTutorialEntry();
  return taken;
}
/** Tests only: forget the answer of {@link takeTutorialEntryOnce}. */
export function resetTutorialEntryForTests(): void {
  taken = undefined;
}
