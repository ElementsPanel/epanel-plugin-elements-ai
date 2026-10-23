import type { PanelFrontendPluginContext } from "@elements-panel/sdk";
import { reactive } from "vue";
import AiSidebar from "./AiSidebar.vue";
import DesktopAi from "./DesktopAi.vue";
import { localeMessages } from "./i18n";

export const inject = ["console", "i18n", "slots", "user", "desktop"];

export function apply(ctx: PanelFrontendPluginContext) {
  ctx.i18n.define(localeMessages);
  const state = reactive({ open: false });
  ctx.desktop.view({
    id: "epanel-plugin-elements-ai:chat",
    title: () => ctx.i18n.translate("AI_TITLE"),
    icon: "mdi-creation",
    component: DesktopAi,
    initialWidth: 560,
    initialHeight: 700
  });
  ctx.slots.register(
    "shell.header.actions",
    {
      title: () => ctx.i18n.translate("AI_TITLE"),
      mdiIcon: "mdi-creation",
      ariaControls: "epanel-plugin-elements-ai-sidebar",
      expanded: () => state.open,
      click: () => {
        state.open = !state.open;
      },
      desktopClick: () => {
        state.open = false;
        ctx.desktop.open({
          id: "epanel-plugin-elements-ai:chat",
          view: "epanel-plugin-elements-ai:chat"
        });
      }
    },
    { id: "epanel-plugin-elements-ai:button", order: 20 }
  );
  ctx.slots.register("shell.overlay", AiSidebar, { id: "epanel-plugin-elements-ai:sidebar", props: { state } });
}
