/**
 * Bookkeeping of sends in their undo window (Mail ticket 07; ADR 0007/0008).
 *
 *   <globalCache>/mail/<accountId>/outbox/<sendId>.json      the marker of one send
 *   <globalCache>/mail/<accountId>/outbox/claim-<hash>.json  "this draft is being sent" (one per Message-ID)
 *
 * Why the global CACHE and not global data: the mail itself is safe on the server before a marker is
 * written (the exact message is in the account's Drafts folder, the remote authority), so losing the
 * markers never loses a message; that is what makes this a disposable cache. It does cost two things,
 * and they are stated rather than hidden: the notice "this was not sent" after a restart, and the
 * cross-process exclusion (the claim files live here too). Within one process an in-memory guard
 * still stops a second send of the same draft; across processes, wiping this directory while another
 * process sends the same draft can produce a duplicate. Deleting an account removes its cache
 * directory, markers included.
 *
 * Ownership: exactly one server process owns a send (the one whose in-memory timer fires it). Other
 * processes only read markers. A marker whose owner process is gone is reported as interrupted;
 * nothing ever sends on the strength of a marker, so a restart cannot produce a second send.
 *
 * The claim file makes "send this draft" exclusive across processes: it is created with O_EXCL, so
 * two processes (or two requests) cannot both put the same Message-ID into an undo window.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  MAIL_ACCOUNT_ID_PATTERN,
  MAIL_SEND_ID_PATTERN,
  type MailOutboxMarker,
  MailOutboxMarkerSchema,
} from "@argelanderspace/contracts";

/** A marker/claim whose owner pid still exists but is this old past its deadline is treated as stale (pid reuse). */
export const MAIL_OUTBOX_STALE_MS = 10 * 60 * 1000;
/** A claim file that cannot be parsed yet is presumed to be mid-creation for this long. */
const UNREADABLE_CLAIM_GRACE_MS = 5000;

export interface OutboxOwner {
  pid: number;
  boot: string;
}

interface Claim {
  sendId: string;
  ownerPid: number;
  ownerBoot: string;
  at: number;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === "EPERM";
  }
}

export class MailOutbox {
  constructor(
    private readonly root: () => string,
    private readonly alive: (pid: number) => boolean = isProcessAlive,
    private readonly now: () => number = Date.now
  ) {}

  private dir(accountId: string): string | null {
    return MAIL_ACCOUNT_ID_PATTERN.test(accountId)
      ? join(this.root(), "mail", accountId, "outbox")
      : null;
  }
  private markerPath(accountId: string, sendId: string): string | null {
    const d = this.dir(accountId);
    return d && MAIL_SEND_ID_PATTERN.test(sendId) ? join(d, `${sendId}.json`) : null;
  }
  private claimPath(accountId: string, messageId: string): string | null {
    const d = this.dir(accountId);
    return d
      ? join(d, `claim-${createHash("sha256").update(messageId).digest("hex").slice(0, 32)}.json`)
      : null;
  }

  /** Throws when the marker cannot be written: starting a send without one would lose the restart report. */
  writeStrict(m: MailOutboxMarker): void {
    const path = this.markerPath(m.accountId, m.sendId);
    if (!path) throw new Error("bad marker path");
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
    renameSync(tmp, path);
  }
  /** Later transitions are best effort: the send is already under way. */
  write(m: MailOutboxMarker): void {
    try {
      const dir = this.dir(m.accountId);
      if (!dir || !existsSync(dir)) return; // an account deleted meanwhile must not get its cache directory back
      this.writeStrict(m);
    } catch {
      /* the cache may have been deleted meanwhile; the in-memory state is still right */
    }
  }

  read(accountId: string, sendId: string): MailOutboxMarker | null {
    const path = this.markerPath(accountId, sendId);
    if (!path) return null;
    try {
      return MailOutboxMarkerSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return null; // missing, truncated or another version: a cache miss
    }
  }

  remove(accountId: string, sendId: string): void {
    const path = this.markerPath(accountId, sendId);
    if (path) rmSync(path, { force: true });
  }

  /** Every readable marker of one account. Unreadable files are skipped, not reported. */
  list(accountId: string): MailOutboxMarker[] {
    const d = this.dir(accountId);
    if (!d) return [];
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return [];
    }
    const out: MailOutboxMarker[] = [];
    for (const name of names) {
      const id = name.replace(/\.json$/, "");
      if (!name.endsWith(".json") || !MAIL_SEND_ID_PATTERN.test(id)) continue;
      const m = this.read(accountId, id);
      if (m) out.push(m);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Account ids that have a cache directory (some may have no markers). */
  accountIds(): string[] {
    try {
      return readdirSync(join(this.root(), "mail")).filter((n) => MAIL_ACCOUNT_ID_PATTERN.test(n));
    } catch {
      return [];
    }
  }

  /**
   * Does the marker's owner still look alive? The same pid with another boot id is a process that was
   * replaced (a restart whose pid was reused, or an earlier life of this very process): dead.
   */
  ownerAlive(m: MailOutboxMarker, self: OutboxOwner): boolean {
    if (m.ownerPid === self.pid && m.ownerBoot !== self.boot) return false;
    return this.alive(m.ownerPid) && this.now() - m.deadlineAt < MAIL_OUTBOX_STALE_MS;
  }

  /** Delete terminal markers older than `maxAgeMs` (acknowledged or forgotten). */
  sweep(
    accountId: string,
    terminalMaxAgeMs: number,
    problemMaxAgeMs: number,
    self: OutboxOwner
  ): void {
    for (const m of this.list(accountId)) {
      const age = this.now() - m.createdAt;
      // A sent mail whose result the user still has to be told about (no Sent copy, refused recipients, a
      // Drafts copy left behind) is kept until the page acknowledges it, like any other problem.
      const needsAttention =
        m.state === "sent" && (m.sentCopy === "failed" || m.rejected > 0 || m.draftKept);
      const terminal = (m.state === "sent" && !needsAttention) || m.state === "cancelled";
      if ((terminal && age > terminalMaxAgeMs) || (!terminal && age > problemMaxAgeMs)) {
        if ((m.state === "pending" || m.state === "sending") && this.ownerAlive(m, self)) continue;
        this.remove(accountId, m.sendId);
      }
    }
  }

  /**
   * Take the exclusive "being sent" claim for this Message-ID. False when another live send holds it.
   * A claim left by a dead owner (or a very old one) is replaced.
   */
  claim(accountId: string, messageId: string, sendId: string, owner: OutboxOwner): boolean {
    const path = this.claimPath(accountId, messageId);
    if (!path) return false;
    // In-process guard first: it still works when the cache directory (and with it the claim file) is gone.
    const key = `${accountId}\u0000${messageId}`;
    if (this.held.has(key)) return false;
    const won = this.claimFile(path, sendId, owner);
    if (won) this.held.add(key);
    return won;
  }

  private readonly held = new Set<string>();

  private claimFile(path: string, sendId: string, owner: OutboxOwner): boolean {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    const body: Claim = { sendId, ownerPid: owner.pid, ownerBoot: owner.boot, at: this.now() };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(path, JSON.stringify(body), { mode: 0o600, flag: "wx" });
        return true;
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== "EEXIST") throw error;
      }
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue; // vanished between the two calls: try to create again
      }
      let held: Claim | null = null;
      try {
        held = JSON.parse(text) as Claim;
      } catch {
        held = null;
      }
      let live: boolean;
      if (held === null || typeof held.ownerPid !== "number") {
        // Not (yet) readable: another process may be between creating the file and writing it. Treat a
        // fresh unreadable claim as live, an old one as garbage.
        let age = Number.POSITIVE_INFINITY;
        try {
          age = Date.now() - statSync(path).mtimeMs;
        } catch {
          /* gone */
        }
        live = age < UNREADABLE_CLAIM_GRACE_MS;
      } else {
        const replaced = held.ownerPid === owner.pid && held.ownerBoot !== owner.boot;
        live =
          !replaced && this.alive(held.ownerPid) && this.now() - held.at < MAIL_OUTBOX_STALE_MS;
      }
      if (live) return false;
      // Stale. Remove it only if it is still the very file we judged stale.
      try {
        if (readFileSync(path, "utf8") === text) rmSync(path, { force: true });
      } catch {
        /* gone already */
      }
    }
    return false;
  }

  /** Release a claim, but only the one `sendId` holds. */
  release(accountId: string, messageId: string, sendId: string): void {
    this.held.delete(`${accountId}\u0000${messageId}`);
    const path = this.claimPath(accountId, messageId);
    if (!path) return;
    try {
      const held = JSON.parse(readFileSync(path, "utf8")) as Claim;
      if (held.sendId === sendId) rmSync(path, { force: true });
    } catch {
      /* nothing to release */
    }
  }

  /** Is a live send holding this draft (this process, or another process whose claim looks alive)? */
  claimHeld(accountId: string, messageId: string, self: OutboxOwner): boolean {
    if (this.held.has(`${accountId}\u0000${messageId}`)) return true;
    const path = this.claimPath(accountId, messageId);
    if (!path) return false;
    try {
      const held = JSON.parse(readFileSync(path, "utf8")) as Claim;
      const replaced = held.ownerPid === self.pid && held.ownerBoot !== self.boot;
      return !replaced && this.alive(held.ownerPid) && this.now() - held.at < MAIL_OUTBOX_STALE_MS;
    } catch {
      try {
        return Date.now() - statSync(path).mtimeMs < UNREADABLE_CLAIM_GRACE_MS;
      } catch {
        return false;
      }
    }
  }

  /** For tests and diagnostics: does a claim file exist for this draft? */
  hasClaim(accountId: string, messageId: string): boolean {
    const path = this.claimPath(accountId, messageId);
    if (!path) return false;
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  }
}
