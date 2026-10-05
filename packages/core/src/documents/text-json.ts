/**
 * JSON for the `argelander-*` marker blocks, with positions.
 *
 * The value always comes from the standard `JSON.parse`. The scanner here only answers WHERE: it walks the same text
 * and records the offset of every object key and array element, so a schema problem at `[2].id` can be reported at the
 * line and column of that field, and a syntax error at the character the scanner stopped on (`JSON.parse` messages do
 * not always carry a position). It also rejects a duplicate key, which `JSON.parse` would silently resolve to the last
 * value.
 */

interface Node {
  start: number;
  children?: Map<string | number, Node>;
}

export type LocatedJson =
  | {
      ok: true;
      value: unknown;
      offsetOf: (path: readonly (string | number)[]) => number | undefined;
    }
  | { ok: false; offset: number; message: string };

const MAX_DEPTH = 64;

class ScanError extends Error {
  constructor(
    readonly offset: number,
    message: string
  ) {
    super(message);
  }
}

function scan(text: string): Node {
  let i = 0;
  const ws = (): void => {
    while (
      i < text.length &&
      (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")
    )
      i += 1;
  };
  const fail = (message: string): never => {
    throw new ScanError(i, message);
  };
  const string = (): string => {
    // text[i] === '"'
    const start = i;
    i += 1;
    let out = "";
    while (i < text.length) {
      const ch = text[i] as string;
      if (ch === '"') {
        i += 1;
        return out;
      }
      if (ch < " ") return fail("a control character in a string");
      if (ch === "\\") {
        const next = text[i + 1];
        if (next === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) return fail("a bad \\u escape");
          out += String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        const simple: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        const mapped = next === undefined ? undefined : simple[next];
        if (mapped === undefined) return fail("a bad escape in a string");
        out += mapped;
        i += 2;
        continue;
      }
      out += ch;
      i += 1;
    }
    i = start;
    return fail("a string that is not closed");
  };
  const value = (depth: number): Node => {
    if (depth > MAX_DEPTH) return fail("nesting is too deep");
    ws();
    const start = i;
    const ch = text[i];
    if (ch === "{") {
      i += 1;
      const children = new Map<string | number, Node>();
      ws();
      if (text[i] === "}") {
        i += 1;
        return { start, children };
      }
      for (;;) {
        ws();
        if (text[i] !== '"') return fail("an object key (a quoted string) is expected");
        const keyStart = i;
        const key = string();
        if (children.has(key)) throw new ScanError(keyStart, `the key "${key}" appears twice`);
        ws();
        if (text[i] !== ":") return fail("':' is expected after the key");
        i += 1;
        const child = value(depth + 1);
        children.set(key, { ...child, start: keyStart });
        ws();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "}") {
          i += 1;
          return { start, children };
        }
        return fail("',' or '}' is expected");
      }
    }
    if (ch === "[") {
      i += 1;
      const children = new Map<string | number, Node>();
      ws();
      if (text[i] === "]") {
        i += 1;
        return { start, children };
      }
      for (let index = 0; ; index += 1) {
        children.set(index, value(depth + 1));
        ws();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "]") {
          i += 1;
          return { start, children };
        }
        return fail("',' or ']' is expected");
      }
    }
    if (ch === '"') {
      string();
      return { start };
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      text.slice(i, i + 400)
    );
    if (literal === null) return fail("a value is expected");
    i += literal[0].length;
    return { start };
  };
  const root = value(0);
  ws();
  if (i < text.length) fail("text after the JSON value");
  return root;
}

/** Parse the JSON text of a marker block; `offsetOf` maps a path (object keys / array indexes) to a text offset. */
export function parseLocatedJson(text: string): LocatedJson {
  let root: Node;
  try {
    root = scan(text);
  } catch (error) {
    if (error instanceof ScanError)
      return { ok: false, offset: error.offset, message: error.message };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    // the scanner is stricter or equal in every case we know; keep the standard parser's verdict anyway
    return {
      ok: false,
      offset: root.start,
      message: error instanceof Error ? error.message : "invalid JSON",
    };
  }
  return {
    ok: true,
    value,
    offsetOf: (path) => {
      let node: Node | undefined = root;
      for (const step of path) {
        node = node?.children?.get(step);
        if (node === undefined) return undefined;
      }
      return node?.start;
    },
  };
}

/** `authors[1].name` / `[2].id` style path used in diagnostics. */
export function formatJsonPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const step of path) {
    if (typeof step === "number") out += `[${step}]`;
    else out += out === "" ? String(step) : `.${String(step)}`;
  }
  return out;
}
