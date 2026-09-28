<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { FileDiff } from "./types";

const props = defineProps<{ diff: FileDiff }>();
const { t } = useI18n();
const lines = computed(() =>
  props.diff.patch.split("\n").map((line) => ({
    // Make CRLF changes visible while retaining the original patch in history.
    text: line.replace(/\r/g, "␍"),
    kind: line.startsWith("+")
      ? "added"
      : line.startsWith("-")
      ? "removed"
      : line.startsWith("@@")
      ? "hunk"
      : "context"
  }))
);
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
