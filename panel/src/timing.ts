export const MODEL_REQUEST_TIMEOUT_MS = 45_000;
export const MODEL_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
export const DOWNLOAD_WAIT_TIMEOUT_MS = 30 * 60_000;
// Reserve time for all five reconnection attempts in addition to normal work.
export const CHAT_TIMEOUT_MS =
  DOWNLOAD_WAIT_TIMEOUT_MS +
  150_000 +
  MODEL_REQUEST_TIMEOUT_MS * MODEL_RETRY_DELAYS_MS.length +
  MODEL_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0);
export const CLIENT_CHAT_TIMEOUT_MS = CHAT_TIMEOUT_MS + 20_000;
