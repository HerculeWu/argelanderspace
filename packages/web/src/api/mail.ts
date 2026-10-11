import type {
  MailAccount,
  MailAccountCreate,
  MailAccountMutationResponse,
  MailAccountsResponse,
  MailAccountUpdate,
  MailFoldersResponse,
  MailHeadersResponse,
  MailOpenRequest,
  MailOpenResponse,
  MailPresetsResponse,
  MailTestResponse,
} from "@argelanderspace/contracts";
import { apiRequest, HttpError } from "./request";

/** A failed mail request: only the machine code (and the server's field/test details); never mail text. */
export class MailApiError extends HttpError {
  constructor(
    code: string,
    status: number,
    readonly extra: { fields?: string[]; test?: MailTestResponse } = {},
    body: unknown = null
  ) {
    super(code, status, body);
  }
}

/** The machine code of a failed mail request; a network failure or anything else is "unreachable". */
export const mailErrorCode = (e: unknown): string => (e instanceof MailApiError ? e.code : "unreachable");

/**
 * Mail's reading of a failed request: no answer is `unreachable`; an answer's code is its body's `code` or
 * `unavailable`. `withDetails` adds the server's field/test details (the account routes). Anything that is not an
 * HttpError (an abort, a non-JSON ok answer) passes through.
 */
export function toMailApiError(e: unknown, withDetails: boolean): unknown {
  if (!(e instanceof HttpError)) return e;
  if (e.status === 0) return new MailApiError("unreachable", 0);
  const data = e.body as { code?: unknown; fields?: string[]; test?: MailTestResponse } | null;
  const extra = withDetails
    ? { ...(Array.isArray(data?.fields) ? { fields: data.fields } : {}), ...(data?.test ? { test: data.test } : {}) }
    : {};
  return new MailApiError(typeof data?.code === "string" ? data.code : "unavailable", e.status, extra, e.body);
}

export async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  try {
    return await apiRequest<T>(
      `/api/mail${path}`,
      { method, headers: { "Content-Type": "application/json" }, json: body, cache: "no-store" },
      { signal }
    );
  } catch (error) {
    throw toMailApiError(error, true);
  }
}

export const acc = (id: string) => `/accounts/${encodeURIComponent(id)}`;

export const fetchMailPresets = () => request<MailPresetsResponse>("/presets");
export const fetchMailAccounts = () => request<MailAccountsResponse>("/accounts");
export const createMailAccount = (input: MailAccountCreate) =>
  request<MailAccountMutationResponse>("/accounts", "POST", input);
export const updateMailAccount = (id: string, input: MailAccountUpdate) =>
  request<MailAccountMutationResponse>(acc(id), "PUT", input);
export const removeMailAccount = (id: string, rev: number) =>
  request<{ rev: number; warnings: string[] }>(`${acc(id)}?rev=${rev}`, "DELETE");

export const fetchMailFolders = (id: string, signal?: AbortSignal) =>
  request<MailFoldersResponse>(`${acc(id)}/folders`, "GET", undefined, signal);
export const fetchMailHeaders = (
  id: string,
  folder: string,
  opts: { before?: number | null; limit?: number } = {},
  signal?: AbortSignal
) => {
  const q = new URLSearchParams({ folder, limit: String(opts.limit ?? 50) });
  if (opts.before) q.set("before", String(opts.before));
  return request<MailHeadersResponse>(`${acc(id)}/messages?${q}`, "GET", undefined, signal);
};
export const openMailMessage = (id: string, input: MailOpenRequest, signal?: AbortSignal) =>
  request<MailOpenResponse>(`${acc(id)}/messages/open`, "POST", input, signal);

/** URL of an attachment; `inline` only for cid: images shown inside a sanitised HTML body. */
export function mailAttachmentUrl(
  accountId: string,
  m: { folder: string; uid: number; uidValidity: number },
  part: number,
  inline = false
): string {
  const q = new URLSearchParams({
    folder: m.folder,
    uid: String(m.uid),
    uidValidity: String(m.uidValidity),
    part: String(part),
  });
  if (inline) q.set("inline", "1");
  return `${window.location.origin}/api/mail${acc(accountId)}/attachment?${q}`;
}

export type { MailAccount };
