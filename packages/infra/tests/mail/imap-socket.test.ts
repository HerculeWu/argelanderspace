import { getDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { expect, test } from "vitest";
import { imapSocketOptions } from "../../src/mail/imap-internal.js";

// A real slow handshake cannot be reproduced on loopback; this pins the option that fixes it. Node's own 250 ms per
// address made email.uni-bonn.de (IPv6 unreachable, IPv4 handshake ~2 s from the user's network) fail as ETIMEDOUT
// in 0.5 s while SMTP to the same host worked.
test("each address gets half the connection budget instead of Node's 250 ms default", () => {
  expect(getDefaultAutoSelectFamilyAttemptTimeout()).toBeLessThan(1000);
  expect(imapSocketOptions(undefined, 10_000).autoSelectFamilyAttemptTimeout).toBe(5000);
  expect(imapSocketOptions(undefined, 100).autoSelectFamilyAttemptTimeout).toBe(250);
});

test("the caller's TLS settings are kept and TLS 1.2 stays the floor", () => {
  const o = imapSocketOptions({ ca: "synthetic-ca", rejectUnauthorized: false }, 4000);
  expect(o).toMatchObject({ ca: "synthetic-ca", rejectUnauthorized: false, minVersion: "TLSv1.2" });
});
