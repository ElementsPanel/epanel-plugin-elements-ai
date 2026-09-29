const CHAT_COMPLETIONS_PATH = "/chat/completions";

/** Store and display the API base address, including `/v1` when required. */
export function normalizeModelEndpoint(endpoint: string): string {
  const normalized = endpoint.trim().replace(/\/+$/, "");
  return normalized.endsWith(CHAT_COMPLETIONS_PATH)
    ? normalized.slice(0, -CHAT_COMPLETIONS_PATH.length).replace(/\/+$/, "")
    : normalized;
}

/** Build the OpenAI-compatible chat endpoint at request time. */
export function chatCompletionsEndpoint(endpoint: string): string {
  return `${normalizeModelEndpoint(endpoint)}${CHAT_COMPLETIONS_PATH}`;
}
