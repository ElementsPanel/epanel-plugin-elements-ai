import type { ChatEvent } from "./types";

/** Coalesce token bursts without delaying tool requests, retries or completion. */
export function batchStreamUpdates(emit: (event: ChatEvent) => void) {
  let pending: ChatEvent | undefined;
  let chunks: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flush() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const event = pending;
    pending = undefined;
    if (event?.type === "delta") event.content = chunks.join("");
    chunks = [];
    if (event) emit(event);
  }

  function push(event: ChatEvent) {
    const reasoning = event.type === "message" && event.message.role === "assistant" &&
      event.message.reasoning && !event.message.reasoningComplete && !event.message.workComplete;
    if (event.type === "delta" || reasoning) {
      if (pending && (pending.type !== event.type ||
          !("index" in pending) || !("index" in event) || pending.index !== event.index)) flush();
      pending = { ...event };
      if (event.type === "delta") chunks.push(event.content);
      if (timer === undefined) timer = setTimeout(flush, 32);
    } else {
      flush();
      emit(event);
    }
  }

  return { push, flush };
}
