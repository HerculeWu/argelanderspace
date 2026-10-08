/**
 * A small in-memory IMAP server with real mailboxes, for the reading tests
 * (Mail ticket 05). Implicit TLS on 127.0.0.1 with the throwaway localhost
 * certificate; synthetic users and mail only. It speaks just enough IMAP for
 * imapflow: CAPABILITY, ID, NAMESPACE, LOGIN, AUTHENTICATE PLAIN, LIST, LSUB,
 * STATUS, SELECT/EXAMINE, UID SEARCH, UID FETCH, UID STORE, NOOP, CLOSE, LOGOUT.
 */

import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import { FAKE_TLS, TEST_PASSWORD, TEST_USER } from "./fake-servers.js";

export interface FakeMessage {
  uid: number;
  flags: Set<string>;
  /** Full RFC 822 source (CRLF line ends). */
  source: string;
  date: string; // RFC 2822 date, also used for the envelope
  subject: string; // exactly as in the envelope (may contain encoded words)
  from: [name: string, address: string];
  to: [name: string, address: string][];
  /** BODYSTRUCTURE s-expression; defaults to one text/plain part. */
  bodyStructure?: string;
}
export interface FakeFolder {
  path: string;
  attrs?: string[]; // e.g. ["\\Sent"]
  uidValidity: number;
  messages: FakeMessage[];
  /** Highest uid ever assigned, so uids are not reused after an expunge. */
  lastUid?: number;
}

export interface FakeMailbox {
  port: number;
  folders: FakeFolder[];
  /** Every command line's verb (and for SELECT/EXAMINE/STORE the verb and target), for assertions. */
  commands: string[];
  /** Make STORE answer NO (a read-only server). */
  denyStore: boolean;
  /** Make APPEND answer NO (Mail ticket 07: a server that refuses new drafts / Sent copies). */
  denyAppend: boolean;
  /** Withhold the APPENDUID response code, as a server without UIDPLUS does. */
  hideAppendUid: boolean;
  close(): Promise<void>;
}

type Tok = string | Tok[];

function tokenize(line: string): Tok[] {
  let i = 0;
  const parseList = (): Tok[] => {
    const out: Tok[] = [];
    while (i < line.length) {
      const c = line[i] as string;
      if (c === " ") {
        i++;
      } else if (c === "(") {
        i++;
        out.push(parseList());
      } else if (c === ")") {
        i++;
        return out;
      } else if (c === '"') {
        i++;
        let s = "";
        while (i < line.length && line[i] !== '"') {
          if (line[i] === "\\") i++;
          s += line[i++];
        }
        i++;
        out.push(s);
      } else {
        let s = "";
        let depth = 0;
        while (i < line.length) {
          const d = line[i] as string;
          if (d === "[") depth++;
          if (d === "]") depth--;
          if ((d === " " || d === ")" || d === "(") && depth === 0) break;
          s += d;
          i++;
        }
        out.push(s);
      }
    }
    return out;
  };
  return parseList();
}

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const nstr = (s: string | null) => (s === null ? "NIL" : q(s));
function addrList(list: [string, string][]): string {
  if (list.length === 0) return "NIL";
  return `(${list
    .map(([name, address]) => {
      const [box = "", host = ""] = address.split("@");
      return `(${nstr(name || null)} NIL ${q(box)} ${q(host)})`;
    })
    .join("")})`;
}
function envelope(m: FakeMessage): string {
  return `(${q(m.date)} ${q(m.subject)} ${addrList([m.from])} ${addrList([m.from])} ${addrList([m.from])} ${addrList(m.to)} NIL NIL NIL ${q(`<m${m.uid}@fake.test>`)})`;
}
const imapDate = (rfc: string) => {
  const d = new Date(rfc);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}-${mon[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
};
const flagList = (f: Set<string>) => `(${[...f].join(" ")})`;
const TEXT_PART = (len: number) =>
  `("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" ${len} 1 NIL NIL NIL)`;

/** `1,3,5:7` or `4:*` -> predicate over uids. */
function uidSet(spec: string, max: number): (uid: number) => boolean {
  const parts = spec.split(",").map((p) => {
    const [a = "", b] = p.split(":");
    const lo = a === "*" ? max : Number(a);
    const hi = b === undefined ? lo : b === "*" ? max : Number(b);
    return [Math.min(lo, hi), Math.max(lo, hi)] as const;
  });
  return (uid) => parts.some(([lo, hi]) => uid >= lo && uid <= hi);
}

export async function startFakeMailbox(folders: FakeFolder[]): Promise<FakeMailbox> {
  const commands: string[] = [];
  const state: FakeMailbox = {
    port: 0,
    folders,
    commands,
    denyStore: false,
    denyAppend: false,
    hideAppendUid: false,
    close: async () => {},
  };
  const handle = (sock: TLSSocket) => {
    let buf = Buffer.alloc(0);
    let literal: {
      remaining: number;
      tag: string;
      folder: string;
      flags: string[];
      chunks: Buffer[];
    } | null = null;
    let selected: FakeFolder | null = null;
    let authed = false;
    const send = (s: string | Buffer) =>
      sock.write(Buffer.concat([Buffer.from(s as string), Buffer.from("\r\n")]));
    const caps = () => `IMAP4rev1 AUTH=PLAIN ID NAMESPACE UIDPLUS${authed ? "" : ""}`;
    let awaitingPlain: string | null = null;
    const find = (path: string) => folders.find((f) => f.path === path);

    const fetchResponse = (
      f: FakeFolder,
      m: FakeMessage,
      items: string[],
      storeOnly = false
    ): Buffer => {
      const seq = f.messages.indexOf(m) + 1;
      const chunks: Buffer[] = [];
      const parts: string[] = [`UID ${m.uid}`];
      const has = (name: string) => items.some((x) => x.toUpperCase() === name);
      if (storeOnly || has("FLAGS") || has("FAST") || has("ALL") || has("FULL"))
        parts.push(`FLAGS ${flagList(m.flags)}`);
      if (!storeOnly) {
        if (has("INTERNALDATE") || has("FAST") || has("ALL") || has("FULL"))
          parts.push(`INTERNALDATE "${imapDate(m.date)}"`);
        if (has("RFC822.SIZE") || has("FAST") || has("ALL") || has("FULL"))
          parts.push(`RFC822.SIZE ${Buffer.byteLength(m.source)}`);
        if (has("ENVELOPE") || has("ALL") || has("FULL")) parts.push(`ENVELOPE ${envelope(m)}`);
        if (has("BODYSTRUCTURE") || has("FULL"))
          parts.push(`BODYSTRUCTURE ${m.bodyStructure ?? TEXT_PART(Buffer.byteLength(m.source))}`);
      }
      const wantsBody = !storeOnly && items.some((x) => /^BODY(\.PEEK)?\[\]$/i.test(x));
      const head = `* ${seq} FETCH (${parts.join(" ")}`;
      if (wantsBody) {
        const body = Buffer.from(m.source);
        chunks.push(Buffer.from(`${head} BODY[] {${body.length}}\r\n`), body, Buffer.from(")\r\n"));
      } else chunks.push(Buffer.from(`${head})\r\n`));
      return Buffer.concat(chunks);
    };

    const run = (line: string) => {
      if (awaitingPlain) {
        const tag = awaitingPlain;
        awaitingPlain = null;
        const [, u = "", p = ""] = Buffer.from(line, "base64").toString().split("\0");
        if (u === TEST_USER && p === TEST_PASSWORD) {
          authed = true;
          send(`${tag} OK [CAPABILITY ${caps()}] logged in`);
        } else send(`${tag} NO [AUTHENTICATIONFAILED] invalid credentials`);
        return;
      }
      const toks = tokenize(line);
      const tag = String(toks[0] ?? "*");
      const cmd = String(toks[1] ?? "").toUpperCase();
      const args = toks.slice(2);
      const isUid = cmd === "UID";
      const verb = isUid ? `UID ${String(args[0] ?? "").toUpperCase()}` : cmd;
      commands.push(
        verb === "SELECT" || verb === "EXAMINE" || verb === "UID STORE" || verb === "APPEND"
          ? `${verb} ${isUid ? "" : String(args[0] ?? "")}`.trim()
          : verb
      );
      const requireAuth = () => {
        if (authed) return true;
        send(`${tag} NO not authenticated`);
        return false;
      };
      switch (verb) {
        case "CAPABILITY":
          send(`* CAPABILITY ${caps()}`);
          send(`${tag} OK done`);
          break;
        case "ID":
          send("* ID NIL");
          send(`${tag} OK done`);
          break;
        case "NOOP":
          send(`${tag} OK done`);
          break;
        case "NAMESPACE":
          send('* NAMESPACE (("" "/")) NIL NIL');
          send(`${tag} OK done`);
          break;
        case "LOGIN": {
          if (args[0] === TEST_USER && args[1] === TEST_PASSWORD) {
            authed = true;
            send(`${tag} OK [CAPABILITY ${caps()}] logged in`);
          } else send(`${tag} NO [AUTHENTICATIONFAILED] invalid credentials`);
          break;
        }
        case "AUTHENTICATE": {
          const initial = args[1];
          if (typeof initial === "string") {
            const [, u = "", p = ""] = Buffer.from(initial, "base64").toString().split("\0");
            if (u === TEST_USER && p === TEST_PASSWORD) {
              authed = true;
              send(`${tag} OK [CAPABILITY ${caps()}] logged in`);
            } else send(`${tag} NO [AUTHENTICATIONFAILED] invalid credentials`);
          } else {
            awaitingPlain = tag;
            send("+ ");
          }
          break;
        }
        case "ENABLE":
          send(`${tag} OK done`);
          break;
        case "LIST":
        case "LSUB": {
          if (!requireAuth()) break;
          const pattern = String(args[1] ?? "*");
          if (pattern === "") {
            send('* LIST (\\Noselect) "/" ""');
          } else if (pattern === "*" || pattern === "%") {
            for (const f of folders) {
              if (pattern === "%" && f.path.includes("/")) continue;
              send(`* ${cmd} (${(f.attrs ?? []).join(" ")}) "/" ${q(f.path)}`);
            }
          } else {
            const f = find(pattern);
            if (f) send(`* ${cmd} (${(f.attrs ?? []).join(" ")}) "/" ${q(f.path)}`);
          }
          send(`${tag} OK done`);
          break;
        }
        case "STATUS": {
          if (!requireAuth()) break;
          const f = find(String(args[0]));
          if (!f) {
            send(`${tag} NO [NONEXISTENT] no such mailbox`);
            break;
          }
          const unseen = f.messages.filter((m) => !m.flags.has("\\Seen")).length;
          send(`* STATUS ${q(f.path)} (MESSAGES ${f.messages.length} UNSEEN ${unseen})`);
          send(`${tag} OK done`);
          break;
        }
        case "SELECT":
        case "EXAMINE": {
          if (!requireAuth()) break;
          const f = find(String(args[0]));
          if (!f) {
            send(`${tag} NO [NONEXISTENT] no such mailbox`);
            break;
          }
          selected = f;
          send("* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)");
          send(`* ${f.messages.length} EXISTS`);
          send("* 0 RECENT");
          send(`* OK [UIDVALIDITY ${f.uidValidity}] ok`);
          send(`* OK [UIDNEXT ${Math.max(0, ...f.messages.map((m) => m.uid)) + 1}] ok`);
          send("* OK [PERMANENTFLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft \\*)] ok");
          send(`${tag} OK [${verb === "SELECT" ? "READ-WRITE" : "READ-ONLY"}] done`);
          break;
        }
        case "CLOSE":
        case "UNSELECT":
          selected = null;
          send(`${tag} OK done`);
          break;
        case "UID SEARCH": {
          if (!selected) {
            send(`${tag} BAD no mailbox selected`);
            break;
          }
          const upper = args.map((a) => (typeof a === "string" ? a.toUpperCase() : ""));
          const h = upper.indexOf("HEADER");
          let hits = selected.messages;
          if (h >= 0) {
            const name = String(args[h + 1] ?? "").toLowerCase();
            const value = String(args[h + 2] ?? "").toLowerCase();
            hits = hits.filter((m) =>
              (m.source.split("\r\n\r\n")[0] ?? "").split(/\r\n(?![ \t])/).some((line) => {
                const i = line.indexOf(":");
                return (
                  i > 0 &&
                  line.slice(0, i).toLowerCase() === name &&
                  line
                    .slice(i + 1)
                    .toLowerCase()
                    .includes(value)
                );
              })
            );
          }
          send(`* SEARCH ${hits.map((m) => m.uid).join(" ")}`.trimEnd());
          send(`${tag} OK done`);
          break;
        }
        case "UID FETCH": {
          if (!selected) {
            send(`${tag} BAD no mailbox selected`);
            break;
          }
          const max = Math.max(0, ...selected.messages.map((m) => m.uid));
          const inSet = uidSet(String(args[1]), max);
          const itemsRaw = args[2];
          const items = Array.isArray(itemsRaw) ? (itemsRaw as string[]) : [String(itemsRaw)];
          for (const m of selected.messages)
            if (inSet(m.uid)) sock.write(fetchResponse(selected, m, items));
          send(`${tag} OK done`);
          break;
        }
        case "UID STORE": {
          if (!selected) {
            send(`${tag} BAD no mailbox selected`);
            break;
          }
          if (state.denyStore) {
            send(`${tag} NO [NOPERM] read-only`);
            break;
          }
          const max = Math.max(0, ...selected.messages.map((m) => m.uid));
          const inSet = uidSet(String(args[1]), max);
          const mode = String(args[2]).toUpperCase();
          const flagsTok = args[3];
          const flags = (Array.isArray(flagsTok) ? flagsTok : [flagsTok]) as string[];
          for (const m of selected.messages) {
            if (!inSet(m.uid)) continue;
            if (mode.startsWith("+")) for (const f of flags) m.flags.add(f);
            else if (mode.startsWith("-")) for (const f of flags) m.flags.delete(f);
            else m.flags = new Set(flags);
            if (!mode.includes(".SILENT")) sock.write(fetchResponse(selected, m, [], true));
          }
          send(`${tag} OK done`);
          break;
        }
        case "APPEND": {
          if (!requireAuth()) break;
          const target = String(args[0]);
          const last = args[args.length - 1];
          const lit = typeof last === "string" ? /^\{(\d+)\+?\}$/.exec(last) : null;
          if (!lit) {
            send(`${tag} BAD APPEND needs a literal`);
            break;
          }
          const flagTok = args.find((a) => Array.isArray(a));
          // A refused or unknown target still has to swallow the literal the client sends next.
          literal = {
            remaining: Number(lit[1]),
            tag,
            folder: find(target) && !state.denyAppend ? target : "",
            flags: (flagTok as string[] | undefined) ?? [],
            chunks: [],
          };
          send("+ ready");
          break;
        }
        case "UID EXPUNGE":
        case "EXPUNGE": {
          if (!selected) {
            send(`${tag} BAD no mailbox selected`);
            break;
          }
          const max = Math.max(0, ...selected.messages.map((m) => m.uid));
          const inSet = verb === "UID EXPUNGE" ? uidSet(String(args[1]), max) : () => true;
          for (let i = selected.messages.length - 1; i >= 0; i--) {
            const m = selected.messages[i] as FakeMessage;
            if (m.flags.has("\\Deleted") && inSet(m.uid)) {
              selected.messages.splice(i, 1);
              send(`* ${i + 1} EXPUNGE`);
            }
          }
          send(`${tag} OK done`);
          break;
        }
        case "LOGOUT":
          send("* BYE");
          send(`${tag} OK bye`);
          sock.end();
          break;
        default:
          send(`${tag} BAD unknown command`);
      }
    };

    const finishAppend = (lit: NonNullable<typeof literal>) => {
      const body = Buffer.concat(lit.chunks);
      const f = lit.folder ? find(lit.folder) : undefined;
      if (!f) {
        send(`${lit.tag} NO [TRYCREATE] append refused`);
        return;
      }
      const source = body.toString("latin1");
      const head = (source.split("\r\n\r\n")[0] ?? "").replace(/\r\n[ \t]+/g, " ");
      const header = (name: string) =>
        new RegExp(`^${name}:[ \\t]*(.*)$`, "im").exec(head)?.[1] ?? "";
      const fromRaw = header("From").trim();
      const fm = /^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/.exec(fromRaw);
      const uid = Math.max(f.lastUid ?? 0, ...f.messages.map((m) => m.uid)) + 1;
      f.lastUid = uid;
      f.messages.push({
        uid,
        flags: new Set(lit.flags),
        source,
        date: header("Date") || new Date().toUTCString(),
        subject: header("Subject"),
        from: [fm?.[1]?.trim() ?? "", fm?.[2] ?? fromRaw],
        to: [],
      });
      send(
        `${lit.tag} OK ${state.hideAppendUid ? "" : `[APPENDUID ${f.uidValidity} ${uid}] `}done`
      );
    };
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (literal) {
          const take = Math.min(literal.remaining, buf.length);
          if (take > 0) {
            literal.chunks.push(buf.subarray(0, take));
            buf = buf.subarray(take);
            literal.remaining -= take;
          }
          if (literal.remaining > 0) return;
          const eol = buf.indexOf("\r\n");
          if (eol < 0) return; // the command line's terminator has not arrived yet
          buf = buf.subarray(eol + 2);
          const done = literal;
          literal = null;
          finishAppend(done);
          continue;
        }
        const i = buf.indexOf("\r\n");
        if (i < 0) return;
        const line = buf.subarray(0, i).toString("latin1");
        buf = buf.subarray(i + 2);
        run(line);
      }
    });
    sock.on("error", () => {});
    send(`* OK [CAPABILITY ${caps()}] fake mailbox ready`);
  };
  const server = createTlsServer(FAKE_TLS, handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  state.port = typeof addr === "object" && addr ? addr.port : 0;
  state.close = () => new Promise<void>((r) => server.close(() => r()));
  return state;
}

// ---- synthetic mail --------------------------------------------------------

const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");

export function plainMail(opts: {
  uid: number;
  subject: string;
  from: [string, string];
  to?: [string, string][];
  date: string;
  body: string;
  flags?: string[];
}): FakeMessage {
  const to = opts.to ?? [["Tester", "tester@fake.test"]];
  const source = crlf(
    `From: ${opts.from[0]} <${opts.from[1]}>\nTo: ${to.map(([n, a]) => `${n} <${a}>`).join(", ")}\nSubject: ${opts.subject}\nDate: ${opts.date}\nMessage-ID: <m${opts.uid}@fake.test>\nMIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: 8bit\n\n${opts.body}\n`
  );
  return {
    uid: opts.uid,
    flags: new Set(opts.flags ?? []),
    source,
    date: opts.date,
    subject: opts.subject,
    from: opts.from,
    to,
  };
}

/** multipart/mixed: a text body and one PDF attachment (the PDF bytes are "%PDF-synthetic"). */
export function attachmentMail(opts: {
  uid: number;
  subject: string;
  date: string;
  flags?: string[];
  filename?: string;
}): FakeMessage {
  const fn = opts.filename ?? "report.pdf";
  const pdf = Buffer.from("%PDF-synthetic-attachment").toString("base64");
  const source = crlf(
    `From: Ada <ada@fake.test>\nTo: Tester <tester@fake.test>\nSubject: ${opts.subject}\nDate: ${opts.date}\nMessage-ID: <m${opts.uid}@fake.test>\nMIME-Version: 1.0\nContent-Type: multipart/mixed; boundary="bb"\n\n--bb\nContent-Type: text/plain; charset=utf-8\n\nSee the attached report.\n--bb\nContent-Type: application/pdf; name="${fn}"\nContent-Disposition: attachment; filename="${fn}"\nContent-Transfer-Encoding: base64\n\n${pdf}\n--bb--\n`
  );
  return {
    uid: opts.uid,
    flags: new Set(opts.flags ?? []),
    source,
    date: opts.date,
    subject: opts.subject,
    from: ["Ada", "ada@fake.test"],
    to: [["Tester", "tester@fake.test"]],
    bodyStructure: `(("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 24 1 NIL NIL NIL)("APPLICATION" "PDF" ("NAME" "${fn}") NIL NIL "BASE64" 40 NIL ("ATTACHMENT" ("FILENAME" "${fn}")) NIL) "MIXED" ("BOUNDARY" "bb") NIL NIL)`,
  };
}

/** multipart/related HTML mail with a cid: image, and any HTML the test passes in. */
export function htmlMail(opts: {
  uid: number;
  subject: string;
  date: string;
  html: string;
  text?: string;
  flags?: string[];
}): FakeMessage {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const source = crlf(
    `From: Newsletter <news@fake.test>\nTo: Tester <tester@fake.test>\nSubject: ${opts.subject}\nDate: ${opts.date}\nMessage-ID: <m${opts.uid}@fake.test>\nMIME-Version: 1.0\nContent-Type: multipart/related; boundary="rr"\n\n--rr\nContent-Type: multipart/alternative; boundary="aa"\n\n--aa\nContent-Type: text/plain; charset=utf-8\n\n${opts.text ?? "plain alternative"}\n--aa\nContent-Type: text/html; charset=utf-8\n\n${opts.html}\n--aa--\n--rr\nContent-Type: image/png; name="logo.png"\nContent-ID: <logo@fake.test>\nContent-Disposition: inline; filename="logo.png"\nContent-Transfer-Encoding: base64\n\n${png}\n--rr--\n`
  );
  return {
    uid: opts.uid,
    flags: new Set(opts.flags ?? []),
    source,
    date: opts.date,
    subject: opts.subject,
    from: ["Newsletter", "news@fake.test"],
    to: [["Tester", "tester@fake.test"]],
  };
}
