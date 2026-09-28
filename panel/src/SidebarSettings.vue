<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import { VAlert, VBtn, VCard, VCardText, VCheckbox } from "vuetify/components";
import { AccountChangedError, savePreferences } from "./api";
import type { ChatPreferences } from "./preferences";
import type { ModelOption } from "./types";
import ModelManager from "./ModelManager.vue";

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
  <VCard :title="t('AI_CHAT_SETTINGS')" flat class="ai-sidebar-settings">
    <template #prepend
      ><VBtn
        icon="mdi-arrow-left"
        variant="text"
        :aria-label="t('AI_BACK_CHAT')"
        :disabled="busy"
        @click="emit('close')"
    /></template>
    <VCardText>
      <p class="text-body-2 mb-4">{{ t("AI_CHAT_SETTINGS_HELP") }}</p>
      <VAlert v-if="error" type="error" variant="tonal" :text="error" class="mb-3" />
      <form @submit.prevent="save">
        <VCheckbox
          v-model="draft.sendOnEnter"
          :label="t('AI_SEND_ON_ENTER')"
          :hint="t('AI_SEND_ON_ENTER_HELP')"
          persistent-hint
          :disabled="busy"
        />
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
  overflow-y: auto;
}
</style>
