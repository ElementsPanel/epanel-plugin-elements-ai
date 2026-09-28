<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { VBtn, VTooltip } from "vuetify/components";
defineProps<{ state: { open: boolean } }>();
const { t } = useI18n();
</script>

<template>
  <VTooltip :text="t('AI_TITLE')" location="bottom">
    <template #activator="{ props: tooltipProps }">
      <VBtn
        v-bind="tooltipProps"
        icon="mdi-creation"
        variant="text"
        :aria-label="t('AI_TITLE')"
        :aria-expanded="state.open"
        aria-controls="epanel-plugin-elements-ai-sidebar"
        @click="state.open = !state.open"
      />
    </template>
  </VTooltip>
</template>
