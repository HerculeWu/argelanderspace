import type { CopilotConfirmationDecision, CopilotConversationList, CopilotResumeRequest, CopilotViewActionResult, ConversationModel, ConversationSnapshot, CopilotMessageRequest, PageContext } from "@argelanderspace/contracts";
export class CopilotApiError extends Error { constructor(readonly code: string) { super(code); } }
async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api/copilot${path}`, { method, cache: "no-store", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new CopilotApiError(typeof data.code === "string" ? data.code : "unavailable");
  return data as T;
}
export const listConversations = () => request<CopilotConversationList>("/conversations");
export const createConversation = (model: ConversationModel | null) => request<ConversationSnapshot>("/conversations", "POST", { model });
export const fetchConversation = (id: string) => request<ConversationSnapshot>(`/conversations/${id}`);
export const selectConversationModel = (id: string, model: ConversationModel) => request<ConversationSnapshot>(`/conversations/${id}/model`, "PUT", model);
export const publishPageContext = (context: PageContext) => request<{ saved: true }>(`/views/${context.viewId}`, "PUT", context);
export const sendCopilotMessage = (id: string, input: CopilotMessageRequest) => request<{ messageId: string; runId: string }>(`/conversations/${id}/messages`, "POST", input);
export const postViewActionResult = (viewId: string, result: CopilotViewActionResult) => request<{ saved: true }>(`/views/${viewId}/action-results`, "POST", result);
export const stopConversation = (id: string) => request<ConversationSnapshot>(`/conversations/${id}/stop`, "POST");
export const resumeConversation = (id: string, input: CopilotResumeRequest) => request<{ messageId: string; runId: string }>(`/conversations/${id}/resume`, "POST", input);
export const decideConfirmation = (id: string, decision: CopilotConfirmationDecision) => request<{ status: "approved" | "declined" }>(`/confirmations/${id}`, "POST", decision);
export const undoOperation = (conversationId: string, toolCallId: string, viewId: string) => request<{ status: "ok" | "noop"; rev: number }>(`/conversations/${conversationId}/operations/${encodeURIComponent(toolCallId)}/undo`, "POST", { viewId });
