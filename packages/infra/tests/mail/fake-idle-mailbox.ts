/**
 * A small fake IMAP server for the live-update tests (Mail ticket 08): one INBOX,
 * IDLE (switchable off), STATUS, SELECT/EXAMINE, and test controls that push
 * new mail and flag changes to idling clients or cut every connection.
 * Implicit TLS on 127.0.0.1 with the throwaway certificate; synthetic users only.
 */

import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import { FAKE_TLS, TEST_PASSWORD, TEST_USER } from "./fake-servers.js";

export interface FakeIdleMailbox {
  port: number;
  /** Whether CAPABILITY advertises IDLE (set before clients connect). */
  idleSupported: boolean;
  /** New connections are closed at once (a server that is down). */
  refuseConnections: boolean;
  uidValidity: number;
  /** Currently open client connections / connections ever accepted. */
  readonly openConnections: number;
  readonly totalConnections: number;
  /** Connections that are inside IDLE right now. */
  readonly idlingConnections: number;
  /** Every command verb received, for assertions. */
  readonly commands: string[];
  /** Number of messages / unseen, as STATUS would report. */
  readonly total: number;
  readonly unseen: number;
  /** Deliver a new unread message; idling sessions get `* n EXISTS` at once. */
  deliver(subject?: string): number;
  /** When set, every login attempt is answered `NO <this text>` (e.g. "[UNAVAILABLE] try later"); null = normal. */
  loginRefusal: string | null;
  /** Another client sets or clears \Flagged; idling sessions get the unsolicited FETCH. */
  setFlagged(uid: number, flagged: boolean): void;
  /** The server-side \Seen state of one message (null when it does not exist). */
  isSeen(uid: number): boolean | null;
  /** Mark a message \Seen as another client would; idling sessions get an unsolicited FETCH. */
  markSeen(uid: number): void;
  /** Remove a message; idling sessions get `* seq EXPUNGE`. */
  expunge(uid: number): void;
  /** Cut every open connection without a goodbye. */
  dropAll(): void;
  close(): Promise<void>;
}

export async function startFakeIdleMailbox(
  initialUnread = 0,
  initialSeen = 0
): Promise<FakeIdleMailbox> {
  interface Msg {
    uid: number;
    seen: boolean;
    flagged?: boolean;
    subject: string;
  }
  const messages: Msg[] = [];
  let nextUid = 1;
  const add = (seen: boolean, subject?: string): Msg => {
    const uid = nextUid++;
    const m = { uid, seen, subject: subject ?? `Message ${uid}` };
    messages.push(m);
    return m;
  };
  for (let i = 0; i < initialSeen; i++) add(true);
  for (let i = 0; i < initialUnread; i++) add(false);
  const sockets = new Set<TLSSocket>();
  const idling = new Set<TLSSocket>();
  /** Untagged updates for sessions that are not idling at this instant; sent before their next reply, like a real server. */
  const queued = new Map<TLSSocket, (string | Buffer)[]>();
  const notify = (line: string | Buffer, except?: TLSSocket) => {
    for (const sock of sockets) {
      if (sock === except) continue;
      if (idling.has(sock)) sock.write(line);
      else queued.set(sock, [...(queued.get(sock) ?? []), line]);
    }
  };
  const commands: string[] = [];
  let total = 0;

  const api: FakeIdleMailbox = {
    port: 0,
    idleSupported: true,
    refuseConnections: false,
    loginRefusal: null,
    uidValidity: 7,
    get openConnections() {
      return sockets.size;
    },
    get totalConnections() {
      return total;
    },
    get idlingConnections() {
      return idling.size;
    },
    commands,
    get total() {
      return messages.length;
    },
    get unseen() {
      return messages.filter((m) => !m.seen).length;
    },
    deliver(subject) {
      const m = add(false, subject);
      notify(`* ${messages.length} EXISTS\r\n`);
      return m.uid;
    },
    setFlagged(uid, flagged) {
      const i = messages.findIndex((m) => m.uid === uid);
      const m = messages[i];
      if (!m) return;
      m.flagged = flagged;
      notify(fetchLine(m, "", true));
    },
    isSeen(uid) {
      return messages.find((m) => m.uid === uid)?.seen ?? null;
    },
    markSeen(uid) {
      const i = messages.findIndex((m) => m.uid === uid);
      const m = messages[i];
      if (!m) return;
      m.seen = true;
      notify(`* ${i + 1} FETCH (FLAGS (\\Seen) UID ${uid})\r\n`);
    },
    expunge(uid) {
      const i = messages.findIndex((m) => m.uid === uid);
      if (i < 0) return;
      messages.splice(i, 1);
      notify(`* ${i + 1} EXPUNGE\r\n`);
    },
    dropAll() {
      for (const s of [...sockets]) s.destroy();
    },
    close: async () => {},
  };

  const q = (x: string) => `"${x.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const dateOf = (m: Msg) => new Date(Date.UTC(2026, 9, 1, 10, m.uid)).toUTCString();
  const sourceOf = (m: Msg) =>
    `From: Ada <ada@fake.test>\r\nTo: Tester <tester@fake.test>\r\nSubject: ${m.subject}\r\nDate: ${dateOf(m)}\r\nMessage-ID: <m${m.uid}@fake.test>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody of message ${m.uid}\r\n`;
  /** `1,3:5` or `*` -> predicate over uids. */
  const uidSet = (spec: string): ((uid: number) => boolean) => {
    const max = Math.max(0, ...messages.map((m) => m.uid));
    const parts = spec.split(",").map((p) => {
      const [a = "", b] = p.split(":");
      const lo = a === "*" ? max : Number(a);
      const hi = b === undefined ? lo : b === "*" ? max : Number(b);
      return [Math.min(lo, hi), Math.max(lo, hi)] as const;
    });
    return (uid) => parts.some(([lo, hi]) => uid >= lo && uid <= hi);
  };
  const fetchLine = (m: Msg, asked: string, flagsOnly = false): Buffer => {
    const seq = messages.indexOf(m) + 1;
    const parts = [
      `UID ${m.uid}`,
      `FLAGS (${[m.seen ? "\\Seen" : "", m.flagged ? "\\Flagged" : ""].filter(Boolean).join(" ")})`,
    ];
    if (!flagsOnly) {
      if (asked.includes("INTERNALDATE")) {
        const d = new Date(dateOf(m));
        const p = (n: number) => String(n).padStart(2, "0");
        parts.push(
          `INTERNALDATE "${p(d.getUTCDate())}-Oct-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00 +0000"`
        );
      }
      if (asked.includes("RFC822.SIZE"))
        parts.push(`RFC822.SIZE ${Buffer.byteLength(sourceOf(m))}`);
      if (asked.includes("ENVELOPE"))
        parts.push(
          `ENVELOPE (${q(dateOf(m))} ${q(m.subject)} (("Ada" NIL "ada" "fake.test")) (("Ada" NIL "ada" "fake.test")) (("Ada" NIL "ada" "fake.test")) (("Tester" NIL "tester" "fake.test")) NIL NIL NIL ${q(`<m${m.uid}@fake.test>`)})`
        );
      if (asked.includes("BODYSTRUCTURE"))
        parts.push(
          `BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" ${Buffer.byteLength(sourceOf(m))} 1 NIL NIL NIL)`
        );
    }
    if (!flagsOnly && /BODY(\.PEEK)?\[\]/.test(asked)) {
      const body = Buffer.from(sourceOf(m));
      return Buffer.concat([
        Buffer.from(`* ${seq} FETCH (${parts.join(" ")} BODY[] {${body.length}}\r\n`),
        body,
        Buffer.from(")\r\n"),
      ]);
    }
    return Buffer.from(`* ${seq} FETCH (${parts.join(" ")})\r\n`);
  };

  const handle = (sock: TLSSocket) => {
    total++;
    if (api.refuseConnections) {
      sock.destroy();
      return;
    }
    sockets.add(sock);
    sock.on("close", () => {
      sockets.delete(sock);
      idling.delete(sock);
    });
    sock.on("error", () => {});
    let buf = "";
    let authed = false;
    let idleTag: string | null = null;
    let awaitingPlain: string | null = null;
    const checkPlain = (tag: string, b64: string) => {
      const [, u = "", p = ""] = Buffer.from(b64, "base64").toString().split("\0");
      if (u === TEST_USER && p === TEST_PASSWORD && api.loginRefusal === null) {
        authed = true;
        send(`${tag} OK [CAPABILITY ${caps()}] logged in`);
      } else send(`${tag} NO ${api.loginRefusal ?? "[AUTHENTICATIONFAILED] invalid credentials"}`);
    };
    const send = (s: string) => sock.write(`${s}\r\n`);
    const caps = () => `IMAP4rev1 AUTH=PLAIN ID${api.idleSupported ? " IDLE" : ""}`;
    const run = (line: string) => {
      if (awaitingPlain !== null) {
        const tag = awaitingPlain;
        awaitingPlain = null;
        checkPlain(tag, line.trim());
        return;
      }
      if (idleTag !== null) {
        if (line.trim().toUpperCase() === "DONE") {
          const tag = idleTag;
          idleTag = null;
          idling.delete(sock);
          send(`${tag} OK IDLE terminated`);
        }
        return;
      }
      for (const pending of queued.get(sock) ?? []) sock.write(pending);
      queued.delete(sock);
      const m = /^(\S+) (\S+)\s?(.*)$/.exec(line);
      if (!m) return;
      const [, tag = "*", verbRaw = "", rest = ""] = m;
      const verb = verbRaw.toUpperCase();
      commands.push(verb);
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
        case "LOGIN": {
          const [u, p] = rest.split(" ").map((x) => x.replace(/^"|"$/g, ""));
          if (u === TEST_USER && p === TEST_PASSWORD && api.loginRefusal === null) {
            authed = true;
            send(`${tag} OK [CAPABILITY ${caps()}] logged in`);
          } else
            send(`${tag} NO ${api.loginRefusal ?? "[AUTHENTICATIONFAILED] invalid credentials"}`);
          break;
        }
        case "AUTHENTICATE": {
          const initial = rest.split(" ")[1];
          if (initial) checkPlain(tag, initial);
          else {
            awaitingPlain = tag;
            send("+ ");
          }
          break;
        }
        case "LIST":
        case "LSUB":
          if (!authed) return send(`${tag} NO not authenticated`);
          if (rest.includes('"" ""')) send(`* ${verb} (\\Noselect) "/" ""`);
          else send(`* ${verb} () "/" "INBOX"`);
          send(`${tag} OK done`);
          break;
        case "STATUS": {
          if (!authed) return send(`${tag} NO not authenticated`);
          const items: string[] = [];
          const asked = rest.toUpperCase();
          if (asked.includes("MESSAGES")) items.push(`MESSAGES ${messages.length}`);
          if (asked.includes("UNSEEN")) items.push(`UNSEEN ${api.unseen}`);
          if (asked.includes("UIDNEXT")) items.push(`UIDNEXT ${nextUid}`);
          if (asked.includes("UIDVALIDITY")) items.push(`UIDVALIDITY ${api.uidValidity}`);
          send(`* STATUS "INBOX" (${items.join(" ")})`);
          send(`${tag} OK done`);
          break;
        }
        case "SELECT":
        case "EXAMINE":
          if (!authed) return send(`${tag} NO not authenticated`);
          send("* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)");
          send(`* ${messages.length} EXISTS`);
          send("* 0 RECENT");
          send(`* OK [UIDVALIDITY ${api.uidValidity}] ok`);
          send(`* OK [UIDNEXT ${nextUid}] ok`);
          send(`${tag} OK [${verb === "SELECT" ? "READ-WRITE" : "READ-ONLY"}] done`);
          break;
        case "UID": {
          const [sub = "", ...restArgs] = rest.split(" ");
          const subVerb = sub.toUpperCase();
          commands.push(`UID ${subVerb}`);
          const set = restArgs[0] ?? "";
          const tail = restArgs.slice(1).join(" ").toUpperCase();
          if (subVerb === "SEARCH") {
            const only = tail.includes("UNSEEN") || set.toUpperCase() === "UNSEEN";
            send(
              `* SEARCH ${messages
                .filter((m) => !only || !m.seen)
                .map((m) => m.uid)
                .join(" ")}`.trimEnd()
            );
            send(`${tag} OK done`);
          } else if (subVerb === "FETCH") {
            const inSet = uidSet(set);
            for (const m of messages) if (inSet(m.uid)) sock.write(fetchLine(m, tail));
            send(`${tag} OK done`);
          } else if (subVerb === "STORE") {
            const inSet = uidSet(set);
            const adding = tail.startsWith("+");
            if (tail.includes("\\SEEN")) {
              for (const m of messages) {
                if (!inSet(m.uid)) continue;
                m.seen = adding;
                sock.write(fetchLine(m, "", true));
                notify(fetchLine(m, "", true), sock);
              }
            }
            send(`${tag} OK done`);
          } else send(`${tag} BAD unknown command`);
          break;
        }
        case "IDLE":
          if (!api.idleSupported) return send(`${tag} BAD IDLE not supported`);
          idleTag = tag;
          idling.add(sock);
          send("+ idling");
          break;
        case "CLOSE":
        case "UNSELECT":
          send(`${tag} OK done`);
          break;
        case "LOGOUT":
          send("* BYE");
          send(`${tag} OK bye`);
          sock.end();
          break;
        default:
          send(`${tag} BAD unknown command`);
      }
    };
    sock.on("data", (d: Buffer) => {
      buf += d.toString("latin1");
      let i = buf.indexOf("\r\n");
      while (i >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        run(line);
        i = buf.indexOf("\r\n");
      }
    });
    send(`* OK [CAPABILITY ${caps()}] fake mailbox ready`);
  };

  const server = createTlsServer(FAKE_TLS, handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  api.port = typeof addr === "object" && addr ? addr.port : 0;
  api.close = () =>
    new Promise<void>((r) => {
      for (const s of [...sockets]) s.destroy();
      server.close(() => r());
    });
  return api;
}
