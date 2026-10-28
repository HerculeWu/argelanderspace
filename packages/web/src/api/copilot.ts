import type { CopilotConfirmationDecision, CopilotConversationList, CopilotResumeRequest, CopilotViewActionResult, ConversationModel, ConversationSnapshot, CopilotMessageRequest, PageContext } from "@argelanderspace/contracts";
import { apiRequest, HttpError } from "./request";
export class CopilotApiError extends HttpError { constructor(code: string, status = 0, body: unknown = null) { super(code, status, body); } }
/** A failed answer is its body's `code` or `unavailable`, and so is an answer that is not JSON; a network failure or an abort passes through as is. */
async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  try {
    return await apiRequest<T>(`/api/copilot${path}`, { method, cache: "no-store", headers: { "Content-Type": "application/json" }, json: body });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "AbortError") throw error;
    // Not an HttpError: the ok answer's body did not parse.
    if (!(error instanceof HttpError)) throw new CopilotApiError("unavailable");
    if (error.status === 0) throw error.cause;
    const code = (error.body as { code?: unknown } | null)?.code;
    throw new CopilotApiError(typeof code === "string" ? code : "unavailable", error.status, error.body);
  }
}
export const listConversations = () => request<CopilotConversationList>("/conversations");
export const createConversation = (model: ConversationModel | null) => request<ConversationSnapshot>("/conversations", "POST", { model });
export const fetchConversation = (id: string) => request<ConversationSnapshot>(`/conversations/${id}`);
export const selectConversationModel = (id: string, model: ConversationModel) => request<ConversationSnapshot>(`/conversations/${id}/model`, "PUT", model);
export const publishPageContext = (context: PageContext) => request<{ saved: true }>(`/views/${context.viewId}`, "PUT", context);
export const sendCopilotMessage = (id: string, input: CopilotMessageRequest) => request<{ messageId: string; runId: string }>(`/conversations/${id}/messages`, "POST", input);
export const postViewActionResult = (viewId: string, result: CopilotViewActionResult) => request<{ saved: true }>(`/views/${viewId}/action-results`, "POST", result);
export const stopConversation = (id: string) => request<ConversationSnapshot>(`/conversations/${id}/stop`, "POST");
/** The user's "compact context": `stopped` when Stop gave it up (nothing changed). */
export const compactConversation = (id: string) => request<{ status: "compacted" | "stopped"; snapshot: ConversationSnapshot }>(`/conversations/${id}/compact`, "POST");
export const resumeConversation = (id: string, input: CopilotResumeRequest) => request<{ messageId: string; runId: string }>(`/conversations/${id}/resume`, "POST", input);
export const decideConfirmation = (id: string, decision: CopilotConfirmationDecision) => request<{ status: "approved" | "declined" }>(`/confirmations/${id}`, "POST", decision);
export const undoOperation = (conversationId: string, toolCallId: string, viewId: string) => request<{ status: "ok" | "noop"; rev: number }>(`/conversations/${conversationId}/operations/${encodeURIComponent(toolCallId)}/undo`, "POST", { viewId });
