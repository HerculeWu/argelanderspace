import type { Conversation, ConversationModel, ConversationSnapshot, CopilotMessageRequest, PageContext } from "@argelanderspace/contracts";
export class CopilotApiError extends Error { constructor(readonly code: string) { super(code); } }
async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api/copilot${path}`, { method, cache: "no-store", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new CopilotApiError(typeof data.code === "string" ? data.code : "unavailable");
  return data as T;
}
export const listConversations = () => request<{ version: 1; conversations: Conversation[] }>("/conversations");
export const createConversation = (model: ConversationModel | null) => request<ConversationSnapshot>("/conversations", "POST", { model });
export const fetchConversation = (id: string) => request<ConversationSnapshot>(`/conversations/${id}`);
export const selectConversationModel = (id: string, model: ConversationModel) => request<ConversationSnapshot>(`/conversations/${id}/model`, "PUT", model);
export const publishPageContext = (context: PageContext) => request<{ saved: true }>(`/views/${context.viewId}`, "PUT", context);
export const sendCopilotMessage = (id: string, input: CopilotMessageRequest) => request<{ messageId: string; runId: string }>(`/conversations/${id}/messages`, "POST", input);
