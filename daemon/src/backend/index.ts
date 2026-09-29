import { spawn, type ChildProcess } from "node:child_process";
import type { DaemonPluginContext } from "../../../../../daemon/src/plugin";

export const COMMAND_EVENT = "elements_ai/execute_command";
const COMMAND_MAX_LENGTH = 4096;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 30;
const MIN_OUTPUT_CHARS = 100;
const MAX_OUTPUT_CHARS = 32000;

export interface CommandRequest {
  command: string;
  timeoutSeconds: number;
  maxChars: number;
}

export interface CommandResult {
  platform: NodeJS.Platform;
  exitCode: number | null;
  content: string;
  truncated: boolean;
  timedOut: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function commandRequest(value: unknown): CommandRequest {
  if (!isRecord(value)) throw new Error("Invalid command request.");
  if (
    Object.keys(value).some(
      (key) => !["command", "timeoutSeconds", "maxChars"].includes(key)
    )
  )
    throw new Error("Invalid command request.");

  if (
    typeof value.command !== "string" ||
    !value.command.trim() ||
    value.command.length > COMMAND_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value.command)
  )
    throw new Error("Invalid command.");

  const timeoutSeconds = value.timeoutSeconds ?? 15;
  const maxChars = value.maxChars ?? 16000;
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < MIN_TIMEOUT_SECONDS ||
    timeoutSeconds > MAX_TIMEOUT_SECONDS ||
    typeof maxChars !== "number" ||
    !Number.isInteger(maxChars) ||
    maxChars < MIN_OUTPUT_CHARS ||
    maxChars > MAX_OUTPUT_CHARS
  )
    throw new Error("Invalid command limits.");

  return {
    command: value.command.trim(),
    timeoutSeconds,
    maxChars
  };
}

export function commandInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
  comSpec = process.env.ComSpec
) {
  return platform === "win32"
    ? { executable: comSpec || "cmd.exe", args: ["/d", "/s", "/c", command] }
    : { executable: "/bin/sh", args: ["-c", command] };
}

function terminalText(text: string, maxChars: number, alreadyTruncated: boolean) {
  const plain = text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
  const content = plain.slice(-maxChars);
  return { content, truncated: alreadyTruncated || content.length < plain.length };
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals, platform: NodeJS.Platform) {
  if (platform === "win32" && child.pid) {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.unref();
    } catch {}
  }
  if (platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  try {
    child.kill(signal);
  } catch {}
}

export function executeCommand(value: unknown): Promise<CommandResult> {
  const request = commandRequest(value);
  const platform = process.platform;
  const invocation = commandInvocation(request.command, platform);
  const child = spawn(invocation.executable, invocation.args, {
    cwd: process.cwd(),
    env: process.env,
    detached: platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  return new Promise((resolve, reject) => {
    // Keep memory bounded even when a command writes indefinitely. The extra
    // allowance preserves enough source text for escape-sequence cleanup before
    // the final maxChars tail is selected.
    const rawLimit = Math.min(request.maxChars * 4 + 65536, 256000);
    let raw = "";
    let bufferTruncated = false;
    let timedOut = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;

    const append = (chunk: string | Buffer) => {
      raw += chunk.toString();
      if (raw.length > rawLimit) {
        raw = raw.slice(-rawLimit);
        bufferTruncated = true;
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (settleTimer) clearTimeout(settleTimer);
      child.stdout?.off("data", append);
      child.stderr?.off("data", append);
    };
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        platform,
        exitCode,
        ...terminalText(raw, request.maxChars, bufferTruncated),
        timedOut
      });
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("The node command could not be started."));
    };

    child.once("error", fail);
    child.once("close", (code) => finish(code));

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      signalProcess(child, "SIGTERM", platform);
      forceTimer = setTimeout(() => signalProcess(child, "SIGKILL", platform), 250);
      // A descendant can keep inherited pipes open even after the shell dies.
      // Return bounded output after a short grace period instead of hanging the
      // authenticated panel request indefinitely.
      settleTimer = setTimeout(() => finish(null), 1000);
    }, request.timeoutSeconds * 1000);
  });
}

export const inject = ["protocol"];

export function apply(ctx: DaemonPluginContext) {
  ctx.protocol.on(COMMAND_EVENT, async (routerCtx, data) => {
    try {
      ctx.protocol.response(routerCtx, await executeCommand(data));
    } catch (error: any) {
      ctx.protocol.responseError(routerCtx, error, { disablePrint: true });
    }
  });
}
