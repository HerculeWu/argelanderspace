import { expect, test } from "vitest";
import { parseSearchQuery } from "../src/mail/search-query";

test("plain words become one free-text term", () => {
  expect(parseSearchQuery("  weak lensing  results ")).toEqual({
    ok: true,
    criteria: { text: "weak lensing results" },
  });
});

test("field terms, quoted values and dates", () => {
  expect(
    parseSearchQuery('from:ada subject:"weekly report" body:psf since:2026-01-31 before:2026-02-28 euclid')
  ).toEqual({
    ok: true,
    criteria: {
      text: "euclid",
      from: "ada",
      subject: "weekly report",
      body: "psf",
      since: "2026-01-31",
      before: "2026-02-28",
    },
  });
  expect(parseSearchQuery('FROM:"Ada Lovelace"')).toEqual({ ok: true, criteria: { from: "Ada Lovelace" } });
});

test("a repeated field joins its values; a bare field name is just a word", () => {
  expect(parseSearchQuery("from:ada from:lovelace")).toEqual({ ok: true, criteria: { from: "ada lovelace" } });
  expect(parseSearchQuery("from:")).toEqual({ ok: true, criteria: { text: "from:" } });
  expect(parseSearchQuery("10:30 meeting")).toEqual({ ok: true, criteria: { text: "10:30 meeting" } });
});

test("empty input and impossible dates are rejected before any request", () => {
  expect(parseSearchQuery("   ")).toEqual({ ok: false, reason: "empty" });
  expect(parseSearchQuery("since:2026-02-30")).toEqual({ ok: false, reason: "date" });
  expect(parseSearchQuery("before:yesterday")).toEqual({ ok: false, reason: "date" });
  expect(parseSearchQuery("since:2026-1-5")).toEqual({ ok: false, reason: "date" });
});

test("an unterminated quote takes the rest of the input; very long terms are cut to the server limit", () => {
  expect(parseSearchQuery('subject:"open ended')).toEqual({ ok: true, criteria: { subject: "open ended" } });
  const long = parseSearchQuery("x".repeat(500));
  expect(long.ok && long.criteria.text?.length).toBe(200);
});
