const MAX_DETAIL_LENGTH = 2000;

/** Read error fields only; never serialize request configs, headers or stacks. */
export function toolErrorDetail(
  error: unknown,
  fallback: string,
  secrets: readonly string[] = []
): string {
  const seen = new Set<object>();
  const describe = (value: unknown, depth = 0): string => {
    if (depth > 5 || value == null) return "";
    if (typeof value === "string") {
      const message = value.trim();
      if (["[object Object]", "undefined", "null"].includes(message)) return "";
      // Daemon errors sometimes arrive as JSON inside an Error.message.
      if (message.startsWith("{") || message.startsWith("[")) {
        try {
          const detail = describe(JSON.parse(message), depth + 1);
          if (detail) return detail;
          // Do not echo a JSON object that contains only private metadata.
          return "";
        } catch {}
      }
      return message;
    }
    if (typeof value !== "object" || seen.has(value)) return "";
    seen.add(value);
    if (Array.isArray(value))
      return value.slice(0, 5).map((item) => describe(item, depth + 1)).filter(Boolean).join("; ");
    const failure = value as Record<string, any>;
    const status = failure.response?.status ?? failure.status;
    const code = typeof failure.code === "string" ? failure.code : "";
    const details = [
      describe(failure.response?.data, depth + 1),
      describe(failure.error, depth + 1) || describe(failure.err, depth + 1),
      describe(failure.message, depth + 1),
      describe(failure.detail, depth + 1) || describe(failure.error_description, depth + 1),
      describe(failure.cause, depth + 1),
      describe(failure.errors, depth + 1)
    ].filter(Boolean);
    return [...new Set([
      ...(typeof status === "number" && status >= 100 && status <= 599 ? [`HTTP ${status}`] : []),
      ...(code ? [code] : []),
      ...details
    ])].join(": ");
  };

  let detail = describe(error) || fallback;
  // Redact before truncation so a long credential is never partially exposed.
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    detail = detail.split(secret).join("[redacted]");
    detail = detail.split(encodeURIComponent(secret)).join("[redacted]");
  }
  detail = detail
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[redacted]")
    .replace(/\bBearer\s+[^\s"'<>;,]+/gi, "Bearer [redacted]")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic [redacted]")
    .replace(/\b(?:set-cookie|cookie)\s*:\s*[^\r\n]*/gi, "Cookie: [redacted]")
    .replace(/((?:["']?[\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie)[\w.-]*["']?)\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&<>]+)/gi, "$1[redacted]")
    .replace(/\b(?:https?|wss?|ftp):\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        // Signed downloads and URL credentials must not enter model/history data.
        return `${url.protocol}//${url.host}/[redacted]`;
      } catch {
        return "[redacted URL]";
      }
    })
    .replace(/\r\n?/g, "\n")
    .replace(/\n\s*at\s[^\n]*/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .trim();
  return detail.length > MAX_DETAIL_LENGTH
    ? `${detail.slice(0, MAX_DETAIL_LENGTH - 1)}…`
    : detail || fallback;
}
