import type { MailSearchCriteria } from "@argelanderspace/contracts";

/**
 * The search box takes plain words (matched against sender, subject and body)
 * and optional `from:` `subject:` `body:` `since:YYYY-MM-DD` `before:YYYY-MM-DD`
 * terms. A value with spaces is quoted: `subject:"weekly report"`. The same
 * field repeated is joined with a space. Nothing here talks to a server.
 */
export type ParsedSearch =
  | { ok: true; criteria: MailSearchCriteria }
  | { ok: false; reason: "empty" | "date" };

const FIELD = /^(from|subject|body|since|before):/i;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function tokens(input: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i] as string)) i++;
    if (i >= input.length) break;
    let tok = "";
    while (i < input.length && !/\s/.test(input[i] as string)) {
      if (input[i] === '"') {
        i++;
        while (i < input.length && input[i] !== '"') tok += input[i++];
        i++; // closing quote (or end of input)
      } else tok += input[i++];
    }
    out.push(tok);
  }
  return out;
}

const validDay = (v: string) => {
  const m = DAY.exec(v);
  if (!m) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return (
    !Number.isNaN(d.getTime()) &&
    d.getUTCFullYear() === Number(m[1]) &&
    d.getUTCMonth() + 1 === Number(m[2]) &&
    d.getUTCDate() === Number(m[3])
  );
};

export function parseSearchQuery(input: string): ParsedSearch {
  const words: string[] = [];
  const fields: Partial<Record<"from" | "subject" | "body", string[]>> = {};
  const days: Partial<Record<"since" | "before", string>> = {};
  for (const tok of tokens(input)) {
    const f = FIELD.exec(tok);
    // Terms are checked for the field first: `from:` alone (nothing after it) is just a word.
    const value = f ? tok.slice(f[0].length).trim() : "";
    if (!f || value === "") {
      words.push(tok);
      continue;
    }
    const name = (f[1] as string).toLowerCase();
    if (name === "since" || name === "before") {
      if (!validDay(value)) return { ok: false, reason: "date" };
      days[name] = value;
    } else (fields[name as "from" | "subject" | "body"] ??= []).push(value);
  }
  const criteria: MailSearchCriteria = {};
  const text = words.join(" ").trim();
  if (text) criteria.text = text.slice(0, 200);
  for (const k of ["from", "subject", "body"] as const) {
    const v = fields[k]?.join(" ").trim();
    if (v) criteria[k] = v.slice(0, 200);
  }
  if (days.since) criteria.since = days.since;
  if (days.before) criteria.before = days.before;
  return Object.keys(criteria).length === 0 ? { ok: false, reason: "empty" } : { ok: true, criteria };
}
