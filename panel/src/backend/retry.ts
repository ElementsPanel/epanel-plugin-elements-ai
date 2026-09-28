/** Backoff is cancelled by stopping generation, disconnecting or unloading. */
export function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const interrupted = () => Object.assign(new Error("Request aborted"), { code: "ERR_CANCELED" });
    if (signal.aborted) return reject(interrupted());
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(interrupted());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}
