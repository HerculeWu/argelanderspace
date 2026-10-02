import type { ProviderLoginResponse, ProviderModelConfig, ProviderMutationResult, ProvidersResponse, ProviderTestResult } from "@argelanderspace/contracts";

export class ProviderApiError extends Error {
  constructor(readonly code: string) { super(code); }
}
async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/copilot/providers${path}`, {
    method, headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal, cache: "no-store",
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ProviderApiError(typeof data?.code === "string" ? data.code : "unavailable");
  }
  return response.json();
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
