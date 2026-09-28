import type { FileDiff } from "../types";

const MAX_DIFF_LENGTH = 48_000;
const MAX_DIFF_LINES = 1000;
const CONTEXT = 3;
type Change = { sign: " " | "+" | "-"; text: string; oldLine: number; newLine: number };

/** A bounded unified diff of the verified original and the successfully written text. */
export function fileDiff(path: string, before: string, after: string): FileDiff {
  if (before === after) return { path, patch: "", truncated: false };
  // Retain terminators so a change to the final newline is not mistaken for a no-op.
  const oldLines = before.match(/[^\n]*\n|[^\n]+$/g) || [];
  const newLines = after.match(/[^\n]*\n|[^\n]+$/g) || [];
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  )
    prefix++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const changes: Change[] = [];
  let oldLine = 1;
  let newLine = 1;
  const push = (sign: Change["sign"], text: string) => {
    changes.push({ sign, text, oldLine, newLine });
    if (sign !== "+") oldLine++;
    if (sign !== "-") newLine++;
  };
  for (let i = 0; i < prefix; i++) push(" ", oldLines[i]);
  const oldCount = oldEnd - prefix;
  const newCount = newEnd - prefix;
  // Bound quadratic work. Large replacements still produce an exact diff, with a
  // less compact replacement of the changed middle rather than blocking the server.
  if ((oldCount + 1) * (newCount + 1) <= 1_000_000) {
    const width = newCount + 1;
    const lengths = new Uint32Array((oldCount + 1) * width);
    for (let i = oldCount - 1; i >= 0; i--)
      for (let j = newCount - 1; j >= 0; j--)
        lengths[i * width + j] =
          oldLines[prefix + i] === newLines[prefix + j]
            ? lengths[(i + 1) * width + j + 1] + 1
            : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    let i = 0;
    let j = 0;
    while (i < oldCount || j < newCount) {
      if (i < oldCount && j < newCount && oldLines[prefix + i] === newLines[prefix + j]) {
        push(" ", oldLines[prefix + i++]);
        j++;
      } else if (
        i < oldCount &&
        (j === newCount || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])
      ) {
        push("-", oldLines[prefix + i++]);
      } else {
        push("+", newLines[prefix + j++]);
      }
    }
  } else {
    for (let i = prefix; i < oldEnd; i++) push("-", oldLines[i]);
    for (let i = prefix; i < newEnd; i++) push("+", newLines[i]);
  }
  for (let i = oldEnd; i < oldLines.length; i++) push(" ", oldLines[i]);

  const hunks: { start: number; end: number }[] = [];
  for (let i = 0; i < changes.length; i++) {
    if (changes[i].sign === " ") continue;
    const start = Math.max(0, i - CONTEXT);
    const end = Math.min(changes.length, i + CONTEXT + 1);
    const previous = hunks[hunks.length - 1];
    if (previous && start <= previous.end) previous.end = end;
    else hunks.push({ start, end });
  }
  const lines: string[] = [];
  let length = 0;
  let truncated = false;
  const append = (line: string) => {
    const remaining = MAX_DIFF_LENGTH - length;
    if (remaining <= 0 || lines.length >= MAX_DIFF_LINES) {
      truncated = true;
      return false;
    }
    if (line.length + 1 > remaining) {
      lines.push(line.slice(0, remaining - 1) + "…");
      truncated = true;
      return false;
    }
    lines.push(line);
    length += line.length + 1;
    return true;
  };
  outer: for (const { start, end } of hunks) {
    const hunk = changes.slice(start, end);
    const oldSize = hunk.filter((line) => line.sign !== "+").length;
    const newSize = hunk.filter((line) => line.sign !== "-").length;
    const first = hunk[0];
    if (
      !append(
        `@@ -${first.oldLine - (oldSize ? 0 : 1)},${oldSize} +${
          first.newLine - (newSize ? 0 : 1)
        },${newSize} @@`
      )
    )
      break;
    for (const line of hunk) {
      if (!append(line.sign + line.text.replace(/\n$/, ""))) break outer;
      if (!line.text.endsWith("\n") && !append("\\ No newline at end of file")) break outer;
    }
  }
  return { path, patch: lines.join("\n"), truncated };
}
