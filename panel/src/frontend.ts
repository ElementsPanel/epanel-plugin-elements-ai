import type { PanelFrontendPluginContext } from "@elements-panel/sdk";
import { reactive } from "vue";
import AiSidebar from "./AiSidebar.vue";
import { localeMessages } from "./i18n";

export const inject = ["console", "i18n", "slots", "user"];

export function apply(ctx: PanelFrontendPluginContext) {
  ctx.i18n.define(localeMessages);
  const state = reactive({ open: false });
  ctx.slots.register(
    "shell.header.actions",
    {
      title: () => ctx.i18n.translate("AI_TITLE"),
      mdiIcon: "mdi-creation",
      ariaControls: "epanel-plugin-elements-ai-sidebar",
      expanded: () => state.open,
      click: () => {
        state.open = !state.open;
      }
    },
    { id: "epanel-plugin-elements-ai:button", order: 20 }
  );
  ctx.slots.register("shell.overlay", AiSidebar, { id: "epanel-plugin-elements-ai:sidebar", props: { state } });
}
