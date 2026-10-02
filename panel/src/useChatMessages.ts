import { computed, nextTick, onBeforeUnmount, ref, watch, type Ref } from "vue";
import type { ChatMessage } from "./types";

const PAGE_SIZE = 40;
const BOTTOM_THRESHOLD = 48;
const HISTORY_THRESHOLD = 120;

export function useChatMessages(messages: Ref<ChatMessage[]>, isOpen: () => boolean) {
  const list = ref<HTMLElement>();
  const content = ref<HTMLElement>();
  const start = ref(0);
  const visibleMessages = computed(() => messages.value.slice(start.value).map((message, offset) => ({
    message, index: start.value + offset
  })));
  const showScrollBottom = ref(false);
  let following = true;
  let frame: number | undefined;
  let lastTop = 0;
  let lastHeight = 0;
  let restoring = false;
  let revision = 0;
  let touchY: number | undefined;

  function rememberPosition() {
    lastTop = list.value?.scrollTop || 0;
    lastHeight = list.value?.scrollHeight || 0;
  }

  function cancelScroll() {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
  }

  function recentMessages() {
    start.value = Math.max(0, messages.value.length - PAGE_SIZE);
  }

  function scroll(force = false) {
    if (!isOpen()) return;
    if (force) {
      revision++;
      restoring = false;
      following = true;
      showScrollBottom.value = false;
      recentMessages();
    }
    if (!following || frame !== undefined) return;
    frame = window.requestAnimationFrame(() => {
      frame = undefined;
      if (!isOpen() || !following || !list.value) return;
      list.value.scrollTo({ top: list.value.scrollHeight, behavior: "auto" });
      rememberPosition();
      showScrollBottom.value = false;
    });
  }

  function pauseFollowing() {
    following = false;
    showScrollBottom.value = true;
    cancelScroll();
  }

  async function loadOlder() {
    const element = list.value;
    if (!element || following || restoring || start.value === 0 || element.scrollTop > HISTORY_THRESHOLD)
      return;
    const version = revision;
    // Anchor a visible row, so simultaneous streaming below it does not move
    // the reader when older messages are inserted above it.
    const top = element.getBoundingClientRect().top;
    const anchor = Array.from(element.querySelectorAll<HTMLElement>("[data-message-index]"))
      .find((row) => row.getBoundingClientRect().bottom > top);
    const offset = anchor?.getBoundingClientRect().top;
    const height = element.scrollHeight;
    restoring = true;
    start.value = Math.max(0, start.value - PAGE_SIZE);
    await nextTick();
    if (version !== revision || list.value !== element) return;
    element.scrollTop += anchor && offset !== undefined
      ? anchor.getBoundingClientRect().top - offset
      : element.scrollHeight - height;
    rememberPosition();
    restoring = false;
  }

  function listScrolled() {
    const element = list.value;
    if (!element || restoring) return;
    const movedUp = element.scrollTop < lastTop;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD;
    if (nearBottom) {
      following = true;
      showScrollBottom.value = false;
      recentMessages();
    } else if (movedUp && element.scrollHeight === lastHeight) {
      // Scrollbar/keyboard scrolling changes the offset. Growing content can
      // change the distance from the bottom without expressing user intent.
      pauseFollowing();
    }
    rememberPosition();
    if (following) scroll();
    else if (movedUp) void loadOlder();
  }

  function listWheel(event: WheelEvent) {
    if (event.deltaY < 0) {
      pauseFollowing();
      void loadOlder();
    }
  }

  function listPointerDown(event: PointerEvent) {
    // Native scrollbar drags must also pause during simultaneous layout changes.
    if (event.target === list.value) pauseFollowing();
  }

  function listKeydown(event: KeyboardEvent) {
    if (event.target !== list.value) return;
    if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) {
      pauseFollowing();
      void loadOlder();
    }
  }

  function listTouchStart(event: TouchEvent) {
    touchY = event.touches[0]?.clientY;
  }

  function listTouchMove(event: TouchEvent) {
    const y = event.touches[0]?.clientY;
    if (y !== undefined && touchY !== undefined && y > touchY) {
      pauseFollowing();
      void loadOlder();
    }
    touchY = y;
  }

  function resetMessages() {
    revision++;
    restoring = false;
    following = true;
    showScrollBottom.value = false;
    touchY = undefined;
    recentMessages();
    rememberPosition();
    cancelScroll();
  }

  watch(() => messages.value.length, () => {
    if (following) recentMessages();
    else start.value = Math.min(start.value, Math.max(0, messages.value.length - 1));
    scroll();
  }, { flush: "pre" });

  watch([list, content], ([element, body], _previous, onCleanup) => {
    rememberPosition();
    if (!element || !body) return;
    // Markdown, images, expanded tools and the composer can resize after an
    // SSE event has already scheduled its scroll.
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => scroll());
      observer.observe(element);
      observer.observe(body);
      onCleanup(() => observer.disconnect());
    }
    scroll();
  }, { flush: "post" });

  onBeforeUnmount(() => { revision++; cancelScroll(); });
  return {
    list, content, visibleMessages, showScrollBottom, scroll, cancelScroll, resetMessages,
    listScrolled, listWheel, listPointerDown, listKeydown, listTouchStart, listTouchMove
  };
}
