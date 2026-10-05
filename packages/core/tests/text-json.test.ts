import { describe, expect, it } from "vitest";
import { formatJsonPath, parseLocatedJson } from "../src/documents/text-json.js";

describe("located JSON for the argelander-* marker blocks", () => {
  it("agrees with the standard parser on what is valid (no silent last-key-wins aside)", () => {
    const valid = [
      "{}",
      "[]",
      '{"a":[1,2.5,-3e2,true,false,null,"x\\n\\u00e9\\"",{"b":{}}]}',
      " \n\t [ ] \r\n",
      '"just a string"',
      "0",
      "-0.5e+10",
    ];
    for (const text of valid) {
      const r = parseLocatedJson(text);
      expect(r.ok, text).toBe(true);
      if (r.ok) expect(r.value).toEqual(JSON.parse(text));
    }
    const invalid = [
      "",
      "{",
      '{"a":}',
      '{"a":1,}',
      "[1,]",
      "[01]",
      "{'a':1}",
      '{"a":1} x',
      '"unterminated',
      '"bad \\q escape"',
      '"tab\there"',
      "NaN",
      "[1 2]",
      '{"a" 1}',
      "{a:1}",
    ];
    for (const text of invalid) {
      expect(() => JSON.parse(text), text).toThrow();
      expect(parseLocatedJson(text).ok, text).toBe(false);
    }
  });

  it("reports a syntax error at the character it stops on", () => {
    expect(parseLocatedJson('{\n  "a": 1,\n}')).toMatchObject({ ok: false, offset: 12 });
    expect(parseLocatedJson("[1, 2 3]")).toMatchObject({ ok: false, offset: 6 });
    expect(parseLocatedJson("")).toMatchObject({ ok: false, offset: 0 });
  });

  it("a duplicate key is an error at the second key (JSON.parse would keep the last value silently)", () => {
    const text = '{"id":"a",\n "id":"b"}';
    const r = parseLocatedJson(text);
    expect(r).toMatchObject({ ok: false, offset: text.indexOf('"id":"b"') });
    expect((r as { message: string }).message).toMatch(/twice/);
  });

  it("locates object keys and array elements by path", () => {
    const text = '{\n  "authors": ["x",\n    "y"],\n  "meta": {"k": 1}\n}';
    const r = parseLocatedJson(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.offsetOf([])).toBe(0);
    expect(r.offsetOf(["authors"])).toBe(text.indexOf('"authors"'));
    expect(r.offsetOf(["authors", 1])).toBe(text.indexOf('"y"'));
    expect(r.offsetOf(["meta", "k"])).toBe(text.indexOf('"k"'));
    expect(r.offsetOf(["nope"])).toBeUndefined();
  });

  it("deep nesting is refused instead of overflowing the stack", () => {
    expect(parseLocatedJson("[".repeat(500) + "]".repeat(500)).ok).toBe(false);
  });

  it("formats paths for diagnostics", () => {
    expect(formatJsonPath(["authorDetails", 0, "affiliations", 2])).toBe(
      "authorDetails[0].affiliations[2]"
    );
    expect(formatJsonPath([3, "id"])).toBe("[3].id");
    expect(formatJsonPath([])).toBe("");
  });
});
