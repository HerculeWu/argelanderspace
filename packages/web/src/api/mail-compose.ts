import type {
  MailComposeDraft,
  MailComposeInitRequest,
  MailComposeInitResponse,
  MailOutboxResponse,
  MailSaveDraftResponse,
  MailSendStatus,
  MailStagedAttachment,
} from "@argelanderspace/contracts";
import { MailApiError } from "./mail";

/** Writing and sending mail (ticket 07). Same error contract as api/mail: only a machine code, never mail text. */
async function request<T>(path: string, init: RequestInit = {}, json?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/mail/compose${path}`, {
      ...init,
      headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
      body: json === undefined ? init.body : JSON.stringify(json),
      cache: "no-store",
    });
  } catch {
    throw new MailApiError("unreachable", 0);
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { code?: unknown } | null;
    throw new MailApiError(typeof data?.code === "string" ? data.code : "unavailable", response.status);
  }
  return response.json() as Promise<T>;
}

const acc = (id: string) => `/accounts/${encodeURIComponent(id)}`;

export const initMailCompose = (accountId: string, input: MailComposeInitRequest) =>
  request<MailComposeInitResponse>(`${acc(accountId)}/init`, { method: "POST" }, input);

export const saveMailDraft = (accountId: string, draft: MailComposeDraft) =>
  request<MailSaveDraftResponse>(`${acc(accountId)}/draft`, { method: "PUT" }, draft);

export const discardMailDraft = (accountId: string, draft: MailComposeDraft) =>
  request<{ ok: true }>(`${acc(accountId)}/draft/discard`, { method: "POST" }, draft);

export const uploadMailAttachment = (accountId: string, file: File) =>
  request<MailStagedAttachment>(`${acc(accountId)}/attachments`, {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-Mail-Filename": encodeURIComponent(file.name),
    },
    body: file,
  });

export const removeMailAttachment = (accountId: string, id: string) =>
  request<{ ok: true }>(`${acc(accountId)}/attachments/${encodeURIComponent(id)}`, { method: "DELETE" });

export const startMailSend = (accountId: string, sendId: string, draft: MailComposeDraft) =>
  request<MailSendStatus>(`${acc(accountId)}/send`, { method: "POST" }, { sendId, draft });

export const fetchMailSendStatus = (accountId: string, sendId: string) =>
  request<MailSendStatus>(`${acc(accountId)}/sends/${encodeURIComponent(sendId)}`);

export const undoMailSend = (accountId: string, sendId: string) =>
  request<MailSendStatus>(`${acc(accountId)}/sends/${encodeURIComponent(sendId)}/undo`, { method: "POST" });

export const dismissMailSend = (accountId: string, sendId: string) =>
  request<{ ok: true }>(`${acc(accountId)}/sends/${encodeURIComponent(sendId)}`, { method: "DELETE" });

export const fetchMailOutbox = () => request<MailOutboxResponse>("/outbox");
