import type { PanelPluginContext } from "../../../../../panel/src/app/plugin";
import { defaultPreferences, type ChatPreferences } from "../preferences";
import { ModelSettingsError } from "./settings";

class PreferencesData {
  preferences = defaultPreferences();
}

export class PreferencesStore {
  constructor(private ctx: PanelPluginContext) {}

  async read(userId: string): Promise<ChatPreferences> {
    const saved: PreferencesData | null = await this.ctx.storage
      .getStorage()
      .load("EpanelPluginElementsAiPreferences", PreferencesData, userId);
    const defaults = defaultPreferences();
    return {
      sendOnEnter:
        typeof saved?.preferences?.sendOnEnter === "boolean"
          ? saved.preferences.sendOnEnter
          : defaults.sendOnEnter
    };
  }

  validate(value: unknown): ChatPreferences {
    const defaults = defaultPreferences();
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ModelSettingsError(this.ctx.i18n.$t("AI_INVALID_SETTINGS"));
    const input = value as Record<string, unknown>;
    if (
      Object.keys(input).some((key) => !Object.prototype.hasOwnProperty.call(defaults, key)) ||
      Object.entries(defaults).some(([key, fallback]) => typeof input[key] !== typeof fallback)
    )
      throw new ModelSettingsError(this.ctx.i18n.$t("AI_INVALID_SETTINGS"));
    return { ...input } as unknown as ChatPreferences;
  }

  async save(userId: string, value: ChatPreferences) {
    await this.ctx.storage
      .getStorage()
      .store("EpanelPluginElementsAiPreferences", userId, { preferences: this.validate(value) });
  }
}
