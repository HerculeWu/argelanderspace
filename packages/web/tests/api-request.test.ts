import { afterEach, describe, expect, it, vi } from "vitest";
import { CopilotApiError, fetchConversation } from "../src/api/copilot";
import { fetchMailAccounts, MailApiError } from "../src/api/mail";
import { fetchMailOutbox } from "../src/api/mail-compose";
import { fetchProviders, ProviderApiError } from "../src/api/providers";
import { apiRequest, conflictKind, HttpError } from "../src/api/request";

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const text = (body: string, status = 200) => new Response(body, { status });
const stub = (impl: (url: string, init?: RequestInit) => Promise<Response>) => {
  const fetch = vi.fn(impl);
  vi.stubGlobal("fetch", fetch);
  return fetch;
};
const abortError = () => Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
const caught = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => { throw new Error("resolved"); }, (e: unknown) => e);

describe("apiRequest", () => {
  it("resolves the parsed JSON body of an ok answer", async () => {
    stub(async () => json({ a: 1 }));
    await expect(apiRequest<{ a: number }>("/api/x")).resolves.toEqual({ a: 1 });
  });

  it("sends a JSON body with its content type, a raw body as is, and the caller's options", async () => {
    const fetch = stub(async () => json({}));
    const signal = new AbortController().signal;
    await apiRequest("/api/x", { method: "PUT", cache: "no-store", headers: { "X-A": "1" }, json: { b: 2 } }, { signal });
    expect(fetch).toHaveBeenLastCalledWith("/api/x", {
      method: "PUT", cache: "no-store", headers: { "Content-Type": "application/json", "X-A": "1" }, body: JSON.stringify({ b: 2 }), signal,
    });
    const blob = new Blob(["zip"]);
    await apiRequest("/api/y", { method: "POST", headers: { "Content-Type": "application/zip" }, raw: blob });
    expect(fetch).toHaveBeenLastCalledWith("/api/y", { method: "POST", headers: { "Content-Type": "application/zip" }, body: blob });
  });

  it("calls fetch with the bare path when there is nothing to configure", async () => {
    const fetch = stub(async () => json({}));
    await apiRequest("/api/x");
    expect(fetch).toHaveBeenLastCalledWith("/api/x");
  });

  it("hands back the unread response with parse: none", async () => {
    const response = text("raw bytes");
    stub(async () => response);
    await expect(apiRequest<Response>("/api/x", {}, { parse: "none" })).resolves.toBe(response);
  });

  it("turns a network failure into unreachable with status 0, keeping the original error", async () => {
    const network = new TypeError("Failed to fetch");
    stub(async () => { throw network; });
    const e = await caught(apiRequest("/api/x"));
    expect(e).toBeInstanceOf(HttpError);
    expect(e).toMatchObject({ code: "unreachable", status: 0, body: null, cause: network });
  });

  it("rethrows an abort as is", async () => {
    const abort = abortError();
    stub(async () => { throw abort; });
    await expect(apiRequest("/api/x")).rejects.toBe(abort);
  });

  it("rejects a non-JSON ok answer with the parse error itself", async () => {
    stub(async () => text("<html>"));
    const e = await caught(apiRequest("/api/x"));
    expect(e).not.toBeInstanceOf(HttpError);
    expect(e).toBeInstanceOf(SyntaxError);
  });

  it("uses the body's code for a failed answer", async () => {
    stub(async () => json({ code: "not_found", detail: "no such thing" }, 404));
    const e = await caught(apiRequest("/api/x"));
    expect(e).toBeInstanceOf(HttpError);
    expect(e).toMatchObject({ code: "not_found", status: 404, body: { code: "not_found", detail: "no such thing" } });
    expect((e as HttpError).cause).toBeUndefined();
  });

  it("derives the code from a contract detail when there is no code", async () => {
    stub(async () => json({ detail: "document busy" }, 409));
    expect(await caught(apiRequest("/api/x"))).toMatchObject({ code: "busy", status: 409 });
    stub(async () => json({ detail: "rev mismatch", rev: 4 }, 409));
    expect(await caught(apiRequest("/api/x"))).toMatchObject({ code: "rev-mismatch", status: 409, body: { rev: 4 } });
    stub(async () => json({ detail: "document busy" }, 500));
    expect(await caught(apiRequest("/api/x"))).toMatchObject({ code: "unavailable", status: 500 });
  });

  it("falls back to unavailable when the failed answer has neither, and keeps the parse error of a non-JSON one", async () => {
    stub(async () => json({ detail: "boom" }, 500));
    expect(await caught(apiRequest("/api/x"))).toMatchObject({ code: "unavailable", status: 500, body: { detail: "boom" } });
    stub(async () => text("Bad Gateway", 502));
    const e = await caught(apiRequest("/api/x"));
    expect(e).toMatchObject({ code: "unavailable", status: 502, body: null });
    expect((e as HttpError).cause).toBeInstanceOf(SyntaxError);
  });
});

describe("conflictKind", () => {
  const conflict = (body: unknown, status = 409) => new HttpError("x", status, body);

  it("classifies the contract's 409 answers by their literal text", () => {
    expect(conflictKind(conflict({ detail: "document busy" }))).toBe("busy");
    expect(conflictKind(conflict({ detail: "document changed" }))).toBe("changed");
    expect(conflictKind(conflict({ detail: "rev mismatch" }))).toBe("rev-mismatch");
    expect(conflictKind(conflict({ detail: "source revision changed", code: "stale" }))).toBe("stale");
  });

  it("says nothing about other details, other statuses or other errors", () => {
    expect(conflictKind(conflict({ detail: "reading position rev mismatch" }))).toBeNull();
    expect(conflictKind(conflict({ detail: "Document busy" }))).toBeNull();
    expect(conflictKind(conflict(null))).toBeNull();
    expect(conflictKind(conflict({ detail: "document busy" }, 500))).toBeNull();
    expect(conflictKind(new Error("document busy"))).toBeNull();
    expect(conflictKind(undefined)).toBeNull();
  });
});

describe("the three API error classes", () => {
  it("are HttpErrors with their own fields", () => {
    const mail = new MailApiError("invalid", 400, { fields: ["host"] });
    expect(mail).toBeInstanceOf(HttpError);
    expect(mail).toBeInstanceOf(MailApiError);
    expect(mail).toMatchObject({ code: "invalid", status: 400, extra: { fields: ["host"] }, message: "invalid" });
    expect(new MailApiError("unreachable", 0).extra).toEqual({});
    const copilot = new CopilotApiError("stale");
    expect(copilot).toBeInstanceOf(HttpError);
    expect(copilot).toMatchObject({ code: "stale", message: "stale" });
    const provider = new ProviderApiError("busy");
    expect(provider).toBeInstanceOf(HttpError);
    expect(provider).toMatchObject({ code: "busy", message: "busy" });
  });

  it("are what the mail, compose, Copilot and provider clients throw", async () => {
    stub(async () => json({ code: "invalid", fields: ["host"] }, 400));
    const mail = await caught(fetchMailAccounts());
    expect(mail).toBeInstanceOf(MailApiError);
    expect(mail).toMatchObject({ code: "invalid", status: 400, extra: { fields: ["host"] } });
    const compose = await caught(fetchMailOutbox());
    expect(compose).toBeInstanceOf(MailApiError);
    expect(compose).toMatchObject({ code: "invalid", status: 400, extra: {} });
    stub(async () => json({ code: "not_found" }, 404));
    expect(await caught(fetchConversation("c1"))).toMatchObject({ code: "not_found" });
    expect(await caught(fetchConversation("c1"))).toBeInstanceOf(CopilotApiError);
    expect(await caught(fetchProviders())).toBeInstanceOf(ProviderApiError);
  });

  it("keep the clients' network behaviour: mail says unreachable, Copilot and providers pass the failure through", async () => {
    const network = new TypeError("Failed to fetch");
    stub(async () => { throw network; });
    expect(await caught(fetchMailAccounts())).toMatchObject({ code: "unreachable", status: 0 });
    expect(await caught(fetchMailOutbox())).toMatchObject({ code: "unreachable", status: 0 });
    expect(await caught(fetchConversation("c1"))).toBe(network);
    expect(await caught(fetchProviders())).toBe(network);
  });

  it("Copilot: a non-JSON answer is unavailable, not a SyntaxError", async () => {
    stub(async () => text("<html>Bad Gateway</html>", 502));
    const failed = await caught(fetchConversation("c1"));
    expect(failed).toBeInstanceOf(CopilotApiError);
    expect(failed).toMatchObject({ code: "unavailable" });
    stub(async () => text("<html>ok</html>"));
    const garbled = await caught(fetchConversation("c1"));
    expect(garbled).toBeInstanceOf(CopilotApiError);
    expect(garbled).toMatchObject({ code: "unavailable" });
  });

  it("compose passes an abort through like the rest of mail", async () => {
    const abort = abortError();
    stub(async () => { throw abort; });
    expect(await caught(fetchMailOutbox())).toBe(abort);
    expect(await caught(fetchMailAccounts())).toBe(abort);
  });

  it("Copilot passes an abort through, like the provider client", async () => {
    const abort = abortError();
    stub(async () => { throw abort; });
    expect(await caught(fetchConversation("c1"))).toBe(abort);
    expect(await caught(fetchProviders())).toBe(abort);
  });
});
