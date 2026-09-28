import { PassThrough } from "stream";
import type { ChatEvent } from "../types";
import type { RequestContext } from "./tools";
import { ToolError } from "./tools";
import { ModelSettingsError } from "./settings";
import { ProviderError } from "./provider";

/** Return immediately so Koa can send chunks while the model is still generating. */
export function streamChat(
  request: RequestContext,
  run: (emit: (event: ChatEvent) => Promise<void>) => Promise<unknown>,
  fallback: string
) {
  const stream = new PassThrough();
  request.set("Content-Type", "text/event-stream; charset=utf-8");
  request.set("Cache-Control", "no-cache, no-transform");
  request.set("X-Accel-Buffering", "no");
  request.status = 200;
  request.body = stream;
  const write = async (data: string) => {
    if (stream.destroyed) throw new Error("Stream closed");
    if (!stream.write(data))
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          stream.off("drain", drained);
          stream.off("close", closed);
          stream.off("error", closed);
        };
        const drained = () => {
          cleanup();
          resolve();
        };
        const closed = () => {
          cleanup();
          reject(new Error("Stream closed"));
        };
        stream.once("drain", drained);
        stream.once("close", closed);
        stream.once("error", closed);
      });
  };
  const emit = (event: ChatEvent) => write(`data: ${JSON.stringify(event)}\n\n`);
  stream.write(": connected\n\n");
  const heartbeat = setInterval(() => {
    if (!stream.destroyed && stream.writableLength < 16_384) stream.write(": keepalive\n\n");
  }, 15_000);
  heartbeat.unref();
  stream.once("close", () => clearInterval(heartbeat));
  void run(emit)
    .catch(async (error) => {
      const message =
        error instanceof ToolError || error instanceof ModelSettingsError
          ? error.message
          : error instanceof ProviderError
          ? error.detail
          : fallback;
      if (!stream.destroyed) await emit({ type: "error", message }).catch(() => {});
    })
    .finally(() => {
      clearInterval(heartbeat);
      stream.end();
    });
}
