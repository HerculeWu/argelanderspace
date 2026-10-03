import { afterEach, describe, expect, it, vi } from "vitest";
import { claimViewId, loadViewIdentity, saveViewIdentity } from "../src/argelander/view-identity";

afterEach(() => { window.sessionStorage.clear(); vi.restoreAllMocks(); });

describe("view identity (kept apart from message context)", () => {
  it("is stable across a reload and keeps the revision counting upwards", () => {
    const first = loadViewIdentity();
    expect(first.revision).toBe(0);
    saveViewIdentity({ ...first, revision: 41 });
    expect(loadViewIdentity()).toEqual({ viewId: first.viewId, revision: 41 });
  });
  it("ignores a damaged record and survives unavailable storage", () => {
    window.sessionStorage.setItem("argelander.copilot.view", JSON.stringify({ viewId: "not-a-uuid", revision: -1 }));
    expect(loadViewIdentity().viewId).toMatch(/^[0-9a-f-]{36}$/);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(loadViewIdentity().revision).toBe(0);
    expect(() => saveViewIdentity({ viewId: crypto.randomUUID(), revision: 1 })).not.toThrow();
  });
  it("a duplicated tab (the id is already locked elsewhere) must take a new id and must not be reported as held", async () => {
    const taken = vi.fn(), held = vi.fn();
    const request = vi.fn(async (_name: string, _options: unknown, callback: (lock: unknown) => unknown) => { await callback(null); });
    const release = claimViewId("id-1", { onHeld: held, onTaken: taken }, { request });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(request).toHaveBeenCalledWith("argelander-view-id-1", { ifAvailable: true }, expect.any(Function));
    expect(taken).toHaveBeenCalledTimes(1);
    expect(held).not.toHaveBeenCalled();
    release();
  });
  it("a lone tab is told it holds the id only once the lock is granted; without Web Locks it keeps the id", async () => {
    const held = vi.fn(), taken = vi.fn();
    let grant!: () => void;
    const request = vi.fn((_n: string, _o: unknown, callback: (lock: unknown) => unknown) => new Promise<void>((resolve) => { grant = () => { void callback({}); resolve(); }; }));
    const release = claimViewId("id-2", { onHeld: held, onTaken: taken }, { request });
    await Promise.resolve();
    expect(held).not.toHaveBeenCalled(); // nothing may subscribe or publish before the answer is known
    grant();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(held).toHaveBeenCalledTimes(1);
    expect(taken).not.toHaveBeenCalled();
    release();
    const plain = vi.fn();
    const releasePlain = claimViewId("id-3", { onHeld: plain, onTaken: taken }, null as never);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(plain).toHaveBeenCalledTimes(1);
    releasePlain();
  });
  it("StrictMode's mount, cleanup, mount keeps one lock and one answer: the id is not mistaken for a duplicate, and the lock is released after the real unmount", async () => {
    const held = vi.fn(), taken = vi.fn();
    let released = false;
    const request = vi.fn(async (_n: string, _o: unknown, callback: (lock: unknown) => unknown) => { await callback({}); released = true; });
    const first = claimViewId("id-4", { onHeld: held, onTaken: taken }, { request });
    first(); // StrictMode's simulated unmount
    const second = claimViewId("id-4", { onHeld: held, onTaken: taken }, { request });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(request).toHaveBeenCalledTimes(1);
    expect(taken).not.toHaveBeenCalled();
    expect(held).toHaveBeenCalled();
    expect(released).toBe(false);
    second(); // the real unmount
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(released).toBe(true);
  });
});
