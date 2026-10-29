/**
 * The external agents' confirmation cards (release-0.2 ticket 04, approved prototype 03 variant A) at the component
 * seam: the real dock and chip with a scripted API. Layout and stacking are proven in the real browser, not here.
 */
import type { CopilotDocConfirmation, CopilotDocDeleteConfirmation, ExternalRequest } from "@argelanderspace/contracts";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import i18n from "../src/i18n";
import { ExternalRequestsChip, ExternalRequestsDock, useExternalRequestsModel } from "../src/external-requests/ExternalRequests";

const api = vi.hoisted(() => ({
  list: [] as unknown[],
  changed: null as null | (() => void),
  decide: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("../src/api/external-requests", () => ({
  fetchExternalRequests: async () => api.list,
  decideExternalRequest: (...args: unknown[]) => api.decide(...args),
  dismissExternalRequest: (...args: unknown[]) => api.dismiss(...args),
}));
vi.mock("../src/api/ws-instance", () => ({
  bus: {
    on: (_type: string, cb: () => void) => { api.changed = cb; return () => { api.changed = null; }; },
    onResync: () => () => {},
  },
}));

const card = (id: string): CopilotDocDeleteConfirmation => ({
  id: "00000000-0000-4000-8000-0000000000cc", runId: "00000000-0000-4000-8000-0000000000cc", toolCallId: "external", action: "delete_doc",
  object: { kind: "doc", id }, format: "latex", works: [{ id: "w1", title: "First work", main: true, remaining: 1 }],
  impact: { annotations: "known", count: 4 }, baseRev: 3, objectDigest: "d".repeat(64),
});
const request = (n: number, over: Partial<ExternalRequest> = {}): ExternalRequest => ({
  id: `00000000-0000-4000-8000-00000000000${n}`, state: "pending", receivedAt: new Date(Date.now() - 42_000).toISOString(),
  client: { pid: 7, commandLine: `argelanderspace library delete-doc --doc-id doc-${n}` }, card: card(`doc-${n}`), ...over,
});

const guards = { leaveDoc: vi.fn(() => true as boolean | Promise<boolean>), leaveManuscript: vi.fn(() => true as boolean | Promise<boolean>) };
const deleted = vi.fn();
let open: string | null = null;
function Harness() {
  const model = useExternalRequestsModel();
  return <><ExternalRequestsChip model={model} /><ExternalRequestsDock model={model} guards={guards} openDocId={open} onDocDeleted={deleted} /></>;
}
const show = async (...requests: ExternalRequest[]) => { api.list = requests; render(<Harness />); };

beforeEach(async () => {
  await i18n.changeLanguage("en");
  api.list = []; api.decide.mockReset(); api.dismiss.mockReset(); deleted.mockReset(); guards.leaveDoc.mockReset().mockReturnValue(true); open = null;
  document.title = "ArgelanderSpace";
});
afterEach(() => { cleanup(); });

const q = (ui: string) => document.querySelector(`[data-ui="${ui}"]`);

test("a request shows the source, the command line, the wait and Copilot's own delete card with Deny / Delete permanently", async () => {
  await show(request(1));
  await waitFor(() => expect(q("external-request")).not.toBeNull());
  expect(q("external-request")?.textContent).toContain("External agent asks to confirm");
  expect(q("external-request-command")?.textContent).toBe("argelanderspace library delete-doc --doc-id doc-1");
  expect(q("external-request-wait")?.textContent).toMatch(/waited 0:4\d/);
  // the same facts Copilot's card shows (copilot/confirmations/delete-doc.tsx)
  expect(q("copilot-confirmation-count")?.textContent).toContain("4");
  expect(q("external-request-deny")?.textContent).toBe("Deny");
  expect(q("external-request-approve")?.textContent).toBe("Delete permanently");
  expect(q("external-requests-chip")?.textContent).toContain("External requests 1");
  // the tab title carries the count
  expect(document.title).toBe("(1) ArgelanderSpace");
});

test("approve: the page guard is asked first (a refusal keeps the card and sends nothing), then the decision and the Shell's Doc update", async () => {
  await show(request(1));
  await waitFor(() => expect(q("external-request-approve")).not.toBeNull());
  guards.leaveDoc.mockReturnValue(false);
  fireEvent.click(q("external-request-approve") as HTMLElement);
  expect(guards.leaveDoc).toHaveBeenCalledWith("doc-1");
  expect(api.decide).not.toHaveBeenCalled();
  guards.leaveDoc.mockReturnValue(true);
  api.decide.mockResolvedValue({ state: "approved", result: { ok: true, status: "ok", docId: "doc-1", works: [{ id: "w1", title: "t", remaining: ["doc-2"] }] } });
  api.list = [];
  fireEvent.click(q("external-request-approve") as HTMLElement);
  await waitFor(() => expect(api.decide).toHaveBeenCalledWith(request(1).id, "approve"));
  await waitFor(() => expect(deleted).toHaveBeenCalledWith("doc-1", ["doc-2"]));
  await waitFor(() => expect(q("external-request-result")?.textContent).toContain("Deleted permanently"));
  expect(q("external-request")).toBeNull();
});

test("a delete that did not happen (the Doc changed) says so with the server's reason, and does not move the Shell", async () => {
  await show(request(1));
  await waitFor(() => expect(q("external-request-approve")).not.toBeNull());
  api.decide.mockResolvedValue({ state: "approved", result: { ok: false, status: "expired", detail: "the Doc changed after the user confirmed; nothing was deleted" } });
  api.list = [];
  fireEvent.click(q("external-request-approve") as HTMLElement);
  await waitFor(() => expect(q("external-request-result")?.textContent).toContain("the Doc changed after the user confirmed"));
  expect(deleted).not.toHaveBeenCalled();
});

test("deny: no guard is asked, the result says the command received denied", async () => {
  await show(request(1));
  await waitFor(() => expect(q("external-request-deny")).not.toBeNull());
  api.decide.mockResolvedValue({ state: "denied" });
  api.list = [];
  fireEvent.click(q("external-request-deny") as HTMLElement);
  await waitFor(() => expect(api.decide).toHaveBeenCalledWith(request(1).id, "deny"));
  expect(guards.leaveDoc).not.toHaveBeenCalled();
  await waitFor(() => expect(q("external-request-result")?.textContent).toContain("error code denied"));
});

test("a request the server no longer has says so instead of failing silently", async () => {
  await show(request(1));
  await waitFor(() => expect(q("external-request-approve")).not.toBeNull());
  api.decide.mockResolvedValue({ state: "stale" });
  fireEvent.click(q("external-request-approve") as HTMLElement);
  await waitFor(() => expect(q("external-request-result")?.textContent).toContain("This request is gone"));
});

test("the Doc open in the Reader gets a warning line on its card", async () => {
  open = "doc-1";
  await show(request(1));
  await waitFor(() => expect(q("external-request-open-doc")?.textContent).toContain("open in the Reader"));
});

test("a queue: only the first card is operable, the others are listed in arrival order, no approve-all", async () => {
  await show(request(1), request(2), request(3, { state: "withdrawn" }));
  await waitFor(() => expect(q("external-request")).not.toBeNull());
  expect(document.querySelectorAll('[data-ui="external-request-approve"]')).toHaveLength(1);
  expect(q("external-request-pager")?.textContent).toBe("1 / 3");
  const queued = [...document.querySelectorAll('[data-ui="external-request-queued"]')];
  expect(queued).toHaveLength(2);
  expect(queued[0]?.textContent).toContain("doc-2");
  expect(queued[1]?.className).toContain("gone");
  expect(document.title).toBe("(2) ArgelanderSpace");
});

test("a withdrawn first card stays, disabled, until the user closes it", async () => {
  await show(request(1, { state: "withdrawn" }));
  await waitFor(() => expect(q("external-request-withdrawn")).not.toBeNull());
  expect(q("external-request-withdrawn")?.textContent).toContain("The command was interrupted; the request is withdrawn");
  expect(q("external-request-approve")).toBeNull();
  expect(q("external-request-deny")).toBeNull();
  fireEvent.click(q("external-request-dismiss") as HTMLElement);
  await waitFor(() => expect(api.dismiss).toHaveBeenCalledWith(request(1).id));
  // a withdrawn request is not "waiting": no title prefix
  expect(document.title).toBe("ArgelanderSpace");
});

test("collapse folds the card into a bar (the chip stays); a new request opens it again", async () => {
  await show(request(1));
  await waitFor(() => expect(q("external-request")).not.toBeNull());
  fireEvent.click(q("external-requests-toggle") as HTMLElement);
  expect(q("external-request")).toBeNull();
  expect(q("external-requests-bar")?.textContent).toContain("External agent asks to confirm");
  expect(q("external-requests-chip")).not.toBeNull();
  fireEvent.click(q("external-requests-chip") as HTMLElement);
  expect(q("external-request")).not.toBeNull();
  fireEvent.click(q("external-requests-toggle") as HTMLElement);
  api.list = [request(1), request(2)];
  await act(async () => { api.changed?.(); });
  await waitFor(() => expect(q("external-request")).not.toBeNull());
});

test("nothing is shown with no request, and the leave prompt is armed only while one waits", async () => {
  const added = vi.spyOn(window, "addEventListener");
  await show();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(q("external-requests-dock")).toBeNull();
  expect(q("external-requests-chip")).toBeNull();
  expect(added.mock.calls.some(([type]) => type === "beforeunload")).toBe(false);
  api.list = [request(1)];
  await act(async () => { api.changed?.(); });
  await waitFor(() => expect(added.mock.calls.some(([type]) => type === "beforeunload")).toBe(true));
  added.mockRestore();
});

const refreshRequest = (): ExternalRequest => ({
  id: "00000000-0000-4000-8000-0000000000f1", state: "pending", receivedAt: new Date(Date.now() - 5_000).toISOString(),
  client: { pid: 7, commandLine: "argelanderspace library attach-arxiv --ref-id arxiv:2603.00002" },
  card: {
    id: "00000000-0000-4000-8000-0000000000cc", runId: "00000000-0000-4000-8000-0000000000cc", toolCallId: "external", action: "refresh_arxiv_source",
    object: { kind: "doc", id: "arxiv-2603.00002", workId: "arxiv:2603.00002" }, label: "The paper", impact: { annotations: "known", count: 2 }, baseRev: 5, objectDigest: "e".repeat(64),
  } satisfies CopilotDocConfirmation,
});

test("replacing an arXiv source: the Copilot card of that action with its summary and the replacement's own result wording", async () => {
  await show(refreshRequest());
  await waitFor(() => expect(q("external-request")).not.toBeNull());
  expect(q("external-request")?.getAttribute("data-action")).toBe("refresh_arxiv_source");
  expect(q("external-request")?.textContent).toContain("Replace the arXiv source of “The paper”");
  expect(q("external-request-command")?.textContent).toContain("attach-arxiv");
  api.decide.mockResolvedValue({ state: "approved", result: { ok: true, status: "submitted", jobId: "ingest-1" } });
  api.list = [];
  fireEvent.click(q("external-request-approve") as HTMLElement);
  await waitFor(() => expect(api.decide).toHaveBeenCalledWith(refreshRequest().id, "approve"));
  await waitFor(() => expect(q("external-request-result")?.textContent).toContain("Replacement started"));
  // not the Doc delete's wording, and the Shell is not told a Doc was deleted
  expect(q("external-request-result")?.textContent).not.toContain("Deleted");
  expect(deleted).not.toHaveBeenCalled();
});

test("replacing an arXiv source: denied and not-done results say nothing was replaced", async () => {
  await show(refreshRequest());
  await waitFor(() => expect(q("external-request-deny")).not.toBeNull());
  api.decide.mockResolvedValue({ state: "denied" });
  api.list = [];
  fireEvent.click(q("external-request-deny") as HTMLElement);
  await waitFor(() => expect(q("external-request-result")?.textContent).toContain("nothing was replaced"));
  cleanup();
  await show(refreshRequest());
  await waitFor(() => expect(q("external-request-approve")).not.toBeNull());
  api.decide.mockResolvedValue({ state: "approved", result: { ok: false, status: "expired", detail: "annotations changed" } });
  api.list = [];
  fireEvent.click(q("external-request-approve") as HTMLElement);
  await waitFor(() => expect(q("external-request-result")?.textContent).toContain("Nothing was replaced"));
});

// ---- Replacing or clearing an argument graph (release-0.2 ticket 08) --------------------------------------------- //

const argumentRequest = (mode: "replace" | "clear", over: Partial<ExternalRequest> = {}): ExternalRequest => ({
  id: "00000000-0000-4000-8000-0000000000a1", state: "pending", receivedAt: new Date(Date.now() - 5_000).toISOString(),
  client: { pid: 9, commandLine: `argelanderspace argument ${mode} --json plan.json` },
  card: {
    id: "00000000-0000-4000-8000-0000000000a1", runId: "00000000-0000-4000-8000-0000000000a1", toolCallId: "external", action: "replace_argument_graph",
    object: { kind: "work", id: "doi:10.1000/w1", workId: "doi:10.1000/w1" }, label: "Work number 1", mode,
    current: { arguments: 12, edges: 9 }, next: mode === "clear" ? { arguments: 0, edges: 0 } : { arguments: 3, edges: 2 },
    baseRev: 4, objectDigest: "d".repeat(64),
  },
  ...over,
});

test("a replace of an argument graph shows Copilot's own card: the work, what is lost and what comes; Deny / Replace", async () => {
  await show(argumentRequest("replace"));
  await waitFor(() => expect(q("external-request")).not.toBeNull());
  expect(q("external-request")?.getAttribute("data-action")).toBe("replace_argument_graph");
  expect(q("external-request-command")?.textContent).toBe("argelanderspace argument replace --json plan.json");
  expect(q("copilot-confirmation-title")?.textContent).toBe("Replace the argument graph");
  expect(q("copilot-confirmation-work")?.textContent).toBe("Work number 1");
  expect(q("copilot-confirmation-scope")?.textContent).toBe("The existing 12 arguments and 9 edges will be replaced by 3 arguments and 2 edges.");
  expect(q("external-request-deny")?.textContent).toBe("Deny");
  expect(q("external-request-approve")?.textContent).toBe("Replace");
  // not a Doc card: no open-Doc warning
  expect(q("external-request-open-doc")).toBeNull();
});

test("a clear says it cannot be undone; approving reports the argument graph, not a Doc, and moves nothing in the Shell", async () => {
  await show(argumentRequest("clear"));
  await waitFor(() => expect(q("external-request-approve")).not.toBeNull());
  expect(q("copilot-confirmation-scope")?.textContent).toContain("All 12 arguments and 9 edges of this work will be deleted. This cannot be undone.");
  api.decide.mockResolvedValue({ state: "approved", result: { ok: true, status: "ok", rev: 5, counts: { arguments: 0, edges: 0 } } });
  api.list = [];
  fireEvent.click(q("external-request-approve") as HTMLElement);
  await waitFor(() => expect(api.decide).toHaveBeenCalledWith("00000000-0000-4000-8000-0000000000a1", "approve"));
  await waitFor(() => expect(q("external-request-result")?.textContent).toContain("Argument graph cleared"));
  expect(guards.leaveDoc).not.toHaveBeenCalled();
  expect(deleted).not.toHaveBeenCalled();
});

test("the queue names an argument request by what it does; a withdrawn or denied one says the graph was not changed", async () => {
  await show(request(1), argumentRequest("replace"));
  await waitFor(() => expect(q("external-request-queued")).not.toBeNull());
  expect(q("external-request-queued")?.textContent).toContain("Replace the argument graph of “Work number 1”");
  cleanup();
  api.list = [argumentRequest("replace", { state: "withdrawn" })];
  render(<Harness />);
  await waitFor(() => expect(q("external-request-withdrawn")).not.toBeNull());
  expect(q("external-request-withdrawn")?.textContent).toContain("The argument graph was not changed.");
  cleanup();
  api.list = [argumentRequest("replace")];
  api.decide.mockResolvedValue({ state: "denied" });
  render(<Harness />);
  await waitFor(() => expect(q("external-request-deny")).not.toBeNull());
  api.list = [];
  fireEvent.click(q("external-request-deny") as HTMLElement);
  await waitFor(() => expect(q("external-request-result")?.textContent).toContain("the argument graph was not changed"));
});
