/**
 * Recording SMTP server for the sending tests (Mail ticket 07): implicit TLS on
 * 127.0.0.1 with the throwaway localhost certificate, synthetic users only. It
 * records every message it accepted and can refuse recipients, refuse the
 * data, hold the answer back, or drop the connection after the data (so the
 * client cannot tell whether the message was accepted).
 */

import { SMTPServer } from "smtp-server";
import { FAKE_TLS, TEST_PASSWORD, TEST_USER } from "./fake-servers.js";

export interface RecordedMail {
  from: string;
  to: string[];
  raw: string;
}
export interface RecordingSmtp {
  port: number;
  /** Every message the server accepted (a refused one is never in here). */
  messages: RecordedMail[];
  /** Number of DATA phases that began, accepted or not. */
  dataStarted: { count: number };
  behavior: {
    /** Refuse RCPT TO for these (lower-case) addresses with 550. */
    rejectRecipients: string[];
    /** Answer the end of DATA with this code (e.g. 552) instead of accepting. */
    rejectData: number | null;
    /** Close the socket on the first RCPT TO without answering (before any message body was accepted). */
    dropAfterRcpt: boolean;
    /** Close the socket after receiving DATA without answering. */
    dropAfterData: boolean;
    /** Delay before the DATA answer, to hold a send open. */
    dataDelayMs: number;
  };
  close(): Promise<void>;
}

export async function startRecordingSmtp(): Promise<RecordingSmtp> {
  const messages: RecordedMail[] = [];
  const dataStarted = { count: 0 };
  const behavior: RecordingSmtp["behavior"] = {
    rejectRecipients: [],
    rejectData: null,
    dropAfterRcpt: false,
    dropAfterData: false,
    dataDelayMs: 0,
  };
  const server = new SMTPServer({
    secure: true,
    key: FAKE_TLS.key,
    cert: FAKE_TLS.cert,
    authOptional: false,
    onAuth(auth, _s, cb) {
      if (auth.username === TEST_USER && auth.password === TEST_PASSWORD)
        return cb(null, { user: 1 });
      return cb(new Error("535 bad credentials"));
    },
    onRcptTo(address, _s, cb) {
      if (behavior.dropAfterRcpt) {
        for (const conn of (
          server as unknown as { connections: Set<{ _socket: { destroy(): void } }> }
        ).connections)
          conn._socket.destroy();
        return;
      }
      if (behavior.rejectRecipients.includes(address.address.toLowerCase())) {
        const err = new Error("550 no such user") as Error & { responseCode: number };
        err.responseCode = 550;
        return cb(err);
      }
      return cb();
    },
    onData(stream, session, cb) {
      dataStarted.count++;
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        const finish = () => {
          if (behavior.dropAfterData) {
            // smtp-server keeps its connections in a Set; each owns its socket.
            for (const conn of (
              server as unknown as { connections: Set<{ _socket: { destroy(): void } }> }
            ).connections)
              conn._socket.destroy();
            return;
          }
          if (behavior.rejectData !== null) {
            const err = new Error("rejected") as Error & { responseCode: number };
            err.responseCode = behavior.rejectData;
            return cb(err);
          }
          messages.push({
            from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
            to: session.envelope.rcptTo.map((r) => r.address),
            raw: Buffer.concat(chunks).toString("utf8"),
          });
          cb();
        };
        if (behavior.dataDelayMs > 0) setTimeout(finish, behavior.dataDelayMs);
        else finish();
      });
    },
    logger: false,
  });
  server.on("error", () => {}); // failed client handshakes are expected in tests
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    messages,
    dataStarted,
    behavior,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
