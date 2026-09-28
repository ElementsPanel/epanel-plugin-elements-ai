<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  VAlert,
  VBtn,
  VCard,
  VCardActions,
  VCardText,
  VCheckbox,
  VDialog,
  VForm,
  VSelect,
  VTextField
} from "vuetify/components";
import { AccountChangedError, deleteModel, saveModel } from "./api";
import type { ModelInput, ModelOption } from "./types";

const props = defineProps<{ models: ModelOption[]; userId: string; admin: boolean }>();
const emit = defineEmits<{ (event: "changed"): void; (event: "account-changed"): void }>();
const { t } = useI18n();
const personal = computed(() => props.models.filter((model) => model.source === "personal"));
const empty = (): ModelInput => ({
  name: "",
  endpoint: "",
  model: "",
  apiKey: "",
  clearApiKey: false,
  thinkingEnabled: null,
  thinkingEffort: "medium"
});
const draft = ref(empty());
const thinkingModes = computed(() => [
  { title: t("AI_THINKING_DEFAULT"), value: null },
  { title: t("AI_THINKING_ON"), value: true },
  { title: t("AI_THINKING_OFF"), value: false }
]);
const thinkingOptions = computed(() => [
  { title: t("AI_THINKING_MEDIUM"), value: "medium" },
  { title: t("AI_THINKING_LOW"), value: "low" },
  { title: t("AI_THINKING_HIGH"), value: "high" }
]);
const editing = ref(false);
const busy = ref(false);
const error = ref("");
const editorError = ref("");
const deleting = ref<string>();
const controller = new AbortController();
const valid = computed(
  () => !!draft.value.name.trim() && !!draft.value.endpoint.trim() && !!draft.value.model.trim()
);
const modelId = (model: ModelOption) => model.id.slice("personal:".length);

function edit(model?: ModelOption) {
  if (busy.value) return;
  error.value = "";
  editorError.value = "";
  deleting.value = undefined;
  draft.value = model
    ? {
        id: modelId(model),
        name: model.name,
        endpoint: model.endpoint || "",
        model: model.model,
        apiKey: "",
        clearApiKey: false,
        thinkingEnabled: model.thinkingEnabled ?? null,
        thinkingEffort: model.thinkingEffort ?? "medium"
      }
    : empty();
  editing.value = true;
}

function clearEditor() {
  if (editing.value) return;
  draft.value = empty();
  editorError.value = "";
}

async function save() {
  if (!editing.value || !valid.value || busy.value) return;
  busy.value = true;
  editorError.value = "";
  try {
    await saveModel({ ...draft.value }, props.userId, controller.signal);
    if (controller.signal.aborted) return;
    editing.value = false;
    emit("changed");
  } catch (cause) {
    if (controller.signal.aborted) return;
    if (cause instanceof AccountChangedError) emit("account-changed");
    else editorError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

async function remove(model: ModelOption) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await deleteModel(modelId(model), props.userId, controller.signal);
    if (controller.signal.aborted) return;
    deleting.value = undefined;
    emit("changed");
  } catch (cause) {
    if (controller.signal.aborted) return;
    if (cause instanceof AccountChangedError) emit("account-changed");
    else error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}
onBeforeUnmount(() => {
  controller.abort();
  draft.value = empty();
});
</script>

<template>
  <VCard :title="t('AI_MY_MODELS')" flat class="ai-model-manager">
    <VCardText>
      <p class="text-body-2 mb-3">{{ t("AI_PERSONAL_HELP") }}</p>
      <VAlert v-if="error" type="error" variant="tonal" class="mb-3" :text="error" />
      <p v-if="!personal.length" class="text-body-2 mb-3">{{ t("AI_NO_PERSONAL_MODELS") }}</p>
      <div v-for="model in personal" :key="model.id" class="ai-model-row">
        <strong class="ai-model-name" :title="model.name">{{ model.name }}</strong>
        <div class="ai-model-actions">
          <VBtn
            type="button"
            icon="mdi-pencil-outline"
            size="small"
            variant="text"
            :disabled="busy"
            :aria-label="t('AI_EDIT_MODEL')"
            @click="edit(model)"
          />
          <VBtn
            type="button"
            icon="mdi-delete-outline"
            size="small"
            variant="text"
            :disabled="busy"
            :aria-label="t('AI_DELETE_MODEL')"
            @click="deleting = model.id"
          />
        </div>
        <div v-if="deleting === model.id" class="ai-model-delete">
          <span>{{ t("AI_DELETE_MODEL_CONFIRM") }}</span>
          <VBtn size="small" color="error" :loading="busy" @click="remove(model)">{{
            t("AI_DELETE_MODEL")
          }}</VBtn>
          <VBtn size="small" :disabled="busy" @click="deleting = undefined">{{
            t("AI_CANCEL")
          }}</VBtn>
        </div>
      </div>
      <VBtn
        type="button"
        prepend-icon="mdi-plus"
        color="primary"
        variant="tonal"
        :disabled="busy"
        class="mt-3"
        @click="edit()"
        >{{ t("AI_ADD_MODEL") }}</VBtn
      >
    </VCardText>
  </VCard>
  <VDialog
    v-model="editing"
    max-width="640"
    scrollable
    :persistent="busy"
    @after-leave="clearEditor"
  >
    <VCard :title="t(draft.id ? 'AI_EDIT_MODEL' : 'AI_ADD_MODEL')" class="ai-model-editor">
      <VForm @submit.stop.prevent="save">
        <VCardText class="ai-model-editor-content">
          <VAlert
            v-if="editorError"
            type="error"
            variant="tonal"
            class="mb-3"
            :text="editorError"
          />
          <VTextField
            v-model="draft.name"
            :label="t('AI_MODEL_LABEL')"
            maxlength="100"
            :disabled="busy"
            variant="solo-filled"
            density="comfortable"
          />
          <VTextField
            v-model="draft.endpoint"
            :label="t('AI_ENDPOINT')"
            maxlength="2048"
            :disabled="busy"
            variant="solo-filled"
            density="comfortable"
            :hint="t(admin ? 'AI_ENDPOINT_HELP' : 'AI_PUBLIC_ENDPOINT')"
            persistent-hint
          />
          <VTextField
            v-model="draft.model"
            :label="t('AI_MODEL')"
            maxlength="200"
            :disabled="busy"
            variant="solo-filled"
            density="comfortable"
          />
          <VTextField
            v-model="draft.apiKey"
            :label="t('AI_API_KEY')"
            type="password"
            autocomplete="new-password"
            maxlength="4096"
            :disabled="busy"
            variant="solo-filled"
            density="comfortable"
            :hint="t('AI_KEY_HELP')"
            persistent-hint
          />
          <VSelect
            v-model="draft.thinkingEnabled"
            :label="t('AI_THINKING_ENABLED')"
            :items="thinkingModes"
            :hint="t('AI_THINKING_ENABLED_HELP')"
            persistent-hint
            :disabled="busy"
            variant="solo-filled"
            density="comfortable"
          />
          <VSelect
            v-if="draft.thinkingEnabled"
            v-model="draft.thinkingEffort"
            :label="t('AI_THINKING_EFFORT')"
            :items="thinkingOptions"
            :hint="t('AI_THINKING_EFFORT_HELP')"
            persistent-hint
            :disabled="busy"
            variant="solo-filled"
            density="comfortable"
          />
          <VCheckbox
            v-if="draft.id"
            v-model="draft.clearApiKey"
            :label="t('AI_CLEAR_KEY')"
            :disabled="busy"
            hide-details
          />
        </VCardText>
        <VCardActions class="justify-end">
          <VBtn type="button" :disabled="busy" @click="editing = false">{{ t("AI_CANCEL") }}</VBtn>
          <VBtn
            type="submit"
            color="primary"
            variant="flat"
            :loading="busy"
            :disabled="!valid || busy"
            >{{ t("AI_SAVE_MODEL") }}</VBtn
          >
        </VCardActions>
      </VForm>
    </VCard>
  </VDialog>
</template>

<style scoped>
.ai-model-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 0;
}
.ai-model-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-model-actions {
  display: flex;
  flex-shrink: 0;
  gap: 4px;
}
.ai-model-editor > :deep(.v-form) {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.ai-model-editor-content {
  /* VForm separates this body from the card, bypassing VDialog's padding rules. */
  padding: 16px 24px 24px 30px;
  overflow-y: auto;
}
.ai-model-delete {
  flex-basis: 100%;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
</style>
