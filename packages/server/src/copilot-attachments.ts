/**
 * Application-owned Copilot attachments (copilot ticket 15, spec §8.2): the files a user hands to a conversation.
 * They live under `<dataDir>/copilot/attachments/<conversationId>/` (never in a Reader Doc, never restored by a Doc
 * delete), are written atomically, are bounded in size and carry id, filename, size, type and sha256. Only ids and
 * metadata ever reach the model; a tool resolves an id to bytes only through the conversation that owns it.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  COPILOT_ATTACHMENT_MAX_BYTES,
  type CopilotAttachment,
  CopilotAttachmentSchema,
} from "@argelanderspace/contracts";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class AttachmentError extends Error {
  constructor(readonly code: "invalid" | "too_large" | "empty" | "not_found" | "storage") {
    super(`copilot attachment: ${code}`);
  }
}

/** A display name only: never a path, no control characters. */
export function safeAttachmentName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = [...base]
    .map((character) => {
      const code = character.charCodeAt(0);
      // Control characters and the Unicode direction controls (they can make a name read as another one).
      const bidi =
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069) ||
        code === 0x200e ||
        code === 0x200f;
      return code < 0x20 || code === 0x7f || bidi ? "_" : character;
    })
    .join("")
    .trim();
  if (!cleaned || cleaned.length > 255 || cleaned === "." || cleaned === "..")
    throw new AttachmentError("invalid");
  return cleaned;
}

export class AttachmentStore {
  constructor(private readonly root: string) {}

  private dir(conversationId: string): string {
    if (!ID.test(conversationId)) throw new AttachmentError("invalid");
    return join(this.root, conversationId);
  }

  /** Save the bytes (atomic: temp file, then rename; the metadata is written last, so a half-written file is never listed). */
  add(
    conversationId: string,
    filename: string,
    contentType: string,
    bytes: Buffer
  ): CopilotAttachment {
    if (bytes.length === 0) throw new AttachmentError("empty");
    if (bytes.length > COPILOT_ATTACHMENT_MAX_BYTES) throw new AttachmentError("too_large");
    const dir = this.dir(conversationId);
    const id = randomUUID();
    const meta = CopilotAttachmentSchema.parse({
      id,
      filename: safeAttachmentName(filename),
      size: bytes.length,
      contentType: contentType.slice(0, 200),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      createdAt: new Date().toISOString(),
    });
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const data = join(dir, `${id}.bin`);
      writeFileSync(`${data}.tmp`, bytes, { flag: "wx", mode: 0o600 });
      renameSync(`${data}.tmp`, data);
      const record = join(dir, `${id}.json`);
      writeFileSync(`${record}.tmp`, `${JSON.stringify(meta, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(`${record}.tmp`, record);
    } catch {
      rmSync(join(dir, `${id}.bin`), { force: true });
      rmSync(join(dir, `${id}.bin.tmp`), { force: true });
      rmSync(join(dir, `${id}.json.tmp`), { force: true });
      throw new AttachmentError("storage");
    }
    return meta;
  }

  /** The metadata of an attachment of THIS conversation; anything else (other conversation, forged id, deleted) is not_found. */
  meta(conversationId: string, id: string): CopilotAttachment {
    if (!ID.test(id)) throw new AttachmentError("not_found");
    const dir = this.dir(conversationId);
    const record = join(dir, `${id}.json`);
    const data = join(dir, `${id}.bin`);
    try {
      if (!lstatSync(record).isFile() || !lstatSync(data).isFile())
        throw new AttachmentError("not_found");
      return CopilotAttachmentSchema.parse(JSON.parse(readFileSync(record, "utf8")));
    } catch {
      throw new AttachmentError("not_found");
    }
  }

  /** The bytes, verified against the recorded size and sha256 (a changed file is not_found, never silently used). */
  read(conversationId: string, id: string): { meta: CopilotAttachment; bytes: Buffer } {
    const meta = this.meta(conversationId, id);
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(this.dir(conversationId), `${id}.bin`));
    } catch {
      throw new AttachmentError("not_found");
    }
    if (
      bytes.length !== meta.size ||
      createHash("sha256").update(bytes).digest("hex") !== meta.sha256
    )
      throw new AttachmentError("not_found");
    return { meta, bytes };
  }

  remove(conversationId: string, id: string): void {
    this.meta(conversationId, id);
    const dir = this.dir(conversationId);
    rmSync(join(dir, `${id}.json`), { force: true });
    rmSync(join(dir, `${id}.bin`), { force: true });
  }

  exists(conversationId: string): boolean {
    return existsSync(this.dir(conversationId)) && readdirSync(this.dir(conversationId)).length > 0;
  }
}
