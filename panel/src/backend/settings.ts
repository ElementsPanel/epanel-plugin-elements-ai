import { randomBytes } from "crypto";
import type { PanelPluginContext } from "../../../../../panel/src/app/plugin";
import type { ModelOption, ThinkingEffort } from "../types";
import { assertPublicEndpoint } from "./transport";

export interface SavedModel {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  apiKey: string;
  thinkingEnabled: boolean | null;
  thinkingEffort: ThinkingEffort;
}

export interface ResolvedModel extends SavedModel {
  selectionId: string;
  publicOnly: boolean;
}

export class ModelSettingsError extends Error {}

// Legacy fields must remain declared for migration through the host entity loader.
export class EpanelPluginElementsAiSettings {
  presets: SavedModel[] = [];
  endpoint = "";
  model = "";
  apiKey = "";
}

class PersonalModels {
  models: SavedModel[] = [];
}

function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return value === "low" || value === "medium" || value === "high";
}

function normalizeModel(model: SavedModel): SavedModel {
  return {
    ...model,
    thinkingEnabled: typeof model.thinkingEnabled === "boolean" ? model.thinkingEnabled : null,
    thinkingEffort: isThinkingEffort(model.thinkingEffort) ? model.thinkingEffort : "medium"
  };
}

export class ModelStore {
  private queues = new Map<string, Promise<unknown>>();
  constructor(
    private ctx: PanelPluginContext,
    private presets: () => readonly SavedModel[]
  ) {}

  private async personal(userId: string): Promise<SavedModel[]> {
    const saved: PersonalModels | null = await this.ctx.storage
      .getStorage()
      .load("EpanelPluginElementsAiPersonalModels", PersonalModels, userId);
    return (saved?.models || []).map(normalizeModel);
  }

  async list(userId: string): Promise<ModelOption[]> {
    return [
      ...this.presets().map(({ id, name, model, thinkingEnabled, thinkingEffort }) => ({
        id: `preset:${id}`,
        name,
        model,
        thinkingEnabled,
        thinkingEffort,
        source: "preset" as const
      })),
      ...(await this.personal(userId)).map(
        ({ id, name, model, endpoint, apiKey, thinkingEnabled, thinkingEffort }) => ({
          id: `personal:${id}`,
          name,
          model,
          endpoint,
          hasApiKey: Boolean(apiKey),
          thinkingEnabled,
          thinkingEffort,
          source: "personal" as const
        })
      )
    ];
  }

  async resolve(userId: string, selection: string, admin: boolean): Promise<ResolvedModel> {
    const match = /^(preset|personal):([a-zA-Z0-9_-]{1,64})$/.exec(selection);
    if (!match) throw new ModelSettingsError(this.ctx.i18n.$t("AI_MODEL_MISSING"));
    const models = match[1] === "preset" ? this.presets() : await this.personal(userId);
    const model = models.find((item) => item.id === match[2]);
    if (!model) throw new ModelSettingsError(this.ctx.i18n.$t("AI_MODEL_MISSING"));
    const publicOnly = match[1] === "personal" && !admin;
    if (publicOnly) {
      try {
        assertPublicEndpoint(model.endpoint);
      } catch {
        throw new ModelSettingsError(this.ctx.i18n.$t("AI_PUBLIC_ENDPOINT"));
      }
    }
    return { ...model, selectionId: selection, publicOnly };
  }

  private async exclusive<T>(userId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(userId) || Promise.resolve();
    const pending = previous.catch(() => {}).then(task);
    this.queues.set(userId, pending);
    try {
      return await pending;
    } finally {
      if (this.queues.get(userId) === pending) this.queues.delete(userId);
    }
  }

  async save(userId: string, value: unknown, admin: boolean): Promise<void> {
    await this.exclusive(userId, async () => {
      const models = await this.personal(userId);
      const id =
        value && typeof value === "object" ? (value as Record<string, unknown>).id : undefined;
      const previous = models.find((item) => item.id === id);
      if (id !== undefined && !previous)
        throw new ModelSettingsError(this.ctx.i18n.$t("AI_MODEL_MISSING"));
      const model = validateModel(this.ctx, value, previous);
      if (!admin) {
        try {
          assertPublicEndpoint(model.endpoint);
        } catch {
          throw new ModelSettingsError(this.ctx.i18n.$t("AI_PUBLIC_ENDPOINT"));
        }
      }
      if (!previous && models.length >= 20)
        throw new ModelSettingsError(this.ctx.i18n.$t("AI_MODEL_LIMIT"));
      const next = previous
        ? models.map((item) => (item.id === model.id ? model : item))
        : [...models, model];
      await this.ctx.storage.getStorage().store("EpanelPluginElementsAiPersonalModels", userId, { models: next });
    });
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.exclusive(userId, async () => {
      const models = await this.personal(userId);
      if (!models.some((item) => item.id === id))
        throw new ModelSettingsError(this.ctx.i18n.$t("AI_MODEL_MISSING"));
      await this.ctx.storage
        .getStorage()
        .store("EpanelPluginElementsAiPersonalModels", userId, { models: models.filter((item) => item.id !== id) });
    });
  }
}

function validateModel(ctx: PanelPluginContext, input: unknown, previous?: SavedModel): SavedModel {
  const fail = (): never => {
    throw new ModelSettingsError(ctx.i18n.$t("AI_INVALID_SETTINGS"));
  };
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail();
  const values = input as Record<string, unknown>;
  if (
    Object.keys(values).some(
      (key) =>
        ![
          "id",
          "name",
          "endpoint",
          "model",
          "apiKey",
          "clearApiKey",
          "hasApiKey",
          "thinkingEnabled",
          "thinkingEffort"
        ].includes(key)
    )
  )
    return fail();
  for (const key of ["name", "endpoint", "model"])
    if (typeof values[key] !== "string" || !String(values[key]).trim()) return fail();
  if (
    (values.apiKey !== undefined && typeof values.apiKey !== "string") ||
    (values.clearApiKey !== undefined && typeof values.clearApiKey !== "boolean") ||
    (values.thinkingEnabled != null &&
      values.thinkingEnabled !== "" &&
      typeof values.thinkingEnabled !== "boolean") ||
    (values.thinkingEffort !== undefined && !isThinkingEffort(values.thinkingEffort))
  )
    return fail();
  const id = values.id === undefined ? randomBytes(12).toString("hex") : values.id;
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return fail();
  const endpoint = String(values.endpoint).trim();
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return fail();
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    endpoint.length > 2048
  )
    return fail();
  const name = String(values.name).trim();
  const model = String(values.model).trim();
  const key = String(values.apiKey || "").trim();
  if (name.length > 100 || model.length > 200 || key.length > 4096 || /[\r\n]/.test(key))
    return fail();
  const thinkingEnabled =
    values.thinkingEnabled === undefined
      ? previous?.thinkingEnabled ?? null
      : values.thinkingEnabled === ""
      ? null
      : values.thinkingEnabled;
  const thinkingEffort =
    values.thinkingEffort === undefined
      ? previous?.thinkingEffort || "medium"
      : values.thinkingEffort;
  return {
    id,
    name,
    endpoint,
    model,
    thinkingEnabled,
    thinkingEffort,
    apiKey: values.clearApiKey
      ? ""
      : key || (previous?.endpoint === endpoint ? previous.apiKey : "")
  };
}

export async function registerSettings(ctx: PanelPluginContext): Promise<ModelStore> {
  const storage = ctx.storage.getStorage();
  const stored: EpanelPluginElementsAiSettings =
    (await storage.load("EpanelPluginElementsAiSettings", EpanelPluginElementsAiSettings, "config")) || new EpanelPluginElementsAiSettings();
  let presets = (stored.presets || []).map(normalizeModel);
  if (!presets.length && stored.endpoint && stored.model) {
    presets = [
      {
        id: "default",
        name: stored.model,
        endpoint: stored.endpoint,
        model: stored.model,
        apiKey: stored.apiKey || "",
        thinkingEnabled: null,
        thinkingEffort: "medium"
      }
    ];
    await storage.store("EpanelPluginElementsAiSettings", "config", { presets });
  }
  const t = ctx.i18n.$t;
  ctx.settingsForm.declare({
    fields: () => [
      {
        key: "presets",
        type: "list",
        title: t("AI_PRESETS"),
        description: t("AI_PRESETS_HELP"),
        maxItems: 50,
        itemTitleKey: "name",
        listEditor: "dialog",
        addLabel: t("AI_ADD_MODEL"),
        editLabel: t("AI_EDIT_MODEL"),
        removeLabel: t("AI_DELETE_MODEL"),
        fields: [
          { key: "name", type: "string", title: t("AI_MODEL_LABEL"), required: true },
          {
            key: "endpoint",
            type: "string",
            title: t("AI_ENDPOINT"),
            description: t("AI_ENDPOINT_HELP"),
            required: true
          },
          { key: "model", type: "string", title: t("AI_MODEL"), required: true },
          {
            key: "thinkingEnabled",
            type: "select",
            title: t("AI_THINKING_ENABLED"),
            description: t("AI_THINKING_ENABLED_HELP"),
            options: [
              { value: "", label: t("AI_THINKING_DEFAULT") },
              { value: true, label: t("AI_THINKING_ON") },
              { value: false, label: t("AI_THINKING_OFF") }
            ]
          },
          {
            key: "thinkingEffort",
            type: "select",
            title: t("AI_THINKING_EFFORT"),
            description: t("AI_THINKING_EFFORT_HELP"),
            visibleWhen: "thinkingEnabled=true",
            options: [
              { value: "medium", label: t("AI_THINKING_MEDIUM") },
              { value: "low", label: t("AI_THINKING_LOW") },
              { value: "high", label: t("AI_THINKING_HIGH") }
            ]
          },
          {
            key: "apiKey",
            type: "string",
            title: t("AI_API_KEY"),
            description: t("AI_KEY_HELP"),
            secret: true
          },
          {
            key: "clearApiKey",
            type: "boolean",
            title: t("AI_CLEAR_KEY"),
            visibleWhen: "hasApiKey"
          }
        ]
      }
    ],
    read: () => ({
      presets: presets.map((item) => ({
        ...item,
        thinkingEnabled: item.thinkingEnabled ?? "",
        apiKey: "",
        hasApiKey: Boolean(item.apiKey),
        clearApiKey: false
      }))
    }),
    write: async (values) => {
      if (
        Object.keys(values).some((key) => key !== "presets") ||
        !Array.isArray(values.presets) ||
        JSON.stringify(values.presets).length > 128_000
      )
        throw new ModelSettingsError(t("AI_INVALID_SETTINGS"));
      const entries = values.presets;
      if (!Array.isArray(entries) || entries.length > 50)
        throw new ModelSettingsError(t("AI_INVALID_SETTINGS"));
      const next = entries.map((item) =>
        validateModel(
          ctx,
          item,
          presets.find((previous) => previous.id === item?.id)
        )
      );
      if (new Set(next.map((item) => item.id)).size !== next.length)
        throw new ModelSettingsError(t("AI_INVALID_SETTINGS"));
      await storage.store("EpanelPluginElementsAiSettings", "config", { presets: next });
      presets = next;
    }
  });
  return new ModelStore(ctx, () => presets);
}
