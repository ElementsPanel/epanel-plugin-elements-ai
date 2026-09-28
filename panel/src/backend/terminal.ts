/** Terminal escape sequences are display controls, not useful model context. */
export function terminalText(text: string, lines: number, maxChars: number) {
  const plain = text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
  const tail = plain.split("\n").slice(-lines).join("\n");
  const content = tail.slice(-maxChars);
  return { content, truncated: content.length < plain.length };
}
