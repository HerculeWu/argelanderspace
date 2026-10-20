/**
 * The stand-in of the settings endpoints (`settings-fake.ts`) judges a change as the server does: the combinations
 * that pin the order of the stages (contracts `settings-change.ts`) give the answers the server gives
 * (server `tests/settings.test.ts`).
 */

import { describe, expect, test } from "vitest";
import { type FakeSettings, fakeSettings } from "./settings-fake";

async function put(fake: FakeSettings, key: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fake.handle(`/api/settings/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: typeof body === "string" ? body : JSON.stringify(body),
  })!;
  return { status: res.status, body: await res.json() };
}

function fake(): FakeSettings {
  const f = fakeSettings();
  f.refusalDelayMs = 0;
  return f;
}

describe("the stand-in answers in the server's order", () => {
  test("a file that is not TOML and a value the key does not take: 400 invalid_value", async () => {
    const f = fake();
    f.state = "unparseable";
    expect(await put(f, "ui.theme", { set: "purple" })).toEqual({ status: 400, body: { ok: false, reason: "invalid_value" } });
    expect(await put(f, "ui.theme", { set: "light" })).toEqual({ status: 409, body: { ok: false, reason: "unparseable" } });
  });

  test("a forced write_failed: 500, as the server answers it", async () => {
    const f = fake();
    f.refuse["ui.density"] = "write_failed";
    expect(await put(f, "ui.density", { set: "compact" })).toEqual({ status: 500, body: { ok: false, reason: "write_failed" } });
    expect(f.file).toEqual({});
  });

  test("each forced refusal has the server's status", async () => {
    for (const [reason, status] of [
      ["busy", 409],
      ["dotted_key", 409],
      ["not_writable", 500],
      ["invalid_encoding", 500],
      ["invalid_value", 400],
    ] as const) {
      const f = fake();
      f.refuse["ui.theme"] = reason;
      expect([reason, await put(f, "ui.theme", { set: "light" })]).toEqual([reason, { status, body: { ok: false, reason } }]);
    }
  });

  test("a refusal of the file's layout comes after the value; one of reading the file before it", async () => {
    const f = fake();
    f.uneditable = { "ui.theme": "dotted_key" };
    expect((await put(f, "ui.theme", { set: "purple" })).body).toEqual({ ok: false, reason: "invalid_value" });
    f.uneditable = {};
    f.refuse["ui.theme"] = "busy";
    expect((await put(f, "ui.theme", { set: "purple" })).body).toEqual({ ok: false, reason: "busy" });
  });

  test("a file that cannot be read refuses the change (500 unreadable) and keeps it out of the file", async () => {
    const f = fake();
    f.state = "unreadable";
    expect(await put(f, "ui.theme", { set: "light" })).toEqual({ status: 500, body: { ok: false, reason: "unreadable" } });
    expect(f.file).toEqual({});
  });

  test("the key and the request come first", async () => {
    const f = fake();
    f.state = "unreadable";
    expect(await put(f, "nope", "not a change")).toEqual({ status: 404, body: { ok: false, reason: "unknown_key" } });
    expect(await put(f, "global_dir", { set: 1, reset: true })).toEqual({ status: 422, body: { ok: false, reason: "not_editable" } });
    expect(await put(f, "ui.theme", { set: "purple", extra: 1 })).toEqual({ status: 400, body: { ok: false, reason: "invalid_request" } });
    expect(await put(f, "ui.theme", "not json")).toEqual({ status: 400, body: { ok: false, reason: "invalid_request" } });
    expect(await put(f, "data_dir", { set: "lit\nerature" })).toEqual({ status: 500, body: { ok: false, reason: "unreadable" } });
  });

  test("a value that cannot be written: 400 unrepresentable_value, after invalid_value", async () => {
    const f = fake();
    expect(await put(f, "data_dir", { set: "lit\nerature" })).toEqual({ status: 400, body: { ok: false, reason: "unrepresentable_value" } });
    expect(await put(f, "ui.theme", { set: "pur\nple" })).toEqual({ status: 400, body: { ok: false, reason: "invalid_value" } });
  });

  test("restartPending: the restart-only keys changed since the start, not from a flag, none while read-only", async () => {
    const f = fake();
    f.running = { ...f.running, from_flag: ["port"] };
    expect((await put(f, "port", { set: 1860 })).status).toBe(200);
    expect((await put(f, "data_dir", { set: "./other" })).status).toBe(200);
    expect((await put(f, "ui.theme", { set: "light" })).status).toBe(200);
    expect(f.snapshot().restartPending).toEqual(["data_dir"]);
    f.state = "unparseable";
    expect(f.snapshot().restartPending).toEqual([]);
  });
});
