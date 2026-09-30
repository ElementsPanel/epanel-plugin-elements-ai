<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

const props = defineProps<{ content: string; streaming?: boolean }>();
const emit = defineEmits<{ (event: "rendered"): void }>();
const renderedContent = ref(props.content);
let timer: ReturnType<typeof setTimeout> | undefined;

function cancelPending() {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
}

function renderStreaming() {
  renderedContent.value = props.content;
  timer = setTimeout(() => {
    timer = undefined;
    if (renderedContent.value !== props.content) renderStreaming();
  }, 80);
}

watch([() => props.content, () => props.streaming], () => {
  // Short answers stay immediate. Long, unfinished answers must not repeatedly
  // parse and sanitize the entire document at the provider's token rate.
  if (!props.streaming || props.content.length < 2000) {
    cancelPending();
    renderedContent.value = props.content;
  } else if (timer === undefined) renderStreaming();
});
onBeforeUnmount(cancelPending);
const renderer = new marked.Renderer();
// Literal HTML stays visible as text; only Markdown creates markup.
renderer.html = (html) => html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const html = computed(() =>
  sanitizeHtml(
    marked.parse(renderedContent.value, {
      renderer,
      gfm: true,
      breaks: true,
      mangle: false,
      headerIds: false
    }),
    {
      allowedTags: [
        "p",
        "br",
        "hr",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "strong",
        "em",
        "del",
        "ul",
        "ol",
        "li",
        "blockquote",
        "pre",
        "code",
        "a",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
        "img"
      ],
      allowedAttributes: {
        a: ["href", "title", "target", "rel"],
        code: ["class"],
        ol: ["start"],
        th: ["align"],
        td: ["align"],
        img: ["src", "alt", "title", "loading", "referrerpolicy"]
      },
      allowedClasses: { code: [/^language-[\w-]+$/] },
      allowedSchemes: ["http", "https", "mailto"],
      allowedSchemesByTag: { img: ["http", "https"] },
      allowProtocolRelative: false,
      transformTags: {
        a: (tagName: string, attributes: Record<string, string>) => ({
          tagName,
          attribs: { ...attributes, target: "_blank", rel: "noopener noreferrer" }
        }),
        img: (tagName: string, attributes: Record<string, string>) => ({
          tagName,
          attribs: { ...attributes, loading: "lazy", referrerpolicy: "no-referrer" }
        })
      }
    }
  )
);
watch(html, () => emit("rendered"), { flush: "post" });
</script>

<template>
  <!-- HTML is escaped by the Markdown renderer and sanitized before insertion. -->
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="ai-markdown" v-html="html" />
</template>

<style scoped>
.ai-markdown {
  overflow-wrap: anywhere;
  line-height: 1.65;
  white-space: normal;
}
.ai-markdown :deep(> :first-child) {
  margin-top: 0;
}
.ai-markdown :deep(> :last-child) {
  margin-bottom: 0;
}
.ai-markdown :deep(p),
.ai-markdown :deep(ul),
.ai-markdown :deep(ol),
.ai-markdown :deep(blockquote),
.ai-markdown :deep(pre),
.ai-markdown :deep(table) {
  margin: 0.65em 0;
}
.ai-markdown :deep(h1),
.ai-markdown :deep(h2),
.ai-markdown :deep(h3),
.ai-markdown :deep(h4),
.ai-markdown :deep(h5),
.ai-markdown :deep(h6) {
  font-size: 1.1em;
  margin: 0.9em 0 0.4em;
  line-height: 1.4;
}
.ai-markdown :deep(h1) {
  font-size: 1.35em;
}
.ai-markdown :deep(h2) {
  font-size: 1.2em;
}
.ai-markdown :deep(ul),
.ai-markdown :deep(ol) {
  padding-left: 1.6em;
}
.ai-markdown :deep(blockquote) {
  padding-left: 12px;
  border-left: 3px solid rgba(var(--v-theme-on-surface), 0.25);
  opacity: 0.8;
}
.ai-markdown :deep(code) {
  font-family: monospace;
  background: rgba(var(--v-theme-on-surface), 0.07);
  border-radius: 4px;
  padding: 1px 4px;
}
.ai-markdown :deep(pre) {
  max-width: 100%;
  overflow: auto;
  padding: 12px;
  border-radius: 8px;
  background: rgba(var(--v-theme-on-surface), 0.06);
}
.ai-markdown :deep(pre code) {
  padding: 0;
  background: none;
  white-space: pre;
}
.ai-markdown :deep(table) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
}
.ai-markdown :deep(th),
.ai-markdown :deep(td) {
  padding: 6px 10px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.18);
}
.ai-markdown :deep(a) {
  color: rgb(var(--v-theme-primary));
}
.ai-markdown :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 6px;
}
.ai-markdown :deep(hr) {
  border: 0;
  border-top: 1px solid rgba(var(--v-theme-on-surface), 0.18);
  margin: 12px 0;
}
</style>
