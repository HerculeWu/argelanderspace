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

/** A failed mail request: only the machine code (and the server's field/test details); never mail text. */
export class MailApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly extra: { fields?: string[]; test?: MailTestResponse } = {}
  ) {
    super(code);
  }
}

export async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/mail${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      cache: "no-store",
    });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "AbortError") throw error;
    throw new MailApiError("unreachable", 0);
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as {
      code?: unknown;
      fields?: string[];
      test?: MailTestResponse;
    } | null;
    throw new MailApiError(typeof data?.code === "string" ? data.code : "unavailable", response.status, {
      ...(Array.isArray(data?.fields) ? { fields: data.fields } : {}),
      ...(data?.test ? { test: data.test } : {}),
    });
  }
  return response.json() as Promise<T>;
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
