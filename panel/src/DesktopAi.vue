<script setup lang="ts">
import { reactive, watch } from "vue";
import AiSidebar from "./AiSidebar.vue";

const emit = defineEmits<{ (event: "close"): void }>();
const state = reactive({ open: true });
watch(() => state.open, (open) => {
  if (!open) emit("close");
});
</script>

<template>
  <AiSidebar :state="state" desktop />
</template>
