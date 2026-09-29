<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import { VAlert, VBtn, VCard, VCardText, VCheckbox, VTooltip } from "vuetify/components";
import { AccountChangedError, savePreferences } from "./api";
import type { ChatPreferences } from "./preferences";
import type { ModelOption } from "./types";
import ModelManager from "./ModelManager.vue";
import SidebarPageHeader from "./SidebarPageHeader.vue";

const props = defineProps<{
  preferences: ChatPreferences;
  models: ModelOption[];
  userId: string;
  admin: boolean;
}>();
const emit = defineEmits<{
  (event: "saved", value: ChatPreferences): void;
  (event: "close"): void;
  (event: "plugin-settings"): void;
  (event: "account-changed"): void;
  (event: "models-changed"): void;
}>();
const { t } = useI18n();
const draft = ref({ ...props.preferences });
const busy = ref(false);
const error = ref("");
const controller = new AbortController();
async function save() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  const value = { ...draft.value };
  try {
    await savePreferences(value, props.userId, controller.signal);
    if (!controller.signal.aborted) {
      emit("saved", value);
      emit("close");
    }
  } catch (cause) {
    if (controller.signal.aborted) return;
    if (cause instanceof AccountChangedError) emit("account-changed");
    else error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}
onBeforeUnmount(() => controller.abort());
</script>

<template>
  <VCard flat class="ai-sidebar-settings">
    <SidebarPageHeader :title="t('AI_CHAT_SETTINGS')" :disabled="busy" @back="emit('close')" />
    <VCardText>
      <p class="text-body-2 mb-4">{{ t("AI_CHAT_SETTINGS_HELP") }}</p>
      <VAlert v-if="error" type="error" variant="tonal" :text="error" class="mb-3" />
      <form @submit.prevent="save">
        <div class="ai-send-on-enter-row">
          <VCheckbox
            v-model="draft.sendOnEnter"
            :label="t('AI_SEND_ON_ENTER')"
            :disabled="busy"
            hide-details
          />
          <VTooltip :text="t('AI_SEND_ON_ENTER_HELP')" location="top">
            <template #activator="{ props: tooltipProps }">
              <VBtn
                v-bind="tooltipProps"
                icon="mdi-information-outline"
                size="x-small"
                variant="text"
                :aria-label="t('AI_SEND_ON_ENTER_HELP')"
              />
            </template>
          </VTooltip>
        </div>
        <div class="ai-settings-actions d-flex align-center ga-2 mt-4">
          <VBtn type="submit" color="primary" :disabled="busy" :loading="busy">{{
            t("AI_SAVE_SETTINGS")
          }}</VBtn>
          <VBtn
            v-if="admin"
            type="button"
            prepend-icon="mdi-open-in-new"
            variant="text"
            :disabled="busy"
            :aria-label="t('AI_SETTINGS')"
            @click="emit('plugin-settings')"
            >{{ t("AI_SETTINGS") }}</VBtn
          >
        </div>
      </form>
    </VCardText>
    <ModelManager
      :models="models"
      :user-id="userId"
      :admin="admin"
      @changed="emit('models-changed')"
      @account-changed="emit('account-changed')"
    />
  </VCard>
</template>

<style scoped>
.ai-sidebar-settings {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ai-sidebar-settings > :deep(.v-card-text) {
  flex: 0 0 auto;
  max-height: 50%;
  overflow-y: auto;
}
.ai-sidebar-settings > :deep(.ai-model-manager) {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.ai-send-on-enter-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.ai-send-on-enter-row > :deep(.v-checkbox) {
  flex: 1;
  min-width: 0;
}
</style>
