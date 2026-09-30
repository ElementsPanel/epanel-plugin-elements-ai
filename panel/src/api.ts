import { ctx } from "@elements-panel/sdk";
import type {
  AiStatus,
  ChatEvent,
  ModelInput,
  ConversationSummary,
  ConversationDetail
} from "./types";
import type { InstanceTarget, PermissionMode } from "./types";
import { SseParser } from "./sse";
import { batchStreamUpdates } from "./streamUpdates";
import type { ChatPreferences } from "./preferences";

export class AccountChangedError extends Error {}

async function fetchAuthenticated(
  path: string,
  signal: AbortSignal,
  body?: unknown,
  expectedUser?: string,
  method = body === undefined ? "GET" : "POST"
): Promise<Response> {
  // Call the host's account service instead of bundling a second auth store/API singleton.
  const user = ctx.get("user");
  if (!user) throw new AccountChangedError();
  const info = (await user.api.userInfoApi().execute({ forceRequest: true, signal })).value;
  if (!info?.token || !info.uuid || (expectedUser && info.uuid !== expectedUser))
    throw new AccountChangedError();
  return fetch(`./api/ai/${path}`, {
    method,
    credentials: "same-origin",
    signal,
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      Authorization: `Bearer ${info.token}`
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

async function packet<T>(response: Response): Promise<T> {
  const packet = await response.json();
  if (!response.ok || packet.status !== 200)
    throw new Error(typeof packet.data === "string" ? packet.data : `HTTP ${response.status}`);
  return packet.data as T;
}

export const getStatus = async (signal: AbortSignal) =>
  packet<AiStatus>(await fetchAuthenticated("status", signal));
export const savePreferences = async (
  preferences: ChatPreferences,
  userId: string,
  signal: AbortSignal
) => packet<boolean>(await fetchAuthenticated("preferences", signal, preferences, userId, "PUT"));
export const listConversations = async (userId: string, signal: AbortSignal) =>
  packet<ConversationSummary[]>(
    await fetchAuthenticated("conversations", signal, undefined, userId)
  );
export const getConversation = async (id: string, userId: string, signal: AbortSignal) =>
  packet<ConversationDetail>(
    await fetchAuthenticated(`conversations/${encodeURIComponent(id)}`, signal, undefined, userId)
  );
export const deleteConversations = async (ids: string[], userId: string, signal: AbortSignal) =>
  packet<number>(await fetchAuthenticated("conversations", signal, { ids }, userId, "DELETE"));
export const saveModel = async (model: ModelInput, userId: string, signal: AbortSignal) =>
  packet<boolean>(await fetchAuthenticated("models", signal, model, userId, "PUT"));
export const deleteModel = async (id: string, userId: string, signal: AbortSignal) =>
  packet<boolean>(
    await fetchAuthenticated(
      `models/${encodeURIComponent(id)}`,
      signal,
      undefined,
      userId,
      "DELETE"
    )
  );

export const respondToApproval = async (
  id: string,
  approved: boolean,
  userId: string,
  signal: AbortSignal
) =>
  packet<boolean>(
    await fetchAuthenticated(`approvals/${encodeURIComponent(id)}`, signal, { approved }, userId)
  );

export const respondToQuestion = async (
  id: string,
  answer: string,
  userId: string,
  signal: AbortSignal
) =>
  packet<boolean>(
    await fetchAuthenticated(`questions/${encodeURIComponent(id)}`, signal, { answer }, userId)
  );

export const enqueueChatMessage = async (
  input: { conversationId: string; id: string; message: string },
  userId: string,
  signal: AbortSignal
) => packet<boolean>(await fetchAuthenticated("chat/input", signal, input, userId));

export const updateChatSettings = async (
  settings: { conversationId: string; modelId: string; permissionMode: PermissionMode; refresh?: boolean },
  userId: string,
  signal: AbortSignal
) => packet<boolean>(await fetchAuthenticated("chat/settings", signal, settings, userId, "PUT"));

export async function sendMessage(
  message: string,
  conversationId: string | undefined,
  modelId: string,
  userId: string,
  signal: AbortSignal,
  onEvent: (event: ChatEvent) => void,
  currentInstance?: InstanceTarget,
  permissionMode: PermissionMode = "default"
): Promise<void> {
  const response = await fetchAuthenticated(
    "chat",
    signal,
    { message, conversationId, modelId, currentInstance, permissionMode },
    userId
  );
  if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) {
    await packet(response);
    throw new Error("Expected an event stream");
  }
  if (!response.body) throw new Error("Missing response stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let completed = false;
  const updates = batchStreamUpdates(onEvent);
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const data of parser.push(decoder.decode(value, { stream: true }))) {
        const event = JSON.parse(data) as ChatEvent;
        if (event.type === "error") throw new Error(event.message);
        updates.push(event);
        if (event.type === "done") {
          completed = true;
          break;
        }
      }
      if (completed) break;
    }
    if (!completed || signal.aborted) throw new Error("Incomplete chat stream");
  } finally {
    // Keep the final partial output on interruption and cancel the batch timer.
    updates.flush();
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
