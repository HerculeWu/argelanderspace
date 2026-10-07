/**
 * Local fake IMAP and SMTP servers for protocol tests. Synthetic credentials
 * only; nothing here ever connects to a real mailbox. The self-signed
 * certificate is the throwaway localhost one shipped inside smtp-server.
 */

import { createRequire } from "node:module";
import { createServer as createNetServer, type Server } from "node:net";
import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import { SMTPServer } from "smtp-server";

const require_ = createRequire(import.meta.url);
const tlsOptions = require_("smtp-server/lib/tls-options.js") as (o: object) => {
  key: string;
  cert: string;
};
const { key, cert } = tlsOptions({});

export const TEST_USER = "tester";
export const TEST_PASSWORD = "synthetic-pass-123";

export interface Fake {
  port: number;
  /** Everything the server saw, for assertions (never contains secrets by design of the test). */
  commands: string[];
  close(): Promise<void>;
}

export async function startFakeSmtp(mode: "tls" | "starttls" | "nostarttls"): Promise<Fake> {
  const commands: string[] = [];
  const server = new SMTPServer({
    secure: mode === "tls",
    key,
    cert,
    disabledCommands: mode === "nostarttls" ? ["STARTTLS", "AUTH"] : mode === "starttls" ? [] : [],
    authOptional: false,
    onAuth(auth, _s, cb) {
      commands.push("AUTH");
      if (auth.username === TEST_USER && auth.password === TEST_PASSWORD)
        return cb(null, { user: 1 });
      return cb(new Error("535 bad credentials"));
    },
    logger: false,
  });
  server.on("error", () => {}); // failed client handshakes are expected in tests
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    commands,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Minimal IMAP: CAPABILITY, STARTTLS, LOGIN, AUTHENTICATE PLAIN, ID, NOOP, LOGOUT. */
export async function startFakeImap(mode: "tls" | "starttls" | "plain" | "silent"): Promise<Fake> {
  const commands: string[] = [];
  const handle = (initial: import("node:net").Socket) => {
    let sock: import("node:net").Socket = initial;
    let secured = mode === "tls";
    let buf = "";
    const caps = () =>
      `IMAP4rev1 ${secured || mode === "plain" ? "AUTH=PLAIN" : "STARTTLS LOGINDISABLED"} ID`;
    const send = (s: string) => sock.write(`${s}\r\n`);
    let awaitingPlain: string | null = null; // tag of an AUTHENTICATE waiting for its response line
    const checkPlain = (tag: string, b64: string) => {
      const [, u = "", p = ""] = Buffer.from(b64, "base64").toString().split("\0");
      if (u === TEST_USER && p === TEST_PASSWORD)
        send(`${tag} OK [CAPABILITY ${caps()}] logged in`);
      else send(`${tag} NO [AUTHENTICATIONFAILED] invalid credentials`);
    };
    const onData = (d: Buffer) => {
      buf += d.toString("latin1");
      let i: number = buf.indexOf("\r\n");
      while (i >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (awaitingPlain) {
          const t = awaitingPlain;
          awaitingPlain = null;
          checkPlain(t, line);
          i = buf.indexOf("\r\n");
          continue;
        }
        const [tag = "*", cmdRaw = "", ...rest] = line.split(" ");
        const cmd = cmdRaw.toUpperCase();
        commands.push(cmd);
        if (cmd === "CAPABILITY") {
          send(`* CAPABILITY ${caps()}`);
          send(`${tag} OK done`);
        } else if (cmd === "ID") {
          send("* ID NIL");
          send(`${tag} OK done`);
        } else if (cmd === "STARTTLS" && mode === "starttls" && !secured) {
          send(`${tag} OK begin`);
          const plain = sock;
          plain.removeListener("data", onData);
          const t = new (require_("node:tls").TLSSocket)(plain, {
            isServer: true,
            key,
            cert,
          }) as TLSSocket;
          sock = t;
          secured = true;
          t.on("data", onData);
          t.on("error", () => {});
        } else if (cmd === "LOGIN" || cmd === "AUTHENTICATE") {
          if (cmd === "AUTHENTICATE") {
            if (rest[1]) checkPlain(tag, rest[1]);
            else {
              awaitingPlain = tag;
              send("+ ");
            }
          } else {
            const user = (rest[0] ?? "").replace(/"/g, "");
            const pass = (rest[1] ?? "").replace(/"/g, "");
            if (user === TEST_USER && pass === TEST_PASSWORD)
              send(`${tag} OK [CAPABILITY ${caps()}] logged in`);
            else send(`${tag} NO [AUTHENTICATIONFAILED] invalid credentials`);
          }
        } else if (cmd === "LOGOUT") {
          send("* BYE");
          send(`${tag} OK bye`);
          sock.end();
        } else if (cmd === "NAMESPACE") {
          send('* NAMESPACE (("" "/")) NIL NIL');
          send(`${tag} OK done`);
        } else if (cmd === "LIST") {
          send(`${tag} OK done`);
        } else {
          send(`${tag} OK done`);
        }
        i = buf.indexOf("\r\n");
      }
    };
    sock.on("data", onData);
    sock.on("error", () => {});
    if (mode !== "silent") send(`* OK [CAPABILITY ${caps()}] fake ready`);
  };
  const server: Server =
    mode === "tls"
      ? (createTlsServer({ key, cert }, handle) as unknown as Server)
      : createNetServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    commands,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
