<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  VAlert,
  VBtn,
  VCard,
  VCardText,
  VCheckbox,
  VIcon,
  VProgressLinear
} from "vuetify/components";
import {
  AccountChangedError,
  deleteConversations,
  getConversation,
  listConversations
} from "./api";
import type { ConversationDetail, ConversationSummary } from "./types";
import SidebarPageHeader from "./SidebarPageHeader.vue";

const props = defineProps<{ userId: string; currentId?: string }>();
const emit = defineEmits<{
  (event: "open", conversation: ConversationDetail): void;
  (event: "deleted", ids: string[]): void;
  (event: "close"): void;
  (event: "accountChanged"): void;
}>();
const { t } = useI18n();
const conversations = ref<ConversationSummary[]>([]);
const selectedIds = ref<string[]>([]);
const busy = ref(false);
const error = ref("");
let controller: AbortController | undefined;
const allSelected = computed(
  () => conversations.value.length > 0 && selectedIds.value.length === conversations.value.length
);
const hasSelection = computed(() => selectedIds.value.length > 0);

async function request(task: (signal: AbortSignal) => Promise<void>) {
  controller?.abort();
  const current = new AbortController();
  controller = current;
  busy.value = true;
  error.value = "";
  try {
    await task(current.signal);
  } catch (cause) {
    if (current.signal.aborted) return;
    if (cause instanceof AccountChangedError) emit("accountChanged");
    else error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (controller === current) busy.value = false;
  }
}

const refresh = () =>
  request(async (signal) => {
    const result = await listConversations(props.userId, signal);
    if (!signal.aborted) {
      conversations.value = result;
      selectedIds.value = selectedIds.value.filter((id) => result.some((entry) => entry.id === id));
    }
  });

const open = (id: string) =>
  request(async (signal) => {
    const result = await getConversation(id, props.userId, signal);
    if (!signal.aborted) emit("open", result);
  });

function toggleSelection(id: string, selected: boolean) {
  if (selected) {
    if (!selectedIds.value.includes(id)) selectedIds.value = [...selectedIds.value, id];
  } else selectedIds.value = selectedIds.value.filter((value) => value !== id);
}

function toggleAll() {
  selectedIds.value = allSelected.value
    ? []
    : conversations.value.map((conversation) => conversation.id);
}

const removeSelected = () => {
  if (!selectedIds.value.length) return;
  const ids = [...selectedIds.value];
  request(async (signal) => {
    await deleteConversations(ids, props.userId, signal);
    if (!signal.aborted) {
      conversations.value = conversations.value.filter(
        (conversation) => !ids.includes(conversation.id)
      );
      selectedIds.value = [];
      emit("deleted", ids);
    }
  });
};

onMounted(refresh);
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <VCard flat class="ai-history">
    <SidebarPageHeader :title="t('AI_HISTORY')" :disabled="busy" @back="emit('close')">
      <VBtn
        v-if="conversations.length"
        :icon="allSelected ? 'mdi-checkbox-multiple-marked' : 'mdi-checkbox-multiple-blank-outline'"
        size="small"
        variant="text"
        :title="t(allSelected ? 'AI_HISTORY_DESELECT_ALL' : 'AI_HISTORY_SELECT_ALL')"
        :aria-label="t(allSelected ? 'AI_HISTORY_DESELECT_ALL' : 'AI_HISTORY_SELECT_ALL')"
        :aria-pressed="allSelected"
        :disabled="busy"
        @click="toggleAll"
      />
      <VBtn
        v-if="conversations.length"
        icon="mdi-delete-outline"
        size="small"
        variant="text"
        color="error"
        :title="t('AI_HISTORY_DELETE_SELECTED')"
        :aria-label="t('AI_HISTORY_DELETE_SELECTED')"
        :disabled="busy || !hasSelection"
        @click="removeSelected"
      />
      <VBtn
        icon="mdi-refresh"
        size="small"
        variant="text"
        :disabled="busy"
        :title="t('AI_HISTORY_REFRESH')"
        :aria-label="t('AI_HISTORY_REFRESH')"
        @click="refresh"
      />
    </SidebarPageHeader>
    <VProgressLinear v-if="busy" indeterminate color="primary" height="2" />
    <VCardText>
      <p class="text-body-2 mb-4">{{ t("AI_HISTORY_HELP") }}</p>
      <VAlert v-if="error" type="error" variant="tonal" class="mb-3" :text="error" />
      <p v-if="!busy && !error && !conversations.length" class="ai-history-empty">
        {{ t("AI_HISTORY_EMPTY") }}
      </p>
      <ul class="ai-history-list">
        <li v-for="conversation in conversations" :key="conversation.id">
          <div class="ai-history-row">
            <VCheckbox
              class="ai-history-select"
              :model-value="selectedIds.includes(conversation.id)"
              :aria-label="conversation.title"
              :disabled="busy"
              hide-details
              density="compact"
              @update:model-value="toggleSelection(conversation.id, !!$event)"
            />
            <VBtn
              class="ai-history-entry"
              variant="text"
              block
              :disabled="busy"
              :aria-current="conversation.id === currentId ? 'true' : undefined"
              @click="open(conversation.id)"
            >
              <span class="ai-history-title">{{ conversation.title }}</span>
            </VBtn>
          </div>
        </li>
      </ul>
    </VCardText>
  </VCard>
</template>

<style scoped>
.ai-history {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ai-history > :deep(.v-card-text) {
  min-height: 0;
  overflow-y: auto;
}
.ai-history-list {
  list-style: none;
  padding: 0;
}
.ai-history-row {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 8px;
}
.ai-history-select {
  flex: 0 0 auto;
}
.ai-history-entry {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
  padding: 14px 12px;
  text-align: start;
  color: inherit;
  text-transform: none;
  justify-content: flex-start;
}
.ai-history-entry :deep(.v-btn__content) {
  display: flex;
  align-items: center;
  width: 100%;
  text-align: start;
}
.ai-history-entry:hover,
.ai-history-entry[aria-current="true"] {
  background: rgba(var(--v-theme-primary), 0.06);
}
.ai-history-entry:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}
.ai-history-entry:disabled {
  opacity: 0.6;
  cursor: progress;
}
.ai-history-title {
  flex: 1;
  min-width: 0;
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-history-title,
.ai-history-empty {
  font-size: 14px;
  color: rgba(var(--v-theme-on-surface), 0.6);
}
</style>
