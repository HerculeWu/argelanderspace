import { describe, expect, test } from "vitest";
import {
  defaultSettings,
  isRepresentableSettingString,
  judgeSettingChange,
  restartPendingKeys,
  SETTING_CHANGE_REFUSALS,
  SETTING_CHANGE_STAGE_REFUSALS,
  SETTING_CHANGE_STAGES,
  SETTING_KEYS,
  SETTINGS_SCHEMA,
  type SettingChangeRefusal,
  type SettingKey,
  settingChangeKey,
  settingChangeOf,
  settingChangeRequestOf,
  settingChangeStatus,
  settingRefusalStage,
  settingValueRefusal,
} from "../src/index.js";

describe("the status of each refusal", () => {
  // The table the server answered with before it moved here (server settings.ts `statusOf`), class by class.
  const BEFORE: Record<SettingChangeRefusal, number> = {
    invalid_request: 400,
    not_editable: 422,
    unknown_key: 404,
    invalid_value: 400,
    unrepresentable_value: 400,
    unparseable: 409,
    unsupported_layout: 409,
    duplicate_key: 409,
    dotted_key: 409,
    inline_table: 409,
    multiline_string: 409,
    array_of_tables: 409,
    not_a_scalar: 409,
    table_not_a_table: 409,
    self_check_failed: 409,
    busy: 409,
    unreadable: 500,
    invalid_encoding: 500,
    not_writable: 500,
    write_failed: 500,
  };

  test.each(SETTING_CHANGE_REFUSALS.map((reason) => [reason, BEFORE[reason]] as const))(
    "%s is %i",
    (reason, status) => {
      expect(settingChangeStatus(reason)).toBe(status);
    }
  );

  test("every refusal is in the table, and nothing else", () => {
    expect(Object.keys(BEFORE).sort()).toEqual([...SETTING_CHANGE_REFUSALS].sort());
  });
});

describe("the stages", () => {
  test("every refusal comes from at least one stage; the first one is where a stand-in puts it", () => {
    for (const reason of SETTING_CHANGE_REFUSALS) {
      const stages = SETTING_CHANGE_STAGES.filter((stage) =>
        (SETTING_CHANGE_STAGE_REFUSALS[stage] as readonly string[]).includes(reason)
      );
      expect([reason, stages.length > 0]).toEqual([reason, true]);
      expect(settingRefusalStage(reason)).toBe(stages[0]);
    }
  });

  test("the order: key, request, the file, the value, the text, the replacement", () => {
    expect(SETTING_CHANGE_STAGES).toEqual(["key", "request", "file", "value", "text", "replace"]);
    expect(settingRefusalStage("unknown_key")).toBe("key");
    expect(settingRefusalStage("not_editable")).toBe("key");
    expect(settingRefusalStage("invalid_request")).toBe("request");
    expect(settingRefusalStage("unreadable")).toBe("file");
    expect(settingRefusalStage("invalid_encoding")).toBe("file");
    expect(settingRefusalStage("busy")).toBe("file");
    expect(settingRefusalStage("invalid_value")).toBe("value");
    expect(settingRefusalStage("unrepresentable_value")).toBe("value");
    expect(settingRefusalStage("unparseable")).toBe("text");
    expect(settingRefusalStage("dotted_key")).toBe("text");
    expect(settingRefusalStage("self_check_failed")).toBe("text");
    // The lock and the replacement can both refuse a write.
    for (const reason of ["busy", "not_writable", "write_failed"] as const) {
      expect(SETTING_CHANGE_STAGE_REFUSALS.replace).toContain(reason);
    }
  });
});

describe("the key", () => {
  test("the page may change only keys with a control", () => {
    for (const key of SETTING_KEYS) {
      const answer = settingChangeKey(key, "page");
      expect([key, answer]).toEqual([
        key,
        SETTINGS_SCHEMA[key].ui === "edit"
          ? { ok: true, key }
          : { ok: false, reason: "not_editable" },
      ]);
      expect(settingChangeKey(key, "any")).toEqual({ ok: true, key });
    }
    for (const key of ["nope", "ui", "ui.nope", "__proto__", "constructor", "toString", ""]) {
      expect(settingChangeKey(key, "page")).toEqual({ ok: false, reason: "unknown_key" });
      expect(settingChangeKey(key, "any")).toEqual({ ok: false, reason: "unknown_key" });
    }
  });
});

describe("the shape of a change", () => {
  test("exactly { set: scalar } or { reset: true }", () => {
    for (const body of [
      null,
      "x",
      1,
      [],
      [{ set: 1 }],
      {},
      { set: null },
      { set: [1] },
      { set: { a: 1 } },
      { set: undefined },
      { reset: false },
      { reset: "true" },
      { set: "a", reset: true },
      { set: "a", path: "/x" },
      { value: "a" },
    ]) {
      expect(settingChangeOf(body)).toBeNull();
      expect(settingChangeRequestOf(body)).toBeNull();
    }
    expect(settingChangeOf({ reset: true })).toEqual({ reset: true });
    expect(settingChangeOf({ set: "a" })).toEqual({ set: "a" });
    expect(settingChangeOf({ set: false })).toEqual({ set: false });
    expect(settingChangeOf({ set: 12 })).toEqual({ set: 12 });
  });

  test("minus zero is zero; a number that is not finite is a change, but not a request", () => {
    expect(Object.is((settingChangeOf({ set: -0 }) as { set: number }).set, 0)).toBe(true);
    expect(Object.is((settingChangeRequestOf({ set: -0 }) as { set: number }).set, 0)).toBe(true);
    for (const value of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      // `{"set":1e999}` parses to Infinity: the endpoint refuses it as a request (400 invalid_request) ...
      expect(settingChangeRequestOf({ set: value })).toBeNull();
      // ... and the writer and the line editor take it as a change whose value no key accepts (invalid_value).
      expect(settingChangeOf({ set: value })).toEqual({ set: value });
      expect(settingValueRefusal("port", { set: value })).toBe("invalid_value");
    }
    expect(settingChangeRequestOf(JSON.parse('{"set":1e999}'))).toBeNull();
  });
});

describe("the value", () => {
  test("a value the key does not take is invalid_value; restoring the default has no value to judge", () => {
    expect(settingValueRefusal("ui.theme", { set: "purple" })).toBe("invalid_value");
    expect(settingValueRefusal("port", { set: 70000 })).toBe("invalid_value");
    expect(settingValueRefusal("port", { set: 1.5 })).toBe("invalid_value");
    expect(settingValueRefusal("data_dir", { set: "/abs" })).toBe("invalid_value");
    expect(settingValueRefusal("ui.labels", { set: "yes" })).toBe("invalid_value");
    expect(settingValueRefusal("ui.theme", { set: "light" })).toBeNull();
    expect(settingValueRefusal("ui.theme", { reset: true })).toBeNull();
  });

  test("a string with a control character or an unpaired surrogate cannot be written", () => {
    for (const value of ["a\nb", "a\tb", "a\u0000", "a\u001f", "a\u007f", "a\ud800", "\udc00b"]) {
      expect(isRepresentableSettingString(value)).toBe(false);
      expect(settingValueRefusal("data_dir", { set: value })).toBe("unrepresentable_value");
    }
    for (const value of ["a", "日本", "a😀", "a\u0080b", "a b", 'a"\\b']) {
      expect(isRepresentableSettingString(value)).toBe(true);
      expect(settingValueRefusal("data_dir", { set: value })).toBeNull();
    }
  });
});

describe("the order of the stages, pinned by combinations", () => {
  test("an unknown key with a bad body: unknown_key", () => {
    expect(judgeSettingChange({ key: "nope", body: "not a change" })).toEqual({
      ok: false,
      reason: "unknown_key",
      status: 404,
    });
  });

  test("a key without a control with a bad body: not_editable", () => {
    expect(judgeSettingChange({ key: "global_dir", body: { set: 1, reset: true } })).toEqual({
      ok: false,
      reason: "not_editable",
      status: 422,
    });
  });

  test("a bad body with a value the key does not take: invalid_request", () => {
    expect(judgeSettingChange({ key: "ui.theme", body: { set: "purple", extra: 1 } })).toEqual({
      ok: false,
      reason: "invalid_request",
      status: 400,
    });
    expect(judgeSettingChange({ key: "port", body: { set: Number.POSITIVE_INFINITY } })).toEqual({
      ok: false,
      reason: "invalid_request",
      status: 400,
    });
  });

  test("a value both not taken and holding a control character: invalid_value", () => {
    expect(judgeSettingChange({ key: "ui.theme", body: { set: "pur\nple" } })).toEqual({
      ok: false,
      reason: "invalid_value",
      status: 400,
    });
    expect(judgeSettingChange({ key: "data_dir", body: { set: "lit\nerature" } })).toEqual({
      ok: false,
      reason: "unrepresentable_value",
      status: 400,
    });
  });

  test("the file's own stages go where they run: unreadable before the value, unparseable after it", () => {
    const bad = { key: "ui.theme", body: { set: "purple" } };
    expect(judgeSettingChange({ ...bad, given: { file: "unreadable" } })).toEqual({
      ok: false,
      reason: "unreadable",
      status: 500,
    });
    expect(judgeSettingChange({ ...bad, given: { text: "unparseable" } })).toEqual({
      ok: false,
      reason: "invalid_value",
      status: 400,
    });
    expect(
      judgeSettingChange({ ...bad, given: { file: "busy", text: "unparseable" } })
    ).toMatchObject({
      reason: "busy",
      status: 409,
    });
    const good = { key: "ui.theme", body: { set: "light" } };
    expect(judgeSettingChange({ ...good, given: { text: "unparseable" } })).toEqual({
      ok: false,
      reason: "unparseable",
      status: 409,
    });
    expect(judgeSettingChange({ ...good, given: { replace: "write_failed" } })).toEqual({
      ok: false,
      reason: "write_failed",
      status: 500,
    });
    // The key and the request come before anything of the file.
    expect(
      judgeSettingChange({ key: "nope", body: { set: "light" }, given: { file: "unreadable" } })
    ).toMatchObject({
      reason: "unknown_key",
    });
    expect(
      judgeSettingChange({ key: "ui.theme", body: [], given: { file: "unreadable" } })
    ).toMatchObject({
      reason: "invalid_request",
    });
  });

  test("a refusal given at a stage that judges itself comes after its own judgement", () => {
    expect(
      judgeSettingChange({
        key: "ui.theme",
        body: { set: "light" },
        given: { value: "invalid_value" },
      })
    ).toEqual({
      ok: false,
      reason: "invalid_value",
      status: 400,
    });
    expect(
      judgeSettingChange({
        key: "ui.theme",
        body: { set: "a\nb" },
        given: { value: "invalid_value" },
      })
    ).toMatchObject({
      reason: "invalid_value",
    });
    expect(
      judgeSettingChange({
        key: "data_dir",
        body: { set: "a\nb" },
        given: { value: "invalid_value" },
      })
    ).toMatchObject({
      reason: "unrepresentable_value",
    });
  });

  test("a change that passes every stage", () => {
    expect(judgeSettingChange({ key: "port", body: { set: -0 } })).toEqual({
      ok: true,
      key: "port",
      change: { set: 0 },
    });
    expect(judgeSettingChange({ key: "ui.theme", body: { reset: true }, given: {} })).toEqual({
      ok: true,
      key: "ui.theme",
      change: { reset: true },
    });
  });
});

describe("restartPendingKeys", () => {
  const atStart = defaultSettings();
  const changed = {
    ...atStart,
    port: 1860,
    data_dir: "./other",
    global_dir: "/g",
    log_level: "debug",
  };

  test("the restart-only keys whose value changed since the start, in schema order", () => {
    expect(restartPendingKeys(changed, atStart, { readonly: false, fromFlag: [] })).toEqual([
      "data_dir",
      "port",
      "global_dir",
    ]);
    const restartKeys = SETTING_KEYS.filter((key) => SETTINGS_SCHEMA[key].restart);
    const all = restartPendingKeys({ ...changed, global_cache_dir: "/c" }, atStart, {
      readonly: false,
      fromFlag: [],
    });
    expect(all).toEqual(restartKeys);
  });

  test("a key given on the command line is not pending", () => {
    expect(restartPendingKeys(changed, atStart, { readonly: false, fromFlag: ["port"] })).toEqual([
      "data_dir",
      "global_dir",
    ]);
    expect(
      restartPendingKeys(changed, atStart, { readonly: false, fromFlag: ["port", "data_dir"] })
    ).toEqual(["global_dir"]);
  });

  test("nothing is pending while the file cannot be read", () => {
    expect(restartPendingKeys(changed, atStart, { readonly: true, fromFlag: [] })).toEqual([]);
  });

  test("nothing changed, nothing pending", () => {
    expect(restartPendingKeys(atStart, { ...atStart }, { readonly: false, fromFlag: [] })).toEqual(
      [] as SettingKey[]
    );
  });
});
