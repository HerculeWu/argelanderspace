import type { ProviderLoginResponse, ProviderModelConfig, ProviderMutationResult, ProvidersResponse, ProviderTestResult } from "@argelanderspace/contracts";

import { apiRequest, HttpError } from "./request";

export class ProviderApiError extends HttpError {
  constructor(code: string, status = 0, body: unknown = null) { super(code, status, body); }
}
/** A failed answer is its body's `code` or `unavailable`; a network failure, an abort or a non-JSON ok answer passes through as is. */
async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  try {
    return await apiRequest<T>(`/api/copilot/providers${path}`, { method, headers: { "Content-Type": "application/json" }, json: body, cache: "no-store" }, { signal });
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    if (error.status === 0) throw error.cause;
    const code = (error.body as { code?: unknown } | null)?.code;
    throw new ProviderApiError(typeof code === "string" ? code : "unavailable", error.status, error.body);
  }
}
export const fetchProviders = () => request<ProvidersResponse>("");
export const saveProviderKey = (id: string, key: string) => request<ProviderMutationResult>(`/${encodeURIComponent(id)}/credential`, "PUT", { key });
export const removeProviderKey = (id: string) => request<ProviderMutationResult>(`/${encodeURIComponent(id)}/credential`, "DELETE");
export const saveProviderConfig = (id: string, config: ProviderModelConfig) => request<ProviderMutationResult>(`/${encodeURIComponent(id)}/config`, "PUT", config);
export const testProviderConnection = (id: string, config: ProviderModelConfig, signal: AbortSignal) => request<ProviderTestResult>(`/${encodeURIComponent(id)}/test`, "POST", config, signal);
export const startProviderLogin = (id: string) => request<ProviderLoginResponse>(`/${encodeURIComponent(id)}/login`, "POST");
export const fetchProviderLogin = (id: string, loginId: string, signal?: AbortSignal) => request<ProviderLoginResponse>(`/${encodeURIComponent(id)}/login/${encodeURIComponent(loginId)}`, "GET", undefined, signal);
export const cancelProviderLogin = (id: string, loginId: string) => request<ProviderLoginResponse>(`/${encodeURIComponent(id)}/login/${encodeURIComponent(loginId)}`, "DELETE");
/** The pasted value is a secret: it only travels in this body, never into state shown elsewhere. */
export const answerProviderLogin = (id: string, loginId: string, challengeId: string, value: string) => request<ProviderLoginResponse>(`/${encodeURIComponent(id)}/login/${encodeURIComponent(loginId)}/response`, "POST", { challengeId, value });
export const logoutProvider = (id: string) => request<ProviderMutationResult>(`/${encodeURIComponent(id)}/logout`, "POST");
