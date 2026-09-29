export interface FileDiff {
  path: string;
  patch: string;
  truncated: boolean;
}

export type PermissionMode = "default" | "full";

export interface ToolApproval {
  id: string;
  arguments: string;
}

export interface ToolQuestion {
  id: string;
  question: string;
  options: string[];
}

export interface ToolProgress {
  value?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  speed?: number;
  eta?: number;
  currentItem?: number;
  totalItems?: number;
}

export interface DownloadActivity {
  id: string;
  tool: string;
  progress?: ToolProgress;
  state?: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool" | "error";
  content: string;
  tool?: string;
  ok?: boolean;
  pending?: boolean;
  diff?: FileDiff;
  approval?: ToolApproval;
  question?: ToolQuestion;
  reasoning?: string;
  reasoningComplete?: boolean;
  workComplete?: boolean;
}

export interface ChatResponse {
  conversationId: string;
  messages: ChatMessage[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  modelId: string;
  modelName: string;
  updatedAt: number;
}

export interface ConversationDetail extends ConversationSummary {
  messages: ChatMessage[];
  canContinue: boolean;
}

export interface AiStatus {
  ready: boolean;
  admin: boolean;
  userId: string;
  models: ModelOption[];
  preferences: ChatPreferences;
}

export type ThinkingEffort = "low" | "medium" | "high";

export interface ModelOption {
  id: string;
  name: string;
  model: string;
  source: "preset" | "personal";
  endpoint?: string;
  hasApiKey?: boolean;
  thinkingEnabled: boolean | null;
  thinkingEffort: ThinkingEffort;
}

export interface ModelInput {
  id?: string;
  name: string;
  endpoint: string;
  model: string;
  apiKey: string;
  clearApiKey: boolean;
  thinkingEnabled: boolean | null;
  thinkingEffort: ThinkingEffort;
}

export type ChatEvent =
  | { type: "input"; id: string; index: number; message: ChatMessage }
  | { type: "start"; conversationId: string; messages: ChatMessage[] }
  | { type: "message"; index: number; message: ChatMessage }
  | { type: "delta"; index: number; content: string }
  | { type: "download"; action: "upsert"; task: DownloadActivity }
  | { type: "download"; action: "remove"; id: string }
  | { type: "retry"; attempt: number; maxAttempts: number; delayMs: number }
  | { type: "done"; conversationId: string }
  | { type: "error"; message: string };
import type { ChatPreferences } from "./preferences";
export interface InstanceTarget {
  daemonId: string;
  instanceUuid: string;
}
