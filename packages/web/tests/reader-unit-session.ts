/** Ready session for isolated renderer/navigation tests; end-to-end request
 * acceptance is exercised without this mock in reader-session.test.tsx. */
const state = {
  phase: "ready",
  generation: 0,
  writePending: false,
  accepted: {
    assets: [],
    file: { version: 1, rev: 0, content_fingerprint: "unit", annotations: [] },
  },
  createDraft: { body: "", revision: 0, use: false },
  editDrafts: {},
};
const controller = {
  getSnapshot: () => state,
  canAnnotate: () => true,
  onInvalidate: () => () => {},
};
export const useReaderSession = () => ({ state, controller, canAnnotate: true });
