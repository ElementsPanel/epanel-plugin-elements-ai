<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import {
  VAlert,
  VBtn,
  VCard,
  VDialog,
  VDivider,
  VIcon,
  VProgressCircular,
  VProgressLinear,
  VSelect,
  VTextarea
} from "vuetify/components";
import {
  AccountChangedError,
  getStatus,
  respondToApproval,
  respondToQuestion,
  sendMessage
} from "./api";
import type {
  AiStatus,
  ChatEvent,
  ChatMessage,
  ConversationDetail,
  DownloadActivity,
  PermissionMode,
  ToolProgress
} from "./types";
import ConversationHistory from "./ConversationHistory.vue";
import FileDiffView from "./FileDiff.vue";
import MarkdownMessage from "./MarkdownMessage.vue";
import SidebarSettings from "./SidebarSettings.vue";
import { defaultPreferences, type ChatPreferences } from "./preferences";
import { CLIENT_CHAT_TIMEOUT_MS } from "./timing";

const props = defineProps<{ state: { open: boolean } }>();
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const status = ref<AiStatus>();
const preferences = computed(() => status.value?.preferences || defaultPreferences());
const selectedModel = ref("");
const permissionMode = ref<PermissionMode>("default");
const permissionOptions = computed(() => [
  { title: t("AI_PERMISSION_DEFAULT"), value: "default" },
  { title: t("AI_PERMISSION_FULL"), value: "full" }
]);
const showingHistory = ref(false);
const showingSettings = ref(false);
const canContinue = ref(true);
const historyModelName = ref("");
const modelOptions = computed(() => {
  const options = (status.value?.models || []).map((model) => ({
    title: model.source === "preset" ? model.name : `${model.name} · ${t("AI_PERSONAL_MODEL")}`,
    value: model.id
  }));
  if (historyModelName.value && !options.some((option) => option.value === selectedModel.value))
    options.push({ title: historyModelName.value, value: selectedModel.value });
  return options;
});
const messages = ref<ChatMessage[]>([]);
const downloads = ref<DownloadActivity[]>([]);
const downloadRemovalTimers = new Map<string, number>();
const downloadsExpanded = ref(false);
const downloadsMultiple = computed(() => downloads.value.length > 1);
const draft = ref("");
const conversationId = ref<string>();
const loading = ref(false);
const approvalSubmitting = ref("");
const questionSubmitting = ref("");
const questionAnswers = ref<Record<string, string>>({});
const waitingForApproval = computed(() =>
  messages.value.some((message) => message.pending && message.approval)
);
const waitingForQuestion = computed(() =>
  messages.value.some((message) => message.pending && message.question)
);
const retry = ref<Extract<ChatEvent, { type: "retry" }>>();
const activeReasoning = computed(() =>
  messages.value.some(
    (message) => message.role === "assistant" && message.reasoning && !message.reasoningComplete
  )
);
const messageReasoning = (message: ChatMessage) =>
  (message.reasoning || "").replace(/\s+/g, " ").trim().slice(-300);
const workingText = computed(() =>
  waitingForQuestion.value
    ? t("AI_WAITING_ANSWER")
    : waitingForApproval.value
    ? t("AI_WAITING_APPROVAL")
    : retry.value
    ? t("AI_RETRYING", {
        attempt: retry.value.attempt,
        maxAttempts: retry.value.maxAttempts,
        seconds: retry.value.delayMs / 1000
      })
    : t("AI_WORKING")
);
const checking = ref(false);
const error = ref("");
const list = ref<HTMLElement>();
const input = ref<InstanceType<typeof VTextarea>>();
let controller: AbortController | undefined;
let statusController: AbortController | undefined;
let generation = 0;
const canSend = computed(
  () =>
    status.value?.ready &&
    status.value.models.some((model) => model.id === selectedModel.value) &&
    canContinue.value &&
    !loading.value &&
    !checking.value &&
    !!draft.value.trim() &&
    draft.value.length <= 4000
);
const toolIcons: Record<string, string> = {
  ask_user: "mdi-comment-question-outline",
  list_mod_game_versions: "mdi-minecraft",
  search_mods: "mdi-puzzle-outline",
  list_mod_versions: "mdi-format-list-bulleted-type",
  list_installed_mods: "mdi-puzzle-check-outline",
  download_mod: "mdi-puzzle-plus-outline",
  download_mod_batch: "mdi-download-multiple",
  get_mod_download_status: "mdi-cloud-check-outline",
  read_terminal: "mdi-console-line",
  execute_node_command: "mdi-console-network-outline",
  list_msl_servers: "mdi-server",
  list_msl_versions: "mdi-format-list-numbered",
  list_msl_builds: "mdi-hammer-wrench",
  get_msl_download: "mdi-link-variant",
  download_msl_server: "mdi-download",
  get_msl_download_status: "mdi-download-network-outline",
  create_msl_instance: "mdi-package-down",
  get_msl_install_status: "mdi-progress-check",
  list_nodes: "mdi-server-network",
  list_instances: "mdi-view-grid-outline",
  get_instance: "mdi-information-outline",
  control_instance: "mdi-power",
  update_instance: "mdi-cog-outline",
  create_instance: "mdi-plus-box-outline",
  list_java_runtimes: "mdi-language-java",
  list_java_versions: "mdi-format-list-numbered",
  download_java: "mdi-download-circle-outline",
  wait_download_task: "mdi-cloud-sync-outline",
  get_java_download_status: "mdi-progress-download",
  configure_java: "mdi-coffee-outline",
  delete_instance_directory: "mdi-folder-remove-outline",
  delete_instance: "mdi-delete-outline",
  delete_instance_completely: "mdi-delete-forever-outline",
  list_files: "mdi-folder-open-outline",
  read_file: "mdi-file-document-outline",
  edit_file: "mdi-file-edit-outline",
  create_file: "mdi-file-plus-outline",
  delete_file: "mdi-file-remove-outline"
};
const knownTool = (name = "") => Object.prototype.hasOwnProperty.call(toolIcons, name);
const toolLabelFor = (name?: string) => (knownTool(name) ? t(`AI_TOOL_${name}`) : name || "");
const toolLabel = (message: ChatMessage) => toolLabelFor(message.tool);
const toolIcon = (message: ChatMessage) =>
  knownTool(message.tool) ? toolIcons[message.tool!] : "mdi-wrench-outline";
const progressValue = (progress?: ToolProgress) => {
  const value = progress?.value;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : undefined;
};
const formatBytes = (value?: number) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "";
  if (value < 1024) return Math.round(value) + " B";
  if (value < 1024 ** 2) return (value / 1024).toFixed(1) + " KiB";
  if (value < 1024 ** 3) return (value / 1024 ** 2).toFixed(1) + " MiB";
  return (value / 1024 ** 3).toFixed(1) + " GiB";
};
const progressText = (progress?: ToolProgress) => {
  if (!progress) return "";
  const parts: string[] = [];
  const value = progressValue(progress);
  if (value !== undefined) parts.push(Math.round(value) + "%");
  if (progress.currentItem && progress.totalItems)
    parts.push(progress.currentItem + "/" + progress.totalItems);
  const downloaded = formatBytes(progress.downloadedBytes);
  const total = formatBytes(progress.totalBytes);
  if (downloaded && total) parts.push(downloaded + " / " + total);
  else if (downloaded) parts.push(downloaded);
  return parts.join(" · ");
};

function cancelDownloadRemoval(id: string) {
  const timer = downloadRemovalTimers.get(id);
  if (timer !== undefined) window.clearTimeout(timer);
  downloadRemovalTimers.delete(id);
}

function removeDownload(id: string) {
  cancelDownloadRemoval(id);
  downloads.value = downloads.value.filter((task) => task.id !== id);
  if (downloads.value.length <= 1) downloadsExpanded.value = false;
}

function scheduleDownloadRemoval(task: DownloadActivity) {
  if (task.state !== "completed") {
    cancelDownloadRemoval(task.id);
    return;
  }
  if (downloadRemovalTimers.has(task.id)) return;
  downloadRemovalTimers.set(
    task.id,
    window.setTimeout(() => removeDownload(task.id), 5_000)
  );
}

function clearDownloads() {
  for (const id of downloadRemovalTimers.keys()) cancelDownloadRemoval(id);
  downloads.value = [];
  downloadsExpanded.value = false;
}

function reset(shouldClearDownloads = false) {
  generation++;
  controller?.abort();
  statusController?.abort();
  messages.value = [];
  if (shouldClearDownloads) clearDownloads();
  conversationId.value = undefined;
  draft.value = "";
  error.value = "";
  loading.value = false;
  approvalSubmitting.value = "";
  questionSubmitting.value = "";
  questionAnswers.value = {};
  retry.value = undefined;
  checking.value = false;
  canContinue.value = true;
  historyModelName.value = "";
}

function newChat() {
  reset();
  showingHistory.value = false;
  showingSettings.value = false;
  selectedModel.value = preferredModel();
  void nextTick(() => input.value?.focus());
}

function preferredModel() {
  const models = status.value?.models || [];
  return models.some((model) => model.id === selectedModel.value)
    ? selectedModel.value
    : models[0]?.id || "";
}

function preferencesChanged(value: ChatPreferences) {
  if (!status.value) return;
  status.value.preferences = value;
}

function accountChanged() {
  clearDownloads();
  newChat();
  status.value = undefined;
  selectedModel.value = "";
  permissionMode.value = "default";
  error.value = t("AI_ACCOUNT_CHANGED");
}

function openConversation(conversation: ConversationDetail) {
  reset();
  selectedModel.value = conversation.modelId;
  historyModelName.value = conversation.modelName;
  conversationId.value = conversation.id;
  messages.value = conversation.messages;
  canContinue.value = conversation.canContinue;
  showingHistory.value = false;
  void scroll();
  void nextTick(() => input.value?.focus());
}

async function scroll() {
  await nextTick();
  list.value?.scrollTo({ top: list.value.scrollHeight, behavior: "smooth" });
}

async function refreshStatus() {
  statusController?.abort();
  const current = new AbortController();
  statusController = current;
  checking.value = true;
  const version = generation;
  try {
    const value = await getStatus(current.signal);
    if (current.signal.aborted || version !== generation) return;
    if (status.value && status.value.userId !== value.userId) accountChanged();
    status.value = value;
    if (!messages.value.length && !conversationId.value) selectedModel.value = preferredModel();
    if (!value.models.some((model) => model.id === selectedModel.value)) {
      if (conversationId.value) canContinue.value = false;
      else {
        selectedModel.value = value.models[0]?.id || "";
        reset();
      }
    }
  } catch (cause) {
    if (current.signal.aborted || version !== generation) return;
    reset(true);
    showingHistory.value = false;
    showingSettings.value = false;
    status.value = undefined;
    error.value =
      cause instanceof AccountChangedError
        ? t("AI_ACCOUNT_CHANGED")
        : cause instanceof Error
        ? cause.message
        : String(cause);
  } finally {
    if (statusController === current) checking.value = false;
  }
}

async function send() {
  if (!canSend.value || !status.value) return;
  const content = draft.value.trim();
  const version = generation;
  const current = new AbortController();
  controller = current;
  loading.value = true;
  retry.value = undefined;
  error.value = "";
  draft.value = "";
  messages.value.push({ role: "user", content });
  void scroll();
  const timeout = window.setTimeout(() => current.abort(), CLIENT_CHAT_TIMEOUT_MS);
  try {
    await sendMessage(
      content,
      conversationId.value,
      selectedModel.value,
      status.value.userId,
      current.signal,
      (event) => {
        if (version !== generation) return;
        if (event.type !== "retry") retry.value = undefined;
        if (event.type === "start") {
          conversationId.value = event.conversationId;
          messages.value = event.messages;
        } else if (event.type === "message") {
          const previousQuestion = messages.value[event.index]?.question;
          messages.value[event.index] = event.message;
          if (previousQuestion && !event.message.question) {
            delete questionAnswers.value[previousQuestion.id];
            if (questionSubmitting.value === previousQuestion.id) questionSubmitting.value = "";
          }
        } else if (event.type === "delta") {
          const message = messages.value[event.index];
          if (message?.role === "assistant") message.content += event.content;
        } else if (event.type === "download") {
          if (event.action === "upsert") {
            const index = downloads.value.findIndex((task) => task.id === event.task.id);
            if (index < 0) {
              downloads.value = [...downloads.value, event.task];
              if (downloads.value.length <= 2) downloadsExpanded.value = false;
            }
            else downloads.value[index] = event.task;
            scheduleDownloadRemoval(event.task);
          } else {
            removeDownload(event.id);
          }
        } else if (event.type === "done") {
          messages.value = messages.value.slice(-160);
        } else if (event.type === "retry") {
          retry.value = event;
        }
        void scroll();
      },
      route.path.startsWith("/instances/terminal") &&
        typeof route.query?.daemonId === "string" &&
        typeof route.query?.instanceId === "string"
        ? { daemonId: route.query.daemonId, instanceUuid: route.query.instanceId }
        : undefined,
      permissionMode.value
    );
  } catch (cause) {
    if (version !== generation) return;
    if (cause instanceof AccountChangedError) {
      accountChanged();
    } else {
      // Do not automatically retry: earlier tools may already have succeeded.
      error.value = current.signal.aborted
        ? t("AI_INTERRUPTED")
        : cause instanceof Error
        ? cause.message
        : String(cause);
      messages.value.push({ role: "error", content: error.value });
    }
  } finally {
    window.clearTimeout(timeout);
    // Approval submissions share this task's lifetime, including a response
    // that arrives after the SSE stream has already finished.
    current.abort();
    if (version === generation) {
      for (const message of messages.value) {
        if (message.role === "tool" && message.pending) {
          message.pending = false;
          delete message.approval;
          if (message.question) delete questionAnswers.value[message.question.id];
          delete message.question;
          message.ok = false;
          message.content = t("AI_CHECK_RESULT");
        }
      }
      loading.value = false;
      approvalSubmitting.value = "";
      questionSubmitting.value = "";
      questionAnswers.value = {};
      retry.value = undefined;
      void scroll();
      void nextTick(() => input.value?.focus());
    }
  }
}

async function decideApproval(message: ChatMessage, approved: boolean) {
  const id = message.approval?.id;
  const current = controller;
  if (
    !id ||
    !loading.value ||
    !status.value ||
    !current ||
    current.signal.aborted ||
    approvalSubmitting.value
  )
    return;
  const version = generation;
  approvalSubmitting.value = id;
  error.value = "";
  try {
    await respondToApproval(id, approved, status.value.userId, current.signal);
  } catch (cause) {
    if (version !== generation || controller !== current || current.signal.aborted) return;
    if (cause instanceof AccountChangedError) accountChanged();
    else error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (version === generation && controller === current && approvalSubmitting.value === id)
      approvalSubmitting.value = "";
  }
}

async function answerQuestion(message: ChatMessage, selected?: string) {
  const id = message.question?.id;
  const answer = (selected ?? (id ? questionAnswers.value[id] : "") ?? "").trim();
  const current = controller;
  if (
    !id ||
    !answer ||
    answer.length > 1000 ||
    !loading.value ||
    !status.value ||
    !current ||
    current.signal.aborted ||
    questionSubmitting.value
  )
    return;
  const version = generation;
  questionSubmitting.value = id;
  error.value = "";
  try {
    await respondToQuestion(id, answer, status.value.userId, current.signal);
  } catch (cause) {
    if (version !== generation || controller !== current || current.signal.aborted) return;
    if (cause instanceof AccountChangedError) accountChanged();
    else error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (version === generation && controller === current && questionSubmitting.value === id)
      questionSubmitting.value = "";
  }
}

function keydown(event: KeyboardEvent) {
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    (preferences.value.sendOnEnter || event.ctrlKey || event.metaKey)
  ) {
    event.preventDefault();
    void send();
  }
}

function settings() {
  if (!status.value?.admin) return;
  props.state.open = false;
  void router.push({ path: "/plugins/config", query: { scope: "panel", plugin: "epanel-plugin-elements-ai" } });
}

function changeModel(value: string) {
  if (loading.value) return;
  selectedModel.value = value;
  if (status.value?.models.some((model) => model.id === value)) canContinue.value = true;
}

async function modelsChanged() {
  reset();
  await refreshStatus();
}

watch(
  () => props.state.open,
  async (open) => {
    if (open) {
      await refreshStatus();
      void scroll();
      void nextTick(() => input.value?.focus());
    }
  }
);
watch(
  () => route.path,
  (path) => {
    if (path === "/login" || path.startsWith("/sso")) {
      props.state.open = false;
      reset(true);
      status.value = undefined;
      selectedModel.value = "";
      permissionMode.value = "default";
      showingHistory.value = false;
      showingSettings.value = false;
    }
  }
);
onBeforeUnmount(() => reset(true));
</script>

<template>
  <VDialog
    v-model="state.open"
    class="ai-drawer"
    max-width="480"
    transition="slide-x-reverse-transition"
    :aria-label="t('AI_TITLE')"
  >
    <VCard id="epanel-plugin-elements-ai-sidebar" :title="t('AI_TITLE')" class="ai-card" rounded="0">
      <template #append>
        <VBtn
          icon="mdi-chat-plus-outline"
          size="small"
          variant="text"
          :disabled="loading"
          :title="t('AI_NEW_CHAT')"
          :aria-label="t('AI_NEW_CHAT')"
          @click="newChat"
        />
        <VBtn
          icon="mdi-history"
          size="small"
          variant="text"
          :disabled="loading || checking || !status"
          :title="t('AI_HISTORY')"
          :aria-label="t('AI_HISTORY')"
          :aria-pressed="showingHistory"
          @click="
            showingHistory = !showingHistory;
            showingSettings = false;
          "
        />
        <VBtn
          icon="mdi-cog-outline"
          size="small"
          variant="text"
          :disabled="loading || checking || !status"
          :title="t('AI_CHAT_SETTINGS')"
          :aria-label="t('AI_CHAT_SETTINGS')"
          :aria-pressed="showingSettings"
          @click="
            showingSettings = !showingSettings;
            showingHistory = false;
          "
        />
        <VBtn
          icon="mdi-close"
          size="small"
          variant="text"
          :title="t('AI_CLOSE')"
          :aria-label="t('AI_CLOSE')"
          @click="state.open = false"
        />
      </template>
      <VDivider />
      <SidebarSettings
        v-if="showingSettings && status"
        :key="status.userId"
        :user-id="status.userId"
        :admin="status.admin"
        :models="status.models"
        :preferences="preferences"
        @saved="preferencesChanged"
        @models-changed="modelsChanged"
        @close="showingSettings = false"
        @plugin-settings="settings"
        @account-changed="accountChanged"
      />
      <ConversationHistory
        v-else-if="showingHistory && status"
        :key="status.userId"
        :user-id="status.userId"
        :current-id="conversationId"
        @open="openConversation"
        @close="showingHistory = false"
        @account-changed="accountChanged"
      />
      <template v-else>
        <div
          ref="list"
          class="ai-messages"
          role="log"
          aria-live="polite"
          :aria-label="t('AI_MESSAGES')"
          :aria-busy="loading"
        >
          <div v-if="!messages.length" class="ai-empty">
            <VIcon class="ai-welcome-icon" icon="mdi-creation" size="76" />
            <h2>{{ t("AI_WELCOME_TITLE") }}</h2>
            <p>{{ t("AI_WELCOME") }}</p>
          </div>
          <article
            v-for="(message, index) in messages"
            :key="index"
            class="ai-message"
            :class="`ai-message--${message.role}`"
          >
            <template v-if="message.role === 'tool'">
              <details class="ai-tool">
                <summary :aria-busy="message.pending || undefined">
                  <span class="ai-tool-icon">
                    <VProgressCircular
                      v-if="message.pending"
                      indeterminate
                      :size="18"
                      :width="2"
                      :aria-label="t('AI_TOOL_RUNNING')"
                    />
                    <VIcon v-else :icon="toolIcon(message)" size="18" />
                  </span>
                  <span
                    class="ai-tool-name"
                    :class="{ 'ai-tool-name--failed': !message.pending && message.ok === false }"
                  >
                    {{ toolLabel(message) }}
                  </span>
                </summary>
                <pre v-if="message.content">{{ message.content }}</pre>
              </details>
              <div v-if="loading && message.pending && message.approval" class="ai-approval">
                <p>{{ t("AI_APPROVAL_REQUIRED") }}</p>
                <pre>{{ message.approval.arguments }}</pre>
                <div class="ai-approval-actions">
                  <VBtn
                    size="small"
                    variant="text"
                    :disabled="!!approvalSubmitting"
                    @click="decideApproval(message, false)"
                  >
                    {{ t("AI_DENY") }}
                  </VBtn>
                  <VBtn
                    size="small"
                    variant="tonal"
                    color="primary"
                    :disabled="!!approvalSubmitting"
                    @click="decideApproval(message, true)"
                  >
                    {{ t("AI_APPROVE_ONCE") }}
                  </VBtn>
                </div>
              </div>
              <div v-if="loading && message.pending && message.question" class="ai-question">
                <p>{{ message.question.question }}</p>
                <div class="ai-question-options">
                  <VBtn
                    v-for="option in message.question.options"
                    :key="option"
                    size="small"
                    variant="tonal"
                    :disabled="!!questionSubmitting"
                    @click="answerQuestion(message, option)"
                  >
                    {{ option }}
                  </VBtn>
                </div>
                <VTextarea
                  v-model="questionAnswers[message.question.id]"
                  class="ai-question-custom"
                  :label="t('AI_CUSTOM_ANSWER')"
                  :disabled="!!questionSubmitting"
                  :maxlength="1000"
                  rows="2"
                  auto-grow
                  hide-details
                />
                <div class="ai-question-actions">
                  <VBtn
                    size="small"
                    variant="text"
                    color="primary"
                    :disabled="
                      !!questionSubmitting || !questionAnswers[message.question.id]?.trim()
                    "
                    @click="answerQuestion(message)"
                  >
                    {{ t("AI_SUBMIT_ANSWER") }}
                  </VBtn>
                </div>
              </div>
              <FileDiffView
                v-if="
                  message.tool === 'edit_file' && message.ok && !message.pending && message.diff
                "
                :diff="message.diff"
              />
            </template>
            <template v-else>
              <span v-if="message.role !== 'user'" class="ai-role">{{
                t(message.role === "error" ? "AI_FAILED" : "AI_TITLE")
              }}</span>
              <div
                v-if="message.role === 'assistant' && messageReasoning(message)"
                class="ai-message-thinking"
                role="status"
              >
                <span class="ai-thinking-label">{{
                  t(
                    message.reasoningComplete
                      ? "AI_THINKING_COMPLETE_PREFIX"
                      : "AI_THINKING_PREFIX"
                  )
                }}</span>
                <span class="ai-thinking-content">{{ messageReasoning(message) }}</span>
              </div>
              <MarkdownMessage
                v-if="message.role !== 'error'"
                class="ai-text"
                :content="message.content"
              />
              <div v-else class="ai-text">{{ message.content }}</div>
              <div v-if="message.role === 'assistant' && message.workComplete" class="ai-work-complete">
                {{ t("AI_WORK_COMPLETE") }}
              </div>
            </template>
          </article>
          <div v-if="loading && !activeReasoning" class="ai-working" role="status">
            <span>{{ workingText }}</span>
            <span class="ai-working-shimmer" aria-hidden="true">{{ workingText }}</span>
          </div>
        </div>
        <Transition name="ai-download-panel">
          <div
            v-if="downloads.length"
            class="ai-downloads"
            :class="{ 'ai-downloads--multiple': downloadsMultiple }"
            role="status"
            aria-live="polite"
          >
            <button
              v-if="downloadsMultiple"
              class="ai-download-toggle"
              type="button"
              :aria-expanded="downloadsExpanded"
              :aria-label="t('AI_DOWNLOAD_TOGGLE')"
              :title="t('AI_DOWNLOAD_TOGGLE')"
              @click="downloadsExpanded = !downloadsExpanded"
            >
              <span class="ai-download-summary">
                <VIcon icon="mdi-download-multiple" size="17" />
                <span>{{ t("AI_DOWNLOAD_TASKS", { count: downloads.length }) }}</span>
              </span>
              <VIcon :icon="downloadsExpanded ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="18" />
            </button>
            <Transition name="ai-download-list">
              <TransitionGroup
                v-if="!downloadsMultiple || downloadsExpanded"
                name="ai-download-task"
                tag="div"
                class="ai-download-list"
              >
                <div v-for="task in downloads" :key="task.id" class="ai-download-task">
                  <div class="ai-download-head">
                    <span class="ai-download-name">
                      <VIcon
                        :icon="knownTool(task.tool) ? toolIcons[task.tool] : 'mdi-download-outline'"
                        size="17"
                      />
                      <span>{{ toolLabelFor(task.tool) }}</span>
                    </span>
                    <span class="ai-download-detail">{{ progressText(task.progress) || "0%" }}</span>
                  </div>
                  <VProgressLinear
                    :model-value="progressValue(task.progress) ?? 0"
                    color="primary"
                    height="5"
                    rounded
                  />
                </div>
              </TransitionGroup>
            </Transition>
          </div>
        </Transition>
        <form class="ai-composer" @submit.prevent="send">
          <VAlert
            v-if="!canContinue"
            type="info"
            variant="tonal"
            density="compact"
            class="mb-3"
            :text="t('AI_HISTORY_READ_ONLY')"
          />
          <VAlert
            v-if="!checking && !status?.ready"
            type="info"
            variant="tonal"
            density="compact"
            class="mb-3"
            :text="t('AI_NO_MODELS')"
          />
          <VAlert
            v-if="error"
            type="error"
            variant="tonal"
            density="compact"
            class="mb-3"
            :text="error"
          />
          <div class="ai-input-box rounded-xl">
            <VTextarea
              ref="input"
              v-model="draft"
              class="ai-input"
              :placeholder="t('AI_INPUT')"
              :aria-label="t('AI_INPUT')"
              :disabled="loading || checking || !status?.ready || !canContinue"
              variant="plain"
              rows="3"
              max-rows="6"
              auto-grow
              no-resize
              hide-details
              maxlength="4000"
              @keydown="keydown"
            />
            <small v-if="draft.length" class="ai-character-count">
              {{ draft.length }} / 4000
            </small>
            <div class="ai-composer-toolbar">
              <div class="ai-model-picker">
                <VSelect
                  v-model="permissionMode"
                  class="ai-permission-picker"
                  :items="permissionOptions"
                  :aria-label="t('AI_PERMISSION_MODE')"
                  :disabled="loading || checking"
                  :menu-props="{ location: 'top start' }"
                  :prepend-inner-icon="
                    permissionMode === 'full'
                      ? 'mdi-shield-off-outline'
                      : 'mdi-shield-check-outline'
                  "
                  density="compact"
                  variant="plain"
                  single-line
                  hide-details
                >
                  <template #selection="{ item }">
                    <span class="ai-model-name" :title="item.title">{{ item.title }}</span>
                  </template>
                </VSelect>
                <VSelect
                  :model-value="selectedModel"
                  :items="modelOptions"
                  :placeholder="t('AI_SELECT_MODEL')"
                  :aria-label="t('AI_SELECT_MODEL')"
                  :disabled="loading || checking || !status?.models.length"
                  :menu-props="{ location: 'top start', maxHeight: 300 }"
                  prepend-inner-icon="mdi-cube-outline"
                  density="compact"
                  variant="plain"
                  single-line
                  hide-details
                  @update:model-value="changeModel"
                >
                  <template #selection="{ item }">
                    <span class="ai-model-name" :title="item.title">{{ item.title }}</span>
                  </template>
                </VSelect>
              </div>
              <VBtn
                v-if="loading"
                icon="mdi-stop"
                size="x-small"
                variant="tonal"
                color="primary"
                :title="t('AI_STOP_REPLY')"
                :aria-label="t('AI_STOP_REPLY')"
                @click="controller?.abort()"
              />
              <VBtn
                v-else
                type="submit"
                icon="mdi-arrow-up"
                size="x-small"
                variant="flat"
                color="primary"
                :title="t('AI_SEND')"
                :aria-label="t('AI_SEND')"
                :disabled="!canSend"
              />
            </div>
          </div>
        </form>
      </template>
    </VCard>
  </VDialog>
</template>

<style scoped>
.ai-drawer :deep(.v-overlay__content) {
  right: 0;
  margin: 0 !important;
  width: min(480px, 100vw) !important;
  max-width: 100vw !important;
  height: 100dvh;
  max-height: 100dvh !important;
  border-top-right-radius: 0 !important;
  border-bottom-right-radius: 0 !important;
}
.ai-card {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-top-right-radius: 0 !important;
  border-bottom-right-radius: 0 !important;
}
.ai-card > :deep(.v-card-item) {
  flex: 0 0 auto;
  min-height: 60px;
  padding: 10px 16px;
}
.ai-card > :deep(.v-card-item .v-card-title) {
  font-size: 15px;
  font-weight: 600;
}
.ai-downloads {
  flex: 0 0 auto;
  display: grid;
  gap: 8px;
  padding: 10px 20px;
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.ai-downloads--multiple {
  margin: 8px 20px 0;
  padding: 8px 10px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 8px;
  background: rgba(var(--v-theme-surface-variant), 0.18);
}
.ai-download-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: 30px;
  padding: 3px 2px;
  border: 0;
  color: rgba(var(--v-theme-on-surface), 0.82);
  background: transparent;
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.ai-download-toggle:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}
.ai-download-summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
}
.ai-download-list {
  display: grid;
  gap: 8px;
}
.ai-download-list-enter-active,
.ai-download-list-leave-active {
  transition: opacity 180ms ease, max-height 180ms ease;
  max-height: 400px;
  overflow: hidden;
}
.ai-download-list-enter-from,
.ai-download-list-leave-to {
  max-height: 0;
  opacity: 0;
}
.ai-download-task {
  display: grid;
  gap: 4px;
  padding: 8px 10px 10px;
  border-radius: 8px;
  background: rgba(var(--v-theme-primary), 0.08);
}
.ai-download-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
  color: rgba(var(--v-theme-on-surface), 0.82);
  font-size: 12px;
}
.ai-download-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-weight: 600;
}
.ai-download-name > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-download-detail {
  flex: 0 0 auto;
  color: rgba(var(--v-theme-on-surface), 0.62);
  white-space: nowrap;
}
.ai-download-panel-enter-active,
.ai-download-panel-leave-active {
  transition: opacity 180ms ease, transform 180ms ease;
}
.ai-download-panel-enter-from,
.ai-download-panel-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
.ai-download-task-enter-active,
.ai-download-task-leave-active {
  transition: opacity 180ms ease, transform 180ms ease, max-height 180ms ease;
  max-height: 100px;
  overflow: hidden;
}
.ai-download-task-enter-from,
.ai-download-task-leave-to {
  max-height: 0;
  opacity: 0;
  transform: translateY(-5px);
}
.ai-download-task-move {
  transition: transform 180ms ease;
}
.ai-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 20px;
  scrollbar-width: thin;
}
.ai-empty {
  display: flex;
  align-items: center;
  flex-direction: column;
  padding: clamp(20px, 7dvh, 72px) 4px 24px;
  text-align: center;
}
.ai-welcome-icon {
  margin-bottom: 28px;
  color: rgba(var(--v-theme-on-surface), 0.65);
}
.ai-empty h2 {
  font-size: clamp(22px, 5vw, 28px);
  font-weight: 600;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.ai-empty p {
  max-width: 320px;
  margin: 12px 0 28px;
  font-size: 13px;
  line-height: 1.7;
  color: rgba(var(--v-theme-on-surface), 0.6);
}
.ai-message {
  margin-bottom: 24px;
}
.ai-message--tool {
  margin-bottom: 6px;
}
.ai-message:not(.ai-message--tool):has(+ .ai-message--tool) {
  margin-bottom: 8px;
}
.ai-role {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
  opacity: 0.65;
}
.ai-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.65;
  padding: 12px;
  border-radius: 12px;
  font-size: 14px;
}
.ai-text.ai-markdown {
  white-space: normal;
}
.ai-message--user {
  margin-left: 24px;
}
.ai-message--user .ai-text {
  background: rgba(var(--v-theme-on-surface), 0.06);
}
.ai-message--assistant {
  margin-right: 8px;
}
.ai-message--assistant .ai-text {
  padding: 4px 0;
}
.ai-message--error .ai-text {
  color: rgb(var(--v-theme-error));
}
.ai-tool {
  border: 0;
  background: none;
  padding: 1px 0;
  font-size: 14px;
  line-height: 1.65;
}
.ai-tool summary {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  list-style: none;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.ai-tool summary::-webkit-details-marker {
  display: none;
}
.ai-tool-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 18px;
  width: 18px;
  height: 18px;
  margin-top: 3px;
}
.ai-tool-name--failed {
  color: rgb(var(--v-theme-error));
}
.ai-tool summary:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 3px;
}
.ai-tool pre,
.ai-approval pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 220px;
  overflow-y: auto;
  margin: 4px 0 0 26px;
  border: 0;
  background: none;
  font-size: 12px;
}
.ai-approval,
.ai-question {
  margin: 8px 0 8px 26px;
  font-size: 13px;
}
.ai-approval p,
.ai-question p {
  margin: 0 0 6px;
}
.ai-approval pre {
  margin-left: 0;
}
.ai-approval-actions {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
  margin-top: 8px;
}
.ai-question-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.ai-question-custom {
  margin-top: 2px;
}
.ai-question-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 4px;
}
.ai-working {
  position: relative;
  display: flex;
  width: fit-content;
  max-width: 100%;
  margin: 6px 0 0;
  text-align: left;
  font-size: 13px;
  font-weight: 500;
  color: rgba(var(--v-theme-on-surface), 0.65);
}
.ai-message-thinking {
  display: flex;
  max-width: 100%;
  margin: 2px 0 6px;
  color: rgba(var(--v-theme-on-surface), 0.65);
  font-size: 13px;
  font-weight: 500;
}
.ai-thinking-label {
  flex: none;
  margin-right: 4px;
}
.ai-thinking-content {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-work-complete {
  width: fit-content;
  margin: 6px 0 0;
  color: rgb(var(--v-theme-success));
  font-size: 13px;
  font-weight: 500;
}
.ai-working-shimmer {
  display: none;
}
@supports (background-clip: text) or (-webkit-background-clip: text) {
  .ai-working-shimmer {
    position: absolute;
    inset: 0;
    display: block;
    pointer-events: none;
    color: transparent;
    background-image: linear-gradient(
      110deg,
      transparent 40%,
      rgb(var(--v-theme-on-surface)) 50%,
      transparent 60%
    );
    background-size: 250% 100%;
    background-repeat: no-repeat;
    background-clip: text;
    -webkit-background-clip: text;
    animation: ai-working-shimmer 2s linear infinite;
  }
}
@keyframes ai-working-shimmer {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: 0% 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .ai-working-shimmer {
    display: none;
    animation: none;
  }
}
.ai-composer {
  flex-shrink: 0;
  max-height: 60%;
  overflow-y: auto;
  padding: 12px 16px max(12px, env(safe-area-inset-bottom));
}
.ai-input-box {
  position: relative;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.18);
  background: rgba(var(--v-theme-on-surface), 0.035);
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.ai-input-box:focus-within {
  border-color: rgba(var(--v-theme-primary), 0.75);
  box-shadow: 0 0 0 2px rgba(var(--v-theme-primary), 0.1);
}
.ai-input :deep(.v-field) {
  --v-field-padding-top: 12px;
  --v-field-padding-bottom: 6px;
  --v-field-padding-start: 14px;
  --v-field-padding-end: 14px;
  --v-input-padding-top: 0px;
}
.ai-input :deep(textarea) {
  font-size: 14px;
  line-height: 1.6;
  padding-bottom: 24px;
}
.ai-composer-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 8px;
}
.ai-model-picker {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  gap: 2px;
}
.ai-model-picker :deep(.v-select) {
  flex: 1;
  min-width: 0;
  --v-input-control-height: 32px;
  --v-input-padding-top: 0px;
}
.ai-model-picker :deep(.ai-permission-picker) {
  flex: 0 1 150px;
}
.ai-model-picker :deep(.v-field) {
  align-items: center;
  padding: 0 6px;
  font-size: 12px;
}
.ai-model-picker :deep(.v-field__input) {
  min-height: 32px;
  padding-top: 0;
  padding-bottom: 0;
  flex-wrap: nowrap;
}
.ai-model-picker :deep(.v-select__selection) {
  min-width: 0;
  max-width: 100%;
}
.ai-model-picker :deep(.v-icon) {
  font-size: 18px;
}
.ai-model-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ai-composer-toolbar :deep(.v-btn) {
  flex-shrink: 0;
}
.ai-character-count {
  position: absolute;
  right: 12px;
  bottom: 44px;
  z-index: 1;
  font-size: 11px;
  line-height: 1.5;
  color: rgba(var(--v-theme-on-surface), 0.5);
  text-align: right;
  white-space: nowrap;
  pointer-events: none;
}
@media (max-width: 360px) {
  .ai-card > :deep(.v-card-item) {
    padding-inline: 10px;
  }
  .ai-messages {
    padding: 16px 12px;
  }
  .ai-composer {
    padding-inline: 10px;
  }
}
</style>
