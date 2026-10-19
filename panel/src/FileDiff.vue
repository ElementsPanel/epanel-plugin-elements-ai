<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { FileDiff } from "./types";

type DiffLine = { text: string; kind: "added" | "removed" | "hunk" | "context" | "meta" };

const props = defineProps<{ diff: FileDiff }>();
const { t } = useI18n();

// Present every hunk as one consolidated block: removals first, the untouched
// lines once in the middle, additions last. Nearby edits then read as a single
// change instead of interleaved single-line pairs. This is display-only; the
// stored patch stays a real unified diff, and CRLF changes stay visible as ␍.
const lines = computed<DiffLine[]>(() => {
  const parsed: DiffLine[] = props.diff.patch.split("\n").map((raw) => ({
    text: raw.replace(/\r/g, "␍"),
    kind: raw.startsWith("+")
      ? "added"
      : raw.startsWith("-")
      ? "removed"
      : raw.startsWith("@@")
      ? "hunk"
      : raw.startsWith("\\")
      ? "meta"
      : "context"
  }));
  const result: DiffLine[] = [];
  let hunk: DiffLine[] = [];
  const flush = () => {
    if (hunk.length) result.push(...consolidate(hunk));
    hunk = [];
  };
  for (const line of parsed) {
    if (line.kind === "hunk") {
      flush();
      result.push(line);
    } else hunk.push(line);
  }
  flush();
  return result;
});

// "\ No newline at end of file" markers travel with the line they describe.
function consolidate(hunk: DiffLine[]): DiffLine[] {
  const units: DiffLine[][] = [];
  for (const line of hunk) {
    if (line.kind === "meta" && units.length) units[units.length - 1].push(line);
    else units.push([line]);
  }
  const changed = (unit: DiffLine[]) => unit[0].kind === "added" || unit[0].kind === "removed";
  let first = 0;
  while (first < units.length && !changed(units[first])) first++;
  if (first === units.length) return hunk;
  let last = units.length - 1;
  while (last > first && !changed(units[last])) last--;
  const removed: DiffLine[] = [];
  const kept: DiffLine[] = [];
  const added: DiffLine[] = [];
  for (const unit of units.slice(first, last + 1)) {
    if (unit[0].kind === "removed") removed.push(...unit);
    else if (unit[0].kind === "added") added.push(...unit);
    else kept.push(...unit);
  }
  return [
    ...units.slice(0, first).flat(),
    ...removed,
    ...kept,
    ...added,
    ...units.slice(last + 1).flat()
  ];
}
</script>

<template>
  <figure class="ai-file-diff" :aria-label="t('AI_FILE_DIFF')">
    <figcaption>{{ diff.path }}</figcaption>
    <div v-if="diff.patch" class="ai-diff-lines" tabindex="0" :aria-label="t('AI_FILE_DIFF')">
      <div
        v-for="(line, index) in lines"
        :key="index"
        class="ai-diff-line"
        :class="`ai-diff-line--${line.kind}`"
      >
        {{ line.text }}
      </div>
    </div>
    <p v-else>{{ t("AI_DIFF_EMPTY") }}</p>
    <p v-if="diff.truncated">{{ t("AI_DIFF_TRUNCATED") }}</p>
  </figure>
</template>

<style scoped>
.ai-file-diff {
  min-width: 0;
  margin: 6px 0 8px 26px;
  font-size: 12px;
}
.ai-file-diff figcaption {
  margin-bottom: 4px;
  overflow-wrap: anywhere;
  color: rgba(var(--v-theme-on-surface), 0.7);
}
.ai-diff-lines {
  max-height: 280px;
  overflow: auto;
  overscroll-behavior: contain;
  font-family: monospace;
  line-height: 1.6;
  border-radius: 4px;
}
.ai-diff-lines:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}
.ai-diff-line {
  white-space: pre;
  min-width: 100%;
  width: max-content;
  padding: 0 8px;
}
.ai-diff-line--added {
  color: rgb(var(--v-theme-success));
  background: rgba(var(--v-theme-success), 0.1);
}
.ai-diff-line--removed {
  color: rgb(var(--v-theme-error));
  background: rgba(var(--v-theme-error), 0.1);
}
.ai-diff-line--hunk {
  color: rgba(var(--v-theme-on-surface), 0.6);
}
.ai-file-diff p {
  margin: 4px 0 0;
  color: rgba(var(--v-theme-on-surface), 0.65);
}
</style>
