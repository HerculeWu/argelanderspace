import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMemo, useState } from "react";
import { DocPane } from "../src/doc/DocPane";
import { WorkspaceProvider, type Workspace } from "../src/argelander/workspace";

type Call = { url: string; init?: RequestInit; resolve: (response: Response) => void };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});
let calls: Call[];
function installFetch() {
  calls = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve) => calls.push({ url: String(input), init, resolve }))));
}
async function respond(call: Call, body: unknown, status = 200) {
  await act(async () => call.resolve(json(body, status)));
}
function Harness() {
  const [docId, setDocId] = useState("first-doc");
  const workspace: Workspace = useMemo(() => ({
    papers: ["first-doc", "second-doc"], currentDoc: docId,
    setCurrentDoc: setDocId, openDoc: (id) => { if (id) setDocId(id); },
    pendingAnchor: null, clearPendingAnchor: () => {}, docDeleted: () => {},
    tweaks: { theme: "dark", accent: "azure", density: "regular", labels: true },
  }), [docId]);
  return <WorkspaceProvider value={workspace}>
    <button onClick={() => setDocId("second-doc")}>Switch document</button>
    <DocPane />
  </WorkspaceProvider>;
}
const descriptorUrl = (id: string) => `/api/paper/${id}/description`;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Doc reading-entry dispatch", () => {
  it("keeps descriptor HTTP errors visible and retries before entering the LaTeX Reader", async () => {
    installFetch();
    const { container, getByRole } = render(<Harness />);
    await waitFor(() => expect(calls.some((call) => call.url === descriptorUrl("first-doc"))).toBe(true));
    await respond(calls[0]!, { detail: "unavailable" }, 503);
    expect(getByRole("alert").textContent).toContain("文档载入失败");
    fireEvent.click(getByRole("button", { name: "手动重试" }));
    await waitFor(() => expect(calls.filter((call) => call.url === descriptorUrl("first-doc"))).toHaveLength(2));
    await respond(calls[1]!, { doc_id: "first-doc", format: "latex" });
    await waitFor(() => expect(calls.some((call) => call.url === "/api/paper/first-doc/annotations?coherent=1")).toBe(true));
    expect(container.querySelector(".reader-sync-status")).toBeTruthy();
  });

  it("rejects malformed or misidentified descriptors and offers retry rather than guessing", async () => {
    installFetch();
    const { getByRole } = render(<Harness />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await respond(calls[0]!, { doc_id: "second-doc", format: "latex" });
    expect(getByRole("alert").textContent).toContain("文档载入失败");
    expect(calls.some((call) => call.url.endsWith("/annotations?coherent=1"))).toBe(false);
    expect(getByRole("button", { name: "手动重试" })).toBeTruthy();
  });

  it("aborts and ignores a late descriptor after switching Docs; only dispatches the selected Doc", async () => {
    installFetch();
    const { getByRole } = render(<Harness />);
    await waitFor(() => expect(calls.some((call) => call.url === descriptorUrl("first-doc"))).toBe(true));
    const first = calls.find((call) => call.url === descriptorUrl("first-doc"))!;
    fireEvent.click(getByRole("button", { name: "Switch document" }));
    await waitFor(() => expect(calls.some((call) => call.url === descriptorUrl("second-doc"))).toBe(true));
    expect(first.init?.signal?.aborted).toBe(true);
    await respond(first, { doc_id: "first-doc", format: "latex" });
    const second = calls.find((call) => call.url === descriptorUrl("second-doc"))!;
    await respond(second, { doc_id: "second-doc", format: "latex" });
    await waitFor(() => expect(calls.some((call) => call.url === "/api/paper/second-doc/annotations?coherent=1")).toBe(true));
    expect(calls.some((call) => call.url === "/api/paper/first-doc/annotations?coherent=1")).toBe(false);
  });
});
