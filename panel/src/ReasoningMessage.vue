<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { VIcon } from "vuetify/components";

const props = defineProps<{ content: string; complete?: boolean }>();
const { t } = useI18n();
const expanded = ref(false);
const preview = ref<HTMLElement>();
// Only normalize the visible tail. The full reasoning is rendered on demand.
const tail = computed(() => props.content.slice(-300).replace(/\s+/g, " ").trim());
let frame: number | undefined;
let observer: ResizeObserver | undefined;

function followTail() {
  if (expanded.value || frame !== undefined) return;
  frame = window.requestAnimationFrame(() => {
    frame = undefined;
    if (preview.value && !expanded.value) preview.value.scrollLeft = preview.value.scrollWidth;
  });
}

watch([tail, () => props.complete, expanded], followTail, { flush: "post" });
onMounted(() => {
  followTail();
  if (typeof ResizeObserver !== "undefined" && preview.value) {
    observer = new ResizeObserver(() => { if (!props.complete) followTail(); });
    observer.observe(preview.value);
  }
});
onBeforeUnmount(() => {
  observer?.disconnect();
  if (frame !== undefined) window.cancelAnimationFrame(frame);
});
</script>

<template>
  <details class="ai-message-thinking" @toggle="expanded = ($event.target as HTMLDetailsElement).open">
    <summary :aria-busy="!complete">
      <span class="ai-thinking-label">{{ t(complete ? "AI_THINKING_COMPLETE_PREFIX" : "AI_THINKING_PREFIX") }}</span>
      <span v-show="!expanded" ref="preview" class="ai-thinking-content">{{ tail }}</span>
      <VIcon :icon="expanded ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="16" class="ai-thinking-toggle" />
    </summary>
    <pre v-if="expanded" class="ai-thinking-detail">{{ content }}</pre>
  </details>
</template>

<style scoped>
.ai-message-thinking {
  max-width: 100%;
  margin: 2px 0 6px;
  color: rgba(var(--v-theme-on-surface), 0.65);
  font-size: 13px;
  font-weight: 500;
}
summary {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  list-style: none;
}
summary::-webkit-details-marker { display: none; }
.ai-thinking-label, .ai-thinking-toggle { flex: none; }
.ai-thinking-toggle { margin-inline-start: auto; }
.ai-thinking-content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.ai-thinking-detail {
  margin: 8px 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  line-height: 1.65;
}
</style>
