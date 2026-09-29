<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { VBtn } from "vuetify/components";

defineProps<{ title: string; disabled?: boolean }>();
const emit = defineEmits<{ (event: "back"): void }>();
const { t } = useI18n();
</script>

<template>
  <header class="ai-sidebar-page-header">
    <VBtn
      icon="mdi-arrow-left"
      size="small"
      variant="text"
      :title="t('AI_BACK_CHAT')"
      :aria-label="t('AI_BACK_CHAT')"
      :disabled="disabled"
      @click="emit('back')"
    />
    <h2 class="ai-sidebar-page-title">{{ title }}</h2>
    <div class="ai-sidebar-page-actions">
      <slot />
    </div>
  </header>
</template>

<style scoped>
.ai-sidebar-page-header {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  min-height: 60px;
  gap: 8px;
  padding: 10px 16px;
}

.ai-sidebar-page-title {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: rgba(var(--v-theme-on-surface), 0.92);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-sidebar-page-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}
</style>
