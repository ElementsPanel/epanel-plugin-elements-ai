import type { PanelFrontendPluginContext } from "@elements-panel/sdk";
import { reactive } from "vue";
import AiButton from "./AiButton.vue";
import AiSidebar from "./AiSidebar.vue";
import { localeMessages } from "./i18n";

export const inject = ["console", "i18n", "slots", "user"];

export function apply(ctx: PanelFrontendPluginContext) {
  ctx.i18n.define(localeMessages);
  const state = reactive({ open: false });
  ctx.slots.register("shell.header.actions", AiButton, {
    id: "epanel-plugin-elements-ai:button",
    order: 20,
    props: { state }
  });
  ctx.slots.register("shell.overlay", AiSidebar, { id: "epanel-plugin-elements-ai:sidebar", props: { state } });
}
