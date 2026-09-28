/** Incremental SSE framing shared by the provider reader and the browser. */
export class SseParser {
  private buffer = "";
  private lines: string[] = [];
  private size = 0;

  push(text: string): string[] {
    this.buffer += text;
    const events: string[] = [];
    while (true) {
      const end = this.buffer.search(/[\r\n]/);
      if (end < 0 || (this.buffer[end] === "\r" && end === this.buffer.length - 1)) break;
      const line = this.buffer.slice(0, end);
      const length = this.buffer.slice(end, end + 2) === "\r\n" ? 2 : 1;
      this.buffer = this.buffer.slice(end + length);
      if (!line) {
        if (this.lines.length) events.push(this.lines.join("\n"));
        this.lines = [];
        this.size = 0;
      } else if (line.startsWith("data:")) {
        const value = line.slice(5).replace(/^ /, "");
        this.size += value.length;
        this.lines.push(value);
      }
      if (this.size > 256_000) throw new Error("SSE event too large");
    }
    if (this.buffer.length + this.size > 256_000) throw new Error("SSE event too large");
    return events;
  }
}
