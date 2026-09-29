import axios from "axios";
import type { Readable } from "stream";
import { StringDecoder } from "string_decoder";
import { SseParser } from "../sse";
import { MODEL_REQUEST_TIMEOUT_MS, MODEL_RETRY_DELAYS_MS } from "../timing";
import type { ResolvedModel } from "./settings";
import { modelTransport } from "./transport";
import { waitForRetry } from "./retry";
import { chatCompletionsEndpoint } from "./model_endpoint";
import type { toolDefinitions } from "./tools";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export class ProviderError extends Error {
  public readonly detail: string;

  constructor(message: string, detail: string) {
    super(message);
    this.detail = detail;
    this.name = "ProviderError";
  }
}

export function providerDetail(error: unknown): string {
  const value = error as {
    response?: { status?: number; data?: unknown };
    code?: string;
    message?: string;
  } | null;
  const status = value?.response?.status;
  const data = value?.response?.data;
  let remote = "";
  if (typeof data === "string") remote = data;
  else if (data && typeof data === "object") {
    const body = data as Record<string, unknown>;
    const nested = body.error;
    remote =
      typeof nested === "string"
        ? nested
        : nested && typeof nested === "object" && typeof (nested as any).message === "string"
        ? (nested as any).message
        : typeof body.message === "string"
        ? body.message
        : "";
  }
  const base = remote || value?.code || value?.message || "Unknown provider error";
  return `${status ? `HTTP ${status}: ` : ""}${base}`.slice(0, 500);
}

export async function complete(
  model: ResolvedModel,
  messages: ModelMessage[],
  tools: ReturnType<typeof toolDefinitions>,
  signal: AbortSignal,
  timeout: number,
  onDelta: (text: string) => Promise<void>,
  onToolRequest: (id: string, name: string) => Promise<void> = async () => {},
  hooks: {
    onRetry?: (attempt: number, delayMs: number) => Promise<void>;
    beforeAttempt?: () => Promise<void>;
    onReasoning?: (text: string) => Promise<void>;
  } = {}
): Promise<ModelMessage> {
  const deadline = Date.now() + timeout;
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new Error("Stream interrupted");
    await hooks.beforeAttempt?.();
    const remaining = deadline - Date.now();
    if (remaining <= 0 || signal.aborted) throw new Error("Stream interrupted");
    try {
      return await completeOnce(
        model,
        messages,
        tools,
        signal,
        remaining,
        onDelta,
        onToolRequest,
        hooks.onReasoning || (async () => {})
      );
    } catch (error) {
      if (signal.aborted || attempt >= MODEL_RETRY_DELAYS_MS.length || !retryable(error))
        throw new ProviderError("AI provider request failed", providerDetail(error));
      const delayMs = MODEL_RETRY_DELAYS_MS[attempt];
      if (Date.now() + delayMs >= deadline)
        throw new ProviderError("AI provider request failed", providerDetail(error));
      // Retry only this generation, with the same completed tool receipts.
      // No tool from an incomplete response has been executed by ChatService.
      await hooks.onRetry?.(attempt + 1, delayMs);
      await waitForRetry(delayMs, signal);
    }
  }
}

function retryable(error: unknown): boolean {
  const failure = error as { code?: string; response?: { status?: number } } | null;
  const status = failure?.response?.status;
  if (status !== undefined)
    return [408, 409, 429].includes(status) || (status >= 500 && status <= 599);
  return [
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "ETIMEDOUT",
    "EPIPE",
    "EAI_AGAIN",
    "ENOTFOUND",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "ERR_NETWORK",
    "ERR_STREAM_PREMATURE_CLOSE"
  ].includes(failure?.code || "");
}

async function completeOnce(
  model: ResolvedModel,
  messages: ModelMessage[],
  tools: ReturnType<typeof toolDefinitions>,
  signal: AbortSignal,
  timeout: number,
  onDelta: (text: string) => Promise<void>,
  onToolRequest: (id: string, name: string) => Promise<void>,
  onReasoning: (text: string) => Promise<void>
): Promise<ModelMessage> {
  const controller = new AbortController();
  let stream: Readable | undefined;
  let timedOut = false;
  const abort = () => {
    controller.abort();
    stream?.destroy();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(
    () => {
      timedOut = true;
      abort();
    },
    Math.min(MODEL_REQUEST_TIMEOUT_MS, timeout)
  );
  try {
    const endpoint = chatCompletionsEndpoint(model.endpoint);
    // Redirects are disabled to keep API credentials on the configured API host.
    const response = await axios.post<Readable>(
      endpoint,
      {
        model: model.model,
        messages,
        tools,
        tool_choice: "auto",
        parallel_tool_calls: false,
        stream: true,
        // Omit the option for legacy/ordinary models. Explicit off is different
        // from the provider default, which may itself enable reasoning.
        ...(typeof model.thinkingEnabled === "boolean"
          ? { reasoning_effort: model.thinkingEnabled ? model.thinkingEffort : "none" }
          : {})
      },
      {
        ...modelTransport(endpoint, model.publicOnly),
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {})
        },
        responseType: "stream",
        timeout: Math.min(MODEL_REQUEST_TIMEOUT_MS, timeout),
        signal: controller.signal,
        maxRedirects: 0,
        maxBodyLength: 512 * 1024
      }
    );
    stream = response.data;
    if (!String(response.headers["content-type"]).includes("text/event-stream"))
      throw new Error("Expected an event stream");
    const parser = new SseParser();
    const decoder = new StringDecoder("utf8");
    const calls = new Map<number, ToolCall>();
    const announced = new Map<number, string>();
    let content = "";
    let reasoningLength = 0;
    let size = 0;
    let finished = false;
    let done = false;
    for await (const chunk of stream) {
      if (controller.signal.aborted) throw new Error("Stream interrupted");
      size += Buffer.byteLength(chunk);
      if (size > 1024 * 1024) throw new Error("Model response too large");
      for (const data of parser.push(
        decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      )) {
        if (data === "[DONE]") {
          done = true;
          break;
        }
        const packet = JSON.parse(data);
        if (packet.error || !Array.isArray(packet.choices)) throw new Error("Invalid model stream");
        const choice = packet.choices.find((item: { index: number }) => item.index === 0);
        if (!choice) continue; // Usage-only chunks have no choices.
        if (finished) throw new Error("Content after completion");
        const delta = choice.delta || {};
        if (delta.role !== undefined && delta.role !== "assistant") throw new Error("Invalid role");
        const reasoningValue =
          delta.reasoning_content ??
          delta.reasoning ??
          delta.thinking?.content ??
          delta.thinking;
        if (typeof reasoningValue === "string" && reasoningValue) {
          reasoningLength += reasoningValue.length;
          if (reasoningLength > 48000) throw new Error("Reasoning content too large");
          await onReasoning(reasoningValue);
        }
        if (delta.content != null) {
          if (typeof delta.content !== "string" || content.length + delta.content.length > 24000)
            throw new Error("Invalid content");
          content += delta.content;
          if (delta.content) await onDelta(delta.content);
        }
        if (delta.tool_calls != null) {
          if (!Array.isArray(delta.tool_calls)) throw new Error("Invalid tool calls");
          for (const piece of delta.tool_calls) {
            if (
              !piece ||
              !Number.isSafeInteger(piece.index) ||
              piece.index < 0 ||
              (piece.type !== undefined && piece.type !== "function")
            )
              throw new Error("Invalid tool call");
            const call = calls.get(piece.index) || {
              id: "",
              type: "function" as const,
              function: { name: "", arguments: "" }
            };
            if (piece.id != null) {
              if (typeof piece.id !== "string" || (call.id && call.id !== piece.id))
                throw new Error("Invalid tool ID");
              call.id = piece.id;
            }
            for (const key of ["name", "arguments"] as const) {
              const part = piece.function?.[key];
              if (part != null) {
                if (typeof part !== "string") throw new Error("Invalid tool fragment");
                call.function[key] += part;
              }
            }
            if (
              call.id.length > 200 ||
              call.function.name.length > 100 ||
              call.function.arguments.length > 12000
            )
              throw new Error("Tool call too large");
            calls.set(piece.index, call);
            // Announce the request while arguments are streaming; execution still waits
            // for the complete, validated response below.
            if (
              call.id &&
              call.function.name &&
              announced.get(piece.index) !== call.function.name
            ) {
              announced.set(piece.index, call.function.name);
              await onToolRequest(call.id, call.function.name);
            }
          }
        }
        if (choice.finish_reason != null) {
          if (!["stop", "tool_calls"].includes(choice.finish_reason))
            throw new Error("Incomplete model response");
          finished = true;
        }
      }
      if (done) break;
    }
    if (controller.signal.aborted || !done || !finished)
      throw Object.assign(new Error("Incomplete model stream"), {
        code: "ERR_STREAM_PREMATURE_CLOSE"
      });
    const toolCalls = Array.from(calls)
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call);
    const ids = new Set<string>();
    for (const call of toolCalls) {
      if (!call.id || !call.function.name || ids.has(call.id)) throw new Error("Invalid tool call");
      ids.add(call.id);
      // A completed stream alone does not make fragmented tool JSON valid.
      JSON.parse(call.function.arguments);
    }
    if (!content.trim() && !toolCalls.length) throw new Error("Empty model response");
    return {
      role: "assistant",
      content: content || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {})
    };
  } catch (error) {
    (error as { response?: { data?: { destroy?: () => void } } })?.response?.data?.destroy?.();
    if (timedOut && !signal.aborted)
      throw Object.assign(new Error("Model request timed out"), { code: "ETIMEDOUT" });
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    stream?.destroy();
  }
}
