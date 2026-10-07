import { afterEach, expect, test } from "vitest";
import { createNodeMailProtocol } from "../../src/mail/protocol.js";
import {
  type Fake,
  startFakeImap,
  startFakeSmtp,
  TEST_PASSWORD,
  TEST_USER,
} from "./fake-servers.js";

const open: Fake[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});
const keep = async (p: Promise<Fake>) => {
  const f = await p;
  open.push(f);
  return f;
};
const lenient = createNodeMailProtocol({ timeoutMs: 3000, tls: { rejectUnauthorized: false } });
const target = (port: number, security: "tls" | "starttls", password = TEST_PASSWORD) => ({
  host: "127.0.0.1",
  port,
  security,
  user: TEST_USER,
  password,
});

test("IMAP implicit TLS: good login ok, bad password auth_failed", async () => {
  const s = await keep(startFakeImap("tls"));
  expect(await lenient.verifyImapLogin(target(s.port, "tls"))).toEqual({ ok: true });
  expect(await lenient.verifyImapLogin(target(s.port, "tls", "wrong"))).toEqual({
    ok: false,
    code: "auth_failed",
  });
});

test("IMAP STARTTLS login ok", async () => {
  const s = await keep(startFakeImap("starttls"));
  expect(await lenient.verifyImapLogin(target(s.port, "starttls"))).toEqual({ ok: true });
});

test("IMAP STARTTLS requested but server has none: failure, never a plaintext login", async () => {
  const s = await keep(startFakeImap("plain"));
  const r = await lenient.verifyImapLogin(target(s.port, "starttls"));
  expect(r.ok).toBe(false);
  expect(s.commands).not.toContain("LOGIN");
  expect(s.commands).not.toContain("AUTHENTICATE");
});

test("IMAP untrusted certificate is tls_failed with default (strict) TLS", async () => {
  const s = await keep(startFakeImap("tls"));
  const strict = createNodeMailProtocol({ timeoutMs: 3000 });
  expect(await strict.verifyImapLogin(target(s.port, "tls"))).toEqual({
    ok: false,
    code: "tls_failed",
  });
});

test("IMAP silent server times out; closed port is connection_refused", async () => {
  const s = await keep(startFakeImap("silent"));
  const fast = createNodeMailProtocol({ timeoutMs: 400, tls: { rejectUnauthorized: false } });
  expect(await fast.verifyImapLogin(target(s.port, "starttls"))).toMatchObject({
    ok: false,
    code: "timeout",
  });
  const closed = await keep(startFakeImap("tls"));
  const port = closed.port;
  await closed.close();
  open.pop();
  expect(await lenient.verifyImapLogin(target(port, "tls"))).toEqual({
    ok: false,
    code: "connection_refused",
  });
});

test("unknown host is host_not_found", async () => {
  const r = await lenient.verifyImapLogin({
    host: "no-such-host.invalid",
    port: 993,
    security: "tls",
    user: "u",
    password: "p",
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(["host_not_found", "timeout"]).toContain(r.code);
});

test("SMTP implicit TLS and STARTTLS: good login ok, bad password auth_failed", async () => {
  const a = await keep(startFakeSmtp("tls"));
  expect(await lenient.verifySmtpLogin(target(a.port, "tls"))).toEqual({ ok: true });
  expect(await lenient.verifySmtpLogin(target(a.port, "tls", "wrong"))).toEqual({
    ok: false,
    code: "auth_failed",
  });
  const b = await keep(startFakeSmtp("starttls"));
  expect(await lenient.verifySmtpLogin(target(b.port, "starttls"))).toEqual({ ok: true });
});

test("SMTP STARTTLS requested but unsupported: fails without sending credentials", async () => {
  const s = await keep(startFakeSmtp("nostarttls"));
  const r = await lenient.verifySmtpLogin(target(s.port, "starttls"));
  expect(r.ok).toBe(false);
  expect(s.commands).not.toContain("AUTH");
});

test("SMTP untrusted certificate is tls_failed with strict TLS", async () => {
  const s = await keep(startFakeSmtp("tls"));
  const strict = createNodeMailProtocol({ timeoutMs: 3000 });
  expect(await strict.verifySmtpLogin(target(s.port, "tls"))).toEqual({
    ok: false,
    code: "tls_failed",
  });
});
