// Child process for the cross-process rev test: tries to add one account at rev 0.
import { register } from "node:module";

register("./ts-resolve-hook.mjs", import.meta.url);
const { createMailAccountStore, MailRevConflict } = await import("../../src/mail/account-store.ts");
const [dir, n] = process.argv.slice(2);
const id = `acc-${Number(n).toString(16).padStart(12, "0")}`;
const store = createMailAccountStore({ dataDir: dir });
try {
  await store.update(0, async () => {
    // widen the race window between the rev check and the write
    await new Promise((r) => setTimeout(r, 150));
    return {
      accounts: [
        {
          id,
          displayName: `A${n}`,
          address: `a${n}@example.test`,
          preset: "custom",
          imap: { host: "imap.example.test", port: 993, security: "tls" },
          smtp: { host: "smtp.example.test", port: 465, security: "tls" },
          imapUser: "u",
          smtpUser: "u",
          credentialRef: id,
          credentialProtection: "keychain",
        },
      ],
      result: null,
    };
  });
  console.log("ok");
} catch (e) {
  console.log(e instanceof MailRevConflict ? "conflict" : "error");
}
